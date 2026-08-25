/**
 * Agrupaciones de familias Ágora para Informes IA (ventas por artículo).
 *
 * Persistencia: Igp_Ajustes (mismo patrón que MIA_GRUPOS_FAMILIAS).
 *   PK = 'IA_GRUPOS_FAMILIAS'
 *   SK = id del grupo
 *   Campos: nombre, familiaIds (FamilyId Ágora), orden?, activo?
 */

import { randomUUID } from 'crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { canonicalFamilyId, listFamiliasMia } from '../mia/gruposFamilias.js';

export const PK_IA_GRUPOS_FAMILIAS = 'IA_GRUPOS_FAMILIAS';

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeFamiliaIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const el of raw) {
    const id = canonicalFamilyId(el);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} it
 * @returns {{ id: string, nombre: string, familiaIds: string[], orden: number, activo: boolean } | null}
 */
function mapGrupoItem(it) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.SK ?? it.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    nombre: typeof it.nombre === 'string' ? it.nombre.trim() : '',
    familiaIds: normalizeFamiliaIds(it.familiaIds),
    orden: typeof it.orden === 'number' && Number.isFinite(it.orden) ? it.orden : 0,
    activo: it.activo !== false,
  };
}

/**
 * Lista grupos IA desde ajustes.
 * @param {{ todos?: boolean }} [opts]
 * @returns {Promise<Array<{ id: string, nombre: string, familiaIds: string[], orden: number, activo: boolean }>>}
 */
export async function listGruposFamiliasIa(opts = {}) {
  const todos = opts.todos === true;
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.ajustes,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK_IA_GRUPOS_FAMILIAS },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  return items
    .map(mapGrupoItem)
    .filter(Boolean)
    .filter((g) => (todos ? true : g.activo !== false))
    .sort(
      (a, b) =>
        a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }),
    );
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, nombre: string, familiaIds: string[], orden: number, activo: boolean } | null>}
 */
export async function getGrupoFamiliasIa(id) {
  const sk = String(id ?? '').trim();
  if (!sk) return null;
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.ajustes,
        Key: { PK: PK_IA_GRUPOS_FAMILIAS, SK: sk },
      }),
    );
    return mapGrupoItem(r.Item || null);
  } catch {
    return null;
  }
}

/**
 * @param {{ id?: string, nombre: string, familiaIds: string[], orden?: number, activo?: boolean }} body
 * @returns {Promise<{ id: string, nombre: string, familiaIds: string[], orden: number, activo: boolean }>}
 */
export async function upsertGrupoFamiliasIa(body) {
  const nombre = String(body?.nombre ?? '').trim();
  if (!nombre) {
    throw Object.assign(new Error('nombre es obligatorio'), { status: 400 });
  }
  const familiaIds = normalizeFamiliaIds(body?.familiaIds);
  if (familiaIds.length === 0) {
    throw Object.assign(new Error('familiaIds debe ser un array no vacío'), { status: 400 });
  }

  let id = String(body?.id ?? '').trim();
  if (!id) id = `gf_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const orden =
    body?.orden != null && Number.isFinite(Number(body.orden))
      ? Number(body.orden)
      : 0;
  const activo = body?.activo !== false;

  const item = {
    PK: PK_IA_GRUPOS_FAMILIAS,
    SK: id,
    nombre,
    familiaIds,
    orden,
    activo,
    actualizadoEn: new Date().toISOString(),
  };

  await docClient.send(
    new PutCommand({
      TableName: tables.ajustes,
      Item: item,
    }),
  );

  return mapGrupoItem(item);
}

/**
 * @param {string} id
 * @returns {Promise<{ ok: true, id: string }>}
 */
export async function deleteGrupoFamiliasIa(id) {
  const sk = String(id ?? '').trim();
  if (!sk) {
    throw Object.assign(new Error('id es obligatorio'), { status: 400 });
  }
  await docClient.send(
    new DeleteCommand({
      TableName: tables.ajustes,
      Key: { PK: PK_IA_GRUPOS_FAMILIAS, SK: sk },
    }),
  );
  return { ok: true, id: sk };
}

/**
 * Familias para multi-select (reutiliza listado MIA; no exige permiso mia).
 * @returns {Promise<{ familias: Array<{ id: string, nombre: string }>, source: 'agora' | 'dynamo' }>}
 */
export async function listFamiliasIa() {
  return listFamiliasMia();
}
