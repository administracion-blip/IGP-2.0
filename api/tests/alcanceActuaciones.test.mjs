/**
 * Aislamiento por local en actuaciones. Un encargado con todos los permisos de
 * actuaciones pero solo con «Bar Norte» intenta generar huecos, mover artistas,
 * listar y firmar actuaciones de «Bar Sur».
 *
 * Escrituras: bloquean siempre.
 */

import test, { after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { S3Client } from '@aws-sdk/client-s3';

const subidasS3 = [];
S3Client.prototype.send = async (cmd) => {
  subidasS3.push(cmd.input?.Key);
  return {};
};

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance-actuaciones';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesGsi, clavesActuacion } = await import('../lib/clavesIndice.js');
const { default: actuacionesRouter } = await import('../routes/artistasActuaciones.js');

const ROL = 'Encargado';
const ENCARGADO_NORTE = { sub: '000070', email: 'norte@grupo.test', rol: ROL };
const OFICINA = { sub: '000071', email: 'oficina@grupo.test', rol: ROL };

const MODO_ORIGINAL = process.env.ALCANCE_MODO_LECTURAS;
function modo(valor) {
  if (valor === undefined) delete process.env.ALCANCE_MODO_LECTURAS;
  else process.env.ALCANCE_MODO_LECTURAS = valor;
}
afterEach(() => modo(MODO_ORIGINAL));

let usuarioActual = ENCARGADO_NORTE;
let servidor = null;
let base = '';

async function arrancar() {
  if (servidor) return;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = usuarioActual;
    next();
  });
  app.use('/api', actuacionesRouter);
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

async function api(metodo, ruta, cuerpo, usuario = ENCARGADO_NORTE) {
  usuarioActual = usuario;
  await arrancar();
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

let db = null;

function actuacion(id, idLocal, extra = {}) {
  const item = {
    id_actuacion: id,
    id_local: idLocal,
    fecha: '2026-09-05',
    hora_inicio: '22:00',
    id_artista: '',
    estado: 'pendiente',
    firma_artista_key: '',
    fecha_firma: '',
    ...extra,
  };
  return aplicarClavesGsi(item, clavesActuacion(item));
}

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.actuaciones, {
    hashKey: 'id_actuacion',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Artista-Fecha-index': { hashKey: 'gsi_artista', rangeKey: 'gsi_fecha' },
    },
  });
  db.crearTabla(tables.artistas, { hashKey: 'id_artista' });
  db.crearTabla(tables.gestionFestivos, { hashKey: 'id' });
  db.instalar(docClient);
  for (const p of ['ver', 'crear', 'editar', 'programacion', 'firma']) {
    db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#actuaciones.${p}` });
  }
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'Bar Norte' });
  db.sembrar(tables.locales, { id_Locales: '000020', nombre: 'Bar Sur' });
  db.sembrar(tables.usuarios, { id_usuario: '000070', Email: ENCARGADO_NORTE.email, Rol: ROL, Local: ['Bar Norte'] });
  db.sembrar(tables.usuarios, { id_usuario: '000071', Email: OFICINA.email, Rol: ROL, Local: [] });
  db.sembrar(tables.artistas, { id_artista: 'art-1', nombre_artistico: 'Trío Jazz' });
  db.sembrar(tables.actuaciones, actuacion('A-NORTE', '000010', { id_artista: 'art-1', artista_nombre_snapshot: 'Trío Jazz' }));
  db.sembrar(tables.actuaciones, actuacion('A-SUR', '000020', { id_artista: 'art-1', artista_nombre_snapshot: 'Trío Jazz' }));
  db.sembrar(tables.actuaciones, actuacion('A-NORTE-2', '000010', { hora_inicio: '23:00' }));
  subidasS3.length = 0;
  invalidarContextoAcceso();
  invalidarMaestroLocales();
  return db;
}

// ─── generar-base ───

const HUECOS = { fecha_inicio: '2026-10-01', fecha_fin: '2026-10-02', horas: ['22:00'] };

