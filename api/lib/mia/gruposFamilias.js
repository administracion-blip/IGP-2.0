/**
 * Agrupaciones de familias Ágora para filtro MIA.
 *
 * Persistencia: Igp_Ajustes (mismo patrón que AGRUPACION_OBJETIVOS).
 *   PK = 'MIA_GRUPOS_FAMILIAS'
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
import { exportFamilies } from '../agora/client.js';

export const PK_MIA_GRUPOS_FAMILIAS = 'MIA_GRUPOS_FAMILIAS';

/**
 * FamilyId canónico (string sin padding numérico).
 * @param {unknown} raw
 * @returns {string}
 */
export function canonicalFamilyId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? String(n) : s;
  }
  return s;
}

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
 * Lista grupos MIA desde ajustes.
 * @param {{ todos?: boolean }} [opts] — si todos=true incluye inactivos; por defecto solo activos
 * @returns {Promise<Array<{ id: string, nombre: string, familiaIds: string[], orden: number, activo: boolean }>>}
 */
export async function listGruposFamilias(opts = {}) {
  const todos = opts.todos === true;
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.ajustes,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK_MIA_GRUPOS_FAMILIAS },
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
 * Obtiene un grupo por id (incluye inactivos).
 * @param {string} id
 * @returns {Promise<{ id: string, nombre: string, familiaIds: string[], orden: number, activo: boolean } | null>}
 */
export async function getGrupoFamilias(id) {
  const sk = String(id ?? '').trim();
  if (!sk) return null;
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.ajustes,
        Key: { PK: PK_MIA_GRUPOS_FAMILIAS, SK: sk },
      }),
    );
    return mapGrupoItem(r.Item || null);
  } catch {
    return null;
  }
}

/**
 * Upsert de grupo.
 * @param {{ id?: string, nombre: string, familiaIds: string[], orden?: number, activo?: boolean }} body
 * @returns {Promise<{ id: string, nombre: string, familiaIds: string[], orden: number, activo: boolean }>}
 */
export async function upsertGrupoFamilias(body) {
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
    PK: PK_MIA_GRUPOS_FAMILIAS,
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
 * Borra un grupo por id.
 * @param {string} id
 * @returns {Promise<{ ok: true, id: string }>}
 */
export async function deleteGrupoFamilias(id) {
  const sk = String(id ?? '').trim();
  if (!sk) {
    throw Object.assign(new Error('id es obligatorio'), { status: 400 });
  }
  await docClient.send(
    new DeleteCommand({
      TableName: tables.ajustes,
      Key: { PK: PK_MIA_GRUPOS_FAMILIAS, SK: sk },
    }),
  );
  return { ok: true, id: sk };
}

/**
 * Familias para multi-select: Ágora exportFamilies, fallback Dynamo productos.
 * @returns {Promise<{ familias: Array<{ id: string, nombre: string }>, source: 'agora' | 'dynamo' }>}
 */
export async function listFamiliasMia() {
  try {
    const raw = await exportFamilies();
    const familias = [];
    const seen = new Set();
    for (const f of raw || []) {
      if (!f || typeof f !== 'object') continue;
      const id = canonicalFamilyId(f.Id ?? f.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const nombre = String(f.Name ?? f.name ?? f.Nombre ?? '').trim() || id;
      familias.push({ id, nombre });
    }
    familias.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
    if (familias.length > 0) {
      return { familias, source: 'agora' };
    }
  } catch (err) {
    console.warn('[mia/familias] exportFamilies falló, fallback Dynamo:', err?.message || err);
  }

  const byId = new Map();
  let lastKey = null;
  try {
    do {
      const r = await docClient.send(
        new QueryCommand({
          TableName: tables.agoraProducts,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': 'GLOBAL' },
          ProjectionExpression: 'FamilyId, FamilyName, SK',
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }),
      );
      for (const it of r.Items || []) {
        if (String(it.SK ?? '') === '__meta__') continue;
        const id = canonicalFamilyId(it.FamilyId);
        if (!id || byId.has(id)) continue;
        const nombre = String(it.FamilyName ?? '').trim() || id;
        byId.set(id, { id, nombre });
      }
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
  } catch (err) {
    console.warn('[mia/familias] Query Dynamo falló:', err?.message || err);
  }

  const familias = [...byId.values()].sort((a, b) =>
    a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }),
  );
  return { familias, source: 'dynamo' };
}
