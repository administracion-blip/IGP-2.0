/**
 * Cantidad ya pedida a Ágora y todavía no entregada, por producto y unidad de compra.
 * Solo informes aprobados o aprobados a medias, por el índice del almacén.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { listInformeLineas } from './informes.js';
import { normalizeProductId, normalizeWarehouseId } from './keys.js';

const GSI_WAREHOUSE = 'WarehouseId-CreadoEn-index';
const MAX_INFORMES = 100;

function proveedoresConPedido(meta) {
  const set = new Set();
  const raw = meta?.agoraPurchaseOrderIds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return set;
  for (const [id, v] of Object.entries(raw)) {
    const serie = String(v?.serie || '').trim();
    const number = v?.number;
    if (!serie || number == null || String(number).trim() === '') continue;
    set.add(String(id));
  }
  return set;
}

/** Lo que queda por recibir de una línea. 0 si está omitida o no hay cantidad pedida. */
export function pendienteDeLinea(ln) {
  if (ln?.omitida === true) return 0;
  const pedida = Number(ln?.cantidadPedida != null ? ln.cantidadPedida : ln?.qty);
  if (!Number.isFinite(pedida) || pedida <= 0) return 0;
  const entregada = Number(ln?.cantidadEntregada);
  const ya = Number.isFinite(entregada) && entregada > 0 ? entregada : 0;
  return Math.max(0, Math.round((pedida - ya) * 1000) / 1000);
}

export function claveEnCamino(productId, purchaseUnitId) {
  const pid = normalizeProductId(productId);
  const unit = purchaseUnitId != null ? String(purchaseUnitId).trim() : '';
  return `${pid}|${unit}`;
}

async function listarAprobados(warehouseId) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.miaInformes,
        IndexName: GSI_WAREHOUSE,
        KeyConditionExpression: 'WarehouseId = :w',
        FilterExpression: 'estado IN (:aprobado, :parcial)',
        ExpressionAttributeValues: {
          ':w': warehouseId,
          ':aprobado': 'aprobado',
          ':parcial': 'aprobado_parcial',
        },
        ScanIndexForward: false,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey && items.length < MAX_INFORMES);
  return items.slice(0, MAX_INFORMES);
}

/**
 * @param {string|number} warehouseId
 * @returns {Promise<Map<string, number>>} clave `productId|unidad` → cantidad pendiente
 */
export async function cargarEnCamino(warehouseId) {
  const wid = normalizeWarehouseId(warehouseId);
  const mapa = new Map();
  if (!wid || wid === '000000') return mapa;

  const informes = await listarAprobados(wid);
  for (const meta of informes) {
    const informeId = String(meta.informeId || String(meta.PK || '').replace(/^INFORME#/, '')).trim();
    const proveedores = proveedoresConPedido(meta);
    if (!informeId || proveedores.size === 0) continue;
    const lineas = await listInformeLineas(informeId);
    for (const ln of lineas) {
      if (!proveedores.has(String(ln.proveedorId || ''))) continue;
      const qty = pendienteDeLinea(ln);
      if (qty <= 0) continue;
      const clave = claveEnCamino(ln.productId, ln.purchaseUnitId);
      mapa.set(clave, Math.round(((mapa.get(clave) || 0) + qty) * 1000) / 1000);
    }
  }
  return mapa;
}
