/**
 * Lee de Ágora la cantidad entregada de los pedidos que MIA ya creó
 * y la guarda en la línea del informe. No escribe en Ágora ni en la cabecera META.
 */

import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { exportPurchaseOrders } from '../agora/client.js';
import { listInformeLineas } from './informes.js';
import { normalizeWarehouseId, pkInforme, skInformeLinea } from './keys.js';

const GSI_WAREHOUSE = 'WarehouseId-CreadoEn-index';
const ESTADOS_CON_PEDIDO = new Set(['aprobado', 'aprobado_parcial']);
const MAX_DIAS_DEF = 14;
const MAX_INFORMES_DEF = 100;

function tableInformes() {
  return tables.miaInformes;
}

function tableLineas() {
  return tables.miaInformeLineas;
}

function tope(valor, defecto, maximo) {
  const n = Number(valor);
  const base = Number.isFinite(n) && n > 0 ? n : defecto;
  return Math.min(maximo, Math.max(1, Math.floor(base)));
}

function maxDiasDe(opts) {
  if (opts.maxDias != null) return tope(opts.maxDias, MAX_DIAS_DEF, 60);
  return tope(process.env.MIA_ENTREGAS_MAX_DIAS, MAX_DIAS_DEF, 60);
}

/** Día UTC de la aprobación: es la Date con la que se creó el pedido. */
function diaDe(meta) {
  const iso = String(meta?.aprobadoEn || '').trim();
  const dia = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dia) ? dia : '';
}

function pedidosDe(meta) {
  const raw = meta?.agoraPurchaseOrderIds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const [proveedorId, v] of Object.entries(raw)) {
    const serie = String(v?.serie || '').trim();
    const number = v?.number;
    if (!serie || number == null || String(number).trim() === '') continue;
    const date = String(v?.date || '').slice(0, 10);
    out.push({
      proveedorId: String(proveedorId),
      serie,
      number: String(number),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    });
  }
  return out;
}

function pedidosExport(data) {
  const raw = data?.PurchaseOrders ?? data?.purchaseOrders;
  return Array.isArray(raw) ? raw : [];
}

function lineasExport(po) {
  const raw = po?.Lines ?? po?.lines;
  return Array.isArray(raw) ? raw : [];
}

function mismoPedido(po, ref) {
  const serie = String(po?.Serie ?? po?.serie ?? '').trim();
  const number = po?.Number ?? po?.number;
  if (!serie || number == null || String(number).trim() === '') return false;
  return serie === ref.serie && String(number) === ref.number;
}

function qtyEntregada(ln) {
  const v = ln?.DeliveredQuantity ?? ln?.deliveredQuantity;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function mismaLinea(agoraLn, miaLn) {
  const pid = String(agoraLn?.ProductId ?? agoraLn?.productId ?? '').trim();
  if (!pid || pid !== String(miaLn?.productId || '').trim()) return false;
  const unit = agoraLn?.PurchaseUnitId ?? agoraLn?.purchaseUnitId;
  if (unit == null || String(unit).trim() === '') return true;
  const miaUnit = String(miaLn?.purchaseUnitId || '').trim();
  if (!miaUnit) return true;
  return String(unit) === miaUnit;
}

/**
 * Informes aprobados del almacén, los más recientes primero.
 * Solo Query sobre WarehouseId-CreadoEn-index.
 */
async function listarAprobados(warehouseId, maxInformes) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tableInformes(),
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
  } while (lastKey && items.length < maxInformes);
  return items.slice(0, maxInformes).filter((it) => ESTADOS_CON_PEDIDO.has(String(it.estado || '')));
}

async function guardarEntregada(informeId, proveedorId, productId, qty) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableLineas(),
        Key: { PK: pkInforme(informeId), SK: skInformeLinea(proveedorId, productId) },
        UpdateExpression: 'SET cantidadEntregada = :q',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':q': qty },
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * @param {string|number} warehouseId
 * @param {{ maxDias?: number, maxInformes?: number, exportPurchaseOrders?: Function }} [opts]
 */
export async function syncEntregasAlmacen(warehouseId, opts = {}) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') {
    const err = new Error('warehouseId es obligatorio');
    err.status = 400;
    throw err;
  }

  const maxDias = maxDiasDe(opts);
  const maxInformes = tope(opts.maxInformes, MAX_INFORMES_DEF, 500);
  const exportar = opts.exportPurchaseOrders || exportPurchaseOrders;

  const informes = await listarAprobados(wid, maxInformes);
  /** @type {Map<string, Array<{ informeId: string, proveedorId: string, serie: string, number: string }>>} */
  const porDia = new Map();
  let sinFecha = 0;
  for (const meta of informes) {
    const informeId = String(meta.informeId || String(meta.PK || '').replace(/^INFORME#/, '')).trim();
    const pedidos = pedidosDe(meta);
    if (!pedidos.length) continue;
    const diaInforme = diaDe(meta);
    for (const p of pedidos) {
      const dia = p.date || diaInforme;
      if (!dia) {
        sinFecha += 1;
        continue;
      }
      const lista = porDia.get(dia) || [];
      lista.push({ informeId, ...p });
      porDia.set(dia, lista);
    }
  }

  const dias = [...porDia.keys()].sort((a, b) => b.localeCompare(a)).slice(0, maxDias);
  const resumen = {
    ok: true,
    warehouseId: wid,
    diasConsultados: 0,
    pedidosEncontrados: 0,
    pedidosNoEncontrados: 0,
    lineasActualizadas: 0,
    lineasSinCambio: 0,
    lineasNoEncontradas: 0,
    sinFecha,
  };

  for (const dia of dias) {
    const data = await exportar(dia);
    resumen.diasConsultados += 1;
    const pedidos = pedidosExport(data);
    for (const ref of porDia.get(dia) || []) {
      const po = pedidos.find((p) => mismoPedido(p, ref));
      if (!po) {
        resumen.pedidosNoEncontrados += 1;
        continue;
      }
      resumen.pedidosEncontrados += 1;
      const lineas = await listInformeLineas(ref.informeId);
      const delProveedor = lineas.filter((ln) => String(ln.proveedorId || '') === ref.proveedorId);
      for (const agoraLn of lineasExport(po)) {
        const qty = qtyEntregada(agoraLn);
        if (qty == null) continue;
        const miaLn = delProveedor.find((ln) => mismaLinea(agoraLn, ln));
        if (!miaLn) {
          resumen.lineasNoEncontradas += 1;
          continue;
        }
        const actual = Number(miaLn.cantidadEntregada);
        if (Number.isFinite(actual) && actual === qty) {
          resumen.lineasSinCambio += 1;
          continue;
        }
        const escrita = await guardarEntregada(ref.informeId, ref.proveedorId, miaLn.productId, qty);
        if (!escrita) resumen.lineasNoEncontradas += 1;
        else resumen.lineasActualizadas += 1;
      }
    }
  }

  return resumen;
}
