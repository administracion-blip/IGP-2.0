/**
 * Motor de cálculo MIA v1 — orquesta demanda, ajuste, stock, enriquecimiento y persistencia.
 */

import { randomUUID } from 'crypto';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  daysBetweenInclusive,
  getLastSalesLinesSync,
  queryVentasPorLocalRango,
} from '../dynamo/ventasProducto.js';
import { loadAgoraProductsMap } from '../campanas/campanaResultados.js';
import { queryUltimaCompraPorProductos } from '../dynamo/comprasProveedor.js';
import { formatId6 } from '../usuarioLocales.js';
import { aplicarFactorDia, resolverAjusteFacturacion } from './ajusteFacturacion.js';
import { listConfigByWarehouse } from './configProducto.js';
import {
  aggregateVentasPorProductoFecha,
  aplicarColchon,
  demandaBaseRango,
  mediaPorWeekday,
  parseIsoDate,
  rangoHistorico,
  redondearCantidadCompra,
} from './demanda.js';
import { agruparLineasPorProveedor, putInformeCompleto } from './informes.js';
import { buildMapaLocalAlmacen } from './localAlmacen.js';
import { normalizeProductId, normalizeWarehouseId } from './keys.js';
import { canonicalFamilyId, getGrupoFamilias } from './gruposFamilias.js';
import { getStocksSyncMeta } from './syncMeta.js';
import { syncStocksForWarehouse } from './stocksSync.js';
import { explodeDemanda } from '../escandallos/explode.js';
import { getReceta } from '../escandallos/store.js';

const SIN_PROVEEDOR = 'SIN_PROVEEDOR';
const AVISO_PEDIDOS = 'pedidos_pendientes_confirmacion';
const ESTADOS_PENDIENTES_CONFIRMACION = new Set(['Borrador']);

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickFormatoCompra(config) {
  const fromCfg = toNum(config?.formatoCompra, NaN);
  if (Number.isFinite(fromCfg) && fromCfg > 0) return fromCfg;
  return null;
}

function pickCostPrice(agora, warehouseId) {
  if (!agora) return 0;
  const cps = agora.CostPrices;
  if (Array.isArray(cps) && warehouseId) {
    const hit = cps.find(
      (c) => normalizeWarehouseId(c.WarehouseId ?? c.warehouseId) === warehouseId,
    );
    if (hit != null) return toNum(hit.CostPrice ?? hit.costPrice, 0);
  }
  return toNum(agora.CostPrice, 0);
}

function isProductoBorradoAgora(agora) {
  if (!agora) return false;
  if (agora.Active === false || agora.active === false) return true;
  const del = agora.DeletionDate ?? agora.deletionDate;
  return del != null && String(del).trim() !== '';
}

function unitName(ultima, config, agora) {
  return (
    (ultima?.PurchaseUnitName && String(ultima.PurchaseUnitName).trim()) ||
    (config?.formatoCompraNombre && String(config.formatoCompraNombre).trim()) ||
    (agora?.PurchaseUnitName && String(agora.PurchaseUnitName).trim()) ||
    (agora?.purchaseUnitName && String(agora.purchaseUnitName).trim()) ||
    'ud'
  );
}

function pickAgora(agoraMap, productId) {
  return agoraMap.get(productId) || agoraMap.get(String(Number(productId))) || null;
}

function pickUltima(ultimaPorProducto, productId) {
  return ultimaPorProducto.get(productId) || ultimaPorProducto.get(String(Number(productId))) || null;
}

function hasMetaActiva(receta) {
  return Boolean(receta?.meta && receta.meta.activo !== false);
}

function mergeExploded(target, source) {
  for (const [ingId, info] of source || []) {
    const prev = target.get(ingId);
    if (prev) {
      prev.cantidad += info.cantidad;
      if (!prev.unidad && info.unidad) prev.unidad = info.unidad;
      if (!prev.nombre && info.nombre) prev.nombre = info.nombre;
    } else {
      target.set(ingId, {
        cantidad: info.cantidad,
        unidad: info.unidad || '',
        nombre: info.nombre || '',
      });
    }
  }
}

/**
 * Línea de pedido (directo o escandallo). Null si no hay qty a pedir.
 */
