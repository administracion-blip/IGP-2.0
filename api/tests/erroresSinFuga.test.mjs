/**
 * S-19: el texto de AWS/Dynamo/Ágora no llega al cliente en los 5xx. Cada prueba
 * provoca un error con ARN y nombre de tabla y comprueba que la respuesta no los lleva;
 * los 4xx de negocio conservan su mensaje.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-errores';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { responderError, mensajeSeguro } = await import('../lib/http/responderError.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { default: festivosRouter } = await import('../routes/festivos.js');

const ARN = 'arn:aws:dynamodb:eu-west-3:123456789012:table/Igp_Gestionfestivosyestimaciones';

function errorAws(name = 'InternalServerError') {
  return Object.assign(new Error(`User: ${ARN} is not authorized to perform: dynamodb:Scan on resource ${ARN}`), {
    name,
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });
}

const logs = [];
let servidor = null;
let base = '';

async function pedir(metodo, ruta) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };
      req.log = { info() {}, warn() {}, error: (o) => logs.push(o) };
      next();
    });
    app.use('/api', festivosRouter);
    app.get('/x/negocio', (_req, res) => {
      responderError(res, Object.assign(new Error('Importe debe ser mayor que 0'), { status: 400 }), { mensaje: 'Error' });
    });
    app.get('/x/conflicto', (_req, res) => {
      responderError(res, Object.assign(new Error('La factura ha cambiado, vuelve a intentarlo'), { status: 409, code: 'FACTURA_CAMBIADA' }));
    });
    app.get('/x/aws', (_req, res) => responderError(res, errorAws(), { mensaje: 'Error al guardar' }));
    app.get('/x/aws-400-por-defecto', (_req, res) => responderError(res, errorAws('ValidationException'), { statusPorDefecto: 400 }));
    app.get('/x/validacion-sin-status', (_req, res) => responderError(res, new Error('nombre es obligatorio'), { statusPorDefecto: 400 }));
    app.get('/x/red', (_req, res) => {
      responderError(res, Object.assign(new Error('connect ECONNREFUSED 10.0.3.7:443'), { code: 'ECONNREFUSED', syscall: 'connect' }), { statusPorDefecto: 400 });
    });
    app.get('/x/agora-400', (_req, res) => {
      responderError(res, Object.assign(new Error('Ágora 400: {"Token":"abc","Detail":"Serie X"}'), { agoraStatus: 400 }), { mensaje: 'Error' });
    });
    app.get('/x/expuesto', (_req, res) => {
      responderError(res, Object.assign(new Error('Falló el envío a Ágora para todos los proveedores (2)'), { status: 502, expose: true }));
    });
    app.get('/x/4xx-tras-cabeceras', (_req, res) => {
      res.status(200).write('parcial');
      responderError(res, Object.assign(new Error('Importe debe ser mayor que 0'), { status: 400 }));
      res.end();
    });
    app.get('/x/throw', () => { throw errorAws(); });
    app.get('/x/throw-aws-404', () => { throw errorAws('ResourceNotFoundException'); });
    app.get('/x/throw-500-status', () => { throw Object.assign(new Error(`fallo en ${ARN}`), { status: 503 }); });
    app.use(errorHandler);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, { method: metodo });
  const texto = await res.text();
  let body = {};
  try { body = JSON.parse(texto); } catch { /* texto plano */ }
  return { status: res.status, body, texto };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function sinFuga(r) {
  assert.ok(!r.texto.includes('arn:aws'), `la respuesta lleva el ARN: ${r.texto}`);
  assert.ok(!r.texto.includes('Igp_'), `la respuesta lleva el nombre de tabla: ${r.texto}`);
  assert.ok(!r.texto.includes('123456789012'), 'la respuesta lleva la cuenta de AWS');
}

test('ruta real: un Scan que falla con ARN responde 500 genérico y el detalle va al log', async () => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.gestionFestivos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.interceptar('ScanCommand', tables.gestionFestivos, () => { throw errorAws(); });
  logs.length = 0;
  const r = await pedir('GET', '/api/gestion-festivos');
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'Error al listar');
  assert.match(r.body.errorId, /^[0-9a-f]{12}$/);
  sinFuga(r);
  const log = logs.find((l) => l.errorId === r.body.errorId);
  assert.ok(log, 'el error queda en el log con su errorId');
  assert.ok(log.err.message.includes(ARN), 'el log conserva el mensaje completo');
});

test('helper: 4xx de negocio conserva mensaje, status y code', async () => {
  const r = await pedir('GET', '/x/negocio');
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Importe debe ser mayor que 0' });
  const c = await pedir('GET', '/x/conflicto');
  assert.equal(c.status, 409);
  assert.deepEqual(c.body, { error: 'La factura ha cambiado, vuelve a intentarlo', code: 'FACTURA_CAMBIADA' });
});

test('helper: un 4xx con las cabeceras ya enviadas no intenta responder otra vez', async () => {
  const r = await pedir('GET', '/x/4xx-tras-cabeceras');
  assert.equal(r.status, 200);
  assert.equal(r.texto, 'parcial');
});

test('helper: error de AWS → 500 con el mensaje de la ruta, sin ARN', async () => {
  const r = await pedir('GET', '/x/aws');
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'Error al guardar');
  sinFuga(r);
});

test('helper: statusPorDefecto 400 solo conserva validaciones propias, no AWS ni red', async () => {
  const v = await pedir('GET', '/x/validacion-sin-status');
  assert.equal(v.status, 400);
  assert.equal(v.body.error, 'nombre es obligatorio');
  const aws = await pedir('GET', '/x/aws-400-por-defecto');
  assert.equal(aws.status, 500);
  sinFuga(aws);
  const red = await pedir('GET', '/x/red');
  assert.equal(red.status, 500);
  assert.ok(!red.texto.includes('10.0.3.7'), 'no sale la IP interna');
});

test('helper: Ágora 4xx → 502 "Ágora rechazó la operación" sin su respuesta', async () => {
  const r = await pedir('GET', '/x/agora-400');
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'Ágora rechazó la operación');
  assert.ok(!r.texto.includes('Token'));
});

test('helper: un 5xx redactado por nosotros con expose:true sí se publica', async () => {
  const r = await pedir('GET', '/x/expuesto');
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'Falló el envío a Ágora para todos los proveedores (2)');
});

test('errorHandler: error no controlado y 5xx con status, genéricos también fuera de producción', async () => {
  assert.notEqual(process.env.NODE_ENV, 'production');
  const r = await pedir('GET', '/x/throw');
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'Error interno del servidor');
  sinFuga(r);
  const s = await pedir('GET', '/x/throw-500-status');
  assert.equal(s.status, 503);
  sinFuga(s);
  const nf = await pedir('GET', '/x/throw-aws-404');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error, 'Error de servicio externo');
  sinFuga(nf);
});

test('mensajeSeguro: para listas de errores dentro de respuestas 200', () => {
  assert.equal(mensajeSeguro(errorAws(), 'No se pudo actualizar'), 'No se pudo actualizar');
  assert.equal(mensajeSeguro(Object.assign(new Error('Factura no encontrada'), { status: 404 })), 'Factura no encontrada');
});
