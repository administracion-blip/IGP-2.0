/**
 * El listado de facturas sale de Tipo-Fecha, no de un Scan: una factura del
 * tipo pedido pero sin clave de índice, o fuera del rango, no aparece.
 */

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-el-listado-por-indice';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

let servidor = null;
let base = '';

beforeEach(() => {
  const db = montarEscenario({ paginaTam: 2 });
  db.crearTabla(tables.remesas, {
    hashKey: 'remesaId',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Activa-index': { hashKey: 'gsi_activa', rangeKey: 'gsi_fecha' },
    },
  });
  const dentro = (id, extra) => aplicarClavesFactura({
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    emisor_id: '000001',
    fecha_emision: '2026-03-10',
    numero_factura: id,
    empresa_nombre: 'Proveedor Uno',
    empresa_cif: 'B11111111',
    ...extra,
  });
  db.sembrar(tables.facturas, dentro('F-A'));
  db.sembrar(tables.facturas, dentro('F-B', { fecha_emision: '2026-01-02', numero_factura: 'B-9', empresa_nombre: 'Otra' }));
  db.sembrar(tables.facturas, dentro('F-C', { fecha_emision: '2026-08-01', estado: 'pagada' }));
  db.sembrar(tables.facturas, dentro('F-D', { fecha_emision: '2026-05-20', numero_factura: 'D-1' }));
  db.sembrar(tables.facturas, dentro('F-VIEJA', { fecha_emision: '2024-06-01' }));
  db.sembrar(tables.facturas, aplicarClavesFactura({
    id_factura: 'F-OUT', tipo: 'OUT', estado: 'emitida', emisor_id: '000001', fecha_emision: '2026-03-11',
  }));
  db.sembrar(tables.facturas, {
    id_factura: 'F-SIN-GSI', tipo: 'IN', estado: 'pendiente_pago', emisor_id: '000001', fecha_emision: '2026-03-12',
  });
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(ruta) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
      next();
    });
    app.use('/api', facturacionRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta);
  return { status: res.status, body: await res.json() };
}

test('listado por tipo y rango: solo las del índice, con las fechas aplicadas', async () => {
  const r = await api('/api/facturacion/facturas?tipo=in&fechaDesde=2026-01-01&fechaHasta=2026-06-30');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rango, { desde: '2026-01-01', hasta: '2026-06-30' });
  assert.deepEqual(r.body.facturas.map((f) => f.id_factura), ['F-D', 'F-A', 'F-B']);
});

test('sin fechas el rango es el año en curso hasta hoy, y el filtro de estado queda en JS', async () => {
  const hoy = new Date().toISOString().slice(0, 10);
  const anio = hoy.slice(0, 4);
  const r = await api(`/api/facturacion/facturas?tipo=IN&estado=pagada&busqueda=F-C`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rango.desde, `${anio}-01-01`);
  assert.equal(r.body.rango.hasta, hoy);
  if (anio === '2026' && hoy >= '2026-08-01') {
    assert.deepEqual(r.body.facturas.map((f) => f.id_factura), ['F-C']);
  } else {
    assert.deepEqual(r.body.facturas, []);
  }
});

test('fechas inválidas no disparan una lectura', async () => {
  const r = await api('/api/facturacion/facturas?tipo=IN&fechaDesde=2026-06-01&fechaHasta=2026-01-01');
  assert.equal(r.status, 400);
});
