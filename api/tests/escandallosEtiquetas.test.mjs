import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { docClient, tables } from '../lib/db.js';
import { crearDynamoMemoria } from './dynamoMemoria.mjs';
import { getReceta, normalizeEtiquetas, putReceta } from '../lib/escandallos/store.js';

const ING = { ingredienteId: '99', cantidad: 1, unidad: 'KG' };

function recetaBase(extra = {}) {
  return {
    nombre: 'Croquetas',
    udReceta: 'UD',
    activo: true,
    ingredientes: [ING],
    ...extra,
  };
}

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.escandallos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

describe('normalizeEtiquetas', () => {
  it('hace trim y descarta vacíos', () => {
    assert.deepEqual(normalizeEtiquetas(['  Postres  ', '', '  ']), ['Postres']);
    assert.deepEqual(normalizeEtiquetas([]), []);
  });

  it('deduplica case-insensitive y conserva la primera grafía', () => {
    assert.deepEqual(normalizeEtiquetas(['Postres', 'postres', 'POSTRES']), ['Postres']);
  });

  it('se queda con las 8 primeras únicas', () => {
    const nueve = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    assert.deepEqual(normalizeEtiquetas(nueve), nueve.slice(0, 8));
  });

  it('rechaza si no es un array', () => {
    for (const raw of ['Postres', null, { t: 'x' }, 1]) {
      assert.throws(
        () => normalizeEtiquetas(raw),
        (err) => err.status === 400 && err.message === 'etiquetas debe ser un array',
      );
    }
  });

  it('rechaza una etiqueta de más de 32 caracteres', () => {
    const ok = 'a'.repeat(32);
    assert.deepEqual(normalizeEtiquetas([ok]), [ok]);
    assert.throws(
      () => normalizeEtiquetas(['a'.repeat(33)]),
      (err) => err.status === 400 && /32 caracteres/.test(err.message),
    );
  });
});

describe('putReceta etiquetas', () => {
  it('guarda etiquetas normalizadas en META', async () => {
    montar();
    const saved = await putReceta('1744', recetaBase({ etiquetas: ['  Postres  ', 'postres', 'Verano'] }));
    assert.deepEqual(saved.meta.etiquetas, ['Postres', 'Verano']);
    const receta = await getReceta('1744');
    assert.deepEqual(receta.meta.etiquetas, ['Postres', 'Verano']);
  });

  it('conserva las etiquetas si el PUT no manda el campo', async () => {
    montar();
    await putReceta('1744', recetaBase({ etiquetas: ['Postres', 'Verano'] }));
    const saved = await putReceta('1744', recetaBase());
    assert.deepEqual(saved.meta.etiquetas, ['Postres', 'Verano']);
    const receta = await getReceta('1744');
    assert.deepEqual(receta.meta.etiquetas, ['Postres', 'Verano']);
  });

  it('quita las etiquetas si el PUT manda []', async () => {
    montar();
    await putReceta('1744', recetaBase({ etiquetas: ['Postres'] }));
    const saved = await putReceta('1744', recetaBase({ etiquetas: [] }));
    assert.deepEqual(saved.meta.etiquetas, []);
    const receta = await getReceta('1744');
    assert.deepEqual(receta.meta.etiquetas, []);
  });
});
