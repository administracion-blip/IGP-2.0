import test from 'node:test';
import { strict as assert } from 'node:assert';
import { agregarActasDesdeEventos } from '../lib/activos/custodiaDocumentos.js';

const actaKey = 'activos/entregas/ent-1/acta.pdf';

test('dos activos de la misma entrega producen una sola acta', () => {
  const actas = agregarActasDesdeEventos([
    {
      tipo: 'entrega',
      creado_en: '2026-09-10T10:00:00.000Z',
      despues: { entrega_id: 'ent-1', acta_s3_key: actaKey },
    },
    {
      tipo: 'entrega',
      creado_en: '2026-09-10T10:00:00.000Z',
      despues: { entrega_id: 'ent-1', acta_s3_key: actaKey },
    },
  ]);
  assert.equal(actas.length, 1);
  assert.deepEqual(actas[0], {
    entrega_id: 'ent-1',
    fecha: '2026-09-10T10:00:00.000Z',
    acta_s3_key: actaKey,
  });
});

test('evento de entrega sin key se omite', () => {
  const actas = agregarActasDesdeEventos([
    { tipo: 'entrega', creado_en: '2026-09-11T08:00:00.000Z', despues: { entrega_id: 'ent-2' } },
    { tipo: 'devolucion', creado_en: '2026-09-12T08:00:00.000Z', despues: { entrega_id: 'ent-x', acta_s3_key: actaKey } },
    { tipo: 'entrega', creado_en: '2026-09-11T09:00:00.000Z', entrega_id: 'ent-3', acta_s3_key: 'activos/entregas/ent-3/acta.pdf' },
  ]);
  assert.deepEqual(actas.map((a) => a.entrega_id), ['ent-3']);
});

test('ordena por fecha descendente', () => {
  const actas = agregarActasDesdeEventos([
    {
      tipo: 'entrega',
      creado_en: '2026-08-01T10:00:00.000Z',
      despues: { entrega_id: 'vieja', acta_s3_key: 'activos/entregas/vieja/acta.pdf' },
    },
    {
      tipo: 'entrega',
      creado_en: '2026-09-15T10:00:00.000Z',
      despues: { entrega_id: 'nueva', acta_s3_key: 'activos/entregas/nueva/acta.pdf' },
    },
    {
      tipo: 'entrega',
      creado_en: '2026-09-01T10:00:00.000Z',
      despues: { entrega_id: 'media', acta_s3_key: 'activos/entregas/media/acta.pdf' },
    },
  ]);
  assert.deepEqual(actas.map((a) => a.entrega_id), ['nueva', 'media', 'vieja']);
});