function buildLineaPedido({
  productId,
  config,
  agora,
  ultima,
  warehouseId,
  demandaBaseTotal,
  demandaAjustada,
  modoDemanda,
  nombreFallback,
}) {
  const stock = toNum(config?.Quantity, 0);
  const necesidad = Math.max(0, demandaAjustada - stock);
  const formato = pickFormatoCompra(config);
  const qty = redondearCantidadCompra(necesidad, formato);
  if (qty <= 0 && demandaAjustada <= 0) return null;
  if (qty <= 0) return null;

  const costeUnit = pickCostPrice(agora, warehouseId);
  const costeLinea = Math.round(qty * costeUnit * 100) / 100;
  const configProv = config?.proveedorId != null ? String(config.proveedorId).trim() : '';
  let proveedorId;
  let proveedorNombre;
  if (configProv) {
    proveedorId = configProv;
    proveedorNombre = String(config?.proveedorNombre || '').trim() || proveedorId;
  } else {
    const ultProv = ultima?.SupplierId != null ? String(ultima.SupplierId).trim() : '';
    if (ultProv) {
      proveedorId = ultProv;
      proveedorNombre = String(ultima?.SupplierName || '').trim() || ultProv;
    } else {
      proveedorId = SIN_PROVEEDOR;
      proveedorNombre = 'Sin proveedor';
    }
  }

  return {
    linea: {
      productId,
      ProductId: productId,
      nombre: String(agora?.Name || config?.nombre || nombreFallback || productId).trim(),
      familia: String(agora?.FamilyName || '').trim() || null,
      proveedorId,
      proveedorNombre,
      qty,
      cantidadPedida: qty,
      omitida: false,
      unit: unitName(ultima, config, agora),
      formatoCompra: formato,
      purchaseUnitId: ultima?.PurchaseUnitId != null ? String(ultima.PurchaseUnitId).trim() : '',
      ultimaCompraFecha: ultima?.AlbaranFecha || null,
      costeUnitario: costeUnit,
      costeLinea,
      demandaBase: Math.round((demandaBaseTotal || 0) * 1000) / 1000,
      demandaAjustada: Math.round(demandaAjustada * 1000) / 1000,
      stock,
      modoDemanda,
    },
    qty,
    costeLinea,
  };
}

/**
 * WorkplaceIds (agoraCode) de los locales asociados al almacén.
 * @param {{ locales?: Array<{ id: string, agoraCode?: string }> }} mapa
 * @param {string[]} localIds
 * @returns {string[]}
 */
