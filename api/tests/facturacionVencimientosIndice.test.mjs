/**
 * check-vencimientos lee Estado-Fecha (gsi_fecha <= hoy). Una factura vencida
 * de verdad entra; la de otro estado, la de fecha de índice futura y la que
 * no tiene gsi_* no se marcan.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-vencimientos-por-indice';

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
    fecha_emision: '2026-01-10',
    fecha_vencimiento: '2020-01-01',
    version: 1,
    ...extra,
  });
}

db.sembrar(tables.facturas, factura('V-1', { fecha_emision: '2026-01-01' }));
db.sembrar(tables.facturas, factura('V-2', { estado: 'emitida', tipo: 'OUT', fecha_emision: '2026-02-01' }));
db.sembrar(tables.facturas, factura('V-3', { estado: 'parcialmente_pagada', fecha_emision: '2026-03-01' }));
db.sembrar(tables.facturas, factura('V-4', { fecha_emision: '2026-04-01' }));
db.sembrar(tables.facturas, factura('FUTURA', { fecha_emision: '2099-01-01' }));
db.sembrar(tables.facturas, factura('AL-DIA', { fecha_vencimiento: '2099-01-01' }));
db.sembrar(tables.facturas, factura('PAGADA', { estado: 'pagada' }));
db.sembrar(tables.facturas, {
  id_factura: 'SIN-GSI',
  tipo: 'IN',
  estado: 'pendiente_pago',
  emisor_id: '000001',
  fecha_emision: '2026-01-01',
  fecha_vencimiento: '2020-01-01',
  version: 1,
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
  next();
});
app.use('/api', facturacionRouter);
const servidor = http.createServer(app);
const listo = new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));

after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

test('solo vence las que el índice Estado-Fecha devuelve y siguen en ese estado', async () => {
  await listo;
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const res = await fetch(`${base}/api/facturacion/check-vencimientos`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.actualizadas, 4);
  assert.equal(body.omitidas, 0);
  for (const id of ['V-1', 'V-2', 'V-3', 'V-4']) {
    assert.equal(db.obtener(tables.facturas, { id_factura: id }).estado, 'vencida');
  }
  for (const id of ['FUTURA', 'AL-DIA', 'PAGADA', 'SIN-GSI']) {
    assert.notEqual(db.obtener(tables.facturas, { id_factura: id }).estado, 'vencida');
  }
});
