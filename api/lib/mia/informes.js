/**
 * Persistencia de informes MIA (cabecera + líneas).
 */

import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  normalizeProductId,
  normalizeWarehouseId,
  pkInforme,
  skInformeLinea,
  skInformeMeta,
} from './keys.js';

const ESTADOS_EDITABLES = new Set(['calculado', 'revisado']);

const GSI_WAREHOUSE = 'WarehouseId-CreadoEn-index';

function tableInformes() {
  return tables.miaInformes;
}

function tableLineas() {
  return tables.miaInformeLineas;
}

async function batchPut(table, items) {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let requestItems = {
      [table]: chunk.map((Item) => ({ PutRequest: { Item } })),
    };
    let attempts = 0;
    while (requestItems[table]?.length && attempts < 8) {
      const r = await docClient.send(new BatchWriteCommand({ RequestItems: requestItems }));
      const unprocessed = r.UnprocessedItems?.[table];
      if (!unprocessed?.length) {
        requestItems = { [table]: [] };
        break;
      }
      requestItems = { [table]: unprocessed };
      attempts += 1;
      await new Promise((res) => setTimeout(res, 100 * attempts));
    }
    if (requestItems[table]?.length) {
      throw new Error(
        `BatchWrite incompleto en ${table}: ${requestItems[table].length} UnprocessedItems tras reintentos`,
      );
    }
  }
}

/**
 * Guarda cabecera META + líneas LINE#.
 * @param {object} meta
 * @param {Array<object>} lineas
 */
export async function putInformeCompleto(meta, lineas) {
  const informeId = String(meta.informeId || meta.id || '').trim();
  if (!informeId) throw new Error('informeId obligatorio');
  const PK = pkInforme(informeId);
  const Item = {
    ...meta,
    PK,
    SK: skInformeMeta(),
    informeId,
    WarehouseId: normalizeWarehouseId(meta.warehouseId || meta.WarehouseId),
  };
  await docClient.send(new PutCommand({ TableName: tableInformes(), Item }));

  const lineItems = (lineas || []).map((ln) => {
    const supplierId = String(ln.proveedorId || ln.supplierId || 'SIN_PROVEEDOR').trim() || 'SIN_PROVEEDOR';
    const productId = String(ln.productId || ln.ProductId || '').trim();
    return {
      ...ln,
      PK,
      SK: skInformeLinea(supplierId, productId),
      informeId,
      proveedorId: supplierId,
      productId,
    };
  });
  if (lineItems.length) {
    await batchPut(tableLineas(), lineItems);
  }
  return { meta: Item, lineas: lineItems };
}

export async function getInformeMeta(informeId) {
  const PK = pkInforme(informeId);
  if (!PK) return null;
  const r = await docClient.send(
    new GetCommand({ TableName: tableInformes(), Key: { PK, SK: skInformeMeta() } }),
  );
  return r.Item || null;
}

