import test from 'node:test';
import { strict as assert } from 'node:assert';
import { fechaSiguienteIso } from '../lib/ia/motores/diaADia.js';

test('fechaSiguienteIso avanza un día', () => {
  assert.equal(fechaSiguienteIso('2026-08-11'), '2026-08-12');
});

test('fechaSiguienteIso cruza de año', () => {
  assert.equal(fechaSiguienteIso('2026-12-31'), '2027-01-01');
});

test('fechaSiguienteIso input inválido → null', () => {
  // Contrato: null ante fecha ausente, mal formada o no ISO YYYY-MM-DD
  assert.equal(fechaSiguienteIso(null), null);
  assert.equal(fechaSiguienteIso(undefined), null);
  assert.equal(fechaSiguienteIso(''), null);
  assert.equal(fechaSiguienteIso('11/08/2026'), null);
  assert.equal(fechaSiguienteIso('2026-8-11'), null);
  assert.equal(fechaSiguienteIso('no-fecha'), null);
});
