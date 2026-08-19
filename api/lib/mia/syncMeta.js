/**
 * Lectura/escritura de Igp_MiaSyncMeta (PK GLOBAL, SK tipo).
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { PK_SYNC_META, SK_STOCKS, skStocksWarehouse } from './keys.js';

function tableName() {
  return tables.miaSyncMeta;
}

/**
 * @param {string} sk
 * @returns {Promise<object|null>}
 */
export async function getSyncMeta(sk) {
  const Key = { PK: PK_SYNC_META, SK: String(sk || '').trim() };
  if (!Key.SK) return null;
  const r = await docClient.send(new GetCommand({ TableName: tableName(), Key }));
  return r.Item || null;
}

/**
 * @param {string} sk
 * @param {object} fields
 */
export async function setSyncMeta(sk, fields = {}) {
  const SK = String(sk || '').trim();
  if (!SK) throw new Error('SK de SyncMeta obligatorio');
  const now = new Date().toISOString();
  const Item = {
    PK: PK_SYNC_META,
    SK,
    updatedAt: now,
    ...fields,
  };
  await docClient.send(new PutCommand({ TableName: tableName(), Item }));
  return Item;
}

export async function getStocksSyncMeta(warehouseId) {
  if (warehouseId != null && String(warehouseId).trim() !== '') {
    return getSyncMeta(skStocksWarehouse(warehouseId));
  }
  return getSyncMeta(SK_STOCKS);
}

/**
 * Marca intento de sync de stocks (antes de llamar a Ágora).
 */
export async function markStocksAttempt(warehouseId, extra = {}) {
  const sk = warehouseId != null && String(warehouseId).trim() !== ''
    ? skStocksWarehouse(warehouseId)
    : SK_STOCKS;
  const prev = (await getSyncMeta(sk)) || {};
  return setSyncMeta(sk, {
    ...prev,
    lastAttemptAt: new Date().toISOString(),
    source: 'agora-export-master',
    ...extra,
  });
}

/**
 * Éxito de sync (incluye count 0).
 */
export async function markStocksOk(warehouseId, { count = 0, ...extra } = {}) {
  const sk = warehouseId != null && String(warehouseId).trim() !== ''
    ? skStocksWarehouse(warehouseId)
    : SK_STOCKS;
  const prev = (await getSyncMeta(sk)) || {};
  return setSyncMeta(sk, {
    ...prev,
    lastOkAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastError: null,
    count: Number(count) || 0,
    source: 'agora-export-master',
    ...extra,
  });
}

/**
 * Error de sync: no actualiza lastOkAt.
 */
export async function markStocksError(warehouseId, errorMessage, extra = {}) {
  const sk = warehouseId != null && String(warehouseId).trim() !== ''
    ? skStocksWarehouse(warehouseId)
    : SK_STOCKS;
  const prev = (await getSyncMeta(sk)) || {};
  return setSyncMeta(sk, {
    ...prev,
    lastAttemptAt: new Date().toISOString(),
    lastError: String(errorMessage || 'Error desconocido').slice(0, 500),
    source: 'agora-export-master',
    ...extra,
  });
}
