/**
 * El listado de pedidos consulta Estado-Fecha (y abonos, Local-Fecha).
 * Un pedido sin gsi no aparece. Sin fechas, el año en curso va en la respuesta.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-pedidos-indice';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesGsi, clavesPedido } = await import('../lib/clavesIndice.js');
const { default: pedidosRouter } = await import('../routes/pedidos.js');

const anio = new Date().toISOString().slice(0, 4);
const anioPrevio = String(Number(anio) - 1);

function pedido(campos, { sellar = true } = {}) {
  const item = { Notas: '', ...campos };
  if (sellar) aplicarClavesGsi(item, clavesPedido(item));
  return item;
}

const db = crearDynamoMemoria();
db.crearTabla(tables.locales, { hashKey: 'id_Locales' }, [
  { id_Locales: '000020', nombre: 'Bar Sur', empresa: 'Sur SL' },
]);
db.crearTabla(tables.pedidos, {
  hashKey: 'Id',
  indices: {
    'Estado-Fecha-index': { hashKey: 'gsi_estado', rangeKey: 'gsi_fecha' },
    'Local-Fecha-index': { hashKey: 'gsi_local', rangeKey: 'gsi_fecha' },
  },
}, [
  pedido({ Id: 'EN-ANIO', LocalId: '000020', Estado: 'Borrador', Fecha: `${anio}-06-10` }),
  pedido({ Id: 'OTRO-ANIO', LocalId: '000020', Estado: 'Completado', Fecha: `${anioPrevio}-03-01`, CompletadoEn: `${anioPrevio}-03-02T10:00:00.000Z` }),
  pedido({ Id: 'SIN-GSI', LocalId: '000020', Estado: 'Borrador', Fecha: `${anio}-06-11` }, { sellar: false }),
  pedido({ Id: 'TRASPASO', LocalId: '000020', Estado: 'Completado', Fecha: `${anio}-04-01`, CompletadoEn: `${anio}-04-02T08:00:00.000Z` }),
]);
db.crearTabla(tables.pedidosLineas, { hashKey: 'PedidoId', rangeKey: 'LineaIndex' }, [
  { PedidoId: 'EN-ANIO', LineaIndex: '0', TotalLinea: 3, TotalRappel: 1, Preparada: true },
  { PedidoId: 'EN-ANIO', LineaIndex: '1', TotalLinea: 4, TotalRappel: 2, Preparada: false },
  { PedidoId: 'SIN-GSI', LineaIndex: '0', TotalLinea: 99, TotalRappel: 50, Preparada: false },
  { PedidoId: 'TRASPASO', LineaIndex: '0', ProductId: 'P1', ProductoNombre: 'Cola', Cantidad: 2, TotalLinea: 8 },
]);
db.instalar(docClient);
invalidarMaestroLocales();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: '000001', rol: 'Administrador' };
  next();
});
app.use('/api', pedidosRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function get(ruta) {
  const res = await fetch(base + ruta);
  return { status: res.status, body: await res.json() };
}

test('sin fechas el listado es el año en curso y suma solo sus líneas', async () => {
  const { status, body } = await get('/api/pedidos');
  assert.equal(status, 200);
  assert.equal(body.desde, `${anio}-01-01`);
  assert.equal(body.hasta, `${anio}-12-31`);
  const ids = body.pedidos.map((p) => p.Id).sort();
  assert.deepEqual(ids, ['EN-ANIO', 'TRASPASO']);
  const enAnio = body.pedidos.find((p) => p.Id === 'EN-ANIO');
  assert.equal(enAnio.TotalAlbaran, 7);
  assert.equal(enAnio.LineasTotal, 2);
  assert.equal(enAnio.LineasPreparadas, 1);
});

test('un rango explícito devuelve el otro año', async () => {
  const { status, body } = await get(`/api/pedidos?desde=${anioPrevio}-01-01&hasta=${anioPrevio}-12-31`);
  assert.equal(status, 200);
  assert.equal(body.desde, `${anioPrevio}-01-01`);
  assert.deepEqual(body.pedidos.map((p) => p.Id), ['OTRO-ANIO']);
});

test('abonos consulta el local de la empresa y no la línea sin índice', async () => {
  const { status, body } = await get(`/api/pedidos/abonos?empresa=Sur%20SL&anio=${anio}&modo=abonos`);
  assert.equal(status, 200);
  assert.deepEqual(body.pedidos.map((p) => p.Id), ['EN-ANIO']);
  assert.equal(body.total, 3);
});

test('el traspaso solo incluye completados del rango', async () => {
  const { status, body } = await get(`/api/pedidos/traspaso-export?desde=${anio}-04-01&hasta=${anio}-04-30`);
  assert.equal(status, 200);
  assert.deepEqual(body.pedidos.map((p) => p.Id), ['TRASPASO']);
  assert.equal(body.totalUnidades, 2);
});
