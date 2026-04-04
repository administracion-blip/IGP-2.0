/**
 * Infraestructura compartida de Compras a Proveedor (Igp_ComprasAProveedor).
 *
 * Gestiona el GSI ProductId-AlbaranFecha-index y expone queryComprasPorProductos()
 * para uso de purchases y acuerdos.
 */

import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { client, docClient, tables } from '../db.js';

const TABLE_NAME = tables.comprasProveedor;

export const GSI_COMPRAS_NAME = 'ProductId-AlbaranFecha-index';

let gsiReady = false;

export function isGsiReady() {
  return gsiReady;
}

export async function ensureComprasGSI() {
  try {
    const desc = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    const gsis = desc.Table?.GlobalSecondaryIndexes || [];
    const existing = gsis.find((g) => g.IndexName === GSI_COMPRAS_NAME);
    if (existing) {
      gsiReady = existing.IndexStatus === 'ACTIVE';
      if (!gsiReady) console.log(`[GSI] ${GSI_COMPRAS_NAME} existe pero está en estado ${existing.IndexStatus}, usando Scan como fallback`);
      else console.log(`[GSI] ${GSI_COMPRAS_NAME} activo y listo`);
      return;
    }
    console.log(`[GSI] Creando ${GSI_COMPRAS_NAME} en ${TABLE_NAME}…`);
    await client.send(new UpdateTableCommand({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: 'ProductId', AttributeType: 'S' },
        { AttributeName: 'AlbaranFecha', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexUpdates: [{
        Create: {
          IndexName: GSI_COMPRAS_NAME,
          KeySchema: [
            { AttributeName: 'ProductId', KeyType: 'HASH' },
            { AttributeName: 'AlbaranFecha', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['Quantity', 'PK', 'SK'] },
          ProvisionedThroughput: desc.Table?.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' ? undefined : { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      }],
    }));
    console.log(`[GSI] ${GSI_COMPRAS_NAME} creación iniciada. Estará activo en unos minutos. Usando Scan como fallback mientras tanto.`);
  } catch (err) {
    console.warn('[GSI] No se pudo crear/verificar el GSI:', err.message || err);
  }
}

export async function queryComprasPorProductos(productIds, fechaInicio, fechaFin) {
  const comprasPorProducto = {};
  if (!productIds || productIds.size === 0) return comprasPorProducto;

  if (gsiReady) {
    const queries = [...productIds].map(async (pid) => {
      let keyExpr = 'ProductId = :pid';
      const exprVals = { ':pid': pid };
      if (fechaInicio && fechaFin) {
        keyExpr += ' AND AlbaranFecha BETWEEN :fi AND :ff';
        exprVals[':fi'] = fechaInicio <= fechaFin ? fechaInicio : fechaFin;
        exprVals[':ff'] = fechaInicio <= fechaFin ? fechaFin : fechaInicio;
      } else if (fechaInicio) {
        keyExpr += ' AND AlbaranFecha >= :fi';
        exprVals[':fi'] = fechaInicio;
      } else if (fechaFin) {
        keyExpr += ' AND AlbaranFecha <= :ff';
        exprVals[':ff'] = fechaFin;
      }
      let total = 0;
      let lastKey = null;
      do {
        const r = await docClient.send(new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: GSI_COMPRAS_NAME,
          KeyConditionExpression: keyExpr,
          ExpressionAttributeValues: exprVals,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        for (const item of (r.Items || [])) {
          total += Number(item.Quantity) || 0;
        }
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
      comprasPorProducto[pid] = total;
    });
    await Promise.all(queries);
  } else {
    let cKey = null;
    const allCompras = [];
    do {
      const r = await docClient.send(new ScanCommand({ TableName: TABLE_NAME, ...(cKey && { ExclusiveStartKey: cKey }) }));
      allCompras.push(...(r.Items || []));
      cKey = r.LastEvaluatedKey || null;
    } while (cKey);
    for (const c of allCompras) {
      const pid = String(c.ProductId || '').trim();
      if (!productIds.has(pid)) continue;
      const fecha = c.AlbaranFecha || '';
      if (fechaInicio && fecha < fechaInicio) continue;
      if (fechaFin && fecha > fechaFin) continue;
      comprasPorProducto[pid] = (comprasPorProducto[pid] || 0) + (Number(c.Quantity) || 0);
    }
  }
  return comprasPorProducto;
}
