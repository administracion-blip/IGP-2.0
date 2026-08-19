/**
 * Ajuste de demanda por facturación (closeouts + comparativa YoY/festivos).
 *
 * Factor día D = Gross(fechaComp(D)) / media Gross del mismo weekday en hist.
 * Clamp 0.5–2.0. Sin workplaces o sin datos → factor 1.0 + aviso.
 *
 * Media por weekday: sobre todos los días de [histDesde, histHasta]
 * (listDaysBetween); días sin closeout cuentan como Gross 0.
 */

import {
  buildFechaToComp,
  loadFestivosByFecha,
  queryTotalsByDay,
} from '../agora/objetivoMensual.js';
import { listDaysBetween } from '../dynamo/ventasProducto.js';
import { parseIsoDate, rangoHistorico, weekdayOfIso } from './demanda.js';

export const AVISO_AJUSTE_FACTURACION = 'ajuste_facturacion_no_disponible';
export const AVISO_AJUSTE_PARCIAL = 'ajuste_facturacion_parcial';

const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2.0;

function clampFactor(n) {
  if (!Number.isFinite(n)) return null;
  if (n < FACTOR_MIN) return FACTOR_MIN;
  if (n > FACTOR_MAX) return FACTOR_MAX;
  return n;
}

function uniqueSortedIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Media Gross por weekday en el histórico.
 * Incluye ceros: cada día del rango hist entra en el divisor de su weekday.
 * @param {Record<string, number>} grossByFecha
 * @param {string} histDesde
 * @param {string} histHasta
 * @returns {Record<number, number>}
 */
export function mediaGrossPorWeekday(grossByFecha, histDesde, histHasta) {
  /** @type {Record<number, number>} */
  const sum = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  /** @type {Record<number, number>} */
  const count = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const days = listDaysBetween(histDesde, histHasta);
  for (const day of days) {
    const wd = weekdayOfIso(day);
    if (wd == null) continue;
    sum[wd] += Number(grossByFecha?.[day] || 0);
    count[wd] += 1;
  }
  /** @type {Record<number, number>} */
  const medias = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (let wd = 0; wd <= 6; wd += 1) {
    medias[wd] = count[wd] > 0 ? sum[wd] / count[wd] : 0;
  }
  return medias;
}

/**
 * @param {{
 *   fechaDesde: string,
 *   fechaHasta: string,
 *   localIds?: string[],
 *   workplaceIds?: string[],
 *   semanasHistorico?: number,
 * }} ctx
 * @returns {Promise<{
 *   disponible: boolean,
 *   factorPorFecha: Record<string, number>,
 *   factorDefault: number,
 *   avisos: string[],
 *   motivo: string,
 *   fechaToComp?: Record<string, string>,
 * }>}
 */
export async function resolverAjusteFacturacion(ctx = {}) {
  const fechaDesde = parseIsoDate(ctx.fechaDesde);
  const fechaHasta = parseIsoDate(ctx.fechaHasta);
  const workplaceIds = uniqueSortedIds(ctx.workplaceIds);
  const factorDefault = 1;

  if (!workplaceIds.length) {
    return {
      disponible: false,
      factorPorFecha: {},
      factorDefault,
      avisos: [AVISO_AJUSTE_FACTURACION],
      motivo: 'Sin workplaceIds (agoraCode) para closeouts del almacén',
    };
  }

  if (!fechaDesde || !fechaHasta || fechaDesde > fechaHasta) {
    return {
      disponible: false,
      factorPorFecha: {},
      factorDefault,
      avisos: [AVISO_AJUSTE_FACTURACION],
      motivo: 'fechaDesde/fechaHasta inválidas para ajuste de facturación',
    };
  }

  const { histDesde, histHasta } = rangoHistorico(fechaDesde, ctx.semanasHistorico);
  if (!histDesde || !histHasta) {
    return {
      disponible: false,
      factorPorFecha: {},
      factorDefault,
      avisos: [AVISO_AJUSTE_FACTURACION],
      motivo: 'No se pudo resolver el rango histórico de facturación',
    };
  }

  const festivosByFecha = await loadFestivosByFecha();
  const { fechaToComp, minComp, maxComp } = buildFechaToComp(
    fechaDesde,
    fechaHasta,
    festivosByFecha,
  );

  let rangeFrom = histDesde;
  let rangeTo = histHasta;
  if (minComp && minComp < rangeFrom) rangeFrom = minComp;
  if (maxComp && maxComp > rangeTo) rangeTo = maxComp;

  /** @type {Record<string, number>} */
  const grossByFecha = {};
  let closeoutsConDato = 0;
  for (const workplaceId of workplaceIds) {
    const totals = await queryTotalsByDay(workplaceId, rangeFrom, rangeTo);
    for (const [fecha, amount] of Object.entries(totals || {})) {
      const n = Number(amount);
      if (!Number.isFinite(n)) continue;
      grossByFecha[fecha] = (grossByFecha[fecha] || 0) + n;
      closeoutsConDato += 1;
    }
  }

  if (closeoutsConDato === 0) {
    return {
      disponible: false,
      factorPorFecha: {},
      factorDefault,
      avisos: [AVISO_AJUSTE_FACTURACION],
      motivo: 'Sin closeouts Gross en histórico/comparativa para los workplaces',
      fechaToComp,
    };
  }

  for (const k of Object.keys(grossByFecha)) {
    grossByFecha[k] = Math.round(grossByFecha[k] * 100) / 100;
  }

  const mediaWeekday = mediaGrossPorWeekday(grossByFecha, histDesde, histHasta);
  /** @type {Record<string, number>} */
  const factorPorFecha = {};
  const avisos = [];
  let parcial = false;

  const daysObjetivo = listDaysBetween(fechaDesde, fechaHasta);
  for (const fecha of daysObjetivo) {
    const wd = weekdayOfIso(fecha);
    const fc = fechaToComp[fecha];
    const num = fc != null ? Number(grossByFecha[fc]) : NaN;
    const den = wd != null ? Number(mediaWeekday[wd]) : NaN;
    if (Number.isFinite(num) && num >= 0 && Number.isFinite(den) && den > 0) {
      const clamped = clampFactor(num / den);
      factorPorFecha[fecha] = clamped != null ? Math.round(clamped * 1000) / 1000 : factorDefault;
      if (clamped == null) parcial = true;
    } else {
      factorPorFecha[fecha] = factorDefault;
      parcial = true;
    }
  }

  if (parcial) avisos.push(AVISO_AJUSTE_PARCIAL);

  return {
    disponible: true,
    factorPorFecha,
    factorDefault,
    avisos,
    motivo: parcial
      ? 'Ajuste parcial: algún día sin Gross comparable o media weekday=0'
      : 'Ajuste por Gross closeouts vs media weekday histórico',
    fechaToComp,
  };
}

/**
 * Aplica factor diario a una demanda base.
 * @param {number} unidades
 * @param {string} fecha
 * @param {{ factorPorFecha?: Record<string, number>, factorDefault?: number }} ajuste
 */
export function aplicarFactorDia(unidades, fecha, ajuste) {
  const f =
    ajuste?.factorPorFecha?.[fecha] != null
      ? Number(ajuste.factorPorFecha[fecha])
      : Number(ajuste?.factorDefault ?? 1);
  const factor = Number.isFinite(f) && f > 0 ? f : 1;
  return (Number(unidades) || 0) * factor;
}
