/**
 * Infraestructura compartida de Compras a Proveedor (Igp_ComprasAProveedor).
 *
 * Gestiona el GSI ProductId-AlbaranFecha-index y expone:
 *  - queryComprasPorProductos() — suma Quantity (purchases / acuerdos)
 *  - queryUltimaCompraPorProductos() — última línea (MIA: unidad / proveedor)
 */

import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { client, docClient, tables } from '../db.js';

const TABLE_NAME = tables.comprasProveedor;

export const GSI_COMPRAS_NAME = 'ProductId-AlbaranFecha-index';
/** GSI de listado por mes (gsi_mes) y día de albarán (gsi_fecha = AlbaranFecha). */
export const GSI_COMPRAS_MES_FECHA = 'Mes-Fecha-index';

let gsiReady = false;

export function isGsiReady() {
  return gsiReady;
}

export async function ensureComprasGSI() {
  try {
    const desc = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    const gsis = desc.Table?.GlobalSecondaryIndexes || [];
    const existing = gsis.find((g) => g.IndexName === GSI_COMPRAS_NAME);
    if (existing) {
      gsiReady = existing.IndexStatus === 'ACTIVE';
      if (!gsiReady) console.log(`[GSI] ${GSI_COMPRAS_NAME} existe pero está en estado ${existing.IndexStatus}`);
      else console.log(`[GSI] ${GSI_COMPRAS_NAME} activo y listo`);
      return;
    }
    console.log(`[GSI] Creando ${GSI_COMPRAS_NAME} en ${TABLE_NAME}…`);
    await client.send(new UpdateTableCommand({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: 'ProductId', AttributeType: 'S' },
        { AttributeName: 'AlbaranFecha', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexUpdates: [{
        Create: {
          IndexName: GSI_COMPRAS_NAME,
          KeySchema: [
            { AttributeName: 'ProductId', KeyType: 'HASH' },
            { AttributeName: 'AlbaranFecha', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['Quantity', 'PK', 'SK'] },
          ProvisionedThroughput: desc.Table?.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' ? undefined : { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      }],
    }));
    console.log(`[GSI] ${GSI_COMPRAS_NAME} creación iniciada. Estará activo en unos minutos.`);
  } catch (err) {
    console.warn('[GSI] No se pudo crear/verificar el GSI:', err.message || err);
  }
}

export async function queryComprasPorProductos(productIds, fechaInicio, fechaFin) {
  const comprasPorProducto = {};
  if (!productIds || productIds.size === 0) return comprasPorProducto;

  const queries = [...productIds].map(async (pid) => {
      let keyExpr = 'ProductId = :pid';
      const exprVals = { ':pid': pid };
      if (fechaInicio && fechaFin) {
        keyExpr += ' AND AlbaranFecha BETWEEN :fi AND :ff';
        exprVals[':fi'] = fechaInicio <= fechaFin ? fechaInicio : fechaFin;
        exprVals[':ff'] = fechaInicio <= fechaFin ? fechaFin : fechaInicio;
      } else if (fechaInicio) {
        keyExpr += ' AND AlbaranFecha >= :fi';
        exprVals[':fi'] = fechaInicio;
      } else if (fechaFin) {
        keyExpr += ' AND AlbaranFecha <= :ff';
        exprVals[':ff'] = fechaFin;
      }
      let total = 0;
      let lastKey = null;
      do {
        const r = await docClient.send(new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: GSI_COMPRAS_NAME,
          KeyConditionExpression: keyExpr,
          ExpressionAttributeValues: exprVals,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        for (const item of (r.Items || [])) {
          total += Number(item.Quantity) || 0;
        }
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
      comprasPorProducto[pid] = total;
    });
  await Promise.all(queries);
  return comprasPorProducto;
}

/** Meses `YYYY-MM` cubiertos por un rango inclusivo de días. */
export function mesesDelRango(desde, hasta) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || desde > hasta) {
    return out;
  }
  let y = Number(desde.slice(0, 4));
  let m = Number(desde.slice(5, 7));
  const yFin = Number(hasta.slice(0, 4));
  const mFin = Number(hasta.slice(5, 7));
  while (y < yFin || (y === yFin && m <= mFin)) {
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function ultimoDiaMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  const dia = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${mes}-${String(dia).padStart(2, '0')}`;
}

/**
 * Líneas de compra del rango por el GSI Mes-Fecha (un Query por mes).
 * Los ítems sin `gsi_mes`/`gsi_fecha` no salen: el histórico ya está rellenado.
 * @param {string} dateFrom YYYY-MM-DD
 * @param {string} dateTo YYYY-MM-DD
 * @param {{ projection?: string }} [opts]
 */
export async function queryComprasPorMesFecha(dateFrom, dateTo, opts = {}) {
  const items = [];
  for (const mes of mesesDelRango(dateFrom, dateTo)) {
    const ini = dateFrom.startsWith(mes) ? dateFrom : `${mes}-01`;
    const finTope = ultimoDiaMes(mes);
    const fin = dateTo.startsWith(mes) && dateTo < finTope ? dateTo : finTope;
    let lastKey = null;
    do {
      const r = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI_COMPRAS_MES_FECHA,
        KeyConditionExpression: 'gsi_mes = :m AND gsi_fecha BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':m': mes, ':a': ini, ':b': fin },
        ...(opts.projection && { ProjectionExpression: opts.projection }),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
  }
  return items;
}

/** Si no hay fechas, el mes natural en curso (UTC, igual que el resto de compras). */
export function rangoMesEnCurso(hoy = new Date().toISOString().slice(0, 10)) {
  const mes = String(hoy).slice(0, 7);
  return { dateFrom: `${mes}-01`, dateTo: ultimoDiaMes(mes) };
}

const ULTIMA_QUERY_CONCURRENCY = 8;
const ULTIMA_GSI_PAGE = 25;
const ULTIMA_GSI_MAX_KEYS = 200;

function toProductIdList(productIds) {
  if (!productIds) return [];
  const arr = productIds instanceof Set ? [...productIds] : [...productIds];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const pid = String(raw ?? '').trim();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

/** Variante numérica ("0123" → "123"). null si no aplica o es igual. */
function numericIdVariant(pid) {
  const raw = String(pid ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const alt = String(n);
  return alt !== raw ? alt : null;
}

function warehouseIdLoose(val) {
  const t = String(val ?? '').trim();
  if (!t) return '';
  const stripped = t.replace(/^0+/, '');
  return stripped || '0';
}

function fechaAlbaran(item) {
  const s = String(item?.AlbaranFecha ?? '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

/** AlbaranFecha desc, luego syncedAt, luego PK, luego SK (criterio MIA / isCompraLineaNewer). */
function isCompraLineaNewer(a, b) {
  const fa = fechaAlbaran(a);
  const fb = fechaAlbaran(b);
  if (fa !== fb) return fa > fb;
  const sa = a?.syncedAt ? Date.parse(a.syncedAt) : 0;
  const sb = b?.syncedAt ? Date.parse(b.syncedAt) : 0;
  const na = Number.isFinite(sa) ? sa : 0;
  const nb = Number.isFinite(sb) ? sb : 0;
  if (na !== nb) return na > nb;
  const pk = String(a?.PK ?? '').localeCompare(String(b?.PK ?? ''));
  if (pk !== 0) return pk > 0;
  return String(a?.SK ?? '') > String(b?.SK ?? '');
}

function itemMatchesProductId(item, requestedPid) {
  const itemPid = String(item?.ProductId ?? '').trim();
  if (!itemPid) return false;
  if (itemPid === requestedPid) return true;
  const reqAlt = numericIdVariant(requestedPid);
  const itemAlt = numericIdVariant(itemPid);
  if (reqAlt && itemPid === reqAlt) return true;
  if (itemAlt && requestedPid === itemAlt) return true;
  if (reqAlt && itemAlt && reqAlt === itemAlt) return true;
  return false;
}

function pickUltimaLinea(items, warehouseId) {
  if (!items?.length) return null;
  const confirmed = items.filter((it) => it.Confirmed === true);
  const pool = confirmed.length ? confirmed : items;
  const wh = warehouseIdLoose(warehouseId);
  if (wh) {
    const ofWh = pool.filter((it) => warehouseIdLoose(it.WarehouseId) === wh);
    if (ofWh.length) {
      return ofWh.reduce((best, cur) => (!best || isCompraLineaNewer(cur, best) ? cur : best), null);
    }
  }
  return pool.reduce((best, cur) => (!best || isCompraLineaNewer(cur, best) ? cur : best), null);
}

function toUltimaResumen(item) {
  const priceNum = Number(item?.Price);
  const unitId = item?.PurchaseUnitId;
  return {
    SupplierId: String(item?.SupplierId ?? '').trim(),
    SupplierName: String(item?.SupplierName ?? '').trim(),
    PurchaseUnitName: String(item?.PurchaseUnitName ?? '').trim(),
    PurchaseUnitId: unitId != null && String(unitId).trim() !== '' ? String(unitId).trim() : '',
    Price: Number.isFinite(priceNum) ? priceNum : null,
    AlbaranFecha: String(item?.AlbaranFecha ?? '').trim() || null,
    WarehouseId: String(item?.WarehouseId ?? '').trim(),
    ProductId: String(item?.ProductId ?? '').trim(),
  };
}

async function mapPool(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

function lineaCubreAlmacen(item, warehouseId) {
  const wh = warehouseIdLoose(warehouseId);
  if (!wh) return true;
  return warehouseIdLoose(item?.WarehouseId) === wh;
}

/**
 * Recorre el GSI de más reciente a más antiguo hasta hallar una línea
 * confirmada del almacén (o agotar ULTIMA_GSI_MAX_KEYS).
 */
async function queryUltimaViaGsi(lookupPids, warehouseId) {
  const collected = [];
  for (const pid of lookupPids) {
    let lastKey = null;
    let keysThisPid = 0;
    do {
      const r = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: GSI_COMPRAS_NAME,
        KeyConditionExpression: 'ProductId = :pid',
        ExpressionAttributeValues: { ':pid': pid },
        ScanIndexForward: false,
        Limit: ULTIMA_GSI_PAGE,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      const pageKeys = [];
      for (const item of r.Items || []) {
        if (item.PK == null || item.SK == null) continue;
        pageKeys.push({ PK: String(item.PK), SK: String(item.SK) });
        keysThisPid += 1;
        if (keysThisPid >= ULTIMA_GSI_MAX_KEYS) break;
      }
      if (pageKeys.length) {
        collected.push(...(await batchGetCompras(pageKeys)));
        const mine = collected.filter((it) => itemMatchesProductId(it, pid));
        const best = pickUltimaLinea(mine, warehouseId);
        if (best && best.Confirmed === true && lineaCubreAlmacen(best, warehouseId)) {
          return best;
        }
      }
      lastKey = keysThisPid >= ULTIMA_GSI_MAX_KEYS ? null : (r.LastEvaluatedKey || null);
    } while (lastKey);
  }
  return pickUltimaLinea(collected, warehouseId);
}

async function batchGetCompras(keys) {
  const uniq = [];
  const seen = new Set();
  for (const k of keys) {
    if (!k?.PK || k.SK == null || k.SK === '') continue;
    const id = `${k.PK}\u0001${k.SK}`;
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push({ PK: String(k.PK), SK: String(k.SK) });
  }
  const items = [];
  for (let i = 0; i < uniq.length; i += 100) {
    let requestItems = { [TABLE_NAME]: { Keys: uniq.slice(i, i + 100) } };
    let attempts = 0;
    while (requestItems[TABLE_NAME]?.Keys?.length && attempts < 8) {
      const r = await docClient.send(new BatchGetCommand({ RequestItems: requestItems }));
      items.push(...(r.Responses?.[TABLE_NAME] || []));
      const unprocessed = r.UnprocessedKeys?.[TABLE_NAME];
      if (!unprocessed?.Keys?.length) break;
      requestItems = { [TABLE_NAME]: unprocessed };
      attempts += 1;
      await new Promise((res) => setTimeout(res, 100 * attempts));
    }
  }
  return items;
}

/**
 * Última línea de compra por producto (unidad / proveedor para MIA).
 * Siempre por el GSI ProductId-AlbaranFecha-index.
 *
 * @param {Set<string>|string[]} productIds
 * @param {{ warehouseId?: string|number }} [opts]
 * @returns {Promise<Map<string, object>>}
 */
export async function queryUltimaCompraPorProductos(productIds, { warehouseId } = {}) {
  const requested = toProductIdList(productIds);
  const out = new Map();
  if (!requested.length) return out;

  const found = await mapPool(requested, ULTIMA_QUERY_CONCURRENCY, async (pid) => {
    const lookupPids = [pid];
    const alt = numericIdVariant(pid);
    if (alt) lookupPids.push(alt);
    const best = await queryUltimaViaGsi(lookupPids, warehouseId);
    return { pid, best };
  });
  for (const { pid, best } of found) {
    if (!best) continue;
    const resumen = toUltimaResumen(best);
    out.set(pid, resumen);
    const alt = numericIdVariant(pid);
    if (alt) out.set(alt, resumen);
    if (resumen.ProductId) out.set(resumen.ProductId, resumen);
  }
  return out;
}
