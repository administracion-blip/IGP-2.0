/**
 * Ciclo sobrepago / exceso: helpers, registrar con permitirSobrepago y aplicar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const {
  excesoBruto,
  recalcularExcesoPendiente,
  facturaTieneExceso,
  excesoPendienteEfectivo,
  filtrarFacturasConExceso,
  aplicarExcesoPago,
  METODO_PAGO_APLICACION_EXCESO,
} = await import('../lib/facturacion/excesoPago.js');
const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
const { eliminarPagoFactura } = await import('../lib/facturacion/eliminarPago.js');

function escenarioPagos() {
  const db = montarEscenario();
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  return db;
}

function sembrarFactura(db, id, extra = {}) {
  db.sembrar(tables.facturas, {
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    total_factura: 100,
    total_cobrado: 0,
    saldo_pendiente: 100,
    emisor_id: '000001',
    emisor_cif: 'B000001000',
    empresa_id: '000010',
    empresa_cif: 'B000010000',
    empresa_nombre: 'Proveedor Test',
    emisor_nombre: 'Sociedad Test',
    numero_factura_proveedor: id,
    fecha_emision: '2026-08-01',
    ...extra,
  });
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ─── Helpers puros ───

test('excesoBruto / recalcularExcesoPendiente / facturaTieneExceso', () => {
  assert.equal(excesoBruto({ total_factura: 100, total_cobrado: 120 }), 20);
  assert.equal(excesoBruto({ total_factura: 100, total_cobrado: 80 }), 0);
  assert.equal(excesoBruto({ total_factura: 100, total_cobrado: 100 }), 0);

  const f = { total_factura: 50, total_cobrado: 75 };
  assert.equal(recalcularExcesoPendiente(f), 25);
  assert.equal(f.exceso_pendiente, 25);
  assert.equal(facturaTieneExceso(f), true);

  // Backfill: sin campo pero cobrado de más
  assert.equal(excesoPendienteEfectivo({ total_factura: 10, total_cobrado: 15 }), 5);
  assert.equal(facturaTieneExceso({ total_factura: 10, total_cobrado: 15 }), true);
});

test('excesoPendienteEfectivo no oculta crédito si el campo está stale a 0', () => {
  assert.equal(
    excesoPendienteEfectivo({ total_factura: 100, total_cobrado: 130, exceso_pendiente: 0 }),
    30,
  );
  assert.equal(
    facturaTieneExceso({ total_factura: 100, total_cobrado: 130, exceso_pendiente: 0 }),
    true,
  );
  // Campo stale alto no inventa crédito si cobrado ya no lo justifica
  assert.equal(
    excesoPendienteEfectivo({ total_factura: 100, total_cobrado: 100, exceso_pendiente: 25 }),
    0,
  );
});

test('filtrarFacturasConExceso exige mismo par y exceso > 0', () => {
  const destino = {
    id_factura: 'FAC-DEST',
    tipo: 'IN',
    emisor_cif: 'B000001000',
    empresa_cif: 'B000010000',
  };
  const ok = {
    id_factura: 'FAC-EXC',
    tipo: 'IN',
    estado: 'pagada',
    total_factura: 100,
    total_cobrado: 130,
    exceso_pendiente: 30,
    emisor_cif: 'B000001000',
    empresa_cif: 'B000010000',
  };
  const otroProveedor = {
    ...ok,
    id_factura: 'FAC-OTRO',
    empresa_cif: 'B999999000',
  };
  const sinExceso = {
    ...ok,
    id_factura: 'FAC-CERO',
    total_cobrado: 100,
    exceso_pendiente: 0,
  };
  // Campo stale a 0 pero cobrado de más → sigue siendo candidata
  const staleCero = {
    ...ok,
    id_factura: 'FAC-STALE',
    total_cobrado: 120,
    exceso_pendiente: 0,
  };

  const filtradas = filtrarFacturasConExceso(destino, [ok, otroProveedor, sinExceso, staleCero, destino]);
  assert.deepEqual(
    filtradas.map((f) => f.id_factura).sort(),
    ['FAC-EXC', 'FAC-STALE'],
  );
});

// ─── Persistencia al pagar ───

test('sobrepago con permitirSobrepago persiste exceso_pendiente; sin flag se bloquea', async () => {
  const db = escenarioPagos();
  sembrarFactura(db, 'FAC-SOBRE', { total_factura: 100, saldo_pendiente: 100 });

  await assert.rejects(
    () =>
      registrarPagoFactura({
        id_factura: 'FAC-SOBRE',
        fecha: '2026-08-25',
        importe: 120,
        metodo_pago: 'transferencia',
        usuario_id: 'U-1',
      }),
    (err) => err.status === 400 && /supera el pendiente/i.test(err.message),
  );

  const r = await registrarPagoFactura({
    id_factura: 'FAC-SOBRE',
    fecha: '2026-08-25',
    importe: 120,
    metodo_pago: 'transferencia',
    usuario_id: 'U-1',
    permitirSobrepago: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.factura.estado, 'pagada');
  assert.equal(r.factura.total_cobrado, 120);
  assert.equal(r.factura.saldo_pendiente, 0);
  assert.equal(r.factura.exceso_pendiente, 20);

  const guardada = db.obtener(tables.facturas, { id_factura: 'FAC-SOBRE' });
  assert.equal(guardada.exceso_pendiente, 20);
});

test('eliminar pago recalcula exceso_pendiente; bloquea aplicacion_exceso', async () => {
  const db = escenarioPagos();
  sembrarFactura(db, 'FAC-DEL', { total_factura: 100, saldo_pendiente: 100 });

  await registrarPagoFactura({
    id_factura: 'FAC-DEL',
    fecha: '2026-08-25',
    importe: 150,
    metodo_pago: 'efectivo',
    permitirSobrepago: true,
  });
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-DEL' }).exceso_pendiente, 50);

  await eliminarPagoFactura({ id_factura: 'FAC-DEL', id_pago: 'P001', usuario_id: 'U-1' });
  const trasBorrar = db.obtener(tables.facturas, { id_factura: 'FAC-DEL' });
  assert.equal(trasBorrar.total_cobrado, 0);
  assert.equal(trasBorrar.exceso_pendiente, 0);
  assert.equal(trasBorrar.estado, 'pendiente_pago');

  db.sembrar(tables.facturasPagos, {
    id_factura: 'FAC-DEL',
    id_pago: 'P099',
    importe: 10,
    metodo_pago: METODO_PAGO_APLICACION_EXCESO,
  });
  sembrarFactura(db, 'FAC-DEL', {
    total_factura: 100,
    total_cobrado: 100,
    saldo_pendiente: 0,
    estado: 'pagada',
    exceso_pendiente: 0,
  });
  await assert.rejects(
    () => eliminarPagoFactura({ id_factura: 'FAC-DEL', id_pago: 'P099' }),
    (err) => err.status === 400 && err.code === 'PAGO_APLICACION_EXCESO',
  );
});

// ─── Aplicar exceso ───

test('aplicar exceso mueve cobrado de origen a destino', async () => {
  const db = escenarioPagos();
  sembrarFactura(db, 'FAC-ORI', {
    estado: 'pagada',
    total_factura: 100,
    total_cobrado: 130,
    saldo_pendiente: 0,
    exceso_pendiente: 30,
  });
  sembrarFactura(db, 'FAC-DST', {
    estado: 'pendiente_pago',
    total_factura: 80,
    total_cobrado: 0,
    saldo_pendiente: 80,
  });

  const r = await aplicarExcesoPago({
    id_factura: 'FAC-DST',
    id_factura_exceso: 'FAC-ORI',
    importe: 20,
    fecha: '2026-08-25',
    observaciones: 'Prueba',
    usuario_id: 'U-1',
    usuario_nombre: 'Tester',
  });

  assert.equal(r.ok, true);
  assert.equal(r.importe, 20);
  assert.equal(r.factura.total_cobrado, 20);
  assert.equal(r.factura.saldo_pendiente, 60);
  assert.equal(r.factura.estado, 'parcialmente_pagada');
  assert.equal(r.factura.exceso_pendiente, 0);

  assert.equal(r.factura_exceso.total_cobrado, 110);
  assert.equal(r.factura_exceso.exceso_pendiente, 10);
  assert.equal(r.factura_exceso.estado, 'pagada');
  assert.equal(r.factura_exceso.saldo_pendiente, 0);

  const pagoDst = db.obtener(tables.facturasPagos, { id_factura: 'FAC-DST', id_pago: 'P001' });
  const pagoOri = db.obtener(tables.facturasPagos, { id_factura: 'FAC-ORI', id_pago: 'P001' });
  assert.equal(pagoDst.metodo_pago, METODO_PAGO_APLICACION_EXCESO);
  assert.equal(pagoOri.metodo_pago, METODO_PAGO_APLICACION_EXCESO);
  assert.equal(pagoDst.importe, 20);
  assert.equal(pagoOri.importe, 20);
  assert.equal(pagoDst.aplicacion_exceso_grupo_id, pagoOri.aplicacion_exceso_grupo_id);
});

test('tras aplicar exceso, borrar el pago transferencia origen falla', async () => {
  const db = escenarioPagos();
  sembrarFactura(db, 'FAC-ORI-DEL', {
    estado: 'pendiente_pago',
    total_factura: 100,
    total_cobrado: 0,
    saldo_pendiente: 100,
  });
  sembrarFactura(db, 'FAC-DST-DEL', {
    estado: 'pendiente_pago',
    total_factura: 50,
    total_cobrado: 0,
    saldo_pendiente: 50,
  });

  await registrarPagoFactura({
    id_factura: 'FAC-ORI-DEL',
    fecha: '2026-08-25',
    importe: 130,
    metodo_pago: 'transferencia',
    permitirSobrepago: true,
    usuario_id: 'U-1',
  });
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-ORI-DEL' }).exceso_pendiente, 30);

  await aplicarExcesoPago({
    id_factura: 'FAC-DST-DEL',
    id_factura_exceso: 'FAC-ORI-DEL',
    importe: 20,
    fecha: '2026-08-25',
    usuario_id: 'U-1',
  });

  // El pago transferencia original (P001) no se puede borrar: la factura ya
  // tiene aplicaciones de exceso y dejaría crédito huérfano en destino.
  await assert.rejects(
    () => eliminarPagoFactura({ id_factura: 'FAC-ORI-DEL', id_pago: 'P001', usuario_id: 'U-1' }),
    (err) => err.status === 400 && err.code === 'FACTURA_CON_APLICACION_EXCESO',
  );
  // En destino el pago es aplicacion_exceso → bloqueo específico del método
  await assert.rejects(
    () => eliminarPagoFactura({ id_factura: 'FAC-DST-DEL', id_pago: 'P001', usuario_id: 'U-1' }),
    (err) => err.status === 400 && err.code === 'PAGO_APLICACION_EXCESO',
  );
});

test('aplicar exceso concurrente: ConditionExpression evita sobrescritura', async () => {
  const db = escenarioPagos();
  sembrarFactura(db, 'FAC-ORI-RACE', {
    estado: 'pagada',
    total_factura: 100,
    total_cobrado: 140,
    saldo_pendiente: 0,
    exceso_pendiente: 40,
  });
  sembrarFactura(db, 'FAC-DST-RACE', {
    estado: 'pendiente_pago',
    total_factura: 80,
    total_cobrado: 0,
    saldo_pendiente: 80,
  });

  let salto = false;
  // Otro proceso reduce el cobrado del origen entre la lectura y el Put.
  db.interceptar('PutCommand', tables.facturas, () => {
    salto = true;
    const ori = db.obtener(tables.facturas, { id_factura: 'FAC-ORI-RACE' });
    db.sembrar(tables.facturas, {
      ...ori,
      total_cobrado: round2((Number(ori.total_cobrado) || 0) - 10),
      exceso_pendiente: round2(Math.max(0, (Number(ori.exceso_pendiente) || 0) - 10)),
    });
  });

  await assert.rejects(
    () =>
      aplicarExcesoPago({
        id_factura: 'FAC-DST-RACE',
        id_factura_exceso: 'FAC-ORI-RACE',
        importe: 20,
        fecha: '2026-08-25',
      }),
    (err) => err.status === 409 && err.code === 'CONFLICTO_APLICACION_EXCESO',
  );
  assert.ok(salto, 'el gatillo de carrera debió dispararse');
});

test('no aplicar más que el exceso disponible', async () => {
  const db = escenarioPagos();
  sembrarFactura(db, 'FAC-ORI2', {
    estado: 'pagada',
    total_factura: 100,
    total_cobrado: 110,
    saldo_pendiente: 0,
    exceso_pendiente: 10,
  });
  sembrarFactura(db, 'FAC-DST2', {
    estado: 'pendiente_pago',
    total_factura: 50,
    total_cobrado: 0,
    saldo_pendiente: 50,
  });

  await assert.rejects(
    () =>
      aplicarExcesoPago({
        id_factura: 'FAC-DST2',
        id_factura_exceso: 'FAC-ORI2',
        importe: 15,
        fecha: '2026-08-25',
      }),
    (err) => err.status === 400 && /supera el exceso disponible/i.test(err.message),
  );
});

test('par emisor+proveedor distinto → rechazo', async () => {
  const db = escenarioPagos();
  sembrarFactura(db, 'FAC-ORI3', {
    estado: 'pagada',
    total_factura: 100,
    total_cobrado: 130,
    saldo_pendiente: 0,
    exceso_pendiente: 30,
  });
  sembrarFactura(db, 'FAC-DST3', {
    estado: 'pendiente_pago',
    total_factura: 50,
    total_cobrado: 0,
    saldo_pendiente: 50,
    empresa_cif: 'B888888000',
    empresa_id: '000888',
  });

  await assert.rejects(
    () =>
      aplicarExcesoPago({
        id_factura: 'FAC-DST3',
        id_factura_exceso: 'FAC-ORI3',
        importe: 10,
        fecha: '2026-08-25',
      }),
    (err) => err.status === 400 && /no tiene exceso aplicable/i.test(err.message),
  );
});
