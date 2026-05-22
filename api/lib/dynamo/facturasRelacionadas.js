/**
 * Helpers de consulta para tablas relacionadas con `Igp_Facturas`.
 *
 * Las tres tablas (`Igp_FacturasLineas`, `Igp_FacturasPagos`,
 * `Igp_FacturasAuditoria`) ya tienen `id_factura` como **partition key**
 * (HASH), de modo que NO se necesita ningún GSI para resolver
 * "líneas/pagos/auditoría de la factura X". Basta con un `QueryCommand`
 * sobre la PK existente.
 *
 * Antes de este módulo se hacían `Scan + FilterExpression` (ver
 * `routes/facturacion.js` antes del cambio): cada apertura de factura
 * recorría las tablas enteras y filtraba en cliente, gastando lecturas
 * proporcionales al tamaño total. Con `Query` solo se leen los items
 * pertenecientes a la factura concreta.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

async function queryByIdFactura(tableName, idFactura) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#fid = :fid',
      ExpressionAttributeNames: { '#fid': 'id_factura' },
      ExpressionAttributeValues: { ':fid': idFactura },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

export function queryLineasByFactura(idFactura) {
  return queryByIdFactura(tables.facturasLineas, idFactura);
}

export function queryPagosByFactura(idFactura) {
  return queryByIdFactura(tables.facturasPagos, idFactura);
}

export function queryAuditoriaByFactura(idFactura) {
  return queryByIdFactura(tables.facturasAuditoria, idFactura);
}
