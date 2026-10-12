/**
 * [SEC S-08] Ataques por sociedad en facturación: un usuario restringido a la
 * sociedad Norte no valida, no vence ni ve pagos/duplicados de la sociedad Sur.
 *
 * Escrituras: bloquean siempre. Lecturas: en modo 'observar' (por defecto)
 * devuelven todo y avisan; con ALCANCE_MODO_LECTURAS=bloquear filtran.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-alcance';

const { montarEscenario, tables, local, EMPRESA_NORTE, EMPRESA_SUR } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const ROL = 'Administracion';
const PERMISOS = ['facturacion.emitir', 'facturacion.cobrar_pagar', 'facturacion.editar', 'facturacion.crear'];
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };

let db;
let servidor = null;
let base = '';
const avisos = [];
const warnOriginal = console.warn;

function factura(id, emisor, extra = {}) {
  return aplicarClavesFactura({
    id_factura: id,
    tipo: 'IN',
    emisor_id: emisor,
    estado: 'pendiente_pago',
    fecha_emision: '2026-01-15',
    ...extra,
  });
}

beforeEach(() => {
  delete process.env.ALCANCE_MODO_LECTURAS;
  avisos.length = 0;
  console.warn = (...args) => {
    if (args[0] === '[alcance] denegaría') avisos.push(args[1]);
    else warnOriginal(...args);
  };
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.locales, local('000020', 'Local Sur', EMPRESA_SUR));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  console.warn = warnOriginal;
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(metodo, ruta, cuerpo, { interno = false, admin = false } = {}) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-test-interno'] === '1') req.isInternal = true;
      else if (req.headers['x-test-admin'] === '1') req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
      else req.user = NORTE;
      next();
    });
    app.use('/api', facturacionRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(interno && { 'x-test-interno': '1' }),
      ...(admin && { 'x-test-admin': '1' }),
    },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('validar-revision: la factura de otra sociedad va a fallidas y no cambia de estado', async () => {
  db.sembrar(tables.facturas, factura('F-SUR', EMPRESA_SUR, { estado: 'pendiente_revision' }));
  db.sembrar(tables.facturas, factura('F-NORTE', EMPRESA_NORTE, { estado: 'pendiente_revision' }));

  const r = await api('POST', '/api/facturacion/facturas/validar-revision', { facturaIds: ['F-SUR', 'F-NORTE'] });
  assert.equal(r.status, 200);
  const sur = r.body.detalleFallidas.find((f) => f.id_factura === 'F-SUR');
  assert.deepEqual(sur, { id_factura: 'F-SUR', motivo: 'Factura no encontrada' });
  assert.equal(db.obtener(tables.facturas, { id_factura: 'F-SUR' }).estado, 'pendiente_revision');
  const norte = r.body.detalleFallidas.find((f) => f.id_factura === 'F-NORTE');
  assert.notEqual(norte?.motivo, 'Factura no encontrada', 'la propia llega a validarse');
  assert.equal(avisos.length, 0, 'una escritura no observa: bloquea');
});

test('check-vencimientos: restringido solo vence las suyas; interno vence todas', async () => {
  db.sembrar(tables.facturas, factura('V-NORTE', EMPRESA_NORTE, { fecha_vencimiento: '2020-01-01' }));
  db.sembrar(tables.facturas, factura('V-SUR', EMPRESA_SUR, { fecha_vencimiento: '2020-01-01' }));

  const r = await api('POST', '/api/facturacion/check-vencimientos');
  assert.equal(r.status, 200);
  assert.equal(r.body.actualizadas, 1);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'V-NORTE' }).estado, 'vencida');
  assert.equal(db.obtener(tables.facturas, { id_factura: 'V-SUR' }).estado, 'pendiente_pago');

  const interno = await api('POST', '/api/facturacion/check-vencimientos', undefined, { interno: true });
  assert.equal(interno.body.actualizadas, 1);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'V-SUR' }).estado, 'vencida');
});

test('enviar-recordatorios: restringido no envía ni marca facturas de otra sociedad', async () => {
  const smtp = process.env.SMTP_USER;
  process.env.SMTP_USER = 'pruebas@grupo.test';
  try {
    db.sembrar(tables.facturas, factura('R-SUR', EMPRESA_SUR, {
      tipo: 'OUT', estado: 'vencida', empresa_email: 'cliente@sur.test', saldo_pendiente: 10,
    }));
    const r = await api('POST', '/api/facturacion/enviar-recordatorios');
    assert.equal(r.status, 200);
    assert.equal(r.body.vencidas, 0);
    assert.equal(db.obtener(tables.facturas, { id_factura: 'R-SUR' }).ultimo_recordatorio, undefined);
  } finally {
    if (smtp === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = smtp;
  }
});

test('editar factura: un restringido no la lleva a una sociedad ajena; a la suya o sin tocar el emisor, sí', async () => {
  db.sembrar(tables.facturas, factura('E-NORTE', EMPRESA_NORTE, { version: 1 }));

  const ajena = await api('PUT', '/api/facturacion/facturas/E-NORTE', { emisor_id: EMPRESA_SUR, observaciones: 'x' });
  assert.equal(ajena.status, 403);
  assert.equal(ajena.body.error, 'No tienes acceso a esa sociedad');
  const tras = db.obtener(tables.facturas, { id_factura: 'E-NORTE' });
  assert.equal(tras.emisor_id, EMPRESA_NORTE);
  assert.equal(tras.observaciones, undefined);

  const vacia = await api('PUT', '/api/facturacion/facturas/E-NORTE', { emisor_id: '' });
  assert.equal(vacia.status, 403);

  const misma = await api('PUT', '/api/facturacion/facturas/E-NORTE', { emisor_id: '2', observaciones: 'y' });
  assert.equal(misma.status, 200, JSON.stringify(misma.body));
  assert.equal(db.obtener(tables.facturas, { id_factura: 'E-NORTE' }).observaciones, 'y');
});

test('editar factura: un administrador sí cambia la sociedad emisora', async () => {
  db.sembrar(tables.facturas, factura('E-NORTE', EMPRESA_NORTE, { version: 1 }));
  const r = await api('PUT', '/api/facturacion/facturas/E-NORTE', { emisor_id: EMPRESA_SUR }, { admin: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.obtener(tables.facturas, { id_factura: 'E-NORTE' }).emisor_id, EMPRESA_SUR);
});

function sembrarPagosYDuplicados() {
  db.sembrar(tables.facturas, factura('P-NORTE', EMPRESA_NORTE));
  db.sembrar(tables.facturas, factura('P-SUR', EMPRESA_SUR));
  db.sembrar(tables.facturasPagos, { id_factura: 'P-NORTE', id_pago: '1', fecha: '2026-01-02', importe: 5 });
  db.sembrar(tables.facturasPagos, { id_factura: 'P-SUR', id_pago: '1', fecha: '2026-01-01', importe: 7 });
  const dup = { empresa_cif: 'B99999999', numero_factura_proveedor: 'A-1', fecha_emision: '2026-02-01' };
  db.sembrar(tables.facturas, factura('D-NORTE', EMPRESA_NORTE, dup));
  db.sembrar(tables.facturas, factura('D-SUR', EMPRESA_SUR, dup));
}

const REF_DUP = { proveedor_cif: 'B99999999', numero_factura_proveedor: 'A-1', fecha_emision: '2026-02-10' };

test('lecturas en modo observar (por defecto): devuelven todo y avisan sin datos sensibles', async () => {
  sembrarPagosYDuplicados();

  const pagos = await api('GET', '/api/facturacion/pagos');
  assert.deepEqual(pagos.body.pagos.map((p) => p.id_factura).sort(), ['P-NORTE', 'P-SUR']);
  assert.deepEqual(avisos, [{ ruta: '/api/facturacion/pagos', usuario: 'u-norte', empresa: EMPRESA_SUR }]);

  avisos.length = 0;
  const dup = await api('POST', '/api/facturacion/check-duplicados', REF_DUP);
  assert.deepEqual(dup.body.duplicados.map((f) => f.id_factura).sort(), ['D-NORTE', 'D-SUR']);
  assert.deepEqual(avisos, [{ ruta: '/api/facturacion/check-duplicados', usuario: 'u-norte', empresa: EMPRESA_SUR }]);
});

test('lecturas en modo bloquear: pagos y duplicados de otra sociedad no salen', async () => {
  process.env.ALCANCE_MODO_LECTURAS = 'bloquear';
  sembrarPagosYDuplicados();

  const pagos = await api('GET', '/api/facturacion/pagos');
  assert.deepEqual(pagos.body.pagos.map((p) => p.id_factura), ['P-NORTE']);

  const dup = await api('POST', '/api/facturacion/check-duplicados', REF_DUP);
  assert.deepEqual(dup.body.duplicados.map((f) => f.id_factura), ['D-NORTE']);
  assert.equal(avisos.length, 0);
});
