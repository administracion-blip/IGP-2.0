/**
 * Listado de compras a proveedor por el GSI Mes-Fecha, sin Scan de respaldo.
 * Una línea sin gsi_mes/gsi_fecha no aparece aunque su AlbaranFecha caiga en el rango.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-compras-mes';
delete process.env.AGORA_BASE_URL;
process.env.AGORA_API_BASE_URL = 'http://agora.falso';
process.env.AGORA_API_TOKEN = 'token-de-prueba';

const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  const u = String(url);
  if (!u.startsWith('http://agora.falso')) return fetchReal(url, opciones);
  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { aplicarClavesGsi, clavesComprasProveedor } = await import('../lib/clavesIndice.js');
const { queryComprasPorMesFecha, queryComprasPorProductos, rangoMesEnCurso } = await import('../lib/dynamo/comprasProveedor.js');
const { default: agoraRouter } = await import('../routes/agora.js');

const mes = rangoMesEnCurso();
const fuera = mes.dateFrom.startsWith('2026-01') ? '2026-02-15' : `${mes.dateFrom.slice(0, 4)}-01-15`;

function linea(pk, fecha, { sellar = true } = {}) {
  const item = {
    PK: pk,
    SK: '1',
    AlbaranFecha: fecha,
    AlbaranSerie: 'A',
    AlbaranNumero: pk,
    ProductId: '10',
    Quantity: 2,
  };
  if (sellar) aplicarClavesGsi(item, clavesComprasProveedor(fecha));
  return item;
}

const db = crearDynamoMemoria();
db.crearTabla(tables.comprasProveedor, {
  hashKey: 'PK',
  rangeKey: 'SK',
  indices: {
    'Mes-Fecha-index': { hashKey: 'gsi_mes', rangeKey: 'gsi_fecha' },
    'ProductId-AlbaranFecha-index': { hashKey: 'ProductId', rangeKey: 'AlbaranFecha' },
  },
}, [
  linea('en-mes', mes.dateFrom),
  linea('otro-mes', fuera),
  linea('sin-gsi', mes.dateFrom, { sellar: false }),
]);
db.instalar(docClient);

let servidor;
const app = express();
app.use(express.json());
app.use('/api', agoraRouter);
servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
  globalThis.fetch = fetchReal;
});

async function get(ruta) {
  const res = await fetchReal(base + ruta);
  return { status: res.status, body: await res.json() };
}

test('el query por mes devuelve solo las líneas del rango con gsi', async () => {
  const items = await queryComprasPorMesFecha(mes.dateFrom, mes.dateTo);
  const pks = items.map((it) => it.PK).sort();
  assert.deepEqual(pks, ['en-mes']);
  assert.equal(items[0].gsi_mes, mes.dateFrom.slice(0, 7));
  assert.equal(items[0].gsi_fecha, mes.dateFrom);
});

test('por producto usa el GSI y no suma la línea sin clave de índice', async () => {
  const sinIndice = {
    PK: 'otro-producto-sin-fecha',
    SK: '1',
    ProductId: '99',
    Quantity: 7,
  };
  db.sembrar(tables.comprasProveedor, sinIndice);
  const sumas = await queryComprasPorProductos(new Set(['10', '99']), mes.dateFrom, mes.dateTo);
  assert.equal(sumas['10'], 4);
  assert.equal(sumas['99'], 0);
});

test('GET /agora/purchases sin fechas responde el mes en curso', async () => {
  const { status, body } = await get('/api/agora/purchases');
  assert.equal(status, 200);
  assert.equal(body.dateFrom, mes.dateFrom);
  assert.equal(body.dateTo, mes.dateTo);
  assert.equal(body.all, false);
  assert.deepEqual(body.items.map((it) => it.PK), ['en-mes']);
});

test('GET /agora/purchases?all=1 ya no recorre la tabla', async () => {
  const { status, body } = await get('/api/agora/purchases?all=1');
  assert.equal(status, 400);
  assert.match(body.error, /dateFrom/);
});

test('GET /agora/purchases con rango devuelve el otro mes y lo declara', async () => {
  const { status, body } = await get(`/api/agora/purchases?dateFrom=${fuera}&dateTo=${fuera}`);
  assert.equal(status, 200);
  assert.equal(body.dateFrom, fuera);
  assert.equal(body.dateTo, fuera);
  assert.deepEqual(body.items.map((it) => it.PK), ['otro-mes']);
});
