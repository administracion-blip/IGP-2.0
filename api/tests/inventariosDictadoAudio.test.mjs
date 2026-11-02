/**
 * Dictado por voz, fase 5: POST /inventarios/:id/dictado/audio y transcribirAudio.
 * El transcriptor es siempre falso (configurarTranscripcion) y fetch se simula en la prueba
 * unitaria: nunca se llama a OpenAI. Dynamo en memoria.
 */

import test, { after, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { S3Client } from '@aws-sdk/client-s3';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-inventario';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { crearPlantilla } = await import('../lib/inventarios/plantillas.js');
const { crearInventario, cambiarEstado } = await import('../lib/inventarios/inventarios.js');
const { guardarAlias } = await import('../lib/inventarios/dictado/alias.js');
const { configurarTranscripcion, prepararPrompt, restablecerTranscripcion } = await import('../lib/inventarios/dictado/transcripcion.js');
const { transcribirAudio, MAX_PROMPT_TRANSCRIPCION } = await import('../lib/ia/openaiClient.js');
const { detectarTipo } = await import('../lib/seguridad/subidas.js');
const { crearRouterDictado } = await import('../routes/inventariosDictado.js');
const sesion = await import('../lib/inventarios/dictado/sesion.js');

const MB = 1024 * 1024;
const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador', Nombre: 'Ana' };
const COMPRAS = { sub: '000021', email: 'compras@test', rol: 'Compras' };
const NADIE = { sub: '000024', email: 'nadie@test', rol: 'Nadie' };
const AJENO = { sub: '000025', email: 'ajeno@test', rol: 'Contador' };
const USUARIOS = [CONTADOR, COMPRAS, NADIE, AJENO];
const STOCK_SECRETO = 987654;

/** Cabecera EBML mínima de un WebM (DocType «webm»), como la de MediaRecorder en Chrome. */
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]),
  Buffer.from('webm'),
  Buffer.alloc(64, 1),
]);
/** Caja ftyp de un MP4/M4A, como el audio/mp4 de Safari. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypiso5'), Buffer.alloc(4), Buffer.from('iso5isom'), Buffer.alloc(64, 1)]);
const NO_AUDIO = Buffer.from('esto no es audio, solo texto con nombre .webm '.repeat(4));

const T = () => tables.inventarios;

let servidor = null;
let base = '';
let usuarioActual = CONTADOR;
let db = null;
let plantilla = null;

/** Lo que recibe el transcriptor falso. */
let llamadas = [];
let respuesta = 'Roku 7';
let fallo = null;
/** Si es una promesa, el transcriptor falso espera a que se resuelva. */
let puerta = null;
let llamadasS3 = [];
let escriturasDisco = [];

const enviarS3 = S3Client.prototype.send;
S3Client.prototype.send = async function espiaS3(cmd) {
  llamadasS3.push(cmd?.constructor?.name);
  throw new Error('S3 no debe usarse en el dictado por audio');
};
const crearStreamOriginal = fs.createWriteStream;
const escribirOriginal = fs.writeFile;
const escribirSyncOriginal = fs.writeFileSync;
const escribirPromesaOriginal = fs.promises.writeFile;
fs.createWriteStream = function espia(ruta, ...resto) {
  escriturasDisco.push(String(ruta));
  return crearStreamOriginal.call(this, ruta, ...resto);
};
fs.writeFile = function espia(ruta, ...resto) {
  escriturasDisco.push(String(ruta));
  return escribirOriginal.call(this, ruta, ...resto);
};
fs.writeFileSync = function espia(ruta, ...resto) {
  escriturasDisco.push(String(ruta));
  return escribirSyncOriginal.call(this, ruta, ...resto);
};
fs.promises.writeFile = function espia(ruta, ...resto) {
  escriturasDisco.push(String(ruta));
  return escribirPromesaOriginal.call(this, ruta, ...resto);
};