export async function listInformeLineas(informeId) {
  const PK = pkInforme(informeId);
  if (!PK) return [];
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tableLineas(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
        ExpressionAttributeValues: { ':pk': PK, ':pref': 'LINE#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Informe completo: meta + líneas + agrupación por proveedor.
 */
export async function getInformeCompleto(informeId) {
  const id = String(informeId || '').trim();
  if (!id) return null;
  const [meta, lineas] = await Promise.all([getInformeMeta(id), listInformeLineas(id)]);
  if (!meta) return null;
  return {
    informe: meta,
    lineas,
    porProveedor: agruparLineasPorProveedor(lineas),
  };
}

export function agruparLineasPorProveedor(lineas) {
  /** @type {Record<string, object[]>} */
  const out = {};
  for (const ln of lineas || []) {
    const key = String(ln.proveedorId || 'SIN_PROVEEDOR').trim() || 'SIN_PROVEEDOR';
    if (!out[key]) out[key] = [];
    out[key].push(ln);
  }
  return out;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function lineKey(proveedorId, productId) {
  const s = String(proveedorId ?? '').trim() || 'SIN_PROVEEDOR';
  const p = normalizeProductId(productId);
  return `${s}#${p}`;
}

/**
 * Totales META a partir de líneas (excluye omitidas del pedido).
 * @param {Array<object>} lineas
 */
export function recalcTotales(lineas) {
  let productosConPedido = 0;
  let unidadesPedido = 0;
  let costeTotal = 0;
  for (const ln of lineas || []) {
    if (ln?.omitida === true) continue;
    const qty = toNum(ln.cantidadPedida != null ? ln.cantidadPedida : ln.qty, 0);
    if (qty <= 0) continue;
    productosConPedido += 1;
    unidadesPedido += qty;
    const costeUnit = toNum(ln.costeUnitario, 0);
    const costeLinea =
      ln.costeLinea != null && Number.isFinite(Number(ln.costeLinea))
        ? toNum(ln.costeLinea, 0)
        : Math.round(qty * costeUnit * 100) / 100;
    costeTotal += costeLinea;
  }
  return {
    lineas: (lineas || []).length,
    productosConPedido,
    unidadesPedido: Math.round(unidadesPedido * 1000) / 1000,
    costeTotal: Math.round(costeTotal * 100) / 100,
  };
}

/**
 * Actualiza campos de META (Put completo mezclando patch).
 * @param {string} informeId
 * @param {object} patch
 */
export async function updateMeta(informeId, patch) {
  const id = String(informeId || '').trim();
  if (!id) {
    const err = new Error('informeId obligatorio');
    err.status = 400;
    throw err;
  }
  const current = await getInformeMeta(id);
  if (!current) {
    const err = new Error('Informe no encontrado');
    err.status = 404;
    throw err;
  }
  const PK = pkInforme(id);
  const Item = {
    ...current,
    ...(patch || {}),
    PK,
    SK: skInformeMeta(),
    informeId: id,
    WarehouseId: normalizeWarehouseId(patch?.WarehouseId || patch?.warehouseId || current.WarehouseId || current.warehouseId),
  };
  await docClient.send(new PutCommand({ TableName: tableInformes(), Item }));
  return Item;
}

/**
 * Ajusta líneas existentes y recalcula totales META.
 * Body lines: [{ productId, proveedorId, cantidadPedida, omitida? }]
 * Estado permanece en calculado|revisado (pasa a revisado tras editar).
 *
 * @param {string} informeId
 * @param {Array<object>} ajustes
 * @param {{ usuario?: object }} [opts]
 */
export async function updateLineas(informeId, ajustes, opts = {}) {
  const id = String(informeId || '').trim();
  if (!id) {
    const err = new Error('informeId obligatorio');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(ajustes) || ajustes.length === 0) {
    const err = new Error('lineas debe ser un array no vacío');
    err.status = 400;
    throw err;
  }

  const meta = await getInformeMeta(id);
  if (!meta) {
    const err = new Error('Informe no encontrado');
    err.status = 404;
    throw err;
  }
  const estado = String(meta.estado || '').trim();
  if (!ESTADOS_EDITABLES.has(estado)) {
    const err = new Error(
      estado === 'aprobado'
        ? 'Informe ya aprobado; no se pueden ajustar líneas'
        : `Estado '${estado || 'desconocido'}' no permite ajustar líneas`,
    );
    err.status = 409;
    throw err;
  }

  const lineas = await listInformeLineas(id);
  /** @type {Map<string, object>} */
  const byKey = new Map();
  for (const ln of lineas) {
    byKey.set(lineKey(ln.proveedorId, ln.productId), ln);
  }

  const missing = [];
  const touched = [];
  for (const adj of ajustes) {
    const productId = normalizeProductId(adj?.productId ?? adj?.ProductId);
    const proveedorId = String(adj?.proveedorId ?? adj?.supplierId ?? '').trim();
    if (!productId || !proveedorId) {
      const err = new Error('Cada línea requiere productId y proveedorId');
      err.status = 400;
      throw err;
    }
    const key = lineKey(proveedorId, productId);
    const existing = byKey.get(key);
    if (!existing) {
      missing.push({ productId, proveedorId });
      continue;
    }

    if (adj.cantidadPedida != null || adj.qty != null) {
      const qty = toNum(adj.cantidadPedida != null ? adj.cantidadPedida : adj.qty, NaN);
      if (!Number.isFinite(qty) || qty < 0) {
        const err = new Error(`cantidadPedida inválida para ${productId}`);
        err.status = 400;
        throw err;
      }
      existing.qty = qty;
      existing.cantidadPedida = qty;
      const costeUnit = toNum(existing.costeUnitario, 0);
      existing.costeLinea = Math.round(qty * costeUnit * 100) / 100;
    }
    if (adj.omitida !== undefined) {
      existing.omitida = adj.omitida === true;
    }
    existing.actualizadoEn = new Date().toISOString();
    touched.push(existing);
  }

  if (missing.length) {
    const err = new Error(
      `Líneas no encontradas: ${missing.map((m) => `${m.proveedorId}/${m.productId}`).join(', ')}`,
    );
    err.status = 400;
    err.missing = missing;
    throw err;
  }

  if (touched.length) {
    await batchPut(tableLineas(), touched);
  }

  const totales = recalcTotales(lineas);
  const ahora = new Date().toISOString();
  const usuario = opts.usuario || {};
  const metaActualizado = await updateMeta(id, {
    totales,
    estado: 'revisado',
    revisadoEn: ahora,
    revisadoPor: {
      email: usuario.email || null,
      id_usuario: usuario.id_usuario || usuario.sub || null,
      nombre: usuario.Nombre || usuario.nombre || null,
    },
  });

  return {
    informe: metaActualizado,
    lineas,
    porProveedor: agruparLineasPorProveedor(lineas),
    actualizadas: touched.length,
  };
}

/**
 * Listado opcional por warehouse (GSI WarehouseId-CreadoEn-index), más recientes primero.
 * @param {string|number} warehouseId
 * @param {{ limit?: number }} [opts]
 */
export async function listInformesByWarehouse(warehouseId, opts = {}) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') return [];
  const limit = Math.min(100, Math.max(1, Math.floor(Number(opts.limit) || 30)));

  try {
    const items = [];
    let lastKey = null;
    do {
      const r = await docClient.send(
        new QueryCommand({
          TableName: tableInformes(),
          IndexName: GSI_WAREHOUSE,
          KeyConditionExpression: 'WarehouseId = :w',
          ExpressionAttributeValues: { ':w': wid },
          ScanIndexForward: false,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }),
      );
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
      if (items.length >= limit) break;
    } while (lastKey);
    return items.slice(0, limit);
  } catch {
    // Fallback si el GSI aún no existe: scan filtrado.
    const items = [];
    let lastKey = null;
    do {
      const r = await docClient.send(
        new ScanCommand({
          TableName: tableInformes(),
          FilterExpression: 'WarehouseId = :w AND SK = :sk',
          ExpressionAttributeValues: { ':w': wid, ':sk': skInformeMeta() },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }),
      );
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    return items.slice(0, limit);
  }
}
