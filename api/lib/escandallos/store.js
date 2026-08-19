/**
 * Persistencia Igp_Escandallos (cabecera META + líneas ING#).
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { normalizeProductId, pkProducto, skIng, skMeta } from './keys.js';

const GSI_INGREDIENTE = 'GsiIngrediente';

function tableName() {
  return tables.escandallos;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapMeta(item) {
  if (!item || item.SK !== 'META') return null;
  const imagenKey =
    item.imagen_key != null && String(item.imagen_key).trim() !== ''
      ? String(item.imagen_key).trim()
      : '';
  return {
    productoId: String(item.productoId || '').trim() || normalizeProductId(String(item.PK || '').replace(/^PRODUCT#/, '')),
    nombre: item.nombre != null ? String(item.nombre).trim() : '',
    udReceta: item.udReceta != null ? String(item.udReceta) : '',
    activo: item.activo !== false,
    imagen_key: imagenKey,
    updatedAt: item.updatedAt || null,
  };
}

function mapIng(item) {
  if (!item || !String(item.SK || '').startsWith('ING#')) return null;
  return {
    productoId: String(item.productoId || '').trim(),
    ingredienteId: String(item.ingredienteId || '').trim() || normalizeProductId(String(item.SK || '').replace(/^ING#/, '')),
    nombre: item.nombre != null ? String(item.nombre).trim() : '',
    cantidad: toNum(item.cantidad, 0),
    unidad: item.unidad != null ? String(item.unidad) : '',
    mermaPct: toNum(item.mermaPct, 0),
    orden: toNum(item.orden, 0),
  };
}

async function queryByProducto(productoId) {
  const PK = pkProducto(productoId);
  if (!PK) return [];
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Receta completa (META + líneas). Null si no hay META.
 * @param {string|number} productoId
 * @returns {Promise<{ meta: object, ingredientes: object[] } | null>}
 */
export async function getReceta(productoId) {
  const id = normalizeProductId(productoId);
  if (!id) return null;
  const items = await queryByProducto(id);
  const rawMeta = items.find((it) => it.SK === 'META');
  const meta = mapMeta(rawMeta);
  if (!meta) return null;
  const ingredientes = items
    .map(mapIng)
    .filter(Boolean)
    .sort((a, b) => a.orden - b.orden || a.ingredienteId.localeCompare(b.ingredienteId));
  return { meta, ingredientes };
}

/**
 * Lista cabeceras META (scan SK=META).
 * @returns {Promise<object[]>}
 */
export async function listRecetas() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tableName(),
        FilterExpression: 'SK = :meta',
        ExpressionAttributeValues: { ':meta': 'META' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items
    .map(mapMeta)
    .filter(Boolean)
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es') || a.productoId.localeCompare(b.productoId));
}

/**
 * Lista recetas con líneas ING (scan completo agrupado por PK).
 * Ignora PKs sin META. No persiste nada nuevo.
 * @returns {Promise<object[]>}
 */
export async function listRecetasConIngredientes() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tableName(),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  /** @type {Map<string, object[]>} */
  const byPk = new Map();
  for (const it of items) {
    const pk = String(it?.PK || '');
    if (!pk) continue;
    if (!byPk.has(pk)) byPk.set(pk, []);
    byPk.get(pk).push(it);
  }

  const recetas = [];
  for (const group of byPk.values()) {
    const meta = mapMeta(group.find((it) => it.SK === 'META'));
    if (!meta) continue; // solo ING sin META → ignorar
    const ingredientes = group
      .map(mapIng)
      .filter(Boolean)
      .sort((a, b) => a.orden - b.orden || a.ingredienteId.localeCompare(b.ingredienteId));
    recetas.push({ ...meta, ingredientes });
  }

  return recetas.sort(
    (a, b) =>
      String(a.nombre).localeCompare(String(b.nombre), 'es') ||
      a.productoId.localeCompare(b.productoId),
  );
}

/**
 * Productos que usan un ingrediente (GSI GsiIngrediente).
 * @param {string|number} ingredienteId
 */
