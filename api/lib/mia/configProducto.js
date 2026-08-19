/**
 * CRUD mínimo de Igp_MiaConfigProducto (PK WAREHOUSE# / SK PRODUCT#).
 */

import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  normalizeProductId,
  normalizeWarehouseId,
  pkWarehouse,
  skProduct,
} from './keys.js';

function tableName() {
  return tables.miaConfigProducto;
}

/**
 * Campos de configuración de negocio que el sync de stock NO debe pisar.
 */
export const CONFIG_PRESERVE_KEYS = [
  'colchon',
  'proveedorId',
  'proveedorNombre',
  'activo',
  'modoDemanda',
  'formatoCompra',
  'notas',
];

export async function getConfigProducto(warehouseId, productId) {
  const PK = pkWarehouse(warehouseId);
  const SK = skProduct(productId);
  if (!PK || !SK) return null;
  const r = await docClient.send(new GetCommand({ TableName: tableName(), Key: { PK, SK } }));
  return r.Item || null;
}

/**
 * Lista config (+ snapshots de stock) de un almacén.
 * @param {string|number} warehouseId
 */
export async function listConfigByWarehouse(warehouseId) {
  const PK = pkWarehouse(warehouseId);
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
 * Upsert de configuración de negocio (no borra Quantity/stockSyncedAt si no se envían).
 * @param {{ warehouseId: string|number, productId: string|number } & Record<string, unknown>} input
 */
export async function upsertConfigProducto(input) {
  const warehouseId = normalizeWarehouseId(input.warehouseId);
  const productId = normalizeProductId(input.productId);
  if (!warehouseId || warehouseId === '000000') {
    throw new Error('warehouseId es obligatorio');
  }
  if (!productId) throw new Error('productId es obligatorio');

  const PK = pkWarehouse(warehouseId);
  const SK = skProduct(productId);
  const existing = (await getConfigProducto(warehouseId, productId)) || {};
  const now = new Date().toISOString();

  const Item = {
    ...existing,
    PK,
    SK,
    WarehouseId: warehouseId,
    ProductId: productId,
    updatedAt: now,
  };

  for (const key of CONFIG_PRESERVE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      Item[key] = input[key];
    }
  }

  if (Item.activo === undefined) Item.activo = existing.activo !== false;
  if (Item.modoDemanda === undefined) Item.modoDemanda = existing.modoDemanda || 'directo';

  // Solo aceptar escandallo si el flag está activo (Fase 2: default off).
  const escandallosOn = process.env.MIA_ESCANDALLOS_ENABLED === 'true';
  if (Item.modoDemanda === 'escandallo' && !escandallosOn) {
    Item.modoDemanda = 'directo';
    Item.modoDemandaAviso = 'escandallos_deshabilitados';
  } else if (Item.modoDemandaAviso) {
    delete Item.modoDemandaAviso;
  }

  await docClient.send(new PutCommand({ TableName: tableName(), Item }));
  return Item;
}

/**
 * Merge de stock Ágora sobre un ítem existente (conserva colchón/proveedor/activo).
 */
export function mergeStockIntoItem(existing, { warehouseId, productId, quantity, stockSyncedAt }) {
  const wid = normalizeWarehouseId(warehouseId);
  const pid = normalizeProductId(productId);
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const preserved = {};
  for (const key of CONFIG_PRESERVE_KEYS) {
    if (base[key] !== undefined) preserved[key] = base[key];
  }
  return {
    ...base,
    ...preserved,
    PK: pkWarehouse(wid),
    SK: skProduct(pid),
    WarehouseId: wid,
    ProductId: pid,
    Quantity: quantity,
    stockSyncedAt,
    source: 'agora-stocks',
    updatedAt: stockSyncedAt,
    activo: preserved.activo !== undefined ? preserved.activo : (base.activo !== false),
    modoDemanda: preserved.modoDemanda || base.modoDemanda || 'directo',
  };
}
