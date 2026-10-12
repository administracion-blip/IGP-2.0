/**
 * El análisis de variaciones lee compras por Mes-Fecha, no con Scan.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { aplicarClavesGsi, clavesComprasProveedor } = await import('../lib/clavesIndice.js');
const { buildAnalisisComprasVariaciones } = await import('../lib/compras/analisisCompras.js');

function fechaIso(offsetDias) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  return d.toISOString().slice(0, 10);
}

function linea(pk, fecha, importe, { sellar = true } = {}) {
  const item = {
    PK: pk,
    SK: '1',
    AlbaranFecha: fecha,
    SupplierId: 'S1',
    SupplierName: 'Proveedor Uno',
    TotalAmount: importe,
    Quantity: 1,
  };
  if (sellar) aplicarClavesGsi(item, clavesComprasProveedor(fecha));
  return item;
}

const dias = 7;
const db = crearDynamoMemoria();
db.crearTabla(tables.comprasProveedor, {
  hashKey: 'PK',
  rangeKey: 'SK',
  indices: {
    'Mes-Fecha-index': { hashKey: 'gsi_mes', rangeKey: 'gsi_fecha' },
  },
}, [
  linea('actual', fechaIso(-1), 100),
  linea('anterior', fechaIso(-8), 40),
  linea('sin-gsi', fechaIso(-1), 999, { sellar: false }),
  linea('fuera', fechaIso(-20), 500),
]);
db.instalar(docClient);

test('el análisis compara los dos periodos y deja fuera lo que no está en el índice', async () => {
  const r = await buildAnalisisComprasVariaciones({ dias, agrupacion: 'proveedor' });
  assert.equal(r.totales.gastoActual, 100);
  assert.equal(r.totales.gastoAnterior, 40);
  assert.equal(r.totales.lineasActual, 1);
  assert.equal(r.totales.lineasAnterior, 1);
  assert.equal(r.periodoActual.desde, fechaIso(-dias));
  assert.equal(r.periodoActual.hasta, fechaIso(-1));
  assert.equal(r.topGasto[0].nombre, 'Proveedor Uno');
});
