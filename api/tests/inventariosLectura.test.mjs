/**
 * La lectura de un par propone cantidades y no escribe el stock real.
 * El modelo va simulado. No llama a Ágora ni manda el teórico.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-inventario';
process.env.OPENAI_API_KEY = 'sk-test-lectura';
delete process.env.IA_INVENTARIO_MODEL;

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { configurarAlmacenAdjuntos } = await import('../lib/tasks/adjuntos.js');
const { prepararFoto, confirmarFoto } = await import('../lib/inventarios/fotos.js');
const { configurarLecturaIa, fusionarLecturas } = await import('../lib/inventarios/lectura.js');
const { chatCompletion } = await import('../lib/ia/openaiClient.js');
const { default: inventariosRouter } = await import('../routes/inventarios.js');

const CONTADOR = { sub: '000020', email: 'contador@test', rol: 'Contador' };

let servidor = null;
let base = '';
let db = null;
let bucket = null;
let restaurar = null;
let restaurarIa = null;
let respuestaIa = { propuestas: [], noIdentificados: [] };
let ultimoPrompt = '';

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = CONTADOR;
      req.log = { info() {}, error() {}, warn() {} };
      next();
    });
    app.use('/api', inventariosRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function subir(numero, posicion) {
  const preparada = await prepararFoto({
    inventarioId: 'inv1',
    numero,
    posicion,
    nombre: `${posicion}.jpg`,
    contentType: 'image/jpeg',
    tamano: 800,
  });
  bucket.set(preparada.s3Key, { tamano: 800, contentType: 'image/jpeg' });
  await confirmarFoto({
    inventarioId: 'inv1', numero, posicion, s3Key: preparada.s3Key,
  }, 'contador@test');
}

after(() => {
  restaurarIa?.();
  restaurar?.();
  servidor?.closeAllConnections?.();
  servidor?.close();
});

beforeEach(() => {
  db = crearDynamoMemoria();
  bucket = new Map();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.inventarios, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'WarehouseId-Clave-index': { hashKey: 'WarehouseId', rangeKey: 'Clave' } },
  });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: CONTADOR.sub, Rol: 'Contador', Locales: [], Email: CONTADOR.email });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Contador', SK: 'PERMISO#inventario.contar' });
  db.sembrar(tables.inventarios, {
    PK: 'INV#inv1', SK: 'META', WarehouseId: '000001', Clave: 'INV#2026-10-26#inv1',
    inventarioId: 'inv1', fecha: '2026-10-26', estado: 'borrador',
    employeeId: '42', plantillaId: 'p1',
  });
  db.sembrar(tables.inventarios, {
    PK: 'INV#inv1', SK: 'LINE#1367', productId: '1367', nombre: 'Johnnie Walker',
    stockTeorico: 203, botellasAbiertas: 0,
  });
  invalidarContextoAcceso();
  restaurar?.();
  restaurar = configurarAlmacenAdjuntos({
    urlSubida: async ({ key }) => `https://bucket.test/${key}?firma=subida`,
    urlLectura: async ({ key }) => `https://bucket.test/${key}?firma=lectura`,
    cabecera: async ({ key }) => bucket.get(key) || null,
    borrar: async ({ key }) => { bucket.delete(key); },
  });
  restaurarIa?.();
  respuestaIa = {
    propuestas: [{ productId: '1367', cantidad: 3.5, confianza: 0.9 }],
    noIdentificados: [],
  };
  restaurarIa = configurarLecturaIa(async ({ user, model, imagenes }) => {
    ultimoPrompt = user;
    assert.equal(model, 'gpt-4o');
    assert.equal(imagenes.length, 2);
    return { text: JSON.stringify(respuestaIa), model, usage: { prompt: 10, completion: 5 } };
  });
});

test('sin imagenes el mensaje de usuario sigue siendo texto', async () => {
  const original = global.fetch;
  let contenido = null;
  global.fetch = async (_url, init) => {
    contenido = JSON.parse(init.body).messages[1].content;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
  };
  try {
    await chatCompletion({ system: 's', user: 'hola', model: 'gpt-4o-mini' });
    assert.equal(contenido, 'hola');
  } finally {
    global.fetch = original;
  }
});

test('un par incompleto no se lee', async () => {
  await subir(1, 'frente');
  const res = await api('POST', '/api/inventarios/inv1/fotos/1/leer', {});
  assert.equal(res.status, 409);
});

test('la lectura propone solo productos del conteo y no toca el stock', async () => {
  respuestaIa = {
    propuestas: [
      { productId: '1367', cantidad: 3, confianza: 0.91 },
      { productId: '999', cantidad: 1, confianza: 0.8 },
    ],
    noIdentificados: [{ descripcion: 'botella sin etiqueta', cantidad: 1 }],
  };
  await subir(1, 'frente');
  await subir(1, 'superior');
  const res = await api('POST', '/api/inventarios/inv1/fotos/1/leer', {});
  assert.equal(res.status, 201);
  assert.equal(res.body.propuestas.length, 1);
  assert.equal(res.body.propuestas[0].productId, '1367');
  assert.equal(res.body.propuestas[0].cantidad, 3);
  assert.equal(res.body.propuestas[0].stockTeorico, undefined);
  assert.equal(res.body.noIdentificados.length, 2);
  assert.equal(res.body.stockTeorico, undefined);
  assert.equal(ultimoPrompt.includes('203'), false);
  assert.equal(ultimoPrompt.includes('Johnnie Walker'), true);

  const linea = db.obtener(tables.inventarios, { PK: 'INV#inv1', SK: 'LINE#1367' });
  assert.equal(linea.stockReal, undefined);
  assert.equal(linea.stockTeorico, 203);
});

test('el mismo producto en dos fotos se suma y pide revisión', () => {
  const fusion = fusionarLecturas([
    { numero: 1, propuestas: [{ productId: '1367', cantidad: 3, confianza: 0.9 }], noIdentificados: [] },
    { numero: 2, propuestas: [{ productId: '1367', cantidad: 0.5, confianza: 0.4 }], noIdentificados: [] },
  ]);
  assert.equal(fusion.propuestas[0].cantidad, 3.5);
  assert.equal(fusion.propuestas[0].aviso, 'visto en 2 fotos, revisa');
  assert.equal(fusion.propuestas[0].baja, true);
});
