/**
 * check-duplicados lee Proveedor-Fecha con begins_with del año. Otro año, otro
 * CIF o una factura sin gsi no se proponen como duplicado.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-duplicados-por-indice';

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
    empresa_cif: 'B12345678',
    numero_factura_proveedor: 'A-1',
    fecha_emision: '2026-02-01',
    ...extra,
  });
}

db.sembrar(tables.facturas, factura('D-1', { fecha_emision: '2026-01-15' }));
db.sembrar(tables.facturas, factura('D-2', { fecha_emision: '2026-06-01' }));
db.sembrar(tables.facturas, factura('D-3', { fecha_emision: '2026-11-01' }));
db.sembrar(tables.facturas, factura('D-OTRO-ANIO', { fecha_emision: '2025-02-01' }));
db.sembrar(tables.facturas, factura('D-OTRO-CIF', { empresa_cif: 'A87654321' }));
db.sembrar(tables.facturas, {
  id_factura: 'D-SIN', tipo: 'IN', estado: 'pendiente_pago', emisor_id: '000001',
  empresa_cif: 'B12345678', numero_factura_proveedor: 'A-1', fecha_emision: '2026-03-01',
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
  next();
});
app.use('/api', facturacionRouter);
const servidor = http.createServer(app);
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));

after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

test('duplicados: mismo CIF y año del índice, no el resto', async () => {
  const res = await fetch(`http://127.0.0.1:${servidor.address().port}/api/facturacion/check-duplicados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proveedor_cif: 'b-12.345.678',
      numero_factura_proveedor: 'A/1',
      fecha_emision: '2026-08-20',
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.duplicados.map((f) => f.id_factura).sort(), ['D-1', 'D-2', 'D-3']);
});
