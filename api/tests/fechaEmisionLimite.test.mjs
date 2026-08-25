/**
 * Margen de fecha_emision al crear facturas (hoy + 7 días).
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  errorFechaEmisionDemasiadoFutura,
  hoyIsoUtc,
  MSG_FECHA_EMISION_DEMASIADO_FUTURA,
} from '../lib/facturacion/fechaEmisionLimite.js';

const HOY = '2026-08-22';

test('hoyIsoUtc usa toISOString slice 0,10', () => {
  assert.equal(hoyIsoUtc(new Date('2026-08-22T15:30:00.000Z')), '2026-08-22');
});

test('hoy + 7 días inclusive → OK', () => {
  assert.equal(
    errorFechaEmisionDemasiadoFutura('2026-08-29', { hoy: HOY }),
    null,
  );
});

test('hoy + 8 días → error', () => {
  assert.equal(
    errorFechaEmisionDemasiadoFutura('2026-08-30', { hoy: HOY }),
    MSG_FECHA_EMISION_DEMASIADO_FUTURA,
  );
});

test('2076-05-07 → error', () => {
  assert.equal(
    errorFechaEmisionDemasiadoFutura('2076-05-07', { hoy: HOY }),
    MSG_FECHA_EMISION_DEMASIADO_FUTURA,
  );
});

test('vacío / inválido → null', () => {
  assert.equal(errorFechaEmisionDemasiadoFutura('', { hoy: HOY }), null);
  assert.equal(errorFechaEmisionDemasiadoFutura(null, { hoy: HOY }), null);
  assert.equal(errorFechaEmisionDemasiadoFutura(undefined, { hoy: HOY }), null);
  assert.equal(errorFechaEmisionDemasiadoFutura('no-es-fecha', { hoy: HOY }), null);
});

test('dd/mm/aaaa futura lejana → error', () => {
  assert.equal(
    errorFechaEmisionDemasiadoFutura('07/05/2076', { hoy: HOY }),
    MSG_FECHA_EMISION_DEMASIADO_FUTURA,
  );
});
