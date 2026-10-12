/**
 * Compensables y excesos leen Proveedor-Fecha (o Emisor-Fecha si no hay CIF).
 * Otra sociedad, otro proveedor o una factura sin gsi no entran.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-el-par-por-indice';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const db = montarEscenario({ paginaTam: 2 });

function factura(id, extra) {
  return aplicarClavesFactura({
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    emisor_id: '000001',
    emisor_cif: 'A11111111',
    empresa_cif: 'B22222222',
    empresa_id: '000077',
    fecha_emision: '2026-03-01',
    saldo_pendiente: 20,
    total_factura: 20,
    total_cobrado: 0,
    ...extra,
  });
}

db.sembrar(tables.facturas, factura('ORIGEN', { saldo_pendiente: 100, total_factura: 100 }));
db.sembrar(tables.facturas, factura('ABONO', { saldo_pendiente: -40, total_factura: -40, total_cobrado: -40, fecha_emision: '2026-01-01' }));
db.sembrar(tables.facturas, factura('ABONO-2', { saldo_pendiente: -15, total_factura: -15, total_cobrado: -15, fecha_emision: '2026-02-01' }));
db.sembrar(tables.facturas, factura('ABONO-3', { saldo_pendiente: -8, total_factura: -8, total_cobrado: -8, fecha_emision: '2026-04-01' }));
db.sembrar(tables.facturas, factura('OTRA-SOCIEDAD', { emisor_id: '000002', emisor_cif: 'A99999999', saldo_pendiente: -30, total_factura: -30 }));
db.sembrar(tables.facturas, factura('OTRO-PROV', { empresa_cif: 'B33333333', saldo_pendiente: -30, total_factura: -30 }));
db.sembrar(tables.facturas, {
  id_factura: 'SIN-GSI', tipo: 'IN', estado: 'pendiente_pago', emisor_id: '000001', emisor_cif: 'A11111111',
  empresa_cif: 'B22222222', fecha_emision: '2026-03-02', saldo_pendiente: -12, total_factura: -12,
});
db.sembrar(tables.facturas, factura('DESTINO', { saldo_pendiente: 50, total_factura: 50 }));
db.sembrar(tables.facturas, factura('CON-EXCESO', { total_factura: 10, total_cobrado: 25, saldo_pendiente: 0, estado: 'pagada' }));
db.sembrar(tables.facturas, factura('ORIGEN-ID', {
  empresa_cif: '', emisor_cif: '', empresa_id: '000050', saldo_pendiente: 80, total_factura: 80,
}));
db.sembrar(tables.facturas, factura('ABONO-ID', {
  empresa_cif: '', emisor_cif: '', empresa_id: '000050', saldo_pendiente: -20, total_factura: -20,
}));
db.sembrar(tables.facturas, factura('OTRO-ID', {
  empresa_cif: '', emisor_cif: '', emisor_id: '000009', empresa_id: '000050', saldo_pendiente: -20, total_factura: -20,
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

async function ids(ruta) {
  const res = await fetch(base + ruta);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.facturas.map((f) => f.id_factura);
}

test('compensables por CIF de proveedor: solo el par, con saldo de signo contrario', async () => {
  assert.deepEqual(await ids('/api/facturacion/facturas/ORIGEN/compensables'), ['ABONO-3', 'ABONO-2', 'ABONO']);
});

test('sin CIF se lee Emisor-Fecha y se filtra el proveedor por id', async () => {
  assert.deepEqual(await ids('/api/facturacion/facturas/ORIGEN-ID/compensables'), ['ABONO-ID']);
});

test('excesos disponibles: solo el mismo par con cobro por encima del total', async () => {
  assert.deepEqual(await ids('/api/facturacion/facturas/DESTINO/excesos-disponibles'), ['CON-EXCESO']);
});
