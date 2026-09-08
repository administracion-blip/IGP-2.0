/**
 * Identificadores de activos: Luhn, etiqueta legible y UUID.
 * Sin secretos: Luhn es un algoritmo público.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  digitoLuhn,
  esUuid,
  formatearEtiqueta,
  luhnValido,
  nuevoId,
  parsearEtiqueta,
  prefijoValido,
} from '../lib/activos/ids.js';

test('Luhn: vector conocido 7992739871 → dígito 3', () => {
  assert.equal(digitoLuhn('7992739871'), 3);
  assert.equal(luhnValido('79927398713'), true);
  assert.equal(luhnValido('79927398714'), false);
});

test('etiqueta PDA-0042 + Luhn; el siguiente número no reutiliza la anterior', () => {
  const a = formatearEtiqueta('pda', 42, 4);
  const b = formatearEtiqueta('PDA', 43, 4);
  assert.equal(a, `PDA-0042${digitoLuhn('0042')}`);
  assert.notEqual(a, b);
  assert.equal(parsearEtiqueta(a)?.prefijo, 'PDA');
  assert.equal(luhnValido(a.replace('PDA-', '')), true);
});

test('no se recicla: 1 y 2 son etiquetas distintas aunque se dé de baja la primera', () => {
  const primera = formatearEtiqueta('PDA', 1, 4);
  const segunda = formatearEtiqueta('PDA', 2, 4);
  assert.notEqual(primera, segunda);
});

test('prefijo inválido o correlativo 0 se rechazan', () => {
  assert.equal(prefijoValido('P'), false);
  assert.equal(prefijoValido('PDA'), true);
  assert.throws(() => formatearEtiqueta('PDA', 0, 4));
  assert.throws(() => formatearEtiqueta('', 1, 4));
});

test('asset_id es un UUID opaco distinto en cada llamada', () => {
  const a = nuevoId();
  const b = nuevoId();
  assert.equal(esUuid(a), true);
  assert.equal(esUuid(b), true);
  assert.notEqual(a, b);
});
