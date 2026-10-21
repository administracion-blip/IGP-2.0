/**
 * Factura en negativo pagada con «Otro»: el importe salda el abono
 * (resta de lo cobrado) y no deja un exceso falso.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
const { eliminarPagoFactura } = await import('../lib/facturacion/eliminarPago.js');

function escenario(extra = {}) {
  const db = montarEscenario();
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, {
    hashKey: 'remesaId',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Activa-index': { hashKey: 'gsi_activa', rangeKey: 'gsi_fecha' },
    },
  });
  db.sembrar(tables.facturas, {
    id_factura: 'FAC-1',
    tipo: 'IN',
    estado: 'pendiente_pago',
    total_factura: -100,
    total_cobrado: 0,
    saldo_pendiente: -100,
    emisor_id: '000001',
    version: 2,
    ...extra,
  });
  return db;
}

const factura = (db) => db.obtener(tables.facturas, { id_factura: 'FAC-1' });
const pagosDe = (db) => db.listar(tables.facturasPagos).filter((p) => p.id_factura === 'FAC-1');

const pagar = (importe, extra = {}) => registrarPagoFactura({
  id_factura: 'FAC-1',
  fecha: '2026-10-21',
  importe,
  metodo_pago: 'compensado en caja',
  permitirSobrepago: true,
  ...extra,
});

test('Otro en un abono salda el crédito: pagada, saldo 0 y sin exceso', async () => {
  const db = escenario();
  const r = await pagar(100, { saldar_abono: true });
  assert.equal(r.ok, true);
  assert.equal(r.pago.saldar_abono, true);
  assert.equal(r.pago.importe, 100);
  const f = factura(db);
  assert.equal(f.total_cobrado, -100);
  assert.equal(f.saldo_pendiente, 0);
  assert.equal(f.estado, 'pagada');
  assert.equal(f.exceso_pendiente, 0);
});

test('Otro a medias deja el crédito restante con signo y parcialmente pagada', async () => {
  const db = escenario();
  await pagar(40, { saldar_abono: true });
  const f = factura(db);
  assert.equal(f.total_cobrado, -40);
  assert.equal(f.saldo_pendiente, -60);
  assert.equal(f.estado, 'parcialmente_pagada');
  assert.equal(f.exceso_pendiente, 0);
});

test('Otro no puede saldar más crédito del que queda', async () => {
  const db = escenario();
  await assert.rejects(
    () => pagar(120, { saldar_abono: true }),
    (e) => e.status === 400 && /crédito del abono/.test(e.message),
  );
  assert.equal(factura(db).estado, 'pendiente_pago');
  assert.equal(pagosDe(db).length, 0);
});

test('sin la marca de Otro, un abono se cobra como un pago normal', async () => {
  const db = escenario();
  await pagar(100);
  const f = factura(db);
  assert.equal(f.total_cobrado, 100);
  assert.equal(f.exceso_pendiente, 200);
  assert.equal(pagosDe(db)[0].saldar_abono, undefined);
});

test('una factura en positivo ignora saldar_abono', async () => {
  const db = escenario({ total_factura: 80, saldo_pendiente: 80 });
  await pagar(80, { saldar_abono: true });
  const f = factura(db);
  assert.equal(f.total_cobrado, 80);
  assert.equal(f.saldo_pendiente, 0);
  assert.equal(f.estado, 'pagada');
  assert.equal(pagosDe(db)[0].saldar_abono, undefined);
});

test('borrar un cobro normal de un abono deja el crédito con signo', async () => {
  const db = escenario();
  const r = await pagar(100);
  await eliminarPagoFactura({ id_factura: 'FAC-1', id_pago: r.pago.id_pago });
  const f = factura(db);
  assert.equal(f.total_cobrado, 0);
  assert.equal(f.saldo_pendiente, -100);
  assert.equal(f.estado, 'pendiente_pago');
});

test('borrar el saldado devuelve el abono a pendiente, sin exceso', async () => {
  const db = escenario();
  const r = await pagar(100, { saldar_abono: true });
  await eliminarPagoFactura({ id_factura: 'FAC-1', id_pago: r.pago.id_pago });
  const f = factura(db);
  assert.equal(f.total_cobrado, 0);
  assert.equal(f.saldo_pendiente, -100);
  assert.equal(f.estado, 'pendiente_pago');
  assert.equal(f.exceso_pendiente, 0);
  assert.equal(pagosDe(db).length, 0);
});