export async function listUsosIngrediente(ingredienteId) {
  const id = normalizeProductId(ingredienteId);
  if (!id) return [];
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: GSI_INGREDIENTE,
        KeyConditionExpression: 'ingredienteId = :id',
        ExpressionAttributeValues: { ':id': id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items.map(mapIng).filter(Boolean);
}

const UNIDADES_CANON = new Set(['KG', 'L', 'UD']);
const UNIDAD_ALIAS = {
  kg: 'KG',
  kilo: 'KG',
  kilos: 'KG',
  kilogramo: 'KG',
  kilogramos: 'KG',
  'kg.': 'KG',
  l: 'L',
  litro: 'L',
  litros: 'L',
  lt: 'L',
  lts: 'L',
  'l.': 'L',
  ud: 'UD',
  uds: 'UD',
  unidad: 'UD',
  unidades: 'UD',
  uno: 'UD',
  un: 'UD',
};

function normalizeUnidad(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const upper = s.toUpperCase();
  if (UNIDADES_CANON.has(upper)) return upper;
  return UNIDAD_ALIAS[s.toLowerCase()] || '';
}

function validateIngrediente(raw, productoId, index) {
  const ingredienteId = normalizeProductId(raw?.ingredienteId);
  if (!ingredienteId) {
    throw Object.assign(new Error(`ingredientes[${index}]: ingredienteId es obligatorio`), { status: 400 });
  }
  if (ingredienteId === productoId) {
    throw Object.assign(new Error('Un ingrediente no puede ser el propio plato'), { status: 400, code: 'escandallo_ing_igual_plato' });
  }
  const cantidad = Number(raw?.cantidad);
  if (!Number.isFinite(cantidad) || cantidad < 0) {
    throw Object.assign(new Error(`ingredientes[${index}]: cantidad debe ser >= 0`), { status: 400 });
  }
  const mermaPct = raw?.mermaPct == null || raw?.mermaPct === '' ? 0 : Number(raw.mermaPct);
  if (!Number.isFinite(mermaPct) || mermaPct < 0 || mermaPct > 100) {
    throw Object.assign(new Error(`ingredientes[${index}]: mermaPct debe estar entre 0 y 100`), { status: 400 });
  }
  const orden = raw?.orden == null || raw?.orden === '' ? index : Number(raw.orden);
  if (!Number.isFinite(orden)) {
    throw Object.assign(new Error(`ingredientes[${index}]: orden inválido`), { status: 400 });
  }
  const unidad = normalizeUnidad(raw?.unidad);
  if (!unidad) {
    throw Object.assign(new Error(`ingredientes[${index}]: unidad debe ser KG, L o UD`), { status: 400 });
  }
  return {
    ingredienteId,
    nombre: raw?.nombre != null ? String(raw.nombre).trim() : '',
    cantidad,
    unidad,
    mermaPct,
    orden,
  };
}

/**
 * Upsert de receta: escribe META + INGs y borra líneas quitadas.
 * @param {string|number} productoId
 * @param {{ nombre?: string, udReceta?: string, activo?: boolean, ingredientes?: object[] }} body
 */
export async function putReceta(productoId, body) {
  const id = normalizeProductId(productoId);
  if (!id) {
    throw Object.assign(new Error('productoId es obligatorio'), { status: 400 });
  }

  const rawIngs = Array.isArray(body?.ingredientes) ? body.ingredientes : [];
  const seen = new Set();
  const ingredientes = [];
  for (let i = 0; i < rawIngs.length; i += 1) {
    const ing = validateIngrediente(rawIngs[i], id, i);
    if (seen.has(ing.ingredienteId)) {
      throw Object.assign(new Error(`Ingrediente duplicado: ${ing.ingredienteId}`), { status: 400 });
    }
    seen.add(ing.ingredienteId);
    ingredientes.push(ing);
  }

  const activo = body?.activo !== false;
  if (activo && ingredientes.length === 0) {
    throw Object.assign(new Error('Una receta activa debe tener al menos un ingrediente'), {
      status: 400,
    });
  }

  const existing = await queryByProducto(id);
  const existingMeta = existing.find((it) => it.SK === 'META') || null;
  const existingIngSks = new Set(
    existing.filter((it) => String(it.SK || '').startsWith('ING#')).map((it) => it.SK),
  );
  const nextIngSks = new Set(ingredientes.map((ing) => skIng(ing.ingredienteId)));

  let imagenKey = '';
  if (body?.imagen_key !== undefined) {
    imagenKey = body.imagen_key != null && String(body.imagen_key).trim() !== ''
      ? String(body.imagen_key).trim()
      : '';
  } else if (existingMeta?.imagen_key != null && String(existingMeta.imagen_key).trim() !== '') {
    imagenKey = String(existingMeta.imagen_key).trim();
  }

  const now = new Date().toISOString();
  const PK = pkProducto(id);
  const metaItem = {
    PK,
    SK: skMeta(),
    productoId: id,
    nombre: body?.nombre != null ? String(body.nombre).trim() : '',
    udReceta: normalizeUnidad(body?.udReceta) || 'UD',
    activo,
    ...(imagenKey ? { imagen_key: imagenKey } : {}),
    updatedAt: now,
  };

  const writes = [
    docClient.send(new PutCommand({ TableName: tableName(), Item: metaItem })),
    ...ingredientes.map((ing) =>
      docClient.send(
        new PutCommand({
          TableName: tableName(),
          Item: {
            PK,
            SK: skIng(ing.ingredienteId),
            productoId: id,
            ingredienteId: ing.ingredienteId,
            nombre: ing.nombre,
            cantidad: ing.cantidad,
            unidad: ing.unidad,
            mermaPct: ing.mermaPct,
            orden: ing.orden,
          },
        }),
      ),
    ),
  ];

  for (const sk of existingIngSks) {
    if (nextIngSks.has(sk)) continue;
    writes.push(
      docClient.send(new DeleteCommand({ TableName: tableName(), Key: { PK, SK: sk } })),
    );
  }

  await Promise.all(writes);
  return { meta: mapMeta(metaItem), ingredientes };
}

/**
 * Actualiza solo imagen_key en META. 404 si no existe la receta.
 * @param {string|number} productoId
 * @param {string|null|undefined} key — vacío/null limpia la imagen
 */
export async function setImagenKey(productoId, key) {
  const id = normalizeProductId(productoId);
  if (!id) {
    throw Object.assign(new Error('productoId es obligatorio'), { status: 400 });
  }
  const PK = pkProducto(id);
  const SK = skMeta();
  const existing = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: { PK, SK } }),
  );
  if (!existing.Item || existing.Item.SK !== 'META') {
    throw Object.assign(new Error('Receta no encontrada'), { status: 404, code: 'escandallo_sin_meta' });
  }
  const imagenKey = key != null && String(key).trim() !== '' ? String(key).trim() : '';
  const now = new Date().toISOString();
  if (imagenKey) {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK, SK },
        UpdateExpression: 'SET imagen_key = :k, updatedAt = :u',
        ExpressionAttributeValues: { ':k': imagenKey, ':u': now },
      }),
    );
  } else {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK, SK },
        UpdateExpression: 'SET updatedAt = :u REMOVE imagen_key',
        ExpressionAttributeValues: { ':u': now },
      }),
    );
  }
  return { ok: true, productoId: id, imagen_key: imagenKey || null };
}

/**
 * Borra META + todas las líneas del plato.
 * @param {string|number} productoId
 */
export async function deleteReceta(productoId) {
  const id = normalizeProductId(productoId);
  if (!id) {
    throw Object.assign(new Error('productoId es obligatorio'), { status: 400 });
  }
  const items = await queryByProducto(id);
  if (!items.length) {
    return { ok: true, productoId: id, deleted: 0 };
  }
  const PK = pkProducto(id);
  await Promise.all(
    items.map((it) =>
      docClient.send(new DeleteCommand({ TableName: tableName(), Key: { PK, SK: it.SK } })),
    ),
  );
  return { ok: true, productoId: id, deleted: items.length };
}
