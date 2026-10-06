import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  fechasDeRecurrencia,
  normalizarRecurrencia,
  rruleConUntil,
  rruleDe,
  separarMiembros,
} from '../lib/tasks/recurrencia.js';

test('sin repetición no hay regla', () => {
  assert.deepEqual(normalizarRecurrencia(undefined), { ok: true, regla: null });
  assert.deepEqual(normalizarRecurrencia('ninguna'), { ok: true, regla: null });
  assert.equal(normalizarRecurrencia({ frecuencia: 'cada-rato' }).ok, false);
  assert.equal(normalizarRecurrencia({ frecuencia: 'semanal' }).ok, false);
});

test('cada día, cada lunes, el día 31 y el último día', () => {
  const diaria = fechasDeRecurrencia('2026-01-01', { frecuencia: 'diaria', dia_semana: null }, {
    horizonteDias: 2,
    max: 10,
  });
  assert.deepEqual(diaria, ['2026-01-01', '2026-01-02', '2026-01-03']);

  const lunes = fechasDeRecurrencia('2026-09-30', { frecuencia: 'semanal', dia_semana: 1 }, {
    horizonteDias: 14,
    max: 10,
  });
  assert.deepEqual(lunes, ['2026-10-05', '2026-10-12']);

  const dia31 = fechasDeRecurrencia('2026-01-31', { frecuencia: 'mensual', dia_semana: null }, {
    horizonteDias: 70,
    max: 10,
  });
  assert.deepEqual(dia31, ['2026-01-31', '2026-03-31']);

  const ultimo = fechasDeRecurrencia('2026-09-15', { frecuencia: 'ultimo_dia', dia_semana: null }, {
    horizonteDias: 50,
    max: 10,
  });
  assert.deepEqual(ultimo, ['2026-09-30', '2026-10-31']);
});

test('se pueden marcar varios días de la semana y del mes', () => {
  const regla = normalizarRecurrencia({ frecuencia: 'semanal', dias_semana: [4, 1, 1] });
  assert.equal(regla.ok, true);
  assert.deepEqual(regla.regla.dias_semana, [1, 4]);
  const fechas = fechasDeRecurrencia('2026-09-28', regla.regla, { horizonteDias: 10, max: 10 });
  assert.deepEqual(fechas, ['2026-09-28', '2026-10-01', '2026-10-05', '2026-10-08']);
  assert.equal(rruleDe(regla.regla, '2026-09-28'), 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH');

  const mes = normalizarRecurrencia({ frecuencia: 'mensual', dias_mes: [20, 15] });
  assert.equal(mes.ok, true);
  const delMes = fechasDeRecurrencia('2026-09-18', mes.regla, { horizonteDias: 40, max: 10 });
  assert.deepEqual(delMes, ['2026-09-20', '2026-10-15', '2026-10-20']);
  assert.equal(rruleDe(mes.regla, '2026-09-18'), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15,20');

  const con31 = fechasDeRecurrencia('2026-01-15', { frecuencia: 'mensual', dias_mes: [15, 31] }, {
    horizonteDias: 50,
    max: 10,
  });
  assert.deepEqual(con31, ['2026-01-15', '2026-01-31', '2026-02-15']);
});

test('la regla de Google y el corte dejan fuera la fecha elegida', () => {
  assert.equal(rruleDe({ frecuencia: 'semanal', dia_semana: 1 }, '2026-10-05'), 'RRULE:FREQ=WEEKLY;BYDAY=MO');
  assert.equal(rruleDe({ frecuencia: 'ultimo_dia' }, '2026-09-30'), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1');
  assert.equal(
    rruleConUntil('RRULE:FREQ=WEEKLY;BYDAY=MO', '2026-10-12'),
    'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261011T235959Z',
  );
});

test('borrar esta fecha no se lleva las anteriores ni las posteriores', () => {
  const miembros = [
    { id: 'a', fecha: '2026-10-05' },
    { id: 'b', fecha: '2026-10-12' },
    { id: 'c', fecha: '2026-10-19' },
  ];
  const solo = separarMiembros(miembros, { id: 'b', fecha: '2026-10-12', alcance: 'esta' });
  assert.deepEqual(solo.borrar.map((m) => m.id), ['b']);
  assert.deepEqual(solo.quedar.map((m) => m.id), ['a', 'c']);

  const posteriores = separarMiembros(miembros, { id: 'b', fecha: '2026-10-12', alcance: 'posteriores' });
  assert.deepEqual(posteriores.borrar.map((m) => m.id), ['b', 'c']);
  assert.deepEqual(posteriores.quedar.map((m) => m.id), ['a']);
});
