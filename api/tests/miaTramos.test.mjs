/**
 * Tramos del multiplicador: desde 0, sin huecos ni solapes, último sin tope.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { PK_MIA_TRAMOS, guardarTramos, listarTramos, validarTramos } = await import('../lib/mia/tramos.js');

const VALIDOS = [
  { desde: 0, hasta: 20000, multiplicador: 1 },
  { desde: 20000, hasta: 35000, multiplicador: 2 },
  { desde: 35000, hasta: null, multiplicador: 3 },
];

function preparar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

test('un conjunto continuo desde 0 es válido', () => {
  const lista = validarTramos(VALIDOS);
  assert.equal(lista.length, 3);
  assert.equal(lista[2].hasta, null);
});

test('rechaza hueco, solape, tope en el último y un inicio distinto de 0', () => {
  assert.throws(() => validarTramos([
    { desde: 0, hasta: 100, multiplicador: 1 },
    { desde: 150, hasta: null, multiplicador: 2 },
  ]), /hueco/);
  assert.throws(() => validarTramos([
    { desde: 0, hasta: 100, multiplicador: 1 },
    { desde: 50, hasta: null, multiplicador: 2 },
  ]), /solapan/);
  assert.throws(() => validarTramos([
    { desde: 0, hasta: 100, multiplicador: 1 },
  ]), /sin tope|hueco por encima/);
  assert.throws(() => validarTramos([
    { desde: 10, hasta: null, multiplicador: 1 },
  ]), /empezar en 0/);
});

test('guardar sustituye los tramos del ámbito y no mezcla el global con un almacén', async () => {
  const db = preparar();
  db.sembrar(tables.ajustes, { PK: 'mia_proveedores', SK: '12', plazoDias: 2 });
  await guardarTramos(null, VALIDOS);
  await guardarTramos('000020', [
    { desde: 0, hasta: 1000, multiplicador: 1 },
    { desde: 1000, hasta: null, multiplicador: 4 },
  ]);
  await guardarTramos(null, [
    { desde: 0, hasta: null, multiplicador: 1 },
  ]);

  const global = await listarTramos(null);
  assert.equal(global.length, 1);
  assert.equal(global[0].multiplicador, 1);
  const almacen = await listarTramos('20');
  assert.equal(almacen.length, 2);
  assert.equal(almacen[1].multiplicador, 4);
  assert.equal(db.obtener(tables.ajustes, { PK: 'mia_proveedores', SK: '12' }).plazoDias, 2);
  assert.ok(db.listar(tables.ajustes).some((it) => it.PK === PK_MIA_TRAMOS && it.SK.startsWith('GLOBAL#')));
});
