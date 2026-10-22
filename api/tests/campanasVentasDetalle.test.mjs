/**
 * `GET /campanas/:id/ventas-detalle`: el coste por producto se lee en un solo
 * BatchGet; un producto que no está en el maestro cuesta 0, como antes.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-campanas';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { default: campanasRouter } = await import('../routes/campanas.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };

let servidor = null;
let base = '';

async function api(ruta) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = ADMIN;
      next();
    });
    app.use('/api', campanasRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function venta(localId, fecha, productId, unidades) {
  return {
    PK: `LOCAL#${localId}`,
    SK: `DIA#${fecha}#PROD#${productId}#USER#7`,
    Fecha: fecha,
    ProductId: productId,
    ProductName: `Producto ${productId}`,
    AgoraUserId: '7',
    UserName: 'Camarero',
    Unidades: unidades,
    ImporteBruto: unidades * 5,
  };
}

test('ventas-detalle: coste en un lote, el producto sin maestro cuesta 0', async () => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.campanas, { hashKey: 'campanaId' });
  db.crearTabla(tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ventasProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.campanas, {
    campanaId: 'C1',
    locales: ['000010'],
    productos: [{ productId: '101' }, { productId: '102' }, { productId: '103' }],
    fechaInicio: '2026-10-01',
    fechaFin: '2026-10-31',
    tipoIncentivo: 'pct_coste',
    valorIncentivo: 10,
  });
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: '101', CostPrice: 2 });
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: '102', CostPrice: 'no-numero' });
  db.sembrar(tables.ventasProducto, venta('000010', '2026-10-05', '101', 10));
  db.sembrar(tables.ventasProducto, venta('000010', '2026-10-06', '102', 10));
  db.sembrar(tables.ventasProducto, venta('000010', '2026-10-07', '103', 10));

  const r = await api('/api/campanas/C1/ventas-detalle');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const lecturas = db.operaciones.filter((o) => o.tipo === 'BatchGetCommand');
  assert.deepEqual(lecturas.map((o) => o.claves), [3]);
  assert.equal(db.operaciones.filter((o) => o.tipo === 'GetCommand' && o.tabla === tables.agoraProducts).length, 0);

  const [local] = r.body.porLocal;
  const incentivoPorProducto = Object.fromEntries(local.porUsuario[0].lineas.map((l) => [l.productId, l.incentivo]));
  // pct_coste 10 % → 0,10 · uds · coste.
  assert.deepEqual(incentivoPorProducto, { 101: 2, 102: 0, 103: 0 });
  assert.equal(local.totalIncentivo, 2);
});
