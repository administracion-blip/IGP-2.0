/**
 * Vencimiento por defecto de las facturas de gasto con el plazo del proveedor
 * (`Vencimiento` en igp_Empresas): emisión/validación, registro masivo (OCR),
 * maestro de empresas y script de backfill.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-vencimiento';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { aplicarClavesFactura } = await import('../lib/facturacion/clavesIndice.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');
const { default: empresasRouter } = await import('../routes/empresas.js');
const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
const { docClient } = await import('../lib/db.js');
const { procesarFacturas } = await import('../scripts/backfill-vencimiento-facturas-gasto.mjs');
const { emitirOValidarFacturaPorId } = await import('../lib/facturacion/emitirFactura.js');

const SOCIEDAD = '000001';
const PROVEEDOR = '000050';
const PROVEEDOR_SIN_PLAZO = '000060';

let db;
let servidor = null;
let base = '';

beforeEach(() => {
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.empresas, { id_empresa: SOCIEDAD, Nombre: 'Central', Cif: 'A11111111' });
  db.sembrar(tables.empresas, { id_empresa: PROVEEDOR, Nombre: 'Proveedor', Cif: 'B22222222', Vencimiento: 45 });
  db.sembrar(tables.empresas, { id_empresa: PROVEEDOR_SIN_PLAZO, Nombre: 'Sin plazo', Cif: 'B33333333', Vencimiento: 'según acuerdo' });
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
      req.user = { sub: 'u-admin', email: 'admin@grupo.test', rol: 'Administrador' };
      next();
    });
    app.use('/api', facturacionRouter);
    app.use('/api', empresasRouter);
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

function gasto(id, extra = {}) {
  return aplicarClavesFactura({
    id_factura: id,
    id_entrada: id,
    tipo: 'IN',
    estado: 'pendiente_revision',
    emisor_id: SOCIEDAD,
    emisor_nombre: 'Central',
    empresa_id: PROVEEDOR,
    empresa_nombre: 'Proveedor',
    empresa_cif: 'B22222222',
    fecha_emision: '2026-01-10',
    fecha_vencimiento: '',
    condiciones_pago: '',
    total_factura: 121,
    saldo_pendiente: 121,
    version: 1,
    ...extra,
  });
}

function leer(id) {
  return db.obtener(tables.facturas, { id_factura: id });
}

// ─── Emisión / validación ───

test('validar IN sin vencimiento con condiciones "30 días" → emisión + 30', async () => {
  db.sembrar(tables.facturas, gasto('F1', { condiciones_pago: '30 días' }));
  const r = await api('POST', '/api/facturacion/facturas/validar-revision', { facturaIds: ['F1'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.validadas, 1, JSON.stringify(r.body));
  const f = leer('F1');
  assert.equal(f.estado, 'pendiente_pago');
  assert.equal(f.fecha_vencimiento, '2026-02-09');
  assert.equal(f.condiciones_pago, '30 días');
});

test('emitir borrador IN sin condiciones: usa el Vencimiento del proveedor (45)', async () => {
  db.sembrar(tables.facturas, gasto('F2', { estado: 'borrador' }));
  const r = await api('POST', '/api/facturacion/facturas/F2/emitir');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = leer('F2');
  assert.equal(f.fecha_vencimiento, '2026-02-24');
  assert.equal(f.condiciones_pago, '45 días');
});

test('emitir con vencimiento ya puesto: se respeta', async () => {
  db.sembrar(tables.facturas, gasto('F3', { estado: 'borrador', fecha_vencimiento: '2026-05-01', condiciones_pago: '30 días' }));
  const r = await api('POST', '/api/facturacion/facturas/F3/emitir');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(leer('F3').fecha_vencimiento, '2026-05-01');
});

test('fecha de emisión dd/mm/aaaa no rompe la emisión y calcula bien', async () => {
  db.sembrar(tables.facturas, gasto('F4', { estado: 'borrador', fecha_emision: '10/01/2026', condiciones_pago: '30 días' }));
  const r = await api('POST', '/api/facturacion/facturas/F4/emitir');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(leer('F4').fecha_vencimiento, '2026-02-09');
});

test('condiciones históricas "60_dias" siguen funcionando', async () => {
  db.sembrar(tables.facturas, gasto('F5', { condiciones_pago: '60_dias' }));
  await api('POST', '/api/facturacion/facturas/validar-revision', { facturaIds: ['F5'] });
  assert.equal(leer('F5').fecha_vencimiento, '2026-03-11');
  assert.equal(leer('F5').condiciones_pago, '60_dias', 'no se reescriben las condiciones');
});

test('proveedor sin plazo válido: la factura se valida sin vencimiento', async () => {
  db.sembrar(tables.facturas, gasto('F6', { empresa_id: PROVEEDOR_SIN_PLAZO }));
  const r = await api('POST', '/api/facturacion/facturas/validar-revision', { facturaIds: ['F6'] });
  assert.equal(r.status, 200);
  const f = leer('F6');
  assert.equal(f.estado, 'pendiente_pago');
  assert.equal(f.fecha_vencimiento, '');
  assert.equal(f.condiciones_pago, '');
});

test('validación en tanda: el maestro se lee una vez por proveedor', async () => {
  for (const id of ['T1', 'T2', 'T3']) db.sembrar(tables.facturas, gasto(id));
  const antes = db.operaciones.length;
  await api('POST', '/api/facturacion/facturas/validar-revision', { facturaIds: ['T1', 'T2', 'T3'] });
  const lecturasMaestro = db.operaciones
    .slice(antes)
    .filter((o) => o.tipo === 'GetCommand' && o.tabla === tables.empresas);
  assert.equal(lecturasMaestro.length, 1);
  for (const id of ['T1', 'T2', 'T3']) assert.equal(leer(id).fecha_vencimiento, '2026-02-24');
});

// ─── Emisión de ventas (OUT): sin cambios, solo las claves de siempre ───

function venta(id, extra = {}) {
  db.sembrar(tables.facturasLineas, { id_factura: id, id_linea: 'L1', descripcion: 'Servicio', cantidad: 1 });
  return aplicarClavesFactura({
    ...gasto(id),
    tipo: 'OUT',
    estado: 'borrador',
    serie: 'V',
    numero: 1,
    numero_factura: 'V-0001',
    ...extra,
  });
}

test('emitir venta con "30 días" sin vencimiento: sigue sin vencimiento (ni plazo del maestro)', async () => {
  db.sembrar(tables.facturas, venta('V1', { condiciones_pago: '30 días' }));
  const r = await emitirOValidarFacturaPorId('V1');
  assert.equal(r.ok, true, JSON.stringify(r));
  const f = leer('V1');
  assert.equal(f.estado, 'emitida');
  assert.equal(f.fecha_vencimiento, '');
  assert.equal(f.condiciones_pago, '30 días');
});

test('emitir venta sin condiciones: no toma el Vencimiento del maestro', async () => {
  db.sembrar(tables.facturas, venta('V2'));
  const r = await emitirOValidarFacturaPorId('V2');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(leer('V2').fecha_vencimiento, '');
  assert.equal(leer('V2').condiciones_pago, '');
});

test('emitir venta "contado" → vencimiento = emisión; "30_dias" → +30', async () => {
  db.sembrar(tables.facturas, venta('V3', { condiciones_pago: 'contado' }));
  db.sembrar(tables.facturas, venta('V4', { condiciones_pago: '30_dias' }));
  assert.equal((await emitirOValidarFacturaPorId('V3')).ok, true);
  assert.equal((await emitirOValidarFacturaPorId('V4')).ok, true);
  assert.equal(leer('V3').fecha_vencimiento, '2026-01-10');
  assert.equal(leer('V4').fecha_vencimiento, '2026-02-09');
});

test('emitir venta "30_dias" con fecha de emisión no válida: se emite sin vencimiento', async () => {
  db.sembrar(tables.facturas, venta('V5', { condiciones_pago: '30_dias', fecha_emision: 'sin fecha' }));
  const r = await emitirOValidarFacturaPorId('V5');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(leer('V5').fecha_vencimiento, '');
});

// ─── Registro masivo (OCR) ───

function borrador(extra = {}) {
  return {
    sociedad_grupo_id: SOCIEDAD,
    sociedad_grupo_nombre: 'Central',
    sociedad_grupo_cif: 'A11111111',
    empresa_id: PROVEEDOR,
    proveedor_nombre: 'Proveedor',
    proveedor_cif: 'B22222222',
    fecha_emision: '2026-01-10',
    total_factura: 121,
    base_imponible: 100,
    total_iva: 21,
    ...extra,
  };
}

async function confirmar(b) {
  const r = await api('POST', '/api/facturacion/ocr/confirmar', { borradores: [b] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return leer(r.body.ids[0]);
}

test('registro masivo sin vencimiento: emisión + plazo del maestro y condiciones rellenas', async () => {
  const f = await confirmar(borrador());
  assert.equal(f.estado, 'pendiente_revision');
  assert.equal(f.fecha_vencimiento, '2026-02-24');
  assert.equal(f.condiciones_pago, '45 días');
});

test('registro masivo con vencimiento del documento: manda el documento', async () => {
  const f = await confirmar(borrador({ fecha_vencimiento: '15/03/2026' }));
  assert.equal(f.fecha_vencimiento, '2026-03-15');
  assert.equal(f.condiciones_pago, '');
});

test('registro masivo con fecha dd/mm/aaaa y proveedor con Vencimiento 0 → contado', async () => {
  db.sembrar(tables.empresas, { id_empresa: '000070', Nombre: 'Contado', Cif: 'B44444444', Vencimiento: 0 });
  const f = await confirmar(borrador({ empresa_id: '70', proveedor_cif: 'B44444444', fecha_emision: '10/01/2026' }));
  assert.equal(f.fecha_vencimiento, '2026-01-10');
  assert.equal(f.condiciones_pago, 'contado');
});

// ─── Maestro de empresas ───

function fichaProveedor(extra = {}) {
  return { id_empresa: PROVEEDOR, Nombre: 'Proveedor', Cif: 'B22222222', ...extra };
}

test('PUT empresas con "30 días" guarda el Number 30', async () => {
  const r = await api('PUT', '/api/empresas', fichaProveedor({ Vencimiento: '30 días' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.empresa.Vencimiento, 30);
  assert.equal(db.obtener(tables.empresas, { id_empresa: PROVEEDOR }).Vencimiento, 30);
});

test('PUT empresas con "abc" → 400 y no escribe', async () => {
  const r = await api('PUT', '/api/empresas', fichaProveedor({ Vencimiento: 'abc' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Plazo de vencimiento no válido: indica los días (0 = contado)');
  assert.equal(db.obtener(tables.empresas, { id_empresa: PROVEEDOR }).Vencimiento, 45);
});

test('PUT empresas con Vencimiento vacío quita el atributo', async () => {
  const r = await api('PUT', '/api/empresas', fichaProveedor({ Vencimiento: '' }));
  assert.equal(r.status, 200);
  assert.equal('Vencimiento' in db.obtener(tables.empresas, { id_empresa: PROVEEDOR }), false);
});

test('PUT empresas sin Vencimiento en el cuerpo conserva el existente', async () => {
  const r = await api('PUT', '/api/empresas', fichaProveedor({ Telefono: '600000000' }));
  assert.equal(r.status, 200);
  assert.equal(db.obtener(tables.empresas, { id_empresa: PROVEEDOR }).Vencimiento, 45);
});

test('PUT empresas reenviando un texto antiguo no válido sin cambiarlo: se conserva', async () => {
  const r = await api('PUT', '/api/empresas', {
    id_empresa: PROVEEDOR_SIN_PLAZO, Nombre: 'Sin plazo', Cif: 'B33333333', Vencimiento: 'según acuerdo', Telefono: '1',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.obtener(tables.empresas, { id_empresa: PROVEEDOR_SIN_PLAZO }).Vencimiento, 'según acuerdo');
});

test('POST empresas: 0 = contado se guarda como Number y texto no válido → 400', async () => {
  const ok = await api('POST', '/api/empresas', { id_empresa: '80', Nombre: 'Nueva', Cif: 'B55555555', Vencimiento: 'contado' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(db.obtener(tables.empresas, { id_empresa: '000080' }).Vencimiento, 0);
  const mal = await api('POST', '/api/empresas', { id_empresa: '81', Nombre: 'Mala', Cif: 'B66666666', Vencimiento: 'abc' });
  assert.equal(mal.status, 400);
  assert.equal(db.obtener(tables.empresas, { id_empresa: '000081' }), null);
});

// ─── Script de backfill ───

test('backfill: simula sin escribir y aplica solo donde el vencimiento sigue vacío', async () => {
  db.sembrar(tables.facturas, gasto('B1', { estado: 'pendiente_pago', saldo_pendiente: 100 }));
  // B2 es la primera que se escribe (su estado se recorre antes).
  db.sembrar(tables.facturas, gasto('B2', { estado: 'pendiente_revision', condiciones_pago: '30 días', saldo_pendiente: 50 }));
  db.sembrar(tables.facturas, gasto('B6', { estado: 'parcialmente_pagada', fecha_emision: '2026-02-20', saldo_pendiente: 10 }));
  db.sembrar(tables.facturas, gasto('B3', { estado: 'pendiente_pago', empresa_id: PROVEEDOR_SIN_PLAZO }));
  db.sembrar(tables.facturas, gasto('B4', { estado: 'pendiente_pago', fecha_vencimiento: '2026-09-01' }));
  db.sembrar(tables.facturas, aplicarClavesFactura({ ...gasto('B5'), tipo: 'OUT', estado: 'pendiente_pago' }));

  const simulacion = await procesarFacturas({ docClient, UpdateCommand, aplicar: false, hoy: '2026-03-01' });
  assert.equal(simulacion.stats.sinVencimiento, 4);
  assert.equal(simulacion.stats.conPlazoProveedor, 2);
  assert.equal(simulacion.stats.porCondiciones, 1);
  assert.equal(simulacion.stats.sinPlazo, 1);
  assert.equal(simulacion.stats.actualizadas, 3);
  assert.equal(simulacion.stats.yaVencidas, 2);
  assert.equal(simulacion.stats.saldoYaVencido, 150);
  assert.deepEqual([...simulacion.proveedoresSinPlazo.values()], [1]);
  assert.equal(leer('B1').fecha_vencimiento, '', 'la simulación no escribe');

  // Otro proceso pone el vencimiento de B2 entre la lectura y la escritura.
  db.interceptar('UpdateCommand', tables.facturas, async () => {
    db.sembrar(tables.facturas, { ...leer('B2'), fecha_vencimiento: '2026-12-31' });
  });
  const aplicado = await procesarFacturas({ docClient, UpdateCommand, aplicar: true, hoy: '2026-03-01' });
  assert.equal(aplicado.stats.errores, 0);
  const b1 = leer('B1');
  assert.equal(b1.fecha_vencimiento, '2026-02-24');
  assert.equal(b1.condiciones_pago, '45 días');
  assert.equal(b1.version, 2);
  assert.equal(b1.gsi_estado, 'pendiente_pago');
  assert.equal(aplicado.stats.omitidasPorVencimiento, 1);
  assert.equal(aplicado.stats.omitidasPorEstado, 0);
  assert.equal(aplicado.stats.omitidasPorVersion, 0);
  assert.equal(leer('B2').fecha_vencimiento, '2026-12-31', 'no pisa un vencimiento puesto entretanto');
  assert.equal(leer('B6').fecha_vencimiento, '2026-04-06');
  assert.equal(leer('B3').fecha_vencimiento, '');
  assert.equal(leer('B4').fecha_vencimiento, '2026-09-01');
  assert.equal(leer('B5').fecha_vencimiento, '', 'las ventas no entran');
});

test('backfill: si la factura cambia de estado o de versión entre lectura y escritura, no la toca', async () => {
  // E1 y E2 salen en la misma lectura (pendiente_revision, que se recorre
  // antes); E1 es la primera que se escribe por fecha.
  db.sembrar(tables.facturas, gasto('E1', { estado: 'pendiente_revision' }));
  db.sembrar(tables.facturas, gasto('E2', { estado: 'pendiente_revision', fecha_emision: '2026-01-15' }));
  db.sembrar(tables.facturas, gasto('E3', { estado: 'pendiente_pago', fecha_emision: '2026-01-20' }));

  // Justo antes del primer Update: E1 se paga sin subir versión y a E2 le
  // cambian el proveedor (versión 2), las dos sin vencimiento.
  db.interceptar('UpdateCommand', tables.facturas, async () => {
    db.sembrar(tables.facturas, aplicarClavesFactura({ ...leer('E1'), estado: 'pagada', saldo_pendiente: 0 }));
    db.sembrar(tables.facturas, aplicarClavesFactura({ ...leer('E2'), empresa_cif: 'B99999999', version: 2 }));
  });
  const r = await procesarFacturas({ docClient, UpdateCommand, aplicar: true, hoy: '2026-03-01' });
  assert.equal(r.stats.errores, 0);
  assert.equal(r.stats.actualizadas, 1);
  assert.equal(r.stats.omitidasPorEstado, 1);
  assert.equal(r.stats.omitidasPorVersion, 1);
  assert.equal(r.stats.omitidasPorVencimiento, 0);

  const e1 = leer('E1');
  assert.equal(e1.estado, 'pagada');
  assert.equal(e1.gsi_estado, 'pagada', 'el índice no vuelve al estado leído');
  assert.equal(e1.fecha_vencimiento, '');
  const e2 = leer('E2');
  assert.equal(e2.gsi_proveedor, 'B99999999');
  assert.equal(e2.fecha_vencimiento, '');
  assert.equal(e2.version, 2);
  assert.equal(leer('E3').fecha_vencimiento, '2026-03-06');
});
