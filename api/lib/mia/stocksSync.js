/**
 * Sincronización de Stocks Ágora → Igp_MiaConfigProducto (merge) + SyncMeta.
 */

import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { exportStocks } from '../agora/client.js';
import { getLastSalesLinesSync } from '../dynamo/ventasProducto.js';
import { listConfigByWarehouse, mergeStockIntoItem } from './configProducto.js';
import { listWarehouseIds } from './localAlmacen.js';
import {
  markStocksAttempt,
  markStocksError,
  markStocksOk,
  getStocksSyncMeta,
} from './syncMeta.js';
import { normalizeProductId, normalizeWarehouseId, SK_STOCKS } from './keys.js';

const THROTTLE_MINUTES = parseInt(process.env.MIA_STOCKS_SYNC_THROTTLE_MINUTES || '30', 10) || 30;

export function stocksSyncThrottleMinutes() {
  return THROTTLE_MINUTES;
}

export function shouldSkipStocksSync(meta, { force = false } = {}) {
  if (force) return false;
  const iso = meta?.lastOkAt;
  if (!iso) return false;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return false;
  const elapsedMin = (Date.now() - ts) / (60 * 1000);
  return elapsedMin < THROTTLE_MINUTES;
}

function toQuantity(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function batchPutItems(items) {
  const table = tables.miaConfigProducto;
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let requestItems = {
      [table]: chunk.map((Item) => ({ PutRequest: { Item } })),
    };
    let attempts = 0;
    while (requestItems[table]?.length && attempts < 8) {
      const r = await docClient.send(new BatchWriteCommand({ RequestItems: requestItems }));
      const unprocessed = r.UnprocessedItems?.[table];
      if (!unprocessed?.length) break;
      requestItems = { [table]: unprocessed };
      attempts += 1;
      await new Promise((r) => setTimeout(r, 100 * attempts));
    }
  }
}

/**
 * Sync de un almacén: fetch Ágora + merge Put + SyncMeta por warehouse y GLOBAL.
 * @param {string|number} warehouseId
 * @param {{ force?: boolean }} [opts]
 */
export async function syncStocksForWarehouse(warehouseId, opts = {}) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') {
    throw new Error('warehouseId inválido');
  }

  const metaWh = await getStocksSyncMeta(wid);
  if (shouldSkipStocksSync(metaWh, opts)) {
    return {
      ok: true,
      skipped: true,
      reason: 'throttle',
      warehouseId: wid,
      throttleMinutes: THROTTLE_MINUTES,
      lastOkAt: metaWh?.lastOkAt || null,
      count: metaWh?.count ?? null,
    };
  }

  await markStocksAttempt(wid);

  let stocks;
  try {
    stocks = await exportStocks({ warehouseId: wid });
  } catch (err) {
    const msg = err?.message || String(err);
    await markStocksError(wid, msg);
    throw err;
  }

  const existingList = await listConfigByWarehouse(wid);
  /** @type {Map<string, object>} */
  const byProduct = new Map();
  for (const it of existingList) {
    const pid = normalizeProductId(it.ProductId || (it.SK || '').replace(/^PRODUCT#/, ''));
    if (pid) byProduct.set(pid, it);
  }

  const now = new Date().toISOString();
  const toWrite = [];
  for (const row of stocks) {
    const productId = normalizeProductId(row.ProductId ?? row.productId);
    if (!productId) continue;
    const quantity = toQuantity(row.Quantity ?? row.quantity);
    const existing = byProduct.get(productId) || null;
    const merged = mergeStockIntoItem(existing, {
      warehouseId: wid,
      productId,
      quantity,
      stockSyncedAt: now,
    });
    toWrite.push(merged);
    byProduct.set(productId, merged);
  }

  if (toWrite.length) {
    await batchPutItems(toWrite);
  }

  await markStocksOk(wid, { count: toWrite.length });

  return {
    ok: true,
    skipped: false,
    warehouseId: wid,
    fetched: stocks.length,
    upserted: toWrite.length,
    stockSyncedAt: now,
  };
}

/**
 * Sync global: todos los almacenes del maestro (o lista pasada).
 * Actualiza SyncMeta GLOBAL SK=STOCKS al final.
 */
export async function syncStocksAll(opts = {}) {
  const metaGlobal = await getStocksSyncMeta();
  if (shouldSkipStocksSync(metaGlobal, opts)) {
    return {
      ok: true,
      skipped: true,
      reason: 'throttle',
      throttleMinutes: THROTTLE_MINUTES,
      lastOkAt: metaGlobal?.lastOkAt || null,
      count: metaGlobal?.count ?? null,
    };
  }

  await markStocksAttempt(null);

  let warehouseIds = Array.isArray(opts.warehouseIds) && opts.warehouseIds.length
    ? opts.warehouseIds.map(normalizeWarehouseId).filter((id) => id && id !== '000000')
    : await listWarehouseIds();

  const results = [];
  let totalUpserted = 0;
  let errors = 0;

  for (const wid of warehouseIds) {
    try {
      const r = await syncStocksForWarehouse(wid, { force: true });
      results.push(r);
      if (!r.skipped) totalUpserted += r.upserted || 0;
    } catch (err) {
      errors += 1;
      results.push({
        ok: false,
        warehouseId: wid,
        error: err?.message || String(err),
      });
    }
  }

  if (errors > 0 && errors === warehouseIds.length) {
    const msg = `Fallaron todos los almacenes (${errors})`;
    await markStocksError(null, msg, { warehouses: warehouseIds.length, errors });
    return {
      ok: false,
      error: msg,
      warehouses: warehouseIds.length,
      errors,
      results,
    };
  }

  await markStocksOk(null, {
    count: totalUpserted,
    warehouses: warehouseIds.length,
    errors,
  });

  return {
    ok: true,
    skipped: false,
    warehouses: warehouseIds.length,
    upserted: totalUpserted,
    errors,
    results,
  };
}

/**
 * Estado agregado para GET /mia/sync/status.
 */
export async function getMiaSyncStatus() {
  const [stocksGlobal, ventasLast] = await Promise.all([
    getStocksSyncMeta(),
    getLastSalesLinesSync(docClient).catch(() => null),
  ]);

  const escandallosEnabled = process.env.MIA_ESCANDALLOS_ENABLED === 'true';

  return {
    stocks: {
      sk: SK_STOCKS,
      lastOkAt: stocksGlobal?.lastOkAt || null,
      lastAttemptAt: stocksGlobal?.lastAttemptAt || null,
      lastError: stocksGlobal?.lastError || null,
      count: stocksGlobal?.count ?? null,
      source: stocksGlobal?.source || null,
      throttleMinutes: THROTTLE_MINUTES,
    },
    ventasProducto: {
      lastSync: ventasLast != null ? new Date(ventasLast).toISOString() : null,
      lastSyncTs: ventasLast,
      note: 'Reutiliza Igp_VentasProducto / cron sales-lines; MIA no escribe aquí',
    },
    escandallos: {
      enabled: escandallosEnabled,
      reason: escandallosEnabled ? null : 'modulo_no_disponible',
    },
  };
}
