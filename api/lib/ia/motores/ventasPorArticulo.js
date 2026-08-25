/**
 * Motor determinista «ventas por artículo» para Informes IA.
 * Fuente: Igp_VentasProducto (sync sales-lines), sin Ágora en vivo.
 */
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { formatId6, usuarioPuedeAccederLocal } from '../../usuarioLocales.js';
import {
  queryVentasPorLocalRango,
  getLastSalesLinesSync,
  daysBetweenInclusive,
} from '../../dynamo/ventasProducto.js';
import { loadAgoraProductsMap } from '../../campanas/campanaResultados.js';
import { canonicalFamilyId } from '../../mia/gruposFamilias.js';
import { esSedeGrupoParipeLocal } from '../../locales/sede.js';
import { getGrupoFamiliasIa } from '../gruposFamilias.js';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 400;
/** Tope de filas en datosJson persistido (límite práctico Dynamo ~400 KB). */
const MAX_ARTICULOS = 500;
const TOP_PROMPT = 50;
const CONCURRENCY = 4;
const SYNC_STALE_MS = 48 * 60 * 60 * 1000;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function hoyIsoLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function inicioAnoIsoLocal() {
  return `${new Date().getFullYear()}-01-01`;
}

/**
 * Parsea array o CSV de ids.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseIdList(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  return String(raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Agrega filas de ventas por ProductId (suma Unidades / ImporteBruto;
 * ProductName más reciente no vacío).
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Map<string, { productId: string, productName: string, unidades: number, importe: number, lastFecha: string }>}
 */
export function agregarPorProductId(rows) {
  const byId = new Map();
  for (const r of rows || []) {
    const productId = String(r?.ProductId ?? '').trim();
    if (!productId) continue;
    const unidades = Number(r?.Unidades) || 0;
    const importe = Number(r?.ImporteBruto) || 0;
    const name = String(r?.ProductName ?? '').trim();
    const fecha = String(r?.Fecha ?? '').slice(0, 10);

    if (!byId.has(productId)) {
      byId.set(productId, {
        productId,
        productName: name || productId,
        unidades: 0,
        importe: 0,
        lastFecha: '',
      });
    }
    const acc = byId.get(productId);
    acc.unidades += unidades;
    acc.importe = round2(acc.importe + importe);
    if (name && (!acc.lastFecha || fecha >= acc.lastFecha)) {
      acc.productName = name;
      if (fecha) acc.lastFecha = fecha;
    } else if (!name && !acc.productName) {
      acc.productName = productId;
    }
  }
  return byId;
}

/**
 * Une catálogo Ágora (familia) y aplica filtro de familias canónicas.
 * @param {Map<string, { productId: string, productName: string, unidades: number, importe: number }>} byId
 * @param {Map<string, Record<string, unknown>>} productsMap
 * @param {Set<string>|null} familiaIdsSet — null/vacío = sin filtro
 * @returns {{ articulos: Array<object>, sinFamilia: number }}
 */
export function enriquecerYFiltrarFamilias(byId, productsMap, familiaIdsSet) {
  const hayFiltro = familiaIdsSet != null && familiaIdsSet.size > 0;
  const articulos = [];
  let sinFamilia = 0;

  for (const [productId, agg] of byId) {
    const prod = productsMap?.get(productId) || productsMap?.get(String(productId)) || null;
    const familyId = canonicalFamilyId(prod?.FamilyId ?? prod?.familyId ?? '');
    const familyName = familyId
      ? (String(prod?.FamilyName ?? prod?.familyName ?? '').trim() || familyId)
      : 'Sin familia';

    if (!familyId) sinFamilia += 1;

    if (hayFiltro) {
      if (!familyId || !familiaIdsSet.has(familyId)) continue;
    }

    articulos.push({
      productId,
      productName: agg.productName || productId,
      familyId: familyId || '',
      familyName,
      unidades: round3(agg.unidades),
      importe: round2(agg.importe),
    });
  }

  return { articulos, sinFamilia };
}

/**
 * Añade pctImporte / pctUnidades sobre el total del conjunto.
 * @param {Array<{ unidades: number, importe: number }>} articulos
 * @param {{ unidades: number, importe: number }} totales
 */
