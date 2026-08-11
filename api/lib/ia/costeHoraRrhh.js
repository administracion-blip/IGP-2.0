/**
 * Coste €/hora de personal (misma fuente que RRHH → Horas por facturación).
 *
 * - Global: Igp_Ajustes PK='personalizacion' SK='app' → ImporteHoraDefecto
 * - Por local: PK='RATIO_HORAS_LOCAL' SK=id_Locales → ratio
 * - Efectivo: override local > 0; si no, ImporteHoraDefecto > 0; si no, null
 */
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

const PK_PERSONALIZACION = 'personalizacion';
const SK_APP = 'app';
const PK_RATIO_HORAS_LOCAL = 'RATIO_HORAS_LOCAL';

function numPositivo(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** @returns {Promise<number>} €/h por defecto (0 si no configurado) */
export async function getImporteHoraDefecto() {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.ajustes,
      Key: { PK: PK_PERSONALIZACION, SK: SK_APP },
    }));
    return numPositivo(r.Item?.ImporteHoraDefecto);
  } catch (err) {
    console.warn('[ia/costeHora] ImporteHoraDefecto', err?.message || err);
    return 0;
  }
}

/**
 * Mapa localId → ratio €/h (> 0). Locales sin override no aparecen o tienen 0.
 * @returns {Promise<Map<string, number>>}
 */
export async function getRatiosHorasPorLocal() {
  const map = new Map();
  try {
    let lastKey = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const r = await docClient.send(new QueryCommand({
        TableName: tables.ajustes,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK_RATIO_HORAS_LOCAL },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const it of r.Items || []) {
        const id = String(it.SK ?? '').trim();
        if (!id) continue;
        const ratio = numPositivo(it.ratio);
        if (ratio > 0) map.set(id, ratio);
      }
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
  } catch (err) {
    console.warn('[ia/costeHora] RATIO_HORAS_LOCAL', err?.message || err);
  }
  return map;
}

/**
 * Coste €/h efectivo por local.
 * @param {string} localId
 * @param {Map<string, number>} ratiosLocal
 * @param {number} importeDefecto
 * @returns {number|null} null si no hay coste configurado
 */
export function costeHoraEfectivo(localId, ratiosLocal, importeDefecto) {
  const override = numPositivo(ratiosLocal?.get(String(localId)));
  if (override > 0) return override;
  const def = numPositivo(importeDefecto);
  return def > 0 ? def : null;
}

/**
 * Carga defecto + ratios y resuelve el €/h efectivo para cada localId.
 * @param {string[]} localIds
 * @returns {Promise<Map<string, number|null>>}
 */
export async function cargarCosteHoraPorLocal(localIds) {
  const ids = (localIds || []).map((id) => String(id));
  const [importeDefecto, ratiosLocal] = await Promise.all([
    getImporteHoraDefecto(),
    getRatiosHorasPorLocal(),
  ]);
  const out = new Map();
  for (const id of ids) {
    out.set(id, costeHoraEfectivo(id, ratiosLocal, importeDefecto));
  }
  return out;
}
