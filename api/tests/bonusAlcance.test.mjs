import test from 'node:test';
import { strict as assert } from 'node:assert';
import { tieneAlcanceGlobalLocales } from '../lib/usuarioLocales.js';
import { userParaCalculoAlcanceTodos } from '../lib/bonus/bonusMes.js';

test('tieneAlcanceGlobalLocales: Admin siempre global', () => {
  assert.equal(tieneAlcanceGlobalLocales('Administrador', ['Solo Uno']), true);
  assert.equal(tieneAlcanceGlobalLocales('Administrador', []), true);
  assert.equal(tieneAlcanceGlobalLocales('Administrador', null), true);
});

test('tieneAlcanceGlobalLocales: Locales vacío/ausente = global', () => {
  assert.equal(tieneAlcanceGlobalLocales('Encargado', []), true);
  assert.equal(tieneAlcanceGlobalLocales('Encargado', null), true);
  assert.equal(tieneAlcanceGlobalLocales('Encargado', undefined), true);
});

test('tieneAlcanceGlobalLocales: Locales con valores = restringido', () => {
  assert.equal(tieneAlcanceGlobalLocales('Encargado', ['Local A']), false);
  assert.equal(tieneAlcanceGlobalLocales(undefined, ['Local A']), false);
});

test('userParaCalculoAlcanceTodos: eleva rol solo para cálculo de cierre', () => {
  const base = { id_usuario: 'u1', email: 'a@b.c', rol: 'Encargado', Nombre: 'Ana' };
  const actor = userParaCalculoAlcanceTodos(base);
  assert.equal(actor.rol, 'Administrador');
  assert.equal(actor.id_usuario, 'u1');
  assert.equal(actor.email, 'a@b.c');
  assert.equal(actor.Nombre, 'Ana');
  // No muta el user original del request
  assert.equal(base.rol, 'Encargado');
});
