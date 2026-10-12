/**
 * Los recordatorios salen de Estado-Fecha (vencida) y el tipo OUT se filtra
 * después. Una vencida de gasto, una sin gsi y una sin saldo no se envían.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-recordatorios-por-indice';
process.env.SMTP_USER = 'smtp@grupo.test';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { establecerTransporteEmail } = await import('../lib/email.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const enviados = [];
establecerTransporteEmail({ sendMail: async (m) => { enviados.push(m); return {}; } });

const db = montarEscenario({ paginaTam: 2 });

function vencida(id, extra) {
  return aplicarClavesFactura({
    id_factura: id,
    tipo: 'OUT',
    estado: 'vencida',
    emisor_id: '000001',
    fecha_emision: '2026-04-01',
    numero_factura: id,
    empresa_email: `${id}@cliente.test`,
    saldo_pendiente: 10,
    ...extra,
  });
}

db.sembrar(tables.facturas, vencida('R-1', { fecha_emision: '2026-01-01' }));
db.sembrar(tables.facturas, vencida('R-2', { fecha_emision: '2026-02-01' }));
db.sembrar(tables.facturas, vencida('R-3', { fecha_emision: '2026-03-01' }));
db.sembrar(tables.facturas, vencida('R-IN', { tipo: 'IN' }));
db.sembrar(tables.facturas, vencida('R-CERO', { saldo_pendiente: 0 }));
db.sembrar(tables.facturas, {
  id_factura: 'R-SIN', tipo: 'OUT', estado: 'vencida', emisor_id: '000001',
  fecha_emision: '2026-04-02', numero_factura: 'R-SIN', empresa_email: 'sin@cliente.test', saldo_pendiente: 10,
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
  establecerTransporteEmail(null);
  servidor.closeAllConnections?.();
  servidor.close();
});

test('recordatorios: solo OUT vencidas del índice, con saldo y email', async () => {
  const res = await fetch(`http://127.0.0.1:${servidor.address().port}/api/facturacion/enviar-recordatorios`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.vencidas, 3);
  assert.equal(body.enviados, 3);
  const asuntos = enviados.map((m) => m.subject).sort();
  assert.deepEqual(asuntos, ['Recordatorio: Factura R-1 pendiente de pago', 'Recordatorio: Factura R-2 pendiente de pago', 'Recordatorio: Factura R-3 pendiente de pago']);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'R-IN' }).ultimo_recordatorio, undefined);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'R-SIN' }).ultimo_recordatorio, undefined);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'R-CERO' }).ultimo_recordatorio, undefined);
});
