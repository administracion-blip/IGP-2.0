/**
 * GET /facturacion/pagos lee Listado-Fecha (gsi_listado = PAGO). Un pago sin
 * esas claves no sale, aunque estaría en un Scan.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-pagos-por-indice';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesPago } = await import('../lib/facturacion/clavesIndice.js');
const { INDICE_LISTADO_FECHA } = await import('../lib/facturacion/consultaIndice.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const db = montarEscenario({ paginaTam: 2 });
db.crearTabla(tables.facturasPagos, {
  hashKey: 'id_factura',
  rangeKey: 'id_pago',
  indices: { [INDICE_LISTADO_FECHA]: { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' } },
});
db.sembrar(tables.facturasPagos, aplicarClavesPago({ id_factura: 'F-1', id_pago: 'P1', fecha: '2026-01-01', importe: 1 }));
db.sembrar(tables.facturasPagos, aplicarClavesPago({ id_factura: 'F-1', id_pago: 'P2', fecha: '2026-03-01', importe: 2 }));
db.sembrar(tables.facturasPagos, aplicarClavesPago({ id_factura: 'F-2', id_pago: 'P3', fecha: '2026-02-01', importe: 3 }));
db.sembrar(tables.facturasPagos, { id_factura: 'F-3', id_pago: 'P-VIEJO', fecha: '2026-04-01', importe: 9 });

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

test('el listado de pagos es el del índice, ordenado por fecha', async () => {
  const res = await fetch(`http://127.0.0.1:${servidor.address().port}/api/facturacion/pagos`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.pagos.map((p) => p.id_pago), ['P2', 'P3', 'P1']);
});
