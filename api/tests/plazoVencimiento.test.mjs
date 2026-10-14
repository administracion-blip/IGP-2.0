/**
 * Plazo de vencimiento: lectura de los textos de plazo (maestro y
 * `condiciones_pago`) y cálculo de emisión + días.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const {
  parseDiasPlazo,
  condicionesDesdeDias,
  calcularFechaVencimiento,
  vencimientoVentaPorCondiciones,
} = await import('../lib/facturacion/plazoVencimiento.js');

// Tabla común con el front (misma gramática en los dos lados): entrada → días.
const CASOS_PARSE_DIAS_PLAZO = [
  // Number
  [30, 30],
  [0, 0],
  [365, 365],
  [366, null],
  [-1, null],
  [30.5, null],
  [NaN, null],
  [Infinity, null],
  // Contado
  ['contado', 0],
  ['Contado', 0],
  ['al contado', 0],
  [' AL CONTADO ', 0],
  ['al   contado', 0],
  ['contadorX', null],
  ['contado 30 días', null],
  ['al contado 5%', null],
  // '<n>'
  ['0', 0],
  ['30', 30],
  ['030', 30],
  ['365', 365],
  ['366', null],
  ['1000', null],
  ['-30', null],
  ['+30', null],
  ['30.5', null],
  ['30,5', null],
  // '<n>d' y '<n>_dias'
  ['30d', 30],
  ['30D', 30],
  ['30 d', null],
  ['30_dias', 30],
  ['30_días', 30],
  ['15_dias', 15],
  ['30_dia', null],
  ['30 _dias', null],
  // '<n> día(s)'
  ['30 días', 30],
  ['30 dias', 30],
  ['30 DÍAS', 30],
  [' 30 días ', 30],
  ['30   días', 30],
  ['30 dia', 30],
  ['1 día', 1],
  ['1 días', 1],
  ['365 días', 365],
  ['366 días', null],
  ['30dias', null],
  ['días 30', null],
  // Sufijo 'fecha factura' / 'f.f.' / 'ff'
  ['30 días fecha factura', 30],
  ['30 dias fecha factura', 30],
  ['30 días FECHA FACTURA', 30],
  ['30 días fecha  factura', 30],
  ['30 días f.f.', 30],
  ['30 días ff', 30],
  ['30 días FF', 30],
  ['30 días f.f', null],
  ['30 díasff', null],
  ['30 días fecha', null],
  ['30d ff', null],
  ['30 ff', null],
  // Resto de textos
  ['30 días fin de mes', null],
  ['30 días, 60 días', null],
  ['30, 60', null],
  ['30/60/90', null],
  ['fecha factura', null],
  ['transferencia', null],
  ['abc', null],
  ['', null],
  ['   ', null],
  // Otros tipos
  [null, null],
  [undefined, null],
  [true, null],
  [{}, null],
  [[], null],
];

test('parseDiasPlazo: tabla de casos común con el front', () => {
  for (const [entrada, esperado] of CASOS_PARSE_DIAS_PLAZO) {
    assert.equal(parseDiasPlazo(entrada), esperado, JSON.stringify(entrada));
  }
});

test('condicionesDesdeDias', () => {
  assert.equal(condicionesDesdeDias(0), 'contado');
  assert.equal(condicionesDesdeDias(30), '30 días');
  assert.equal(condicionesDesdeDias(75), '75 días');
  assert.equal(parseDiasPlazo(condicionesDesdeDias(75)), 75, 'ida y vuelta');
});

test('calcularFechaVencimiento: ISO y dd/mm/aaaa', () => {
  assert.equal(calcularFechaVencimiento('2026-01-10', 30), '2026-02-09');
  assert.equal(calcularFechaVencimiento('10/01/2026', 30), '2026-02-09');
  assert.equal(calcularFechaVencimiento('2026-01-10T15:30:00.000Z', 0), '2026-01-10');
  assert.equal(calcularFechaVencimiento('2026-01-10', 0), '2026-01-10');
});

test('calcularFechaVencimiento: cambio de mes, de año y bisiesto', () => {
  assert.equal(calcularFechaVencimiento('2026-01-31', 1), '2026-02-01');
  assert.equal(calcularFechaVencimiento('2026-12-15', 30), '2027-01-14');
  assert.equal(calcularFechaVencimiento('2028-02-28', 1), '2028-02-29');
  assert.equal(calcularFechaVencimiento('2027-02-28', 1), '2027-03-01');
  assert.equal(calcularFechaVencimiento('2028-01-30', 30), '2028-02-29');
  assert.equal(calcularFechaVencimiento('2026-01-01', 365), '2027-01-01');
});

test('calcularFechaVencimiento: cruce del cambio de horario no salta días', () => {
  // Madrid adelanta la hora el 29/03/2026 y la retrasa el 25/10/2026.
  assert.equal(calcularFechaVencimiento('2026-03-15', 30), '2026-04-14');
  assert.equal(calcularFechaVencimiento('2026-03-28', 1), '2026-03-29');
  assert.equal(calcularFechaVencimiento('2026-03-29', 1), '2026-03-30');
  assert.equal(calcularFechaVencimiento('2026-10-10', 30), '2026-11-09');
  assert.equal(calcularFechaVencimiento('2026-10-25', 1), '2026-10-26');
});

test('vencimientoVentaPorCondiciones: solo las claves de siempre', () => {
  assert.equal(vencimientoVentaPorCondiciones('contado', '2026-01-10'), '2026-01-10');
  assert.equal(vencimientoVentaPorCondiciones('15_dias', '2026-01-10'), '2026-01-25');
  assert.equal(vencimientoVentaPorCondiciones('30_dias', '2026-01-10'), '2026-02-09');
  assert.equal(vencimientoVentaPorCondiciones('60_dias', '2026-01-10'), '2026-03-11');
  assert.equal(vencimientoVentaPorCondiciones('90_dias', '2026-01-10'), '2026-04-10');
  for (const c of ['30 días', '30', '30d', 'Contado', ' contado', '45_dias', 'toString', '', null]) {
    assert.equal(vencimientoVentaPorCondiciones(c, '2026-01-10'), '', JSON.stringify(c));
  }
  assert.equal(vencimientoVentaPorCondiciones('30_dias', 'basura'), '', 'fecha no válida: no calcula');
});

test('calcularFechaVencimiento: fecha o días no válidos → vacío', () => {
  assert.equal(calcularFechaVencimiento('', 30), '');
  assert.equal(calcularFechaVencimiento(null, 30), '');
  assert.equal(calcularFechaVencimiento('basura', 30), '');
  assert.equal(calcularFechaVencimiento('2026-02-30', 30), '');
  assert.equal(calcularFechaVencimiento('31/02/2026', 30), '');
  assert.equal(calcularFechaVencimiento('2026-01-10', null), '');
  assert.equal(calcularFechaVencimiento('2026-01-10', '30'), '');
  assert.equal(calcularFechaVencimiento('2026-01-10', 366), '');
  assert.equal(calcularFechaVencimiento('2026-01-10', -1), '');
});