test('generar-base con un local ajeno: 403 y no se crea ningún hueco, tampoco del propio', async () => {
  montar();
  const antes = db.listar(tables.actuaciones);
  for (const cuerpo of [
    { ...HUECOS, id_locales: ['000010', '000020'] },
    { ...HUECOS, id_local: '000020' },
    { ...HUECOS, id_locales: ['abc'] },
  ]) {
    const r = await api('POST', '/api/actuaciones/generar-base', cuerpo);
    assert.equal(r.status, 403, JSON.stringify(cuerpo));
    assert.equal(r.body.error, 'No tienes acceso a este local');
  }
  assert.deepEqual(db.listar(tables.actuaciones), antes);
});

test('generar-base en su local crea los huecos; con alcance global, en cualquiera', async () => {
  montar();
  const propio = await api('POST', '/api/actuaciones/generar-base', { ...HUECOS, id_locales: ['000010'] });
  assert.equal(propio.status, 200);
  assert.equal(propio.body.creadas, 2);
  const global = await api('POST', '/api/actuaciones/generar-base', { ...HUECOS, id_locales: ['000010', '000020'] }, OFICINA);
  assert.equal(global.status, 200);
  assert.equal(global.body.creadas, 4);
});

// ─── mover-artista-aqui ───

test('mover-artista-aqui con origen o destino en un local ajeno: 403 y no cambia ninguno', async () => {
  montar();
  const antes = db.listar(tables.actuaciones);
  for (const [id_vaciar, id_asignar] of [
    ['A-SUR', 'A-NORTE-2'],
    ['A-NORTE', 'A-SUR'],
  ]) {
    const r = await api('POST', '/api/actuaciones/mover-artista-aqui', { id_vaciar, id_asignar, id_artista: 'art-1' });
    assert.equal(r.status, 403, `${id_vaciar} -> ${id_asignar}`);
    assert.equal(r.body.error, 'No tienes acceso a este local');
  }
  assert.deepEqual(db.listar(tables.actuaciones), antes);
});

