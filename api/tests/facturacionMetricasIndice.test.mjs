/**
 * Métricas y cuadro de mando leen Tipo-Fecha (y los pagos, Listado-Fecha)
 * acotados al año o a los meses del gráfico. Lo de fuera del rango no cuenta.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-metricas-por-indice';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesFactura, aplicarClavesPago } = await import('../lib/facturacion/clavesIndice.js');
const { INDICE_LISTADO_FECHA } = await import('../lib/facturacion/consultaIndice.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const db = montarEscenario({ paginaTam: 2 });
db.crearTabla(tables.facturasPagos, {
  hashKey: 'id_factura',
  rangeKey: 'id_pago',
  indices: { [INDICE_LISTADO_FECHA]: { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' } },
});

function factura(id, extra) {
  return aplicarClavesFactura({
    id_factura: id,
    emisor_id: '000001',
    estado: 'emitida',
    total_factura: 10,
    total_cobrado: 0,
    saldo_pendiente: 10,
    ...extra,
  });
}

db.sembrar(tables.facturas, factura('IN-2026', { tipo: 'IN', fecha_emision: '2026-05-01', total_factura: 100, estado: 'pendiente_pago' }));
db.sembrar(tables.facturas, factura('OUT-2026', { tipo: 'OUT', fecha_emision: '2026-05-02', total_factura: 40 }));
db.sembrar(tables.facturas, factura('IN-2020', { tipo: 'IN', fecha_emision: '2020-05-01', total_factura: 999, estado: 'pendiente_pago' }));
db.sembrar(tables.facturas, {
  id_factura: 'IN-SIN', tipo: 'IN', fecha_emision: '2026-05-03', emisor_id: '000001',
  estado: 'pendiente_pago', total_factura: 500,
});
db.sembrar(tables.facturasPagos, aplicarClavesPago({
  id_factura: 'OUT-2026', id_pago: 'P-NUEVO', fecha: '2026-05-03', importe: 15, creado_en: '2026-05-03T10:00:00.000Z',
}));
db.sembrar(tables.facturasPagos, aplicarClavesPago({
  id_factura: 'OUT-2026', id_pago: 'P-VIEJO', fecha: '2020-01-01', importe: 7, creado_en: '2026-05-04T10:00:00.000Z',
}));

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
  next();
});
app.use('/api', facturacionRouter);
const servidor = http.createServer(app);
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${servidor.address().port}`;

after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

test('métricas de un año no mezclan facturas de otro año ni las que no están en el índice', async () => {
  const res = await fetch(`${base}/api/facturacion/metricas?anio=2026`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.metricas.totalGastos, 100);
  assert.equal(body.metricas.totalEmitido, 40);
  assert.equal(body.metricas.countIn, 1);
  assert.equal(body.metricas.countOut, 1);
  const mayo = body.metricas.mensual.find((m) => m.mes === '2026-05');
  assert.equal(mayo.gastos, 100);
  assert.equal(mayo.ingresos, 40);
});

test('el cuadro de mando ignora lo anterior a 24 meses y los pagos fuera de ese rango', async () => {
  const res = await fetch(`${base}/api/facturacion/metricas-avanzadas`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.comparativa.anioActual.gastos, 100);
  assert.equal(body.comparativa.anioActual.ingresos, 40);
  assert.equal(body.comparativa.anioAnterior.gastos, 0);
  assert.deepEqual(body.pagosRecientes.map((p) => p.id_pago), ['P-NUEVO']);
});
