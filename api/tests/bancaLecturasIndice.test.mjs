/**
 * Cargas bancarias por Listado-Fecha y facturas conciliables por Estado-Fecha.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { aplicarClavesGsi, clavesFicheroBanca } = await import('../lib/clavesIndice.js');
const { listarFicherosCarga } = await import('../lib/banca/store.js');
const { listarFacturasElegibles } = await import('../lib/banca/conciliacion/store.js');

function carga(campos, { sellar = true } = {}) {
  const item = { estado: 'cargado', cuentas: [], ...campos };
  if (sellar) aplicarClavesGsi(item, clavesFicheroBanca(item));
  return item;
}

const db = crearDynamoMemoria();
db.crearTabla(tables.bankFiles, {
  hashKey: 'hashFichero',
  indices: { 'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' } },
}, [
  carga({ hashFichero: 'NUEVA', importadoEn: '2026-10-12T08:00:00.000Z' }),
  carga({ hashFichero: 'VIEJA', importadoEn: '2026-01-02T08:00:00.000Z' }),
  carga({ hashFichero: 'SIN', importadoEn: '2026-10-11T08:00:00.000Z' }, { sellar: false }),
]);
db.crearTabla(tables.facturas, {
  hashKey: 'id_factura',
  indices: { 'Estado-Fecha-index': { hashKey: 'gsi_estado', rangeKey: 'gsi_fecha' } },
}, [
  {
    id_factura: 'F-OK', tipo: 'IN', estado: 'pendiente_pago', gsi_estado: 'pendiente_pago',
    gsi_fecha: '2026-10-01', saldo_pendiente: 10, emisor_id: '000007',
  },
  {
    id_factura: 'F-PAGADA', tipo: 'IN', estado: 'pagada', gsi_estado: 'pagada',
    gsi_fecha: '2026-10-01', saldo_pendiente: 10,
  },
  {
    id_factura: 'F-SIN', tipo: 'IN', estado: 'pendiente_pago', saldo_pendiente: 99,
  },
  {
    id_factura: 'F-OUT', tipo: 'OUT', estado: 'emitida', gsi_estado: 'emitida',
    gsi_fecha: '2026-10-01', saldo_pendiente: 10,
  },
]);
db.instalar(docClient);

test('el listado de cargas usa el índice y respeta el rango', async () => {
  const mes = await listarFicherosCarga({ desde: '2026-10-01', hasta: '2026-10-31' });
  assert.deepEqual(mes.map((f) => f.hashFichero), ['NUEVA']);
  const todas = await listarFicherosCarga({});
  assert.deepEqual(todas.map((f) => f.hashFichero).sort(), ['NUEVA', 'VIEJA']);
});

test('las facturas conciliables salen por estado y no incluyen la que no tiene gsi', async () => {
  const lista = await listarFacturasElegibles('IN');
  assert.deepEqual(lista.map((f) => f.id_factura), ['F-OK']);
  const deSociedad = await listarFacturasElegibles('IN', { empresaId: '7' });
  assert.deepEqual(deSociedad.map((f) => f.id_factura), ['F-OK']);
});
