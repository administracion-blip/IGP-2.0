/**
 * Líneas de acuerdo por el GSI Producto (gsi_producto sin ceros a la izquierda).
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { clavesAcuerdoDetalle } from '../clavesIndice.js';

export const GSI_ACUERDOS_PRODUCTO = 'Producto-index';

export async function queryDetallesPorProducto(productId) {
  const gsi = clavesAcuerdoDetalle(productId).set.gsi_producto;
  if (!gsi) return [];
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.acuerdosDetalles,
      IndexName: GSI_ACUERDOS_PRODUCTO,
      KeyConditionExpression: 'gsi_producto = :p',
      ExpressionAttributeValues: { ':p': gsi },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}
