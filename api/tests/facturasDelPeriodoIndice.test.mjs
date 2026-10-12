/**
 * facturasDelPeriodo lee Periodo-index (gsi_periodo exacto). Otro dominio, otro
 * mes o una factura sin la clave no entran en el mapa.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { facturasDelPeriodo } = await import('../lib/facturacion/facturacionPeriodica.js');

test('el periodo de rappel no mezcla mantenimiento, otro mes ni facturas sin gsi', async () => {
  const db = montarEscenario({ paginaTam: 2 });
  const rappel = (id, periodo) => aplicarClavesFactura({
    id_factura: id,
    tipo: 'OUT',
    estado: 'emitida',
    fecha_emision: `${periodo}-15`,
    emisor_id: '000001',
    empresa_id: '000002',
    rappel_periodo: periodo,
    numero_factura: id,
    total_factura: 10,
  });
  db.sembrar(tables.facturas, rappel('R-1', '2026-03'));
  db.sembrar(tables.facturas, rappel('R-2', '2026-03'));
  db.sembrar(tables.facturas, rappel('R-3', '2026-03'));
  db.sembrar(tables.facturas, rappel('R-OTRO', '2026-04'));
  db.sembrar(tables.facturas, aplicarClavesFactura({
    id_factura: 'M-1', tipo: 'OUT', estado: 'emitida', fecha_emision: '2026-03-15',
    emisor_id: '000001', empresa_id: '000002', mantenimiento_periodo: '2026-03', numero_factura: 'M-1',
  }));
  db.sembrar(tables.facturas, {
    id_factura: 'SIN', tipo: 'OUT', estado: 'emitida', fecha_emision: '2026-03-15',
    emisor_id: '000001', empresa_id: '000002', rappel_periodo: '2026-03', numero_factura: 'SIN',
  });

  const mapa = await facturasDelPeriodo({
    campoPeriodo: 'rappel_periodo',
    periodo: '2026-03',
    clave: (f) => `${f.emisor_id}|${f.empresa_id}`,
  });
  const ids = (mapa.get('000001|000002') || []).map((f) => f.id_factura).sort();
  assert.deepEqual(ids, ['R-1', 'R-2', 'R-3']);
  assert.equal(mapa.size, 1);
});