export function anotarPcts(articulos, totales) {
  const totU = Number(totales?.unidades) || 0;
  const totI = Number(totales?.importe) || 0;
  for (const a of articulos) {
    a.pctUnidades = totU > 0 ? round2((Number(a.unidades) / totU) * 100) : 0;
    a.pctImporte = totI > 0 ? round2((Number(a.importe) / totI) * 100) : 0;
  }
  return articulos;
}

/**
 * Subtotales por familia a partir de artículos ya filtrados.
 * @param {Array<{ familyId: string, familyName: string, unidades: number, importe: number }>} articulos
 * @param {{ unidades: number, importe: number }} totales
 */
export function buildPorFamilia(articulos, totales) {
  const byFam = new Map();
  for (const a of articulos) {
    const fid = String(a.familyId ?? '');
    if (!byFam.has(fid)) {
      byFam.set(fid, {
        familyId: fid,
        familyName: a.familyName || (fid ? fid : 'Sin familia'),
        unidades: 0,
        importe: 0,
        numArticulos: 0,
      });
    }
    const f = byFam.get(fid);
    f.unidades = round3(f.unidades + (Number(a.unidades) || 0));
    f.importe = round2(f.importe + (Number(a.importe) || 0));
    f.numArticulos += 1;
    if (a.familyName && (!f.familyName || f.familyName === fid)) {
      f.familyName = a.familyName;
    }
  }
  const list = [...byFam.values()].sort(
    (a, b) => b.unidades - a.unidades || a.familyName.localeCompare(b.familyName, 'es'),
  );
  anotarPcts(list, totales);
  return list;
}

/**
 * Ordena por unidades desc, calcula totales/%, subtotales y trunca listado.
 * @param {Array<object>} articulosRaw
 * @param {{ incluirSubtotales?: boolean, maxArticulos?: number }} [opts]
 */
export function finalizarRankingArticulos(articulosRaw, opts = {}) {
  const incluirSubtotales = opts.incluirSubtotales !== false;
  const maxArticulos = opts.maxArticulos ?? MAX_ARTICULOS;
  const sorted = [...(articulosRaw || [])].sort(
    (a, b) =>
      (Number(b.unidades) || 0) - (Number(a.unidades) || 0) ||
      String(a.productName || '').localeCompare(String(b.productName || ''), 'es'),
  );

  const totales = {
    unidades: round3(sorted.reduce((s, a) => s + (Number(a.unidades) || 0), 0)),
    importe: round2(sorted.reduce((s, a) => s + (Number(a.importe) || 0), 0)),
    numArticulos: sorted.length,
    numFamilias: 0,
  };
  anotarPcts(sorted, totales);

  let porFamilia;
  if (incluirSubtotales) {
    porFamilia = buildPorFamilia(sorted, totales);
    totales.numFamilias = porFamilia.length;
  } else {
    totales.numFamilias = new Set(sorted.map((a) => String(a.familyId ?? ''))).size;
  }

  const truncado = sorted.length > maxArticulos;
  const articulos = truncado ? sorted.slice(0, maxArticulos) : sorted;
  return { articulos, totales, porFamilia, truncado, totalSinTruncar: sorted.length };
}

/**
 * Recorte para el LLM: meta + totales + porFamilia + top 50 + avisos.
 * Si hay porLocal (agruparPorLocal), envía top por local.
 * @param {object} datosJson
 */
export function datosParaPromptVentasPorArticulo(datosJson) {
  const d = datosJson && typeof datosJson === 'object' ? datosJson : {};
  const articulos = Array.isArray(d.articulos) ? d.articulos : [];
  const porLocal = Array.isArray(d.porLocal) ? d.porLocal : null;
  const out = {
    meta: d.meta || {},
    totales: d.totales || {},
    ...(Array.isArray(d.porFamilia) ? { porFamilia: d.porFamilia } : {}),
    articulos: articulos.slice(0, TOP_PROMPT),
    avisos: Array.isArray(d.avisos) ? d.avisos : [],
  };
  if (porLocal && porLocal.length > 0) {
    const topPorLocal = Math.max(5, Math.floor(TOP_PROMPT / Math.min(porLocal.length, 10)));
    out.porLocal = porLocal.slice(0, 25).map((loc) => ({
      localId: loc.localId,
      nombre: loc.nombre,
      totales: loc.totales,
      articulos: Array.isArray(loc.articulos) ? loc.articulos.slice(0, topPorLocal) : [],
      ...(Array.isArray(loc.porFamilia)
        ? { porFamilia: loc.porFamilia.slice(0, 10) }
        : {}),
    }));
  }
  return out;
}

