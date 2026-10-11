/**
 * Adjuntos de factura: dos subidas (o una subida y un borrado) a la vez ya no
 * pierden ninguna. La lista se guarda condicionada a la versión leída y, si otra
 * escritura se adelantó, se relee y se vuelve a aplicar sobre la lista nueva.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-adjuntos';
if (!process.env.AWS_ACCESS_KEY_ID) {
  process.env.AWS_ACCESS_KEY_ID = 'clave-de-prueba';
  process.env.AWS_SECRET_ACCESS_KEY = 'secreto-de-prueba';
}

const { S3Client } = await import('@aws-sdk/client-s3');
const { montarEscenario, tables, EMPRESA_NORTE } = await import('./escenarioFacturacion.mjs');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };

const s3Ops = [];
const s3SendOriginal = S3Client.prototype.send;
S3Client.prototype.send = async (cmd) => {
  s3Ops.push({ tipo: cmd.constructor.name, key: cmd.input.Key });
  return {};
};

let db;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = ADMIN;
  next();
});
app.use('/api', facturacionRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

async function subir(nombre) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), nombre);
  const res = await fetch(`${base}/api/facturacion/facturas/F-1/adjuntos`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function borrar(adjId) {
  const res = await fetch(`${base}/api/facturacion/facturas/F-1/adjuntos/${adjId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const factura = () => db.obtener(tables.facturas, { id_factura: 'F-1' });
const nombres = () => (factura().adjuntos || []).map((a) => a.nombre).sort();

beforeEach(() => {
  s3Ops.length = 0;
  db = montarEscenario();
  db.sembrar(tables.facturas, { id_factura: 'F-1', tipo: 'IN', emisor_id: EMPRESA_NORTE, estado: 'pendiente_pago', version: 2 });
});

after(() => {
  S3Client.prototype.send = s3SendOriginal;
  servidor.closeAllConnections?.();
  servidor.close();
});

test('otra subida se cuela entre la lectura y la escritura: se guardan las dos', async () => {
  let segunda;
  db.interceptar('UpdateCommand', tables.facturas, async () => { segunda = await subir('b.png'); });
  const primera = await subir('a.png');
  assert.equal(primera.status, 200, JSON.stringify(primera.body));
  assert.equal(segunda.status, 200, JSON.stringify(segunda.body));
  assert.deepEqual(nombres(), ['a.png', 'b.png']);
  assert.deepEqual(primera.body.adjuntos.map((a) => a.nombre).sort(), ['a.png', 'b.png']);
  assert.equal(factura().version, 4);
  assert.equal(s3Ops.filter((o) => o.tipo === 'DeleteObjectCommand').length, 0);
});

test('dos subidas lanzadas a la vez: ninguna se pierde', async () => {
  const rs = await Promise.all(['a.png', 'b.png', 'c.png'].map(subir));
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(nombres(), ['a.png', 'b.png', 'c.png']);
});

test('una subida mientras se borra otro adjunto: el borrado relee y no se lleva la nueva', async () => {
  db.sembrar(tables.facturas, {
    ...factura(),
    adjuntos: [{ id: 'viejo', fileKey: 'facturas/F-1/viejo.png', nombre: 'viejo.png' }],
  });
  db.interceptar('UpdateCommand', tables.facturas, async () => { await subir('nuevo.png'); });
  const r = await borrar('viejo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(nombres(), ['nuevo.png']);
  assert.ok(s3Ops.some((o) => o.tipo === 'DeleteObjectCommand' && o.key === 'facturas/F-1/viejo.png'));
});

test('borrar un adjunto que ya no está: 404 y no se toca S3', async () => {
  const r = await borrar('no-existe');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Adjunto no encontrado');
  assert.equal(s3Ops.length, 0);
});

test('factura sin version (antigua): la subida funciona y le pone una', async () => {
  const { version: _v, ...sinVersion } = factura();
  db.sembrar(tables.facturas, sinVersion);
  const r = await subir('a.png');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(nombres(), ['a.png']);
  assert.equal(factura().version, 2);
});

test('si la lista no se puede guardar (factura cambiando sin parar): 409 y el fichero subido se borra de S3', async () => {
  const { docClient } = await import('../lib/db.js');
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name === 'UpdateCommand' && cmd.input.TableName === tables.facturas) {
      db.sembrar(tables.facturas, { ...factura(), version: factura().version + 1 });
    }
    return enviar.call(docClient, cmd);
  };
  let r;
  try {
    r = await subir('a.png');
  } finally {
    docClient.send = enviar;
  }
  assert.equal(r.status, 409);
  assert.equal(factura().adjuntos, undefined);
  const subido = s3Ops.find((o) => o.tipo === 'PutObjectCommand');
  assert.ok(s3Ops.some((o) => o.tipo === 'DeleteObjectCommand' && o.key === subido.key));
});
