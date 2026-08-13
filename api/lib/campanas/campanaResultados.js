/**
 * Cálculo de resultados de campañas de incentivo por producto.
 * Modelo operativo: uds vendidas en campaña + incentivo devengado (sin baseline ni rentabilidad).
 */

import { GetCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { toNumberSafe } from '../agora/invoiceSaleValidity.js';
import {
  queryVentasPorLocalRango,
  daysBetweenInclusive,
  listDaysBetween,
} from '../dynamo/ventasProducto.js';
import { tables } from '../db.js';

const IVA_DEFAULT = parseFloat(process.env.INCENTIVOS_IVA_DEFAULT || '0.10') || 0.10;

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function ivaRateFromProduct(agoraProduct, usedDefaultIva) {
  const pct = toNumberSafe(agoraProduct?.VatPercent);
  if (pct > 0) return { rate: pct / 100, usedDefaultIva };
  usedDefaultIva.value = true;
  return { rate: IVA_DEFAULT, usedDefaultIva };
}

function calcPrecioMedioSinIva(rows, agoraProduct, warnings) {
  let sumBruto = 0;
  let sumUds = 0;
  for (const r of rows) {
    sumBruto += toNumberSafe(r.ImporteBruto);
    sumUds += toNumberSafe(r.Unidades);
  }
  if (sumUds <= 0) return 0;
  const usedDefaultIva = { value: false };
  const { rate } = ivaRateFromProduct(agoraProduct, usedDefaultIva);
  if (usedDefaultIva.value && !warnings.includes('iva_estimado')) {
    warnings.push('iva_estimado');
  }
  const precioConIva = sumBruto / sumUds;
  return precioConIva / (1 + rate);
}

export function resolveMargenUnitario(productoCampana, campanaRows, agoraProduct, warnings) {
  if (productoCampana.margenUnitario != null && productoCampana.margenUnitario !== '') {
    const fijo = toNumberSafe(productoCampana.margenUnitario);
    if (fijo !== 0) return fijo;
  }
  const costPrice = toNumberSafe(agoraProduct?.CostPrice);
  if (!costPrice) return 0;
  const precioSinIva = calcPrecioMedioSinIva(campanaRows, agoraProduct, warnings);
  return round2(precioSinIva - costPrice);
}

/**
 * Incentivo devengado.
 * - eur_por_unidad: usa unidades bonificables (descuento > umbral reduce proporcional).
 * - pct_coste / pct_margen: usan unidades reales (ajenos al descuento por unidad;
 *   pct_margen ya refleja el descuento vía el precio medio real).
 */
export function calcIncentivoProducto(unidades, unidadesBonificables, margenUnitario, costeUnitario, tipoIncentivo, valorIncentivo) {
  const uds = toNumberSafe(unidades);
  const udsBonif = toNumberSafe(unidadesBonificables);
  const valor = toNumberSafe(valorIncentivo);
  if (uds <= 0 || valor <= 0) return 0;
  if (tipoIncentivo === 'eur_por_unidad') {
    return round2(udsBonif * valor);
  }
  if (tipoIncentivo === 'pct_coste') {
    return round2(uds * toNumberSafe(costeUnitario) * valor);
  }
  if (tipoIncentivo === 'pct_margen') {
    return round2(uds * margenUnitario * valor);
  }
  return 0;
}

function calcBonificacionUnitaria(margenUnitario, costeUnitario, tipoIncentivo, valorIncentivo) {
  const valor = toNumberSafe(valorIncentivo);
  if (valor <= 0) return 0;
  if (tipoIncentivo === 'eur_por_unidad') return round2(valor);
  if (tipoIncentivo === 'pct_coste') return round2(toNumberSafe(costeUnitario) * valor);
  if (tipoIncentivo === 'pct_margen') return round2(margenUnitario * valor);
  return 0;
}

export async function loadAgoraProductsMap(docClient, productIds) {
  const map = new Map();
  const ids = [...productIds];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const keys = chunk.map((id) => ({ PK: 'GLOBAL', SK: String(id) }));
    const r = await docClient.send(new BatchGetCommand({
      RequestItems: {
        [tables.agoraProducts]: { Keys: keys },
      },
    }));
    for (const item of r.Responses?.[tables.agoraProducts] || []) {
      const id = String(item.SK ?? item.Id ?? '').trim();
      if (id) map.set(id, item);
    }
  }
  return map;
}

export function filterRows(rows, productId, fechaDesde, fechaHasta) {
  return rows.filter((r) => {
    if (String(r.ProductId) !== String(productId)) return false;
    const f = String(r.Fecha || '');
    return f >= fechaDesde && f <= fechaHasta;
  });
}

export function sumUnidades(rows) {
  return rows.reduce((acc, r) => acc + toNumberSafe(r.Unidades), 0);
}

