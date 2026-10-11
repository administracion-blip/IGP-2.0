/**
 * S-16 en las rutas: editar un pago, editar la factura o anularla mientras entra
 * otro pago ya no pisa el total_cobrado escrito por el otro.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-edicion-concurrente';

const { montarEscenario, tables, local, EMPRESA_NORTE } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const ROL = 'Administracion';
const PERMISOS = ['facturacion.cobrar_pagar', 'facturacion.editar', 'facturacion.anular'];
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };

let db;
let servidor = null;
let base = '';

beforeEach(() => {
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });
  db.sembrar(tables.facturas, {
    id_factura: 'F-1',
    tipo: 'IN',
    emisor_id: EMPRESA_NORTE,
    estado: 'parcialmente_pagada',
    total_factura: 100,
    total_cobrado: 10,
    saldo_pendiente: 90,
    version: 3,
  });
  db.sembrar(tables.facturasPagos, { id_factura: 'F-1', id_pago: 'P001', importe: 10, metodo_pago: 'transferencia', fecha: '2026-10-01' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = NORTE;
      next();
    });
    app.use('/api', facturacionRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const otroPago = () => registrarPagoFactura({ id_factura: 'F-1', fecha: '2026-10-02', importe: 30, metodo_pago: 'transferencia' });
const factura = () => db.obtener(tables.facturas, { id_factura: 'F-1' });

test('editar un pago mientras entra otro: se relee y el total suma el pago editado y el nuevo', async () => {
  db.interceptar('TransactWriteCommand', undefined, otroPago);
  const r = await api('PUT', '/api/facturacion/pagos/F-1/P001', { fecha: '2026-10-01', importe: 15, metodo_pago: 'transferencia' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.listar(tables.facturasPagos).length, 2);
  assert.equal(factura().total_cobrado, 45);
  assert.equal(factura().saldo_pendiente, 55);
});

test('editar las líneas de la factura mientras entra un pago: el saldo se recalcula con el pago nuevo', async () => {
  db.interceptar('PutCommand', tables.facturas, otroPago);
  const r = await api('PUT', '/api/facturacion/facturas/F-1', {
    lineas: [{ descripcion: 'Servicio', cantidad: 1, precio_unitario: 200, tipo_iva: 0 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = factura();
  assert.equal(f.total_factura, 200);
  assert.equal(f.total_cobrado, 40);
  assert.equal(f.saldo_pendiente, 160);
  assert.equal(r.body.factura.total_cobrado, 40);
});

test('anular mientras entra un pago: 409 y el pago no se pierde', async () => {
  db.interceptar('PutCommand', tables.facturas, otroPago);
  const r = await api('POST', '/api/facturacion/facturas/F-1/anular', { motivo: 'error' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'La factura ha cambiado, vuelve a intentarlo');
  assert.equal(factura().estado, 'parcialmente_pagada');
  assert.equal(factura().total_cobrado, 40);
});

test('sin concurrencia, editar pago y anular siguen funcionando y suben la versión', async () => {
  const r = await api('PUT', '/api/facturacion/pagos/F-1/P001', { fecha: '2026-10-01', importe: 20, metodo_pago: 'transferencia' });
  assert.equal(r.status, 200);
  assert.equal(factura().total_cobrado, 20);
  assert.equal(factura().version, 4);
  const a = await api('POST', '/api/facturacion/facturas/F-1/anular', { motivo: 'error' });
  assert.equal(a.status, 200);
  assert.equal(factura().estado, 'anulada');
  assert.equal(factura().version, 5);
});
