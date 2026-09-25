/**
 * Horas opcionales de tarea: ambas o ninguna, fin posterior a inicio.
 * No llama a Google Calendar.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

const { validarDatosTarea, validarHorasPareja } = await import('../lib/tasks/tareas.js');

const BASE = {
  titulo: 'Revisar carta',
  responsable_id: '000001',
  fecha_limite: '2026-10-01',
};

test('validarHorasPareja: ambas horas ok', () => {
  const r = validarHorasPareja({ hora_inicio: '09:30', hora_fin: '10:15' });
  assert.equal(r.ok, true);
  assert.equal(r.hora_inicio, '09:30');
  assert.equal(r.hora_fin, '10:15');
});

test('validarHorasPareja: vacío ok (día completo)', () => {
  const r = validarHorasPareja({ hora_inicio: '', hora_fin: '' });
  assert.equal(r.ok, true);
  assert.equal(r.hora_inicio, '');
  assert.equal(r.hora_fin, '');
});

test('validarHorasPareja: ausente ok', () => {
  const r = validarHorasPareja({});
  assert.equal(r.ok, true);
  assert.equal(r.hora_inicio, '');
  assert.equal(r.hora_fin, '');
});

test('validarHorasPareja: solo inicio falla', () => {
  const r = validarHorasPareja({ hora_inicio: '09:00', hora_fin: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /inicio y de fin, o ninguna/);
});

test('validarHorasPareja: solo fin falla', () => {
  const r = validarHorasPareja({ hora_inicio: '', hora_fin: '10:00' });
  assert.equal(r.ok, false);
  assert.match(r.error, /inicio y de fin, o ninguna/);
});

test('validarHorasPareja: fin igual a inicio falla', () => {
  const r = validarHorasPareja({ hora_inicio: '10:00', hora_fin: '10:00' });
  assert.equal(r.ok, false);
  assert.match(r.error, /posterior/);
});

test('validarHorasPareja: fin anterior a inicio falla', () => {
  const r = validarHorasPareja({ hora_inicio: '11:00', hora_fin: '10:00' });
  assert.equal(r.ok, false);
  assert.match(r.error, /posterior/);
});

test('validarHorasPareja: formato inválido', () => {
  assert.equal(validarHorasPareja({ hora_inicio: '9:00', hora_fin: '10:00' }).ok, false);
  assert.equal(validarHorasPareja({ hora_inicio: '25:00', hora_fin: '26:00' }).ok, false);
});

test('validarDatosTarea: incluye horas normalizadas', () => {
  const r = validarDatosTarea({ ...BASE, hora_inicio: '14:00', hora_fin: '15:30' });
  assert.equal(r.ok, true);
  assert.equal(r.datos.hora_inicio, '14:00');
  assert.equal(r.datos.hora_fin, '15:30');
});

test('validarDatosTarea: sin horas deja cadenas vacías', () => {
  const r = validarDatosTarea(BASE);
  assert.equal(r.ok, true);
  assert.equal(r.datos.hora_inicio, '');
  assert.equal(r.datos.hora_fin, '');
});

test('validarDatosTarea: solo una hora → error', () => {
  const r = validarDatosTarea({ ...BASE, hora_inicio: '09:00' });
  assert.equal(r.ok, false);
  assert.match(r.error, /inicio y de fin, o ninguna/);
});

test('validarDatosTarea: fin <= inicio → error', () => {
  const r = validarDatosTarea({ ...BASE, hora_inicio: '16:00', hora_fin: '15:00' });
  assert.equal(r.ok, false);
  assert.match(r.error, /posterior/);
});