test('mover-artista-aqui entre dos actuaciones de su local mueve el artista', async () => {
  montar();
  const r = await api('POST', '/api/actuaciones/mover-artista-aqui', {
    id_vaciar: 'A-NORTE',
    id_asignar: 'A-NORTE-2',
    id_artista: 'art-1',
  });
  assert.equal(r.status, 200);
  assert.equal(db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE' }).id_artista, '');
  assert.equal(db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE-2' }).id_artista, 'art-1');
});

test('mover-artista-aqui con alcance global cruza locales', async () => {
  montar();
  const r = await api(
    'POST',
    '/api/actuaciones/mover-artista-aqui',
    { id_vaciar: 'A-SUR', id_asignar: 'A-NORTE-2', id_artista: 'art-1' },
    OFICINA,
  );
  assert.equal(r.status, 200);
  assert.equal(db.obtener(tables.actuaciones, { id_actuacion: 'A-SUR' }).id_artista, '');
});

// ─── Listados: filtran de verdad en cualquier modo ───

const idsDe = (r) => r.body.actuaciones.map((a) => a.id_actuacion).sort();

test('GET /actuaciones: el restringido solo ve su local (observar y bloquear); el global, todo', async () => {
  for (const m of [undefined, 'observar', 'bloquear']) {
    montar();
    modo(m);
    const r = await api('GET', '/api/actuaciones');
    assert.equal(r.status, 200);
    assert.deepEqual(idsDe(r), ['A-NORTE', 'A-NORTE-2'], String(m));
    const ajeno = await api('GET', '/api/actuaciones?id_local=000020');
    assert.deepEqual(ajeno.body.actuaciones, [], String(m));
    const global = await api('GET', '/api/actuaciones', undefined, OFICINA);
    assert.deepEqual(idsDe(global), ['A-NORTE', 'A-NORTE-2', 'A-SUR'], String(m));
  }
});

test('GET /actuaciones/dia/total cuenta solo su local; el global, todo', async () => {
  montar();
  const r = await api('GET', '/api/actuaciones/dia/total?fecha=2026-09-05');
  assert.deepEqual(r.body, { total: 2, fecha: '2026-09-05' });
  const global = await api('GET', '/api/actuaciones/dia/total?fecha=2026-09-05', undefined, OFICINA);
  assert.equal(global.body.total, 3);
});

test('las lecturas de Dynamo por petición no crecen con el número de actuaciones', async () => {
  // Token vivo de un usuario ya borrado: su contexto no se cachea, así que una
  // comprobación por fila haría una lectura de igp_usuarios por fila.
  const BORRADO = { sub: '000079', email: 'borrado@grupo.test', rol: ROL };
  async function lecturas(filas, ruta, usuario) {
    montar();
    for (let i = 0; i < filas; i += 1) {
      db.sembrar(tables.actuaciones, actuacion(`X-${i}`, i % 2 ? '000010' : '000020'));
    }
    const desde = db.operaciones.length;
    const r = await api('GET', ruta, undefined, usuario);
    assert.equal(r.status, 200);
    if (usuario === BORRADO) assert.ok(r.body.total === 0 || r.body.actuaciones?.length === 0);
    return db.operaciones.length - desde;
  }
  for (const usuario of [ENCARGADO_NORTE, BORRADO]) {
    for (const ruta of ['/api/actuaciones', '/api/actuaciones/dia/total?fecha=2026-09-05']) {
      assert.equal(await lecturas(40, ruta, usuario), await lecturas(2, ruta, usuario), `${usuario.sub} ${ruta}`);
    }
  }
});

// ─── Firma ───

async function firmar(id, usuario = ENCARGADO_NORTE) {
  usuarioActual = usuario;
  await arrancar();
  const form = new FormData();
  // PNG real de 1×1: desde S-20 la firma se valida por contenido.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  form.append('file', new Blob([png], { type: 'image/png' }), 'firma.png');
  const res = await fetch(`${base}/api/actuaciones/item/${id}/firma`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('firmar una actuación de un local ajeno: 403 sin subir nada a S3 ni tocar el registro', async () => {
  montar();
  const antes = db.obtener(tables.actuaciones, { id_actuacion: 'A-SUR' });
  const r = await firmar('A-SUR');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'No tienes acceso a este local');
  assert.deepEqual(subidasS3, []);
  assert.deepEqual(db.obtener(tables.actuaciones, { id_actuacion: 'A-SUR' }), antes);
});

test('firmar una actuación inexistente: 404 sin subir nada a S3', async () => {
  montar();
  const r = await firmar('NO-EXISTE');
  assert.equal(r.status, 404);
  assert.deepEqual(subidasS3, []);
});

test('firmar en su local sube la firma y marca la actuación; volver a firmar sigue permitido (flujo del front)', async () => {
  montar();
  const r = await firmar('A-NORTE');
  assert.equal(r.status, 200);
  assert.equal(subidasS3.length, 1);
  const firmada = db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE' });
  assert.equal(firmada.estado, 'firmada');
  assert.equal(firmada.firma_artista_key, subidasS3[0]);
  assert.ok(firmada.firma_artista_key.startsWith('actuaciones/A-NORTE/firma_'));

  const otra = await firmar('A-NORTE');
  assert.equal(otra.status, 200);
  assert.equal(subidasS3.length, 2);
});

test('PUT no acepta campos de firma: firma_artista_key y fecha_firma no cambian', async () => {
  montar();
  assert.equal((await firmar('A-NORTE')).status, 200);
  const antes = db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE' });
  const r = await api('PUT', '/api/actuaciones/item/A-NORTE', {
    observaciones: 'Todo bien',
    firma_artista_key: 'actuaciones/A-SUR/firma_robada.png',
    fecha_firma: '2000-01-01T00:00:00.000Z',
    forzar_conflicto: true,
  });
  assert.equal(r.status, 200);
  const despues = db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE' });
  assert.equal(despues.observaciones, 'Todo bien');
  assert.equal(despues.firma_artista_key, antes.firma_artista_key);
  assert.equal(despues.fecha_firma, antes.fecha_firma);

  const vacia = await api('PUT', '/api/actuaciones/item/A-NORTE-2', { firma_artista_key: 'actuaciones/x/firma.png' });
  assert.equal(vacia.status, 200);
  assert.equal(db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE-2' }).firma_artista_key, '');
});

test('crear una actuación no acepta campos de firma: nace sin firma', async () => {
  montar();
  const r = await api('POST', '/api/actuaciones', {
    id_actuacion: 'A-NUEVA',
    id_local: '000010',
    fecha: '2026-10-10',
    hora_inicio: '21:00',
    firma_artista_key: 'actuaciones/A-SUR/firma_robada.png',
    fecha_firma: '2000-01-01T00:00:00.000Z',
  });
  assert.equal(r.status, 200);
  const creada = db.obtener(tables.actuaciones, { id_actuacion: 'A-NUEVA' });
  assert.equal(creada.firma_artista_key, '');
  assert.equal(creada.fecha_firma, '');
  assert.equal(r.body.actuacion.firma_artista_key, '');
});

test('crear con el id de una actuación de otro local: 409 y el registro ajeno queda igual', async () => {
  montar();
  const antes = db.obtener(tables.actuaciones, { id_actuacion: 'A-SUR' });
  const r = await api('POST', '/api/actuaciones', {
    id_actuacion: 'A-SUR',
    id_local: '000010',
    fecha: '2026-10-10',
    hora_inicio: '21:00',
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Ya existe una actuación con ese identificador');
  assert.deepEqual(db.obtener(tables.actuaciones, { id_actuacion: 'A-SUR' }), antes);

  const global = await api('POST', '/api/actuaciones', { id_actuacion: 'A-NORTE', id_local: '000010', fecha: '2026-10-10' }, OFICINA);
  assert.equal(global.status, 409);
});

// ─── Carrera entre leer y escribir ───

function moverDeLocalAntesDelPut(id) {
  db.interceptar('PutCommand', tables.actuaciones, async () => {
    db.sembrar(tables.actuaciones, { ...db.obtener(tables.actuaciones, { id_actuacion: id }), id_local: '000020' });
  });
}

test('editar o firmar una actuación que otro mueve de local entre la lectura y el Put: 409 sin pisarla', async () => {
  montar();
  moverDeLocalAntesDelPut('A-NORTE-2');
  const r = await api('PUT', '/api/actuaciones/item/A-NORTE-2', { observaciones: 'colada' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'La actuación ha cambiado, vuelve a cargarla');
  let a = db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE-2' });
  assert.equal(a.id_local, '000020');
  assert.equal(a.observaciones, undefined);

  montar();
  moverDeLocalAntesDelPut('A-NORTE-2');
  const f = await firmar('A-NORTE-2');
  assert.equal(f.status, 409);
  a = db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE-2' });
  assert.equal(a.id_local, '000020');
  assert.equal(a.estado, 'pendiente');
});

// ─── Sin local ───

test('crear sin local: el restringido recibe 400 sin escribir; el global puede', async () => {
  montar();
  const antes = db.listar(tables.actuaciones).length;
  for (const cuerpo of [{ fecha: '2026-10-10' }, { fecha: '2026-10-10', id_local: '' }, { fecha: '2026-10-10', id_local: null }]) {
    const r = await api('POST', '/api/actuaciones', cuerpo);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
    assert.equal(r.body.error, 'Falta el local');
  }
  assert.equal(db.listar(tables.actuaciones).length, antes);
  assert.equal((await api('POST', '/api/actuaciones', { fecha: '2026-10-10' }, OFICINA)).status, 200);
});

test('editar vaciando el local: el restringido recibe 400 y la actuación sigue en su local', async () => {
  montar();
  for (const id_local of ['', null]) {
    const r = await api('PUT', '/api/actuaciones/item/A-NORTE-2', { id_local, observaciones: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Falta el local');
  }
  const a = db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE-2' });
  assert.equal(a.id_local, '000010');
  assert.equal(a.observaciones, undefined);
});

test('editar sin mandar id_local conserva el leído (seguimiento del planning)', async () => {
  montar();
  const r = await api('PUT', '/api/actuaciones/item/A-NORTE-2', { observaciones: 'Muy bien' });
  assert.equal(r.status, 200);
  const a = db.obtener(tables.actuaciones, { id_actuacion: 'A-NORTE-2' });
  assert.equal(a.id_local, '000010');
  assert.equal(a.observaciones, 'Muy bien');
});

test('crear sin id_actuacion genera uno en el servidor', async () => {
  montar();
  const r = await api('POST', '/api/actuaciones', { id_local: '000010', fecha: '2026-10-10', hora_inicio: '21:00' });
  assert.equal(r.status, 200);
  const id = r.body.actuacion.id_actuacion;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(db.obtener(tables.actuaciones, { id_actuacion: id }).id_local, '000010');
});
