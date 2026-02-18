/**
 * Upsert de cierres de ventas (Ágora PosCloseOuts/SystemCloseOuts) en DynamoDB.
 * Tabla Igp_SalesCloseouts: PK = workplaceId, SK = businessDay#posId#number
 */

import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const BATCH_SIZE = 25;

export async function upsertBatch(docClient, tableName, items) {
  if (!items.length) return 0;
  const seen = new Map();
  for (const item of items) {
    const pk = item.PK != null ? String(item.PK).trim() : '';
    const sk = item.SK != null ? String(item.SK).trim() : '';
    if (pk && sk) seen.set(`${pk}#${sk}`, { ...item, PK: pk, SK: sk });
  }
  const deduped = [...seen.values()];
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const chunk = deduped.slice(i, i + BATCH_SIZE);
    let req = {
      RequestItems: { [tableName]: chunk.map((it) => ({ PutRequest: { Item: it } })) },
    };
    let unprocessed;
    do {
      const res = await docClient.send(new BatchWriteCommand(req));
      unprocessed = res.UnprocessedItems?.[tableName];
      if (unprocessed?.length) {
        req = { RequestItems: { [tableName]: unprocessed } };
        await new Promise((r) => setTimeout(r, 100));
      }
    } while (unprocessed?.length);
  }
  return deduped.length;
}
