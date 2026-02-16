/**
 * Upsert de cierres de ventas (Ágora SystemCloseOuts) en DynamoDB.
 * Tabla: PK = workplaceId (string), SK = businessDay#closeOutNumber (string).
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Inserta o actualiza un lote de ítems en Igp_SalesCloseouts.
 * PutCommand sobrescribe si ya existe el mismo PK/SK.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {Array<Record<string, unknown>>} items - cada uno debe tener PK (workplaceId) y SK (businessDay#number)
 * @returns {Promise<number>} cantidad de ítems escritos
 */
export async function upsertBatch(docClient, tableName, items) {
  if (!items.length) return 0;
  for (const item of items) {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }
  return items.length;
}
