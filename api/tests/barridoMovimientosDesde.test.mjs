/**
 * Rango por defecto del barrido de movimientos en sugerencias de conciliación.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  MESES_BARRIDO_MOVIMIENTOS,
  desdeBarridoMovimientosPorDefecto,
} from '../lib/banca/conciliacion/store.js';

test('MESES_BARRIDO_MOVIMIENTOS es 18', () => {
  assert.equal(MESES_BARRIDO_MOVIMIENTOS, 18);
});

test('desdeBarridoMovimientosPorDefecto resta 18 meses en UTC', () => {
  const ref = new Date(Date.UTC(2026, 7, 22)); // 2026-08-22
  assert.equal(desdeBarridoMovimientosPorDefecto(ref), '2025-02-22');
});

test('desdeBarridoMovimientosPorDefecto cruza el año correctamente', () => {
  const ref = new Date(Date.UTC(2026, 0, 15)); // 2026-01-15
  assert.equal(desdeBarridoMovimientosPorDefecto(ref), '2024-07-15');
});
