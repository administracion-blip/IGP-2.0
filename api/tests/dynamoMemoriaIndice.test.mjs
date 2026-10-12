/**
 * El doble pagina un Query por índice con BETWEEN y begins_with, y deja fuera
 * del índice los ítems a los que les falta la sort key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

test('Query por índice: BETWEEN, begins_with y ítem sin sort key', async () => {
  const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
  const db = crearDynamoMemoria({ paginaTam: 2 });
  db.crearTabla('T', {
    hashKey: 'id',
    indices: {
      'Tipo-Fecha-index': { hashKey: 'gsi_tipo', rangeKey: 'gsi_fecha' },
    },
  }, [
    { id: 'a', gsi_tipo: 'IN', gsi_fecha: '2026-01-15' },
    { id: 'b', gsi_tipo: 'IN', gsi_fecha: '2026-06-01' },
    { id: 'c', gsi_tipo: 'IN', gsi_fecha: '2025-12-31' },
    { id: 'd', gsi_tipo: 'OUT', gsi_fecha: '2026-03-01' },
    { id: 'e', gsi_tipo: 'IN' },
    { id: 'f', gsi_tipo: 'IN', gsi_fecha: '2026-03-20' },
  ]);

  const client = { send: (cmd) => db.enviar(cmd) };
  const pedir = (input) => client.send(new QueryCommand({ TableName: 'T', ...input }));

  const entre = [];
  let lastKey;
  do {
    const r = await pedir({
      IndexName: 'Tipo-Fecha-index',
      KeyConditionExpression: '#h = :h AND #s BETWEEN :desde AND :hasta',
      ExpressionAttributeNames: { '#h': 'gsi_tipo', '#s': 'gsi_fecha' },
      ExpressionAttributeValues: { ':h': 'IN', ':desde': '2026-01-01', ':hasta': '2026-12-31' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    });
    entre.push(...r.Items.map((it) => it.id));
    lastKey = r.LastEvaluatedKey;
    if (r.Items.length > 0) assert.ok(r.Items.length <= 2);
  } while (lastKey);
  assert.deepEqual(entre, ['a', 'f', 'b']);

  const prefijo = await pedir({
    IndexName: 'Tipo-Fecha-index',
    KeyConditionExpression: '#h = :h AND begins_with(#s, :prefijo)',
    ExpressionAttributeNames: { '#h': 'gsi_tipo', '#s': 'gsi_fecha' },
    ExpressionAttributeValues: { ':h': 'IN', ':prefijo': '2026-03' },
  });
  assert.deepEqual(prefijo.Items.map((it) => it.id), ['f']);

  const tope = await pedir({
    IndexName: 'Tipo-Fecha-index',
    KeyConditionExpression: '#h = :h AND #s <= :hasta',
    ExpressionAttributeNames: { '#h': 'gsi_tipo', '#s': 'gsi_fecha' },
    ExpressionAttributeValues: { ':h': 'IN', ':hasta': '2026-01-15' },
  });
  assert.deepEqual(tope.Items.map((it) => it.id), ['c', 'a']);
});