async function arrancar() {
  if (servidor) return;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const cabecera = req.headers['x-prueba-usuario'];
    const usuario = cabecera ? USUARIOS.find((u) => u.sub === cabecera) || null : usuarioActual;
    if (usuario) req.user = usuario;
    req.log = { info() {}, error() {}, warn() {} };
    next();
  });
  app.use('/api', crearRouterDictado({ exportStocks: async () => [] }));
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function api(metodo, ruta, cuerpo, usuario = usuarioActual) {
  usuarioActual = usuario;
  await arrancar();
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ruta = (id, resto = '') => `/api/inventarios/${id}/dictado${resto}`;

async function enviarAudio(id, {
  bytes = WEBM,
  tipo = 'audio/webm;codecs=opus',
  nombre = 'grabacion.webm',
  idEnvio = 'grab-1',
  idEnvioDespues = false,
  campo = 'audio',
  usuario = CONTADOR,
  extra = [],
} = {}) {
  usuarioActual = usuario;
  await arrancar();
  const form = new FormData();
  if (idEnvio != null && !idEnvioDespues) form.append('idEnvio', idEnvio);
  if (bytes) form.append(campo, new Blob([bytes], { type: tipo }), nombre);
  if (idEnvio != null && idEnvioDespues) form.append('idEnvio', idEnvio);
  for (const [k, v] of extra) form.append(k, v);
  // El usuario va en cabecera: con peticiones simultáneas la variable global no sirve.
  const headers = usuario ? { 'x-prueba-usuario': usuario.sub } : { 'x-prueba-usuario': 'ninguno' };
  const res = await fetch(base + ruta(id, '/audio'), { method: 'POST', body: form, headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  S3Client.prototype.send = enviarS3;
  fs.createWriteStream = crearStreamOriginal;
  fs.writeFile = escribirOriginal;
  fs.writeFileSync = escribirSyncOriginal;
  fs.promises.writeFile = escribirPromesaOriginal;
  restablecerTranscripcion();
  servidor?.closeAllConnections?.();
  servidor?.close();
});

beforeEach(async () => {
  usuarioActual = CONTADOR;
  llamadas = [];
  respuesta = 'Roku 7';
  fallo = null;
  puerta = null;
  llamadasS3 = [];
  configurarTranscripcion(async (buffer, opts) => {
    llamadas.push({ bytes: Buffer.from(buffer), opts });
    if (puerta) await puerta;
    if (fallo) throw fallo;
    return { texto: respuesta };
  });
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(T(), {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  for (const u of [CONTADOR, COMPRAS, NADIE]) {
    db.sembrar(tables.usuarios, { id_usuario: u.sub, Rol: u.rol, Locales: [], Email: u.email });
  }
  db.sembrar(tables.usuarios, { id_usuario: AJENO.sub, Rol: AJENO.rol, Local: ['Bar Sur'], Email: AJENO.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Compras', SK: 'PERMISO#inventario.gestionar' });
  db.sembrar(tables.almacenes, { Id: '1', Nombre: 'Almacen Centro' });
  db.sembrar(tables.almacenes, { Id: '202', Nombre: 'Almacen Sur' });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Centro', 'almacen origen': 'Almacen Centro' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur', 'almacen origen': 'Almacen Sur' });
  const producto = (id, nombre, activo = true) => db.sembrar(tables.agoraProducts, {
    PK: 'GLOBAL', SK: id, Id: id, Name: nombre, FamilyId: '12', FamilyName: 'BOT', FormatoBaseNombre: 'Unidad', Active: activo,
  });
  producto('200', 'ROKU GIN 70CL');
  producto('1367', 'JOHNNIE WALKER');
  producto('300', 'LARIOS GIN');
  producto('400', 'COCA COLA 35CL');
  producto('50', 'BOMBAY SAPPHIRE', false);
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  plantilla = await crearPlantilla({
    nombre: 'Barra', modo: 'familias', miembros: [{ id: '12', nombre: 'BOT' }],
  }, 'compras@test');
  escriturasDisco = [];
});

afterEach(() => {
  assert.deepEqual(llamadasS3, [], 'el audio no debe tocar S3');
  assert.deepEqual(escriturasDisco, [], 'el audio no debe escribirse en disco');
});

function lineaInv(productId, nombre, stockTeorico, extra = {}) {
  return { productId, nombre, familiaNombre: 'BOT', unidad: 'Unidad', stockTeorico, ...extra };
}

async function nuevoInventario() {
  const inv = await crearInventario({
    warehouseId: '1',
    fecha: '2026-11-02',
    employeeId: '42',
    employeeNombre: 'Ana',
    plantillaId: plantilla.plantillaId,
    lineas: [
      lineaInv('200', 'ROKU GIN 70CL', STOCK_SECRETO, { stockReal: STOCK_SECRETO, botellasAbiertas: 0 }),
      lineaInv('1367', 'JOHNNIE WALKER', 203, { stockReal: 0, botellasAbiertas: 0.5 }),
      lineaInv('300', 'LARIOS GIN', 4),
    ],
  }, 'compras@test');
  return inv.inventarioId;
}

const lineasDictado = () => db.listar(T()).filter((it) => /^DICTADO#.*#LINEA#/.test(String(it.SK)));

// ─── Camino feliz ───

test('audio webm válido: transcribe y crea las líneas igual que interpretar', async () => {
  const id = await nuevoInventario();
  respuesta = 'Larios 2. Coca cola 4';
  const r = await enviarAudio(id, { idEnvio: 'grab-1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.texto, 'Larios 2. Coca cola 4');
  assert.equal(r.body.repetido, undefined);
  assert.equal(r.body.sesion.estado, 'activa');
  assert.deepEqual(r.body.lineas.map((l) => [l.n, l.productId, l.idEnvio, l.cantidad.total]), [
    [1, '300', 'grab-1', 2],
    [2, '400', 'grab-1', 4],
  ]);
  assert.equal(JSON.stringify(r.body).includes('stockTeorico'), false);

  assert.equal(llamadas.length, 1);
  const [{ bytes, opts }] = llamadas;
  assert.ok(bytes.equals(WEBM));
  assert.equal(opts.tipo, 'audio/webm');
  assert.equal(opts.nombre, 'audio.webm');
  assert.equal(opts.idioma, 'es');

  // Mismo resultado que el texto por interpretar en otro inventario.
  const otro = await nuevoInventario();
  const t = await api('POST', ruta(otro, '/interpretar'), { texto: 'Larios 2. Coca cola 4', idEnvio: 'grab-1' }, CONTADOR);
  const sinFechas = (l) => ({ ...l, creadoEn: undefined, actualizadoEn: undefined });
  assert.deepEqual(r.body.lineas.map(sinFechas), t.body.lineas.map(sinFechas));
});

test('mp4 de Safari aceptado, con idEnvio después del fichero', async () => {
  const id = await nuevoInventario();
  const r = await enviarAudio(id, { bytes: MP4, tipo: 'audio/mp4', nombre: 'grabacion.mp4', idEnvio: 'safari-1', idEnvioDespues: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.lineas[0].productId, '200');
  assert.equal(llamadas[0].opts.tipo, 'audio/mp4');
  assert.equal(llamadas[0].opts.nombre, 'audio.m4a');
});

// ─── Validación del fichero ───

test('un fichero que no es audio con nombre .webm y tipo audio/webm → 400 sin transcribir', async () => {
  const id = await nuevoInventario();
  const r = await enviarAudio(id, { bytes: NO_AUDIO, tipo: 'audio/webm', nombre: 'grabacion.webm' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Tipo de archivo no permitido');
  assert.equal(llamadas.length, 0);
  assert.equal(lineasDictado().length, 0);
});

test('más de 25 MB → 400 sin transcribir', async () => {
  const id = await nuevoInventario();
  const grande = Buffer.concat([WEBM, Buffer.alloc(25 * MB)]);
  const r = await enviarAudio(id, { bytes: grande });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'El audio supera el tamaño máximo (25 MB).');
  assert.equal(llamadas.length, 0);
});

test('sin fichero, sin idEnvio, idEnvio no válido o campo equivocado → 400 sin transcribir', async () => {
  const id = await nuevoInventario();
  const sinFichero = await enviarAudio(id, { bytes: null });
  assert.equal(sinFichero.status, 400);
  assert.equal(sinFichero.body.error, 'Falta el audio (campo «audio»).');
  const sinId = await enviarAudio(id, { idEnvio: null });
  assert.equal(sinId.status, 400);
  assert.equal(sinId.body.error, 'idEnvio es obligatorio');
  assert.equal((await enviarAudio(id, { idEnvio: 'a#b' })).status, 400);
  assert.equal((await enviarAudio(id, { campo: 'fichero' })).status, 400);
  const json = await api('POST', ruta(id, '/audio'), { idEnvio: 'x' }, CONTADOR);
  assert.equal(json.status, 400);
  assert.equal(llamadas.length, 0);
  assert.equal(lineasDictado().length, 0);
});

// ─── Prompt ───

test('el prompt lleva nombres y alias, nunca stock', async () => {
  const id = await nuevoInventario();
  const activos = [{ productId: '200', nombre: 'ROKU GIN 70CL' }, { productId: '300', nombre: 'LARIOS GIN' }];
  await guardarAlias('rokku', '200', 'compras@test', { productosActivos: activos });
  await guardarAlias('larios rosa', '300', 'compras@test', { productosActivos: activos });
  const r = await enviarAudio(id);
  assert.equal(r.status, 201);
  const { prompt } = llamadas[0].opts;
  assert.ok(prompt.startsWith('Conteo de inventario de bar: nombre de producto y cantidad.'));
  for (const t of ['ROKU GIN 70CL', 'JOHNNIE WALKER', 'LARIOS GIN', 'COCA COLA 35CL', 'rokku', 'larios rosa']) {
    assert.ok(prompt.includes(t), t);
  }
  assert.equal(prompt.includes('BOMBAY'), false, 'los inactivos no van al prompt');
  assert.equal(prompt.includes(String(STOCK_SECRETO)), false);
  assert.equal(/stockTeorico|stockReal|teórico/i.test(prompt), false);
  assert.ok(prompt.length <= MAX_PROMPT_TRANSCRIPCION);
});

test('prepararPrompt recorta a ~1000 caracteres dando prioridad a los alias más usados', () => {
  const productos = Array.from({ length: 300 }, (_, i) => ({ productId: String(i + 1), nombre: `PRODUCTO LARGO NUMERO ${i + 1}` }));
  const alias = [
    { texto: 'poco usado', productId: '2', usos: 1 },
    { texto: 'muy usado', productId: '1', usos: 50 },
  ];
  const prompt = prepararPrompt(productos, alias);
  assert.ok(prompt.length <= MAX_PROMPT_TRANSCRIPCION);
  assert.ok(prompt.indexOf('muy usado') < prompt.indexOf('poco usado'));
  assert.ok(prompt.indexOf('poco usado') < prompt.indexOf('PRODUCTO LARGO NUMERO 1'));
  assert.equal(prompt.includes('PRODUCTO LARGO NUMERO 300'), false);
});

// ─── Idempotencia y errores ───

test('mismo idEnvio dos veces: transcribe una vez y el repetido devuelve las mismas líneas', async () => {
  const id = await nuevoInventario();
  const a = await enviarAudio(id, { idEnvio: 'grab-7' });
  const b = await enviarAudio(id, { idEnvio: 'grab-7' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.repetido, true);
  assert.equal(b.body.texto, null);
  assert.deepEqual(b.body.lineas.map((l) => l.n), a.body.lineas.map((l) => l.n));
  assert.equal(llamadas.length, 1);
  assert.equal(lineasDictado().length, 1);
});

test('error del transcriptor → 502 en español, sin líneas; el reintento con el mismo idEnvio transcribe', async () => {
  const id = await nuevoInventario();
  fallo = new Error('OpenAI HTTP 500: detalle técnico');
  const r = await enviarAudio(id, { idEnvio: 'grab-err' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'No se ha podido transcribir el audio. Inténtalo de nuevo.');
  assert.equal(JSON.stringify(r.body).includes('OpenAI'), false);
  assert.equal(lineasDictado().length, 0);

  fallo = Object.assign(new Error('La transcripción no está configurada.'), { status: 503, expose: true });
  const n = await enviarAudio(id, { idEnvio: 'grab-err' });
  assert.equal(n.status, 503);
  assert.equal(n.body.error, 'La transcripción no está configurada.');

  fallo = null;
  const ok = await enviarAudio(id, { idEnvio: 'grab-err' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.repetido, undefined);
  assert.equal(ok.body.lineas.length, 1);
  assert.equal(llamadas.length, 3);
});

test('texto vacío → 200 con lineas [] y aviso; libera el idEnvio', async () => {
  const id = await nuevoInventario();
  respuesta = '   ';
  const r = await enviarAudio(id, { idEnvio: 'grab-vacio' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lineas, []);
  assert.equal(r.body.texto, '');
  assert.equal(r.body.aviso, 'No se ha entendido nada en el audio.');
  assert.equal(lineasDictado().length, 0);
  respuesta = 'Roku 1';
  const otra = await enviarAudio(id, { idEnvio: 'grab-vacio' });
  assert.equal(otra.status, 201);
  assert.equal(llamadas.length, 2);
});

// ─── Reserva abandonada ───

function envioGuardado(id, idEnvio) {
  return db.listar(T()).find((it) => it.PK === `INV#${id}` && String(it.SK).endsWith(`#ENVIO#${idEnvio}`)) || null;
}

function envejecer(id, idEnvio, ms) {
  const it = envioGuardado(id, idEnvio);
  db.sembrar(T(), { ...it, creadoEn: new Date(Date.now() - ms).toISOString() });
}

test('una reserva abandonada (> 3 min) se retoma: el reintento transcribe y crea líneas', async () => {
  const id = await nuevoInventario();
  // El proceso que reservó murió transcribiendo: la reserva quedó en 'reservado'.
  assert.deepEqual(await sesion.reservarEnvio(id, CONTADOR.sub, 'grab-muerto'), { reservado: true });
  envejecer(id, 'grab-muerto', sesion.RESERVA_ABANDONADA_MS + 1000);
  const r = await enviarAudio(id, { idEnvio: 'grab-muerto' });
  assert.equal(r.status, 201);
  assert.equal(r.body.repetido, undefined);
  assert.equal(r.body.lineas.length, 1);
  assert.equal(llamadas.length, 1);
  assert.equal(envioGuardado(id, 'grab-muerto').estado, 'hecho');
});

test('una reserva reciente sigue dando 409 sin transcribir', async () => {
  const id = await nuevoInventario();
  await sesion.reservarEnvio(id, CONTADOR.sub, 'grab-vivo');
  envejecer(id, 'grab-vivo', 60 * 1000);
  const r = await enviarAudio(id, { idEnvio: 'grab-vivo' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Este dictado se está procesando; vuelve a intentarlo.');
  assert.equal(llamadas.length, 0);
  assert.equal(lineasDictado().length, 0);
});

test('dos reintentos a la vez sobre una reserva abandonada: solo uno la gana', async () => {
  const id = await nuevoInventario();
  await sesion.reservarEnvio(id, CONTADOR.sub, 'grab-carrera');
  envejecer(id, 'grab-carrera', sesion.RESERVA_ABANDONADA_MS + 1000);
  const [a, b] = await Promise.allSettled([
    sesion.reservarEnvio(id, CONTADOR.sub, 'grab-carrera'),
    sesion.reservarEnvio(id, CONTADOR.sub, 'grab-carrera'),
  ]);
  const ganadas = [a, b].filter((x) => x.status === 'fulfilled' && x.value.reservado === true);
  const perdidas = [a, b].filter((x) => x.status === 'rejected');
  assert.equal(ganadas.length, 1);
  assert.equal(perdidas.length, 1);
  assert.equal(perdidas[0].reason.status, 409);
  assert.ok(Date.now() - Date.parse(envioGuardado(id, 'grab-carrera').creadoEn) < 60 * 1000, 'creadoEn renovado');
});

// ─── Memoria: límites multipart y un audio por usuario ───

test('demasiadas partes o un campo demasiado largo → 400 en español, sin transcribir; luego se puede enviar', async () => {
  const id = await nuevoInventario();
  const partes = await enviarAudio(id, { extra: [['a', '1'], ['b', '2'], ['c', '3']] });
  assert.equal(partes.status, 400);
  assert.equal(partes.body.error, 'Demasiadas partes en el envío: manda solo el audio y el idEnvio.');
  const largo = await enviarAudio(id, { idEnvio: null, extra: [['nota', 'x'.repeat(2000)]] });
  assert.equal(largo.status, 400);
  assert.equal(largo.body.error, 'Un campo del envío es demasiado largo.');
  assert.equal(llamadas.length, 0);
  // El candado del usuario se soltó tras el error de multer.
  assert.equal((await enviarAudio(id, { idEnvio: 'tras-error' })).status, 201);
});

async function esperarLlamadas(n) {
  const limite = Date.now() + 5000;
  while (llamadas.length < n) {
    if (Date.now() > limite) throw new Error(`el transcriptor no llegó a ${n} llamadas`);
    await new Promise((listo) => setTimeout(listo, 10));
  }
}

test('un audio en curso por usuario: el segundo simultáneo da 429; otro usuario no se bloquea', async () => {
  const id = await nuevoInventario();
  let abrir;
  puerta = new Promise((listo) => { abrir = listo; });

  const primera = enviarAudio(id, { idEnvio: 'uno', usuario: CONTADOR });
  await esperarLlamadas(1);
  const segunda = await enviarAudio(id, { idEnvio: 'dos', usuario: CONTADOR });
  assert.equal(segunda.status, 429);
  assert.equal(segunda.body.error, 'Ya se está procesando otro audio. Espera a que termine.');

  const otroUsuario = enviarAudio(id, { idEnvio: 'uno', usuario: COMPRAS });
  await esperarLlamadas(2);
  abrir();
  puerta = null;
  assert.equal((await primera).status, 201);
  assert.equal((await otroUsuario).status, 201);
  assert.equal(llamadas.length, 2, 'el 429 no llegó al transcriptor');

  // Terminado el primero, el mismo usuario puede volver a enviar.
  assert.equal((await enviarAudio(id, { idEnvio: 'dos', usuario: CONTADOR })).status, 201);
  assert.equal(llamadas.length, 3);
});

test('el candado también se suelta tras un 403 y tras un error del transcriptor', async () => {
  const id = await nuevoInventario();
  assert.equal((await enviarAudio(id, { usuario: AJENO })).status, 403);
  assert.equal((await enviarAudio(id, { usuario: AJENO })).status, 403, 'sin 429 tras el 403');
  fallo = new Error('caído');
  assert.equal((await enviarAudio(id, { idEnvio: 'f' })).status, 502);
  fallo = null;
  assert.equal((await enviarAudio(id, { idEnvio: 'f' })).status, 201);
});

// ─── Permisos y estados ───

test('401 sin usuario, 403 sin permiso y 403 con almacén no permitido, sin transcribir', async () => {
  const id = await nuevoInventario();
  assert.equal((await enviarAudio(id, { usuario: null })).status, 401);
  const sinPermiso = await enviarAudio(id, { usuario: NADIE });
  assert.equal(sinPermiso.status, 403);
  const ajeno = await enviarAudio(id, { usuario: AJENO });
  assert.equal(ajeno.status, 403);
  assert.equal(ajeno.body.error, 'Sin acceso a este almacén');
  assert.equal(llamadas.length, 0);
  assert.equal(db.listar(T()).some((it) => String(it.SK).startsWith('DICTADO#')), false);
});

test('importado → 409 y quien cuenta con el inventario revisado → 403, sin transcribir', async () => {
  const id = await nuevoInventario();
  await cambiarEstado(id, 'contado', 'compras@test');
  await cambiarEstado(id, 'revisado', 'compras@test');
  assert.equal((await enviarAudio(id, { usuario: CONTADOR })).status, 403);
  await cambiarEstado(id, 'exportado', 'compras@test');
  await cambiarEstado(id, 'importado', 'compras@test');
  assert.equal((await enviarAudio(id, { usuario: CONTADOR })).status, 409);
  assert.equal((await enviarAudio(id, { usuario: COMPRAS })).status, 409);
  assert.equal(llamadas.length, 0);
});

// ─── Detección de tipo ───

test('detectarTipo reconoce los audios del perfil y no confunde imágenes', () => {
  assert.equal(detectarTipo(WEBM), 'audio/webm');
  assert.equal(detectarTipo(MP4), 'audio/mp4');
  assert.equal(detectarTipo(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])), 'audio/ogg');
  assert.equal(detectarTipo(Buffer.concat([Buffer.from('ID3'), Buffer.from([0x04, 0x00]), Buffer.alloc(20)])), 'audio/mpeg');
  assert.equal(detectarTipo(Buffer.concat([Buffer.from('ID3'), Buffer.from([0x04, 0xff]), Buffer.alloc(20)])), null);
  // Regresión: un CSV cuya primera columna es «ID3» sigue siendo CSV.
  assert.equal(detectarTipo(Buffer.from('ID3;nombre;importe\n1;Roku;10\n'), 'datos.csv'), 'text/csv');
  assert.equal(detectarTipo(Buffer.from('ID3,nombre\n1,Roku\n'), 'datos.csv'), 'text/csv');
  assert.equal(detectarTipo(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])), 'audio/mpeg');
  assert.equal(detectarTipo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(8)])), 'audio/wav');
  assert.equal(detectarTipo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(detectarTipo(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])), 'image/webp');
  assert.equal(detectarTipo(NO_AUDIO, 'x.webm'), null);
});

// ─── transcribirAudio (fetch simulado) ───

async function conFetchFalso(respuestaFalsa, fn) {
  const fetchReal = globalThis.fetch;
  const clavePrevia = process.env.OPENAI_API_KEY;
  const peticiones = [];
  globalThis.fetch = async (url, init) => {
    peticiones.push({ url, init });
    return respuestaFalsa();
  };
  try {
    await fn(peticiones);
  } finally {
    globalThis.fetch = fetchReal;
    if (clavePrevia === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = clavePrevia;
  }
}

test('transcribirAudio envía modelo, idioma, prompt y fichero; 500 → 502; sin clave → 503', async () => {
  const modeloPrevio = process.env.OPENAI_TRANSCRIBE_MODEL;
  delete process.env.OPENAI_TRANSCRIBE_MODEL;
  try {
    await conFetchFalso(() => new Response(JSON.stringify({ text: ' Roku 7 ' }), { status: 200 }), async (peticiones) => {
      process.env.OPENAI_API_KEY = 'sk-solo-pruebas';
      const largo = 'x'.repeat(5000);
      const r = await transcribirAudio(WEBM, { nombre: 'audio.webm', tipo: 'audio/webm', prompt: `Roku, Larios ${largo}` });
      assert.deepEqual(r, { texto: 'Roku 7' });
      assert.equal(peticiones.length, 1);
      const { url, init } = peticiones[0];
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer sk-solo-pruebas');
      assert.equal(init.headers['Content-Type'], undefined);
      const form = init.body;
      assert.ok(form instanceof FormData);
      assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
      assert.equal(form.get('language'), 'es');
      assert.equal(form.get('response_format'), 'json');
      assert.ok(form.get('prompt').startsWith('Roku, Larios'));
      assert.equal(form.get('prompt').length, MAX_PROMPT_TRANSCRIPCION);
      const file = form.get('file');
      assert.equal(file.name, 'audio.webm');
      assert.equal(file.type, 'audio/webm');
      assert.ok(Buffer.from(await file.arrayBuffer()).equals(WEBM));
    });

    await conFetchFalso(() => new Response('{"error":"interno"}', { status: 500 }), async () => {
      process.env.OPENAI_API_KEY = 'sk-solo-pruebas';
      await assert.rejects(transcribirAudio(WEBM, { prompt: 'Roku' }), (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.message, 'No se ha podido transcribir el audio. Inténtalo de nuevo.');
        assert.ok(err.detalle.includes('500'));
        return true;
      });
    });

    await conFetchFalso(() => { throw new Error('no debe llamarse'); }, async (peticiones) => {
      delete process.env.OPENAI_API_KEY;
      await assert.rejects(transcribirAudio(WEBM), (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.message, 'La transcripción no está configurada.');
        return true;
      });
      assert.equal(peticiones.length, 0);
    });

    await conFetchFalso(() => Promise.reject(new Error('socket colgado')), async () => {
      process.env.OPENAI_API_KEY = 'sk-solo-pruebas';
      process.env.OPENAI_TRANSCRIBE_MODEL = 'whisper-1';
      await assert.rejects(transcribirAudio(WEBM), (err) => err.status === 502);
    });
  } finally {
    if (modeloPrevio === undefined) delete process.env.OPENAI_TRANSCRIBE_MODEL;
    else process.env.OPENAI_TRANSCRIBE_MODEL = modeloPrevio;
  }
});