async function scanLocales() {
  const items = [];
  let lastKey = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.locales,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapInBatches(items, concurrency, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    // eslint-disable-next-line no-await-in-loop
    const part = await Promise.all(chunk.map(fn));
    out.push(...part);
  }
  return out;
}

/**
 * @param {object} user
 * @param {{
 *   fechaDesde?: string,
 *   fechaHasta?: string,
 *   localIds?: string[]|string,
 *   familiaIds?: string[]|string,
 *   grupoIds?: string[]|string,
 *   incluirSubtotalesFamilia?: boolean,
 *   agruparPorLocal?: boolean,
 * }} [params]
 */
export async function buildVentasPorArticulo(user, params = {}) {
  const fechaDesde = RE_FECHA.test(String(params?.fechaDesde || ''))
    ? String(params.fechaDesde).slice(0, 10)
    : inicioAnoIsoLocal();
  const fechaHasta = RE_FECHA.test(String(params?.fechaHasta || ''))
    ? String(params.fechaHasta).slice(0, 10)
    : hoyIsoLocal();

  if (fechaDesde > fechaHasta) {
    throw Object.assign(new Error('fechaDesde no puede ser posterior a fechaHasta'), { status: 400 });
  }
  const dias = daysBetweenInclusive(fechaDesde, fechaHasta);
  if (dias > MAX_DIAS) {
    throw Object.assign(
      new Error(`El rango no puede superar ${MAX_DIAS} días (solicitados: ${dias})`),
      { status: 400 },
    );
  }

  const localIdsRaw = parseIdList(params?.localIds);
  const localIdsSet =
    localIdsRaw.length > 0
      ? new Set(localIdsRaw.map((id) => formatId6(id)))
      : null;

  const todos = await scanLocales();
  const visibles = [];
  for (const loc of todos) {
    if (!esSedeGrupoParipeLocal(loc)) continue;
    const idRaw = loc.id_Locales ?? loc.id_locales;
    if (!idRaw) continue;
    const localId = formatId6(idRaw);
    if (localIdsSet && !localIdsSet.has(localId)) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await usuarioPuedeAccederLocal(user, localId);
    if (!ok) continue;
    visibles.push({
      localId,
      nombre: String(loc.nombre ?? loc.Nombre ?? localId).trim(),
    });
  }
  visibles.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));

  const familiaIdsDirectos = parseIdList(params?.familiaIds).map(canonicalFamilyId).filter(Boolean);
  const grupoIds = parseIdList(params?.grupoIds);
  const gruposAplicados = [];
  const familiaIdsSet = new Set(familiaIdsDirectos);

  for (const gid of grupoIds) {
    // eslint-disable-next-line no-await-in-loop
    const g = await getGrupoFamiliasIa(gid);
    if (!g || g.activo === false) continue;
    gruposAplicados.push({ id: g.id, nombre: g.nombre, familiaIds: g.familiaIds });
    for (const fid of g.familiaIds || []) {
      const c = canonicalFamilyId(fid);
      if (c) familiaIdsSet.add(c);
    }
  }

  const hayFiltroFamilias = familiaIdsSet.size > 0;
  const agruparPorLocal = Boolean(params?.agruparPorLocal);
  const incluirSubtotales =
    params?.incluirSubtotalesFamilia === undefined
      ? true
      : Boolean(params.incluirSubtotalesFamilia);

  const localesConError = [];
  const rowsPorLocal = await mapInBatches(visibles, CONCURRENCY, async (v) => {
    try {
      const rows = await queryVentasPorLocalRango(docClient, v.localId, fechaDesde, fechaHasta);
      return { local: v, rows };
    } catch (err) {
      console.warn('[ia/ventas-por-articulo] query falló', v.localId, err?.message || err);
      localesConError.push(v.nombre || v.localId);
      return { local: v, rows: [] };
    }
  });

  const allRows = rowsPorLocal.flatMap((x) => x.rows || []);
  const byIdGlobal = agregarPorProductId(allRows);
  const productIds = new Set([...byIdGlobal.keys()]);
  for (const block of rowsPorLocal) {
    for (const r of block.rows || []) {
      const pid = String(r?.ProductId ?? '').trim();
      if (pid) productIds.add(pid);
    }
  }
  const productsMap = productIds.size > 0
    ? await loadAgoraProductsMap(docClient, [...productIds])
    : new Map();

  const { articulos: articulosGlobalesRaw, sinFamilia } = enriquecerYFiltrarFamilias(
    byIdGlobal,
    productsMap,
    hayFiltroFamilias ? familiaIdsSet : null,
  );

  const rankingGlobal = finalizarRankingArticulos(articulosGlobalesRaw, {
    incluirSubtotales,
    maxArticulos: MAX_ARTICULOS,
  });

  let porLocal = null;
  let truncadoLocales = false;
  if (agruparPorLocal) {
    const maxPorLocal = Math.max(
      30,
      Math.min(100, Math.floor(MAX_ARTICULOS / Math.max(visibles.length, 1))),
    );
    porLocal = [];
    for (const { local, rows } of rowsPorLocal) {
      const byId = agregarPorProductId(rows);
      const { articulos: raw } = enriquecerYFiltrarFamilias(
        byId,
        productsMap,
        hayFiltroFamilias ? familiaIdsSet : null,
      );
      const ranking = finalizarRankingArticulos(raw, {
        incluirSubtotales,
        maxArticulos: maxPorLocal,
      });
      if (ranking.truncado) truncadoLocales = true;
      porLocal.push({
        localId: local.localId,
        nombre: local.nombre,
        totales: ranking.totales,
        articulos: ranking.articulos,
        ...(incluirSubtotales && ranking.porFamilia ? { porFamilia: ranking.porFamilia } : {}),
        truncado: ranking.truncado,
      });
    }
    porLocal.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
  }

  const lastSalesLinesSync = await getLastSalesLinesSync(docClient).catch(() => null);
  const avisos = [];
  if (localesConError.length > 0) {
    avisos.push(
      `No se pudieron cargar ventas de: ${localesConError.slice(0, 8).join(', ')}${localesConError.length > 8 ? '…' : ''}. El informe puede estar incompleto.`,
    );
  }
  if (sinFamilia > 0 && !hayFiltroFamilias) {
    avisos.push(`${sinFamilia} artículo(s) sin familia en catálogo Ágora (aparecen como «Sin familia»).`);
  }
  if (sinFamilia > 0 && hayFiltroFamilias) {
    avisos.push(`${sinFamilia} artículo(s) sin familia excluidos por el filtro de familias.`);
  }
  if (lastSalesLinesSync != null && Date.now() - lastSalesLinesSync > SYNC_STALE_MS) {
    avisos.push(
      `La última sincronización de líneas de venta tiene más de 48 h (${new Date(lastSalesLinesSync).toISOString()}).`,
    );
  }
  if (lastSalesLinesSync == null) {
    avisos.push('No hay marca de última sincronización de líneas de venta.');
  }
  if (rankingGlobal.truncado) {
    avisos.push(
      `Listado global truncado a ${MAX_ARTICULOS} artículos (había ${rankingGlobal.totalSinTruncar}); totales y % sobre el conjunto completo. Orden: unidades desc.`,
    );
  }
  if (truncadoLocales) {
    avisos.push('Algunos locales tienen el listado de artículos truncado (orden unidades desc).');
  }
  if (visibles.length === 0) {
    avisos.push('Ningún local accesible con los filtros indicados.');
  }

  const meta = {
    fechaDesde,
    fechaHasta,
    locales: visibles.map((v) => ({ localId: v.localId, nombre: v.nombre })),
    familiasFiltro: hayFiltroFamilias ? [...familiaIdsSet].sort() : [],
    gruposAplicados,
    agruparPorLocal,
    lastSalesLinesSync:
      lastSalesLinesSync != null ? new Date(lastSalesLinesSync).toISOString() : null,
    generadoEn: new Date().toISOString(),
    orden: 'unidades_desc',
    topPrompt: TOP_PROMPT,
    truncado: rankingGlobal.truncado || truncadoLocales,
  };

  const out = {
    meta,
    totales: rankingGlobal.totales,
    articulos: rankingGlobal.articulos,
    avisos,
  };
  if (incluirSubtotales && rankingGlobal.porFamilia) out.porFamilia = rankingGlobal.porFamilia;
  if (porLocal) out.porLocal = porLocal;
  return out;
}