/** Unidades bonificables de una fila (fallback a Unidades si el agregado es previo al campo). */
export function udsBonificablesRow(r) {
  return r?.UnidadesBonificables != null
    ? toNumberSafe(r.UnidadesBonificables)
    : toNumberSafe(r.Unidades);
}

export function sumUnidadesBonificables(rows) {
  return rows.reduce((acc, r) => acc + udsBonificablesRow(r), 0);
}

/**
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {object} campana — ítem de Igp_Campanas
 */
export async function calcularResultadosCampana(docClient, campana) {
  const warnings = [];
  const locales = Array.isArray(campana.locales) ? campana.locales.map(String) : [];
  const productos = Array.isArray(campana.productos) ? campana.productos : [];
  const productIds = productos.map((p) => String(p.productId || '').trim()).filter(Boolean);

  const fechaInicio = String(campana.fechaInicio || '').trim();
  const fechaFin = String(campana.fechaFin || '').trim();
  const tipoIncentivo = String(campana.tipoIncentivo || '').trim();
  let valorIncentivo = toNumberSafe(campana.valorIncentivo);
  if (['pct_coste', 'pct_margen'].includes(tipoIncentivo) && valorIncentivo > 1) {
    valorIncentivo = round2(valorIncentivo / 100);
  }
  const destinatario = String(campana.destinatario || 'equipo').trim();
  const diasCampana = daysBetweenInclusive(fechaInicio, fechaFin);

  const ventasPorLocal = new Map();
  for (const localId of locales) {
    const rows = await queryVentasPorLocalRango(docClient, localId, fechaInicio, fechaFin);
    ventasPorLocal.set(localId, rows);
  }

  const agoraProducts = await loadAgoraProductsMap(docClient, productIds);

  const porProductoMap = new Map();
  const empleadoAgg = new Map();
  const localAgg = new Map();
  const serieDiariaMap = new Map();

  for (const prod of productos) {
    const productId = String(prod.productId || '').trim();
    if (!productId) continue;
    const productName = String(prod.productName || productId).trim();
    const agoraProduct = agoraProducts.get(productId) || null;

    let udsCampanaTotal = 0;
    let udsBonificablesTotal = 0;
    const campanaRowsAll = [];

    for (const localId of locales) {
      const allRows = ventasPorLocal.get(localId) || [];
      const campanaRows = filterRows(allRows, productId, fechaInicio, fechaFin);
      campanaRowsAll.push(...campanaRows);

      const udsCampanaLocal = sumUnidades(campanaRows);
      udsCampanaTotal += udsCampanaLocal;
      udsBonificablesTotal += sumUnidadesBonificables(campanaRows);

      if (destinatario === 'individual') {
        const byUser = new Map();
        for (const r of campanaRows) {
          const uid = String(r.AgoraUserId || '0');
          const key = `${localId}|${uid}|${productId}`;
          if (!byUser.has(key)) {
            byUser.set(key, {
              agoraUserId: uid,
              userName: String(r.UserName || '').trim(),
              localId,
              unidades: 0,
              importe: 0,
            });
          }
          const row = byUser.get(key);
          row.unidades += toNumberSafe(r.Unidades);
          row.importe = round2(row.importe + toNumberSafe(r.ImporteBruto));
          if (!row.userName && r.UserName) row.userName = String(r.UserName).trim();
        }
        for (const [, row] of byUser) {
          const empKey = `${row.localId}|${row.agoraUserId}`;
          if (!empleadoAgg.has(empKey)) {
            empleadoAgg.set(empKey, {
              agoraUserId: row.agoraUserId,
              userName: row.userName,
              localId: row.localId,
              unidades: 0,
              importe: 0,
              incentivoDevengado: 0,
            });
          }
          const emp = empleadoAgg.get(empKey);
          emp.unidades += row.unidades;
          emp.importe = round2(emp.importe + row.importe);
        }
      }

      if (!localAgg.has(localId)) {
        localAgg.set(localId, { localId, unidades: 0, incentivoDevengado: 0 });
      }
      localAgg.get(localId).unidades += udsCampanaLocal;
    }

    const costeUnitario = toNumberSafe(agoraProduct?.CostPrice);

    const margenUnitario = tipoIncentivo === 'pct_margen'
      ? resolveMargenUnitario(prod, campanaRowsAll, agoraProduct, warnings)
      : 0;

    const costeIncentivo = calcIncentivoProducto(
      udsCampanaTotal,
      udsBonificablesTotal,
      margenUnitario,
      costeUnitario,
      tipoIncentivo,
      valorIncentivo,
    );

    const bonificacionUnitaria = calcBonificacionUnitaria(
      margenUnitario,
      costeUnitario,
      tipoIncentivo,
      valorIncentivo,
    );

    const udsCampanaPorDia = diasCampana > 0 ? udsCampanaTotal / diasCampana : 0;

    porProductoMap.set(productId, {
      productId,
      productName,
      udsCampanaPorDia: round2(udsCampanaPorDia),
      udsCampanaTotal: round2(udsCampanaTotal),
      costeIncentivo,
      bonificacionUnitaria,
      precioCoste: costeUnitario > 0 ? round2(costeUnitario) : undefined,
    });

    if (destinatario === 'individual') {
      for (const localId of locales) {
        const campanaRows = filterRows(ventasPorLocal.get(localId) || [], productId, fechaInicio, fechaFin);
        const byUser = new Map();
        for (const r of campanaRows) {
          const uid = String(r.AgoraUserId || '0');
          if (!byUser.has(uid)) byUser.set(uid, { uds: 0, udsBonif: 0 });
          const acc = byUser.get(uid);
          acc.uds += toNumberSafe(r.Unidades);
          acc.udsBonif += udsBonificablesRow(r);
        }
        for (const [uid, { uds, udsBonif }] of byUser) {
          const empKey = `${localId}|${uid}`;
          const emp = empleadoAgg.get(empKey);
          if (!emp) continue;
          emp.incentivoDevengado = round2(
            emp.incentivoDevengado +
            calcIncentivoProducto(uds, udsBonif, margenUnitario, costeUnitario, tipoIncentivo, valorIncentivo),
          );
        }
      }
    } else {
      for (const localId of locales) {
        const campanaRows = filterRows(ventasPorLocal.get(localId) || [], productId, fechaInicio, fechaFin);
        const udsLocal = sumUnidades(campanaRows);
        const udsBonifLocal = sumUnidadesBonificables(campanaRows);
        const loc = localAgg.get(localId);
        if (loc) {
          loc.incentivoDevengado = round2(
            loc.incentivoDevengado +
            calcIncentivoProducto(udsLocal, udsBonifLocal, margenUnitario, costeUnitario, tipoIncentivo, valorIncentivo),
          );
        }
      }
    }
  }

  for (const fecha of listDaysBetween(fechaInicio, fechaFin)) {
    let total = 0;
    for (const localId of locales) {
      const rows = ventasPorLocal.get(localId) || [];
      for (const r of rows) {
        if (String(r.Fecha) !== fecha) continue;
        if (!productIds.includes(String(r.ProductId))) continue;
        total += toNumberSafe(r.Unidades);
      }
    }
    serieDiariaMap.set(fecha, round2(total));
  }

  const porProducto = [...porProductoMap.values()];
  const totales = porProducto.reduce(
    (acc, p) => ({
      unidadesCampana: round2(acc.unidadesCampana + p.udsCampanaTotal),
      costeIncentivo: round2(acc.costeIncentivo + p.costeIncentivo),
    }),
    { unidadesCampana: 0, costeIncentivo: 0 },
  );

  // Campañas individuales: el incentivo se calcula por empleado; agregar al local.
  if (destinatario === 'individual') {
    for (const emp of empleadoAgg.values()) {
      const loc = localAgg.get(emp.localId);
      if (loc) {
        loc.incentivoDevengado = round2(loc.incentivoDevengado + emp.incentivoDevengado);
      }
    }
  }

  const porEmpleado = destinatario === 'individual'
    ? [...empleadoAgg.values()].sort((a, b) => b.incentivoDevengado - a.incentivoDevengado)
    : [];

  const porLocal = [...localAgg.values()].sort((a, b) => b.incentivoDevengado - a.incentivoDevengado);

  const serieDiaria = [...serieDiariaMap.entries()]
    .map(([fecha, unidades]) => ({ fecha, unidades }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  return {
    porProducto,
    porEmpleado,
    porLocal,
    totales,
    serieDiaria,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export async function resolverMargenesProductos(docClient, productos) {
  const warnings = [];
  const resolved = [];
  for (const p of productos) {
    const productId = String(p.productId || '').trim();
    const out = {
      productId,
      productName: String(p.productName || productId).trim(),
    };
    if (p.margenUnitario != null && p.margenUnitario !== '') {
      out.margenUnitario = round2(toNumberSafe(p.margenUnitario));
    } else if (productId) {
      const r = await docClient.send(new GetCommand({
        TableName: tables.agoraProducts,
        Key: { PK: 'GLOBAL', SK: productId },
      }));
      const cost = toNumberSafe(r.Item?.CostPrice);
      out._costPrice = cost;
      out._productName = String(r.Item?.Name || out.productName).trim();
      if (out._productName) out.productName = out._productName;
    }
    resolved.push(out);
  }
  return { productos: resolved, warnings };
}
