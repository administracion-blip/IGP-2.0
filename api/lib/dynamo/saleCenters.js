/**
 * Upsert de centros de venta (Ágora SaleCenters) en DynamoDB.
 * Tabla: PK = "GLOBAL" (string), SK = SaleCenter Id (string).
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Inserta o actualiza un lote de ítems en Igp_SaleCenters.
 * PutCommand sobrescribe si ya existe el mismo PK/SK.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {Array<Record<string, unknown>>} items - cada uno debe tener PK="GLOBAL" y SK=Id del SaleCenter
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
