/**
 * Matching de incidencias similares (anti-duplicados), sin Dynamo.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizarTexto,
  tokenizar,
  scoreTokensComunes,
  jaccardTokens,
  evaluarSimilitud,
  esCandidatoDuplicado,
  rankearSimilares,
} from '../lib/mantenimiento/similaresIncidencia.js';

test('normalizarTexto: minúsculas, sin tildes, solo alfanum/espacios', () => {
  assert.equal(normalizarTexto('  Fuga de Agua — Baño!! '), 'fuga de agua bano');
  assert.equal(normalizarTexto('Café & té'), 'cafe te');
});

test('tokenizar: stopwords y longitud ≥ 3', () => {
  const tokens = tokenizar('Fuga de agua en el baño de la cocina');
  assert.deepEqual(tokens, ['fuga', 'agua', 'bano', 'cocina']);
});

test('scoreTokensComunes y Jaccard', () => {
  const q = tokenizar('fuga agua grifo');
  const c = tokenizar('fuga agua baño');
  assert.equal(scoreTokensComunes(q, c), 2);
  assert.ok(Math.abs(jaccardTokens(q, c) - 2 / 4) < 1e-9);
});

test('evaluarSimilitud: ≥ 2 tokens en común', () => {
  const q = tokenizar('aire acondicionado no enfría');
  const c = tokenizar('aire acondicionado sala');
  const r = evaluarSimilitud(q, c);
  assert.equal(r.similar, true);
  assert.equal(r.score, 2);
});

test('evaluarSimilitud: Jaccard ≥ 0.4 con query ≥ 2 tokens', () => {
  // 1 en común, unión 2 → Jaccard 0.5
  const q = ['fuga', 'agua'];
  const c = ['fuga'];
  const r = evaluarSimilitud(q, c);
  assert.equal(r.similar, true);
  assert.equal(r.score, 1);
});

test('evaluarSimilitud: un solo token en común y query corto → no similar', () => {
  const r = evaluarSimilitud(['fuga'], ['fuga', 'grifo', 'cocina']);
  assert.equal(r.similar, false);
  assert.equal(r.score, 1);
});

test('esCandidatoDuplicado excluye recurrente y estados cerrados', () => {
  assert.equal(
    esCandidatoDuplicado({ tipo: 'INC', estado: 'Nuevo', origen: 'recurrente' }),
    false,
  );
  assert.equal(
    esCandidatoDuplicado({ tipo: 'INC', estado: 'Completado' }),
    false,
  );
  assert.equal(
    esCandidatoDuplicado({ tipo: 'INC', estado: 'Programado' }),
    true,
  );
  assert.equal(
    esCandidatoDuplicado({ tipo: 'INC', estado: 'Nuevo' }),
    true,
  );
});

test('rankearSimilares: top 5, score desc, zona como tie-break', () => {
  const candidatos = [
    {
      id_incidencia: 'a',
      tipo: 'INC',
      estado: 'Nuevo',
      titulo: 'Fuga de agua en baño',
      descripcion: '',
      zona: 'sala',
      fecha_creacion: '2026-01-01T00:00:00.000Z',
    },
    {
      id_incidencia: 'b',
      tipo: 'INC',
      estado: 'Programado',
      titulo: 'Fuga de agua en baño',
      descripcion: '',
      zona: 'baños',
      fecha_creacion: '2026-01-02T00:00:00.000Z',
    },
    {
      id_incidencia: 'c',
      tipo: 'INC',
      estado: 'Nuevo',
      origen: 'recurrente',
      titulo: 'Fuga de agua en baño',
      zona: 'baños',
    },
    {
      id_incidencia: 'd',
      tipo: 'INC',
      estado: 'Nuevo',
      titulo: 'Bombilla fundida',
      zona: 'baños',
    },
  ];

  const similares = rankearSimilares({
    titulo: 'Fuga de agua baño',
    descripcion: '',
    zona: 'baños',
    candidatos,
  });

  assert.equal(similares.length, 2);
  assert.equal(similares[0].id_incidencia, 'b'); // mismo score, misma zona primero
  assert.equal(similares[1].id_incidencia, 'a');
  assert.ok(similares[0].score >= 2);
  assert.ok(!similares.some((s) => s.id_incidencia === 'c'));
  assert.ok(!similares.some((s) => s.id_incidencia === 'd'));
});
