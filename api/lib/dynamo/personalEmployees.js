/**
 * Repositorio DynamoDB para empleados (Igp_Empleados).
 * PK = EMPLOYEE#<employee_id>, SK = METADATA.
 *
 * Operaciones: upsert batch, listar todos, obtener por id.
 */

import { BatchWriteCommand, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const BATCH_SIZE = 25;

/**
 * Upsert masivo: cada item ya debe tener pk y sk.
 * Deduplica por pk+sk y gestiona UnprocessedItems.
 */
export async function upsertEmployeesBatch(docClient, tableName, items) {
  if (!items.length) return 0;

  const seen = new Map();
  for (const item of items) {
    const key = `${item.PK}#${item.SK}`;
    seen.set(key, item);
  }
  const deduped = [...seen.values()];

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const chunk = deduped.slice(i, i + BATCH_SIZE);
    let req = {
      RequestItems: {
        [tableName]: chunk.map((it) => ({ PutRequest: { Item: it } })),
      },
    };
    let unprocessed;
    do {
      const res = await docClient.send(new BatchWriteCommand(req));
      unprocessed = res.UnprocessedItems?.[tableName];
      if (unprocessed?.length) {
        req = { RequestItems: { [tableName]: unprocessed } };
        await new Promise((r) => setTimeout(r, 150));
      }
    } while (unprocessed?.length);
  }
  return deduped.length;
}

/** Devuelve todos los empleados (Scan completo). */
export async function getAllEmployees(docClient, tableName) {
  const items = [];
  let lastKey;
  do {
    const res = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    if (res.Items) items.push(...res.Items);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Obtiene un empleado por employee_id (PK = EMPLOYEE#<id>, SK = METADATA). */
export async function getEmployeeById(docClient, tableName, employeeId) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: {
        ':pk': `EMPLOYEE#${employeeId}`,
        ':sk': 'METADATA',
      },
    }),
  );
  return res.Items?.[0] ?? null;
}
