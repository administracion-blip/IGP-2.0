/**
 * Demanda MIA v1: media de unidades por weekday (modo directo).
 * Escandallos OFF: producto venta = consumo almacén.
 */

import { listDaysBetween } from '../dynamo/ventasProducto.js';
import { normalizeProductId } from './keys.js';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(fecha) {
  const f = String(fecha || '').slice(0, 10);
  return RE_FECHA.test(f) ? f : '';
}

/** weekday 0=domingo … 6=sábado (UTC vía T12:00:00, alineado con listDaysBetween). */
export function weekdayOfIso(fecha) {
  const f = parseIsoDate(fecha);
  if (!f) return null;
  return new Date(`${f}T12:00:00`).getUTCDay();
}

export function addDaysIso(fecha, deltaDays) {
  const f = parseIsoDate(fecha);
  if (!f) return '';
  const d = new Date(`${f}T12:00:00`);
  d.setUTCDate(d.getUTCDate() + Number(deltaDays) || 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Rango histórico: N semanas justo antes de fechaDesde (sin incluir el rango objetivo).
 * @returns {{ histDesde: string, histHasta: string, semanas: number }}
 */
export function rangoHistorico(fechaDesde, semanasHistorico) {
  const desde = parseIsoDate(fechaDesde);
  const n = Math.max(1, Math.min(52, Math.floor(Number(semanasHistorico) || 4)));
  if (!desde) return { histDesde: '', histHasta: '', semanas: n };
  const histHasta = addDaysIso(desde, -1);
  const histDesde = addDaysIso(desde, -(n * 7));
  return { histDesde, histHasta, semanas: n };
}

/**
 * Agrega ventas por producto+fecha sumando locales.
 * @param {Array<{ ProductId?: string, Fecha?: string, Unidades?: number }>} rows
 * @returns {Map<string, Map<string, number>>} productId → (fecha → unidades)
 */
export function aggregateVentasPorProductoFecha(rows) {
  /** @type {Map<string, Map<string, number>>} */
  const out = new Map();
  for (const r of rows || []) {
    const pid = normalizeProductId(r.ProductId ?? r.productId);
    const fecha = parseIsoDate(r.Fecha ?? r.fecha);
    if (!pid || !fecha) continue;
    const uds = Number(r.Unidades ?? r.unidades ?? 0);
    if (!Number.isFinite(uds) || uds === 0) continue;
    let byDay = out.get(pid);
    if (!byDay) {
      byDay = new Map();
      out.set(pid, byDay);
    }
    byDay.set(fecha, (byDay.get(fecha) || 0) + uds);
  }
  return out;
}

/**
 * Media de unidades del mismo weekday en las N semanas anteriores a fechaDesde.
 * Semanas sin venta cuentan como 0 (divisor = N).
 *
 * @param {Map<string, number>|undefined} unidadesPorFecha
 * @param {string} fechaDesde
 * @param {number} semanas
 * @returns {Record<number, number>} weekday → media
 */
export function mediaPorWeekday(unidadesPorFecha, fechaDesde, semanas) {
  const n = Math.max(1, Math.floor(Number(semanas) || 4));
  const desde = parseIsoDate(fechaDesde);
  /** @type {Record<number, number>} */
  const medias = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  if (!desde) return medias;

  const wdDesde = weekdayOfIso(desde);
  for (let wd = 0; wd <= 6; wd += 1) {
    // Mismo weekday → exactamente 7 días atrás (no 0).
    const offsetToPrev = ((wdDesde - wd + 7) % 7) || 7;
    const firstPrev = addDaysIso(desde, -offsetToPrev);
    let sum = 0;
    for (let w = 0; w < n; w += 1) {
      const day = addDaysIso(firstPrev, -w * 7);
      sum += Number(unidadesPorFecha?.get(day) || 0);
    }
    medias[wd] = sum / n;
  }
  return medias;
}

/**
 * Demanda base por día del rango objetivo (sin ajuste facturación ni colchón).
 * @returns {{ porDia: Array<{ fecha: string, weekday: number, unidades: number }>, total: number }}
 */
export function demandaBaseRango(mediasWeekday, fechaDesde, fechaHasta) {
  const days = listDaysBetween(parseIsoDate(fechaDesde), parseIsoDate(fechaHasta));
  const porDia = [];
  let total = 0;
  for (const fecha of days) {
    const wd = weekdayOfIso(fecha);
    const unidades = Number(mediasWeekday?.[wd] || 0);
    porDia.push({ fecha, weekday: wd, unidades });
    total += unidades;
  }
  return { porDia, total };
}

/**
 * Aplica colchón: demandaTotal *= (nDias + colchonDias) / nDias.
 */
export function aplicarColchon(demandaTotal, nDiasRango, colchonDias) {
  const n = Math.max(0, Number(nDiasRango) || 0);
  const c = Math.max(0, Number(colchonDias) || 0);
  if (n <= 0) return Math.max(0, Number(demandaTotal) || 0);
  return (Number(demandaTotal) || 0) * ((n + c) / n);
}

/**
 * Redondeo al alza a múltiplos de unidad de compra; si no hay formato, ceil entero.
 * @param {number} qty
 * @param {number|null|undefined} formatoCompra
 */
export function redondearCantidadCompra(qty, formatoCompra) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return 0;
  const pack = Number(formatoCompra);
  if (Number.isFinite(pack) && pack > 0) {
    return Math.ceil(q / pack) * pack;
  }
  return Math.ceil(q);
}
