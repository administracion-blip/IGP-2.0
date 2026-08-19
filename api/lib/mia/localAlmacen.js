/**
 * Mapa local ↔ almacén(es) para MIA.
 *
 * Matching por igualdad exacta de nombre normalizado (mismo criterio que
 * `api/lib/pedidos/almacenGeneral.js` / pedidosSociedades): el local guarda
 * nombres CSV en `almacen origen` y el maestro `igp_Almacenes` tiene Id/Nombre.
 * No usar includes laxo (atribuiría almacenes equivocados).
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { normalizarNombreAlmacen } from '../pedidos/almacenGeneral.js';
import { formatId6 } from '../usuarioLocales.js';
import { normalizeWarehouseId } from './keys.js';

export const CAMPO_ALMACENES_LOCAL = 'almacen origen';

function parseAlmacenesLocal(val) {
  if (val == null || String(val).trim() === '') return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function scanProjection(tableName, projection, names) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: projection,
        ...(names ? { ExpressionAttributeNames: names } : {}),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Construye el mapa bidireccional local ↔ warehouse.
 * @returns {Promise<{
 *   locales: Array<object>,
 *   almacenes: Array<object>,
 *   porLocalId: Record<string, string[]>,
 *   porWarehouseId: Record<string, string[]>,
 *   mismatches: { nombresSinAlmacen: Array<object>, almacenesSinLocal: Array<object> },
 * }>}
 */
export async function buildMapaLocalAlmacen() {
  const [localesRaw, almacenesRaw] = await Promise.all([
    scanProjection(
      tables.locales,
      'id_Locales, nombre, agoraCode, #almacenes',
      { '#almacenes': CAMPO_ALMACENES_LOCAL },
    ),
    scanProjection(tables.almacenes, 'Id, Nombre'),
  ]);

  /** @type {Map<string, { id: string, nombre: string }>} */
  const almacenesPorNombre = new Map();
  const almacenes = [];
  for (const a of almacenesRaw) {
    const id = normalizeWarehouseId(a.Id);
    if (!id || id === '000000') continue;
    const nombre = String(a.Nombre ?? '').trim();
    const entry = { id, nombre };
    almacenes.push(entry);
    const key = normalizarNombreAlmacen(nombre);
    if (key && !almacenesPorNombre.has(key)) {
      almacenesPorNombre.set(key, entry);
    }
  }

  /** @type {Record<string, string[]>} */
  const porLocalId = {};
  /** @type {Record<string, string[]>} */
  const porWarehouseId = {};
  const nombresSinAlmacen = [];
  const locales = [];

  for (const l of localesRaw) {
    const id = formatId6(l.id_Locales);
    if (!id || id === '000000') continue;
    const nombres = parseAlmacenesLocal(l[CAMPO_ALMACENES_LOCAL]);
    const warehouseIds = [];
    const unmatchedNombres = [];
    for (const nom of nombres) {
      const hit = almacenesPorNombre.get(normalizarNombreAlmacen(nom));
      if (!hit) {
        unmatchedNombres.push(nom);
        nombresSinAlmacen.push({ localId: id, localNombre: String(l.nombre ?? '').trim(), nombreAlmacen: nom });
        continue;
      }
      if (!warehouseIds.includes(hit.id)) warehouseIds.push(hit.id);
      if (!porWarehouseId[hit.id]) porWarehouseId[hit.id] = [];
      if (!porWarehouseId[hit.id].includes(id)) porWarehouseId[hit.id].push(id);
    }
    porLocalId[id] = warehouseIds;
    locales.push({
      id,
      nombre: String(l.nombre ?? '').trim(),
      agoraCode: l.agoraCode != null ? String(l.agoraCode).trim() : '',
      almacenesNombres: nombres,
      warehouseIds,
      unmatchedNombres,
    });
  }

  const almacenesConLocales = almacenes.map((a) => ({
    ...a,
    localIds: porWarehouseId[a.id] || [],
  }));

  const almacenesSinLocal = almacenesConLocales
    .filter((a) => a.localIds.length === 0)
    .map((a) => ({ warehouseId: a.id, nombre: a.nombre }));

  return {
    locales,
    almacenes: almacenesConLocales,
    porLocalId,
    porWarehouseId,
    mismatches: { nombresSinAlmacen, almacenesSinLocal },
  };
}

/** Ids de almacén del maestro (para sync global). */
export async function listWarehouseIds() {
  const items = await scanProjection(tables.almacenes, 'Id');
  const ids = [];
  for (const a of items) {
    const id = normalizeWarehouseId(a.Id);
    if (id && id !== '000000') ids.push(id);
  }
  return ids;
}
