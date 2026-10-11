import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';

const MAX_CLAVES_BATCH = 100;
const MAX_INTENTOS_BATCH = 3;

/**
 * `emisor_id` (sociedad del grupo) de cada factura, en lotes de 100.
 * Una factura que no existe no aparece en el mapa.
 * @param {string[]} ids
 * @returns {Promise<Map<string, string>>}
 */
export async function emisoresDeFacturas(ids) {
  const distintos = [...new Set((ids || []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  const mapa = new Map();
  if (distintos.length === 0) return mapa;
  const claves = await Promise.all(distintos.map((id) => keyForFacturaPrincipalId(id)));
  const hashKey = Object.keys(claves[0])[0];
  for (let i = 0; i < claves.length; i += MAX_CLAVES_BATCH) {
    let pendientes = claves.slice(i, i + MAX_CLAVES_BATCH);
    for (let intento = 0; intento < MAX_INTENTOS_BATCH && pendientes.length > 0; intento += 1) {
      const r = await docClient.send(
        new BatchGetCommand({
          RequestItems: {
            [tables.facturas]: {
              Keys: pendientes,
              ProjectionExpression: '#k, emisor_id',
              ExpressionAttributeNames: { '#k': hashKey },
            },
          },
        }),
      );
      for (const it of r.Responses?.[tables.facturas] || []) {
        mapa.set(String(it[hashKey]), String(it.emisor_id ?? ''));
      }
      pendientes = r.UnprocessedKeys?.[tables.facturas]?.Keys || [];
    }
  }
  return mapa;
}
