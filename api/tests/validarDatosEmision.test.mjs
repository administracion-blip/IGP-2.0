/**
 * Pruebas del signo en la validación previa a la emisión.
 *
 * Abrir la puerta a los abonos no puede debilitar la protección de las facturas
 * normales, y tampoco puede romper lo que ya entraba: en la base hay facturas de
 * gasto con total negativo (abonos de proveedor que llegan por la revisión de
 * OCR) y esas tienen que seguir validándose.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { validarDatosEmision, esDocumentoDeAbono } = await import('../lib/facturacion/emitirFactura.js');

const LINEAS = [{ id_linea: 'L001', descripcion: 'Concepto', cantidad: 1 }];

function venta(extra = {}) {
  return {
    tipo: 'OUT',
    serie: 'FV',
    empresa_nombre: 'Cliente',
    empresa_cif: 'B00000000',
    fecha_emision: '2026-06-30',
    total_factura: 100,
    ...extra,
  };
}

function gasto(extra = {}) {
  return {
    tipo: 'IN',
    emisor_nombre: 'Sociedad del grupo',
    emisor_cif: 'B11111111',
    empresa_nombre: 'Proveedor',
    empresa_cif: 'B22222222',
    fecha_emision: '2026-06-30',
    total_factura: 100,
    ...extra,
  };
}

test('una factura de venta normal en positivo sigue siendo válida', () => {
  assert.deepEqual(validarDatosEmision(venta(), LINEAS), []);
});

test('una factura de venta en negativo se rechaza: es un error de cálculo, no un abono', () => {
  const errores = validarDatosEmision(venta({ total_factura: -100 }), LINEAS);
  assert.equal(errores.length, 1);
  assert.match(errores[0], /no puede tener importe negativo/);
});

test('un abono de venta en negativo es válido', () => {
  assert.deepEqual(validarDatosEmision(venta({ total_factura: -100, es_abono: true }), LINEAS), []);
});

test('un abono en positivo se rechaza: estaría cobrando en vez de abonando', () => {
  const errores = validarDatosEmision(venta({ total_factura: 100, es_abono: true }), LINEAS);
  assert.equal(errores.length, 1);
  assert.match(errores[0], /debe tener importe negativo/);
});

test('un documento a cero se rechaza siempre, sea abono o factura', () => {
  assert.match(validarDatosEmision(venta({ total_factura: 0 }), LINEAS)[0], /importe 0/);
  assert.match(
    validarDatosEmision(venta({ total_factura: 0, es_abono: true }), LINEAS)[0],
    /El abono no puede tener importe 0/
  );
});

test('una factura de gasto con total negativo sigue validándose', () => {
  // Es el caso real de los abonos de proveedor que entran por la revisión de OCR:
  // el signo lo pone el proveedor y no es una decisión nuestra que podamos exigir.
  assert.deepEqual(validarDatosEmision(gasto({ total_factura: -49.22 }), LINEAS), []);
});

test('una factura de gasto a cero se sigue rechazando', () => {
  assert.match(validarDatosEmision(gasto({ total_factura: 0 }), LINEAS)[0], /importe 0/);
});

test('el signo no tapa el resto de las validaciones', () => {
  const errores = validarDatosEmision(
    venta({ total_factura: -100, es_abono: true, empresa_cif: '', fecha_emision: '' }),
    LINEAS
  );
  assert.ok(errores.some((e) => /CIF\/NIF del cliente/.test(e)));
  assert.ok(errores.some((e) => /fecha de emisión/.test(e)));
});

// ─── El camino manual del abono ───

test('una rectificativa en negativo es válida aunque no lleve la marca de abono', () => {
  // Es el camino que ya existía: `POST /facturas/:id/rectificar` crea la copia con
  // `es_rectificativa` y ninguna pantalla sabe marcar `es_abono`. Sin esto, el
  // abono manual se había quedado sin poder emitirse.
  assert.deepEqual(
    validarDatosEmision(venta({ total_factura: -100, es_rectificativa: true }), LINEAS),
    []
  );
});

test('una rectificativa a cero se sigue rechazando', () => {
  assert.match(
    validarDatosEmision(venta({ total_factura: 0, es_rectificativa: true }), LINEAS)[0],
    /El abono no puede tener importe 0/
  );
});

test('una rectificativa en positivo es válida: rectificar al alza existe', () => {
  assert.deepEqual(
    validarDatosEmision(venta({ total_factura: 100, es_rectificativa: true }), LINEAS),
    []
  );
});

test('marcar el abono sigue exigiendo el signo aunque sea rectificativa', () => {
  // `es_abono` es una afirmación del usuario: si dice que devuelve importe, el
  // total no puede ser positivo. La tolerancia de la rectificativa no lo tapa.
  const errores = validarDatosEmision(
    venta({ total_factura: 100, es_abono: true, es_rectificativa: true }),
    LINEAS
  );
  assert.equal(errores.length, 1);
  assert.match(errores[0], /debe tener importe negativo/);
});

test('el mensaje de la venta en negativo dice cómo emitir un abono', () => {
  const errores = validarDatosEmision(venta({ total_factura: -100 }), LINEAS);
  assert.match(errores[0], /márcala como abono/);
  assert.match(errores[0], /rectificativa/);
});

test('esDocumentoDeAbono no da por abono una venta ordinaria', () => {
  assert.equal(esDocumentoDeAbono(venta()), false);
  assert.equal(esDocumentoDeAbono(venta({ es_abono: false, es_rectificativa: false })), false);
  // Un valor de texto no vale: solo el booleano exacto.
  assert.equal(esDocumentoDeAbono(venta({ es_abono: 'true' })), false);
  assert.equal(esDocumentoDeAbono(venta({ es_abono: true })), true);
  assert.equal(esDocumentoDeAbono(venta({ es_rectificativa: true })), true);
});
