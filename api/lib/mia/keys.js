/**
 * Helpers de claves DynamoDB para el módulo MIA.
 * WarehouseId se alinea con `igp_Almacenes.Id` (formatId6).
 */

import { formatId6 } from '../usuarioLocales.js';

export function normalizeWarehouseId(val) {
  if (val == null || String(val).trim() === '') return '';
  return formatId6(val);
}

export function normalizeProductId(val) {
  if (val == null || String(val).trim() === '') return '';
  return String(val).trim();
}

export function pkWarehouse(warehouseId) {
  const id = normalizeWarehouseId(warehouseId);
  return id ? `WAREHOUSE#${id}` : '';
}

export function skProduct(productId) {
  const id = normalizeProductId(productId);
  return id ? `PRODUCT#${id}` : '';
}

export function pkLocal(localId) {
  const id = formatId6(localId);
  return id && id !== '000000' ? `LOCAL#${id}` : '';
}

export function skProveedor(proveedorId) {
  const id = String(proveedorId ?? '').trim();
  return id ? `PROVEEDOR#${id}` : '';
}

export function pkInforme(informeId) {
  const id = String(informeId ?? '').trim();
  return id ? `INFORME#${id}` : '';
}

export function skInformeMeta() {
  return 'META';
}

export function skInformeLinea(supplierId, productId) {
  const s = String(supplierId ?? '').trim() || '_';
  const p = normalizeProductId(productId) || '_';
  return `LINE#${s}#${p}`;
}

/** SyncMeta: SK global de stocks. */
export const SK_STOCKS = 'STOCKS';

/** SyncMeta: SK por almacén. */
export function skStocksWarehouse(warehouseId) {
  const id = normalizeWarehouseId(warehouseId);
  return id ? `STOCKS#${id}` : SK_STOCKS;
}

export const PK_SYNC_META = 'GLOBAL';
