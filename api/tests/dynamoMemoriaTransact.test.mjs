/**
 * El doble de DynamoDB aplica TransactWrite como DynamoDB: todo o nada, con
 * TransactionCanceledException y una razón por elemento. Las pruebas de
 * concurrencia de facturas (S-16) dependen de que una condición fallida en el
 * segundo elemento no deje escrito el primero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearDynamoMemoria } from './dynamoMemoria.mjs';

const tx = (TransactItems) => ({ constructor: { name: 'TransactWriteCommand' }, input: { TransactItems } });

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla('A', { hashKey: 'id' });
  db.crearTabla('B', { hashKey: 'id', rangeKey: 'sk' });
  db.sembrar('A', { id: '1', n: 1, version: 1 });
  db.sembrar('B', { id: '1', sk: 'x', v: 'antes' });
  return db;
}

test('una condición fallida en un elemento cancela todos y no escribe nada', async () => {
  const db = montar();
  await assert.rejects(
    () => db.enviar(tx([
      { Put: { TableName: 'A', Item: { id: '1', n: 2, version: 2 } } },
      { Delete: { TableName: 'B', Key: { id: '1', sk: 'x' } } },
      { Put: { TableName: 'B', Item: { id: '2', sk: 'y' }, ConditionExpression: 'attribute_exists(id)' } },
    ])),
    (err) => {
      assert.equal(err.name, 'TransactionCanceledException');
      assert.deepEqual(err.CancellationReasons.map((r) => r.Code), ['None', 'None', 'ConditionalCheckFailed']);
      return true;
    },
  );
  assert.equal(db.obtener('A', { id: '1' }).n, 1);
  assert.equal(db.obtener('B', { id: '1', sk: 'x' }).v, 'antes');
  assert.equal(db.obtener('B', { id: '2', sk: 'y' }), null);
});

test('ConditionCheck participa en la transacción sin escribir', async () => {
  const db = montar();
  await assert.rejects(() => db.enviar(tx([
    {
      ConditionCheck: {
        TableName: 'A', Key: { id: '1' }, ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': 9 },
      },
    },
    { Update: { TableName: 'B', Key: { id: '1', sk: 'x' }, UpdateExpression: 'SET v = :d', ExpressionAttributeValues: { ':d': 'después' } } },
  ])), { name: 'TransactionCanceledException' });
  assert.equal(db.obtener('B', { id: '1', sk: 'x' }).v, 'antes');
});

test('si se cumplen todas, se aplican todas (Put, Update con if_not_exists y Delete)', async () => {
  const db = montar();
  await db.enviar(tx([
    {
      Update: {
        TableName: 'A', Key: { id: '1' },
        UpdateExpression: 'SET n = :n, #ver = if_not_exists(#ver, :uno) + :uno',
        ConditionExpression: '#ver = :leida',
        ExpressionAttributeNames: { '#ver': 'version' },
        ExpressionAttributeValues: { ':n': 5, ':uno': 1, ':leida': 1 },
      },
    },
    { Delete: { TableName: 'B', Key: { id: '1', sk: 'x' } } },
    { Put: { TableName: 'B', Item: { id: '2', sk: 'y' }, ConditionExpression: 'attribute_not_exists(id)' } },
  ]));
  assert.deepEqual(db.obtener('A', { id: '1' }), { id: '1', n: 5, version: 2 });
  assert.equal(db.obtener('B', { id: '1', sk: 'x' }), null);
  assert.ok(db.obtener('B', { id: '2', sk: 'y' }));
});

test('dos operaciones sobre el mismo ítem en una transacción: ValidationException, como DynamoDB', async () => {
  const db = montar();
  await assert.rejects(() => db.enviar(tx([
    { Put: { TableName: 'A', Item: { id: '1', n: 2 } } },
    { Delete: { TableName: 'A', Key: { id: '1' } } },
  ])), { name: 'ValidationException' });
  assert.equal(db.obtener('A', { id: '1' }).n, 1);
});

test('los ganchos de un elemento se disparan antes de comprobar las condiciones', async () => {
  const db = montar();
  db.interceptar('PutCommand', 'A', () => { db.sembrar('A', { id: '1', n: 1, version: 7 }); });
  await assert.rejects(() => db.enviar(tx([
    {
      Put: {
        TableName: 'A', Item: { id: '1', n: 3, version: 2 }, ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': 1 },
      },
    },
  ])), { name: 'TransactionCanceledException' });
  assert.equal(db.obtener('A', { id: '1' }).version, 7);
});