export function workplaceIdsFromMapa(mapa, localIds) {
  const setLocal = new Set((localIds || []).map((id) => formatId6(id)).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const loc of mapa?.locales || []) {
    const lid = formatId6(loc.id);
    if (!lid || !setLocal.has(lid)) continue;
    const code = loc.agoraCode != null ? String(loc.agoraCode).trim() : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Pedidos IGP en Borrador para locales del almacén (aviso no bloqueante).
 */
async function hayPedidosPendientesConfirmacion(localIds) {
  const set = new Set((localIds || []).map((id) => formatId6(id)).filter(Boolean));
  if (!set.size) return { hay: false, count: 0 };

  let count = 0;
  let lastKey = null;
  try {
    do {
      const r = await docClient.send(
        new ScanCommand({
          TableName: tables.pedidos,
          ProjectionExpression: 'Id, LocalId, Estado',
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }),
      );
      for (const p of r.Items || []) {
        const estado = String(p.Estado ?? '').trim();
        if (!ESTADOS_PENDIENTES_CONFIRMACION.has(estado)) continue;
        const lid = formatId6(p.LocalId);
        if (lid && set.has(lid)) count += 1;
      }
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
  } catch {
    return { hay: false, count: 0, error: true };
  }
  return { hay: count > 0, count };
}

async function loadFrescor(warehouseId) {
  const [stocksWh, stocksGlobal, ventasTs] = await Promise.all([
    getStocksSyncMeta(warehouseId),
    getStocksSyncMeta(),
    getLastSalesLinesSync(docClient).catch(() => null),
  ]);
  return {
    stockLastOkAt: stocksWh?.lastOkAt || stocksGlobal?.lastOkAt || null,
    stockLastAttemptAt: stocksWh?.lastAttemptAt || stocksGlobal?.lastAttemptAt || null,
    stockLastError: stocksWh?.lastError || stocksGlobal?.lastError || null,
    ventasLastSync: ventasTs != null ? new Date(ventasTs).toISOString() : null,
    ventasLastSyncTs: ventasTs,
  };
}

const STOCK_FRESH_HOURS = Math.max(
  1,
  Number(process.env.MIA_STOCK_FRESH_HOURS) || 36,
);

function hoursSinceIsoOrTs(value) {
  if (value == null || value === '') return null;
  const ts = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / (60 * 60 * 1000);
}

/** Avisos no bloqueantes de frescura de stock/ventas. */
export function avisosDesdeFrescor(frescor, hours = STOCK_FRESH_HOURS) {
  const out = [];
  const lastOk = frescor?.stockLastOkAt || null;
  const lastErr = frescor?.stockLastError || null;
  if (!lastOk || (lastErr && String(lastErr).trim() !== '')) {
    out.push('stock_sync_error');
  }
  const stockAgeH = hoursSinceIsoOrTs(lastOk);
  if (lastOk && stockAgeH != null && stockAgeH > hours) {
    out.push('stock_desactualizado');
  }
  const ventasTs = frescor?.ventasLastSyncTs ?? frescor?.ventasLastSync ?? null;
  const ventasAgeH = hoursSinceIsoOrTs(ventasTs);
  if (ventasAgeH == null || ventasAgeH > hours) {
    out.push('ventas_desactualizadas');
  }
  return out;
}

/**
 * @param {{
 *   warehouseId: string|number,
 *   fechaDesde: string,
 *   fechaHasta: string,
 *   grupoFamiliaId: string,
 *   grupoFamiliaNombre?: string,
 *   semanasHistorico?: number,
 *   colchonDias?: number,
 *   syncStock?: boolean,
 *   usuario?: { email?: string, id_usuario?: string, Nombre?: string },
 * }} input
 */
export async function calcularPedidoMia(input) {
  const warehouseId = normalizeWarehouseId(input.warehouseId);
  if (!warehouseId || warehouseId === '000000') {
    throw Object.assign(new Error('warehouseId inválido'), { status: 400 });
  }
  const fechaDesde = parseIsoDate(input.fechaDesde);
  const fechaHasta = parseIsoDate(input.fechaHasta);
  if (!fechaDesde || !fechaHasta || fechaDesde > fechaHasta) {
    throw Object.assign(new Error('fechaDesde/fechaHasta inválidas (YYYY-MM-DD)'), { status: 400 });
  }

  const grupoFamiliaId = String(input.grupoFamiliaId ?? '').trim();
  if (!grupoFamiliaId) {
    throw Object.assign(new Error('grupoFamiliaId es obligatorio'), { status: 400 });
  }

  const grupo = await getGrupoFamilias(grupoFamiliaId);
  if (!grupo || grupo.activo === false) {
    throw Object.assign(
      new Error(`Grupo de familias ${grupoFamiliaId} no existe o no está activo`),
      { status: 400, code: 'grupo_inactivo' },
    );
  }
  if (!grupo.familiaIds?.length) {
    throw Object.assign(
      new Error(`Grupo ${grupoFamiliaId} sin familias configuradas`),
      { status: 400, code: 'grupo_sin_familias' },
    );
  }

  const familiaIds = grupo.familiaIds.map(canonicalFamilyId).filter(Boolean);
  const familyIdSet = new Set(familiaIds);
  if (familyIdSet.size === 0) {
    throw Object.assign(
      new Error(`Grupo ${grupoFamiliaId} sin familias válidas`),
      { status: 400, code: 'grupo_sin_familias' },
    );
  }

  const grupoFamiliaNombre =
    String(input.grupoFamiliaNombre ?? '').trim() ||
    String(grupo.nombre || '').trim() ||
    grupoFamiliaId;

  const semanasHistorico = Math.max(1, Math.min(52, Math.floor(Number(input.semanasHistorico) || 4)));
  const colchonDias = Math.max(0, Number(input.colchonDias) || 0);
  const syncStock = input.syncStock === true || input.syncStock === 'true';

  const avisos = [];
  let syncStockResult = null;
  if (syncStock) {
    try {
      syncStockResult = await syncStocksForWarehouse(warehouseId, { force: true });
    } catch (err) {
      avisos.push('sync_stock_fallido');
      syncStockResult = { ok: false, error: err?.message || String(err) };
    }
  }

  const mapa = await buildMapaLocalAlmacen();
  const localIds = mapa.porWarehouseId[warehouseId] || [];
  if (!localIds.length) {
    avisos.push('almacen_sin_locales');
  }

  const workplaceIds = workplaceIdsFromMapa(mapa, localIds);

  const { histDesde, histHasta, semanas } = rangoHistorico(fechaDesde, semanasHistorico);
  const nDiasRango = daysBetweenInclusive(fechaDesde, fechaHasta);

  const ventasRows = [];
  for (const localId of localIds) {
    const rows = await queryVentasPorLocalRango(docClient, localId, histDesde, histHasta);
    ventasRows.push(...rows);
  }
  const porProductoFecha = aggregateVentasPorProductoFecha(ventasRows);

  const ajuste = await resolverAjusteFacturacion({
    fechaDesde,
    fechaHasta,
    localIds,
    workplaceIds,
    semanasHistorico: semanas,
  });
  for (const a of ajuste.avisos || []) {
    if (!avisos.includes(a)) avisos.push(a);
  }

  const configList = await listConfigByWarehouse(warehouseId);
  /** @type {Map<string, object>} */
  const configByPid = new Map();
  for (const c of configList) {
    const pid = normalizeProductId(c.ProductId || (c.SK || '').replace(/^PRODUCT#/, ''));
    if (pid) configByPid.set(pid, c);
  }

  const productIds = new Set([...configByPid.keys(), ...porProductoFecha.keys()]);
  const agoraMap = await loadAgoraProductsMap(docClient, [...productIds]);

  // Universo MIA ∩ FamilyId ∈ grupo de familias
  const productIdsFiltrados = [...productIds].filter((productId) => {
    const agora = agoraMap.get(productId) || agoraMap.get(String(Number(productId))) || null;
    const fid = canonicalFamilyId(agora?.FamilyId ?? agora?.familyId);
    return fid && familyIdSet.has(fid);
  });

  if (productIdsFiltrados.length === 0) {
    throw Object.assign(
      new Error(`Ningún producto con FamilyId del grupo ${grupoFamiliaId} (grupo_sin_productos)`),
      { status: 400, code: 'grupo_sin_productos' },
    );
  }

  const escandallosOn = process.env.MIA_ESCANDALLOS_ENABLED === 'true';

  const ultimaPorProducto = await queryUltimaCompraPorProductos(productIdsFiltrados, { warehouseId });

  const lineas = [];
  let costeTotal = 0;
  let unidadesPedidoTotal = 0;
  let productosConPedido = 0;

  const pushLinea = (built) => {
    if (!built) return;
    lineas.push(built.linea);
    costeTotal += built.costeLinea;
    unidadesPedidoTotal += built.qty;
    productosConPedido += 1;
  };

  const calcDemandaProducto = (productId) => {
    const medias = mediaPorWeekday(porProductoFecha.get(productId), fechaDesde, semanas);
    const base = demandaBaseRango(medias, fechaDesde, fechaHasta);
    let demandaAjustada = 0;
    for (const d of base.porDia) {
      demandaAjustada += aplicarFactorDia(d.unidades, d.fecha, ajuste);
    }
    demandaAjustada = aplicarColchon(demandaAjustada, nDiasRango, colchonDias);
    return { base, demandaAjustada };
  };

  if (!escandallosOn) {
    for (const productId of productIdsFiltrados) {
      const config = configByPid.get(productId) || null;
      if (config && config.activo === false) continue;

      const modo = String(config?.modoDemanda || 'directo').trim() || 'directo';
      if (modo !== 'directo') continue;

      const agora = pickAgora(agoraMap, productId);
      if (isProductoBorradoAgora(agora)) continue;

      const { base, demandaAjustada } = calcDemandaProducto(productId);
      pushLinea(buildLineaPedido({
        productId,
        config,
        agora,
        ultima: pickUltima(ultimaPorProducto, productId),
        warehouseId,
        demandaBaseTotal: base.total,
        demandaAjustada,
        modoDemanda: 'directo',
      }));
    }
  } else {
    const recetaCache = new Map();
    const getRecetaCached = async (pid) => {
      const id = normalizeProductId(pid);
      if (!id) return null;
      if (recetaCache.has(id)) return recetaCache.get(id);
      const receta = await getReceta(id);
      recetaCache.set(id, receta);
      return receta;
    };

    /** @type {Map<string, { base: object, demandaAjustada: number, config: object|null, agora: object|null }>} */
    const demandaPorProducto = new Map();
    /** @type {Map<string, { cantidad: number, unidad: string, nombre: string }>} */
    const explodedDemand = new Map();
    const explodedDishes = new Set();

    for (const productId of productIdsFiltrados) {
      const config = configByPid.get(productId) || null;
      if (config && config.activo === false) continue;

      const agora = pickAgora(agoraMap, productId);
      if (isProductoBorradoAgora(agora)) continue;

      const { base, demandaAjustada } = calcDemandaProducto(productId);
      demandaPorProducto.set(productId, { base, demandaAjustada, config, agora });

      const receta = await getRecetaCached(productId);
      if (!hasMetaActiva(receta)) continue;

      let exploded;
      try {
        exploded = await explodeDemanda({
          productoId: productId,
          unidadesPlato: demandaAjustada,
          getReceta: getRecetaCached,
        });
      } catch (err) {
        if (err?.code === 'escandallo_ciclo' || err?.code === 'escandallo_profundidad') {
          throw Object.assign(err, { status: 400 });
        }
        throw err;
      }
      if (!exploded.size) continue;
      explodedDishes.add(productId);
      mergeExploded(explodedDemand, exploded);
    }

    const extraAgoraIds = [...explodedDemand.keys()].filter(
      (id) => !agoraMap.has(id) && !agoraMap.has(String(Number(id))),
    );
    if (extraAgoraIds.length) {
      const extraMap = await loadAgoraProductsMap(docClient, extraAgoraIds);
      for (const [k, v] of extraMap) agoraMap.set(k, v);
    }

    const extraCompraIds = [...explodedDemand.keys()].filter(
      (id) => !ultimaPorProducto.has(id) && !ultimaPorProducto.has(String(Number(id))),
    );
    if (extraCompraIds.length) {
      const extraUltima = await queryUltimaCompraPorProductos(extraCompraIds, { warehouseId });
      for (const [k, v] of extraUltima) ultimaPorProducto.set(k, v);
    }

    const skipDirect = new Set(explodedDishes);
    for (const ingId of explodedDemand.keys()) skipDirect.add(ingId);

    for (const productId of productIdsFiltrados) {
      if (skipDirect.has(productId)) continue;
      const row = demandaPorProducto.get(productId);
      if (!row) continue;
      pushLinea(buildLineaPedido({
        productId,
        config: row.config,
        agora: row.agora,
        ultima: pickUltima(ultimaPorProducto, productId),
        warehouseId,
        demandaBaseTotal: row.base.total,
        demandaAjustada: row.demandaAjustada,
        modoDemanda: 'directo',
      }));
    }

    for (const [ingId, info] of explodedDemand) {
      const own = demandaPorProducto.get(ingId);
      const demandaAjustada = info.cantidad + (own ? own.demandaAjustada : 0);
      const demandaBaseTotal = (own ? own.base.total : 0) + info.cantidad;
      const config = configByPid.get(ingId) || own?.config || null;
      pushLinea(buildLineaPedido({
        productId: ingId,
        config,
        agora: pickAgora(agoraMap, ingId),
        ultima: pickUltima(ultimaPorProducto, ingId),
        warehouseId,
        demandaBaseTotal,
        demandaAjustada,
        modoDemanda: 'escandallo',
        nombreFallback: info.nombre,
      }));
    }
  }

  lineas.sort((a, b) => {
    const pa = a.proveedorId.localeCompare(b.proveedorId);
    if (pa !== 0) return pa;
    return String(a.nombre).localeCompare(String(b.nombre), 'es');
  });

  const pedidosGuard = await hayPedidosPendientesConfirmacion(localIds);
  if (pedidosGuard.hay) {
    avisos.push(AVISO_PEDIDOS);
  }

  const frescor = await loadFrescor(warehouseId);
  for (const a of avisosDesdeFrescor(frescor)) {
    if (!avisos.includes(a)) avisos.push(a);
  }
  const informeId = randomUUID();
  const ahora = new Date().toISOString();
  const usuario = input.usuario || {};

  const meta = {
    informeId,
    warehouseId,
    WarehouseId: warehouseId,
    fechaDesde,
    fechaHasta,
    grupoFamiliaId,
    grupoFamiliaNombre,
    familiaIds: [...familyIdSet],
    semanasHistorico: semanas,
    colchonDias,
    estado: 'calculado',
    avisos,
    localIds,
    workplaceIds,
    nDiasRango,
    histDesde,
    histHasta,
    totales: {
      lineas: lineas.length,
      productosConPedido,
      unidadesPedido: Math.round(unidadesPedidoTotal * 1000) / 1000,
      costeTotal: Math.round(costeTotal * 100) / 100,
    },
    stockSyncedAt: frescor.stockLastOkAt,
    frescor,
    pedidosPendientesConfirmacion: pedidosGuard.count || 0,
    syncStock: syncStockResult,
    usuario: {
      email: usuario.email || null,
      id_usuario: usuario.id_usuario || usuario.sub || null,
      nombre: usuario.Nombre || usuario.nombre || null,
    },
    creadoEn: ahora,
    CreadoEn: ahora,
  };

  await putInformeCompleto(meta, lineas);

  return {
    ok: true,
    informe: meta,
    lineas,
    porProveedor: agruparLineasPorProveedor(lineas),
    frescor,
    avisos,
  };
}
