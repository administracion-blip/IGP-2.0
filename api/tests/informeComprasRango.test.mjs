import test from 'node:test';
import { strict as assert } from 'node:assert';
import { rangoVigenteEnPeriodo } from '../lib/acuerdos/informeCompras.js';

test('rangoVigenteEnPeriodo: sin solape (acuerdo empieza tras el periodo) → null', () => {
  // Diageo FY27 (01/07/2026) vs periodo 01/01–30/06/2026
  assert.equal(
    rangoVigenteEnPeriodo('2026-07-01', '2027-06-30', '2026-01-01', '2026-06-30'),
    null,
  );
});

test('rangoVigenteEnPeriodo: sin solape (acuerdo termina antes del periodo) → null', () => {
  assert.equal(
    rangoVigenteEnPeriodo('2025-01-01', '2025-12-31', '2026-01-01', '2026-06-30'),
    null,
  );
});

test('rangoVigenteEnPeriodo: solape parcial recorta al inicio del acuerdo', () => {
  assert.deepEqual(
    rangoVigenteEnPeriodo('2026-07-01', '2027-06-30', '2026-01-01', '2026-12-31'),
    { desde: '2026-07-01', hasta: '2026-12-31' },
  );
});

test('rangoVigenteEnPeriodo: solape parcial recorta al fin del acuerdo', () => {
  assert.deepEqual(
    rangoVigenteEnPeriodo('2025-07-01', '2026-03-31', '2026-01-01', '2026-06-30'),
    { desde: '2026-01-01', hasta: '2026-03-31' },
  );
});

test('rangoVigenteEnPeriodo: vigencia vacía usa todo el periodo', () => {
  assert.deepEqual(
    rangoVigenteEnPeriodo('', '', '2026-01-01', '2026-06-30'),
    { desde: '2026-01-01', hasta: '2026-06-30' },
  );
  assert.deepEqual(
    rangoVigenteEnPeriodo(null, undefined, '2026-01-01', '2026-06-30'),
    { desde: '2026-01-01', hasta: '2026-06-30' },
  );
});

test('rangoVigenteEnPeriodo: acuerdo contenido entero en el periodo', () => {
  assert.deepEqual(
    rangoVigenteEnPeriodo('2026-02-01', '2026-02-28', '2026-01-01', '2026-06-30'),
    { desde: '2026-02-01', hasta: '2026-02-28' },
  );
});
