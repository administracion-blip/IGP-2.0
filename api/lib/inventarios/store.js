/**
 * Lecturas y escrituras de Igp_Inventarios. Solo Query por clave o por el GSI
 * de almacén: nunca Scan.
 */

import { DeleteCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { GSI_ALMACEN, errorInventario } from './claves.js';

const TABLA = () => tables.inventarios;

function esCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

export function tablaInventarios() {
  return TABLA();
}

function esConflicto(err) {
  return err?.name === 'ConditionalCheckFailedException' || err?.name === 'TransactionCanceledException';
}

export async function queryPk(pk, { consistente = false } = {}) {
  const items = [];
  let lastKey;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLA(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ...(consistente && { ConsistentRead: true }),
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/** META de un almacén cuyo `Clave` empieza por `prefijo` (`PLANTILLA#` o `INV#`). */
export async function queryPorAlmacen(warehouseId, prefijo) {
  const items = [];
  let lastKey;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLA(),
      IndexName: GSI_ALMACEN,
      KeyConditionExpression: 'WarehouseId = :w AND begins_with(Clave, :p)',
      ExpressionAttributeValues: { ':w': warehouseId, ':p': prefijo },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

export async function poner(item, { crear = false, exigir = true } = {}) {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLA(),
      Item: item,
      ...(exigir && {
        ConditionExpression: crear ? 'attribute_not_exists(PK)' : 'attribute_exists(PK)',
      }),
    }));
  } catch (err) {
    if (esCondicion(err)) {
      throw errorInventario(crear ? 'Ya existe' : 'No encontrado', crear ? 409 : 404);
    }
    throw err;
  }
}

export async function borrarClave(pk, sk) {
  await docClient.send(new DeleteCommand({
    TableName: TABLA(),
    Key: { PK: pk, SK: sk },
  }));
}

export async function borrarPk(pk) {
  const items = await queryPk(pk);
  for (const it of items) {
    await borrarClave(it.PK, it.SK);
  }
  return items.length;
}

/** Update condicional. Si la condición no se cumple, el inventario cambió entre medias. */
export async function actualizar(clave, { expression, values, condition }) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLA(),
      Key: clave,
      UpdateExpression: expression,
      ConditionExpression: condition,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (esConflicto(err)) throw errorInventario('El inventario ha cambiado; vuelve a intentarlo', 409);
    throw err;
  }
}

export async function transaccion(items) {
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    if (esConflicto(err)) throw errorInventario('El inventario ha cambiado; vuelve a intentarlo', 409);
    throw err;
  }
}

/** Borra solo si la condición se cumple. No borra un importado que haya cambiado entretanto. */
export async function borrarSi(pk, sk, condition, values) {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLA(),
      Key: { PK: pk, SK: sk },
      ConditionExpression: condition,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (esConflicto(err)) throw errorInventario('El inventario ha cambiado; vuelve a intentarlo', 409);
    throw err;
  }
}
