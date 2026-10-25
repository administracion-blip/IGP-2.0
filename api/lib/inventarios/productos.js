/**
 * Productos de Ágora ya copiados en Igp_AgoraProducts.
 * Query por PK GLOBAL: no es un Scan y no llama a Ágora.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { canonicalFamilyId } from '../mia/gruposFamilias.js';

function activo(item) {
  return item.Active !== false && item.Active !== 0 && item.Active !== 'false';
}

/**
 * @param {{ familiaIds?: string[], productIds?: string[] }} filtro
 * @returns {Promise<Array<{ productId: string, nombre: string, familiaNombre: string, unidad: string }>>}
 */
export async function listarProductosInventario({ familiaIds, productIds } = {}) {
  const familias = new Set((familiaIds || []).map(canonicalFamilyId).filter(Boolean));
  const ids = new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean));
  const porFamilia = familias.size > 0;
  const porId = ids.size > 0;
  const out = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.agoraProducts,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'GLOBAL' },
      ProjectionExpression: 'SK, Id, #nm, FamilyId, FamilyName, FormatoBaseNombre, Active',
      ExpressionAttributeNames: { '#nm': 'Name' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const it of r.Items || []) {
      if (String(it.SK ?? '') === '__meta__') continue;
      const productId = String(it.Id ?? it.SK ?? '').trim();
      if (!productId || !activo(it)) continue;
      if (porFamilia && !familias.has(canonicalFamilyId(it.FamilyId))) continue;
      if (porId && !ids.has(productId)) continue;
      if (!porFamilia && !porId) continue;
      out.push({
        productId,
        nombre: String(it.Name ?? '').trim() || productId,
        familiaNombre: String(it.FamilyName ?? '').trim(),
        unidad: String(it.FormatoBaseNombre ?? '').trim(),
      });
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.productId.localeCompare(b.productId, 'es'));
  return out;
}
