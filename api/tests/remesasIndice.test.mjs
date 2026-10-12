/**
 * El listado de remesas lee Listado-Fecha. La remesa activa de una factura lee
 * Activa-index: Ejecutada solo si conserva líneas pendientes.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-remesas-por-indice';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesRemesa } = await import('../lib/facturacion/clavesIndice.js');
const { findRemesaActivaDeFactura } = await import('../lib/remesas/facturaEnRemesa.js');
const { default: remesasRouter } = await import('../routes/remesas.js');

const db = montarEscenario({ paginaTam: 2 });
db.crearTabla(tables.remesas, {
  hashKey: 'remesaId',
  indices: {
    'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
    'Activa-index': { hashKey: 'gsi_activa', rangeKey: 'gsi_fecha' },
  },
});

function remesa(id, extra) {
  return aplicarClavesRemesa({
    remesaId: id,
    nombre: id,
    estado: 'Borrador',
    sociedadId: '000001',
    creadoEn: '2026-05-01T10:00:00.000Z',
    lineas: [{ id_factura: `FAC-${id}` }],
    ...extra,
  });
}

db.sembrar(tables.remesas, remesa('R-1', { creadoEn: '2026-01-01T00:00:00.000Z' }));
db.sembrar(tables.remesas, remesa('R-2', { creadoEn: '2026-03-01T00:00:00.000Z', estado: 'Generada' }));
db.sembrar(tables.remesas, remesa('R-3', { creadoEn: '2026-06-01T00:00:00.000Z', estado: 'Anulada' }));
db.sembrar(tables.remesas, remesa('R-EJ', {
  estado: 'Ejecutada',
  lineas: [{ id_factura: 'FAC-EJ' }],
  lineasPendientesPago: ['FAC-EJ'],
}));
db.sembrar(tables.remesas, remesa('R-CERRADA', {
  estado: 'Ejecutada',
  lineas: [{ id_factura: 'FAC-CERRADA' }],
  lineasPendientesPago: [],
}));
db.sembrar(tables.remesas, {
  remesaId: 'R-SIN', nombre: 'sin indice', estado: 'Borrador', sociedadId: '000001',
  creadoEn: '2026-07-01T00:00:00.000Z', lineas: [{ id_factura: 'FAC-SIN' }],
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
  next();
});
app.use('/api', remesasRouter);
const servidor = http.createServer(app);
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));

after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

test('el listado trae las del índice Listado-Fecha y el filtro de estado sigue en JS', async () => {
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const todas = await fetch(`${base}/api/remesas`).then((r) => r.json());
  assert.deepEqual(todas.items.map((r) => r.remesaId).sort(), ['R-1', 'R-2', 'R-3', 'R-CERRADA', 'R-EJ']);
  const borradores = await fetch(`${base}/api/remesas?estado=Borrador`).then((r) => r.json());
  assert.deepEqual(borradores.items.map((r) => r.remesaId), ['R-1']);
});

test('en remesa activa: borrador y ejecutada con pendientes; no la cerrada ni la sin gsi', async () => {
  assert.equal((await findRemesaActivaDeFactura('FAC-R-1')).remesaId, 'R-1');
  assert.equal((await findRemesaActivaDeFactura('FAC-EJ')).estado, 'Ejecutada');
  assert.equal(await findRemesaActivaDeFactura('FAC-CERRADA'), null);
  assert.equal(await findRemesaActivaDeFactura('FAC-SIN'), null);
  assert.equal(await findRemesaActivaDeFactura('FAC-R-3'), null);
});
