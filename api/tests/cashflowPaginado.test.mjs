/**
 * El listado de cashflow ve todos los locales (maestro paginado) y la empresa
 * del local se resuelve aunque el nombre caiga en la última página del Scan.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-cashflow-paginado';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { pkLocal, skFecha, resolveLocalEmpresa } = await import('../lib/cashflow/store.js');
const { default: cashflowRouter } = await import('../routes/cashflow.js');

const db = montarEscenario({ paginaTam: 1 });
db.crearTabla(tables.cashflow, { hashKey: 'PK', rangeKey: 'SK' });

for (const [id, nombre] of [['000001', 'Uno'], ['000002', 'Dos'], ['000003', 'Tres']]) {
  db.sembrar(tables.locales, { id_Locales: id, nombre, empresa: id === '000003' ? 'Ultima SL' : 'Otra' });
}
db.sembrar(tables.empresas, { id_empresa: '000010', Nombre: 'Alfa', Cif: 'A00000001' });
db.sembrar(tables.empresas, { id_empresa: '000011', Nombre: 'Beta', Cif: 'B00000001' });
db.sembrar(tables.empresas, { id_empresa: '000012', Nombre: 'Ultima SL', Cif: 'B99999999' });

function movimiento(localId, id) {
  return {
    PK: pkLocal(localId),
    SK: skFecha('2026-05-02', id),
    movimientoId: id,
    localId,
    fecha: '2026-05-02',
    tipo: 'pago',
    estado: 'Firmado',
    importe: 10,
    creadoEn: '2026-05-02T12:00:00.000Z',
  };
}
db.sembrar(tables.cashflow, movimiento('000001', 'CF-1'));
db.sembrar(tables.cashflow, movimiento('000003', 'CF-3'));
invalidarMaestroLocales();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
  next();
});
app.use('/api', cashflowRouter);
const servidor = http.createServer(app);
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));

after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

test('el listado incluye el movimiento del último local, no solo la primera página', async () => {
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const res = await fetch(`${base}/api/cashflow?dateFrom=2026-05-01&dateTo=2026-05-31`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.movimientos.map((m) => m.movimientoId).sort(), ['CF-1', 'CF-3']);
});

test('resolveLocalEmpresa encuentra la empresa aunque esté en la última página', async () => {
  const resuelto = await resolveLocalEmpresa('000003');
  assert.equal(resuelto.empresaId, '000012');
  assert.equal(resuelto.empresaCif, 'B99999999');
  assert.equal(resuelto.localNombre, 'Tres');
});
