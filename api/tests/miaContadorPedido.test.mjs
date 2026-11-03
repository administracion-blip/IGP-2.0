/**
 * El número de la serie MIA sale de un contador condicional.
 * Dos reservas a la vez no pueden quedarse el mismo número.
 * Si la condición falla todas las veces, no hay número y no se envía a Ágora.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const {
  INTENTOS_CONTADOR,
  MENSAJE_SIN_NUMERO,
  PK_CONTADOR,
  SK_CONTADOR,
  reservarNumeroPedido,
} = await import('../lib/mia/contadorPedido.js');

function preparar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

test('dos reservas seguidas no repiten número', async () => {
  const db = preparar();
  const a = await reservarNumeroPedido();
  const b = await reservarNumeroPedido();
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.equal(db.obtener(tables.ajustes, { PK: PK_CONTADOR, SK: SK_CONTADOR }).ultimo, 2);
});

test('dos reservas en paralelo no repiten número', async () => {
  preparar();
  const [a, b] = await Promise.all([reservarNumeroPedido(), reservarNumeroPedido()]);
  assert.equal(new Set([a, b]).size, 2);
  assert.deepEqual([a, b].sort((x, y) => x - y), [1, 2]);
});

test('si la condición falla todos los intentos, aborta sin número', async () => {
  const db = preparar();
  for (let i = 0; i < INTENTOS_CONTADOR; i += 1) {
    db.interceptar('UpdateCommand', tables.ajustes, () => {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    });
  }
  await assert.rejects(reservarNumeroPedido(), (err) => err.status === 409 && err.message === MENSAJE_SIN_NUMERO);
  assert.equal(db.obtener(tables.ajustes, { PK: PK_CONTADOR, SK: SK_CONTADOR }), null);
});
