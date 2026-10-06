/**
 * Lectura de un evento de Google hacia los campos de la agenda.
 * No toca Dynamo: solo la traducción de fecha y hora a Madrid.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { interpretarEventoGoogle } from '../lib/google/calendarClient.js';

test('un evento con hora se lee en Madrid', () => {
  const evento = interpretarEventoGoogle({
    id: 'evt-1',
    status: 'confirmed',
    summary: 'Cerrar caja',
    start: { dateTime: '2026-01-15T09:00:00Z' },
    end: { dateTime: '2026-01-15T10:30:00Z' },
  });
  assert.equal(evento.eventId, 'evt-1');
  assert.equal(evento.cancelado, false);
  assert.equal(evento.titulo, 'Cerrar caja');
  assert.equal(evento.fecha, '2026-01-15');
  assert.equal(evento.horaInicio, '10:00');
  assert.equal(evento.horaFin, '11:30');
});

test('un evento de día completo no trae horas', () => {
  const evento = interpretarEventoGoogle({
    id: 'evt-2',
    summary: 'Inventario',
    start: { date: '2026-03-02' },
    end: { date: '2026-03-03' },
  });
  assert.equal(evento.fecha, '2026-03-02');
  assert.equal(evento.horaInicio, '');
  assert.equal(evento.horaFin, '');
});

test('un evento borrado en Google solo marca la cancelación', () => {
  const evento = interpretarEventoGoogle({ id: 'evt-3', status: 'cancelled' });
  assert.deepEqual(evento, { eventId: 'evt-3', cancelado: true });
});
