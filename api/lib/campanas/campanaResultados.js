/**
 * Cálculo de resultados de campañas de incentivo por producto.
 * Fórmulas normativas: cursor-campanas-prompt.md § Decisiones cerradas.
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

function resolveMargenUnitario(productoCampana, campanaRows, agoraProduct, warnings) {
  if (productoCampana.margenUnitario != null && productoCampana.margenUnitario !== '') {
    const fijo = toNumberSafe(productoCampana.margenUnitario);
    if (fijo !== 0) return fijo;
  }
  const costPrice = toNumberSafe(agoraProduct?.CostPrice);
  if (!costPrice) {
    if (!warnings.includes('coste_desconocido')) warnings.push('coste_desconocido');
    return 0;
  }
  const precioSinIva = calcPrecioMedioSinIva(campanaRows, agoraProduct, warnings);
  return round2(precioSinIva - costPrice);
}

function calcIncentivoProducto(unidades, margenUnitario, tipoIncentivo, valorIncentivo) {
  const uds = toNumberSafe(unidades);
  const valor = toNumberSafe(valorIncentivo);
  if (uds <= 0 || valor <= 0) return 0;
  if (tipoIncentivo === 'eur_por_unidad') {
    return round2(uds * valor);
  }
  if (tipoIncentivo === 'pct_margen') {
    return round2(uds * margenUnitario * valor);
  }
  return 0;
}

function veredictoProducto(resultadoNeto, warnings) {
  if (warnings.includes('coste_desconocido')) return 'REVISAR';
  return resultadoNeto >= 0 ? 'RENTABLE' : 'REVISAR';
}

async function loadAgoraProductsMap(docClient, productIds) {
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

function filterRows(rows, productId, fechaDesde, fechaHasta) {
  return rows.filter((r) => {
    if (String(r.ProductId) !== String(productId)) return false;
    const f = String(r.Fecha || '');
    return f >= fechaDesde && f <= fechaHasta;
  });
}

function sumUnidades(rows) {
  return rows.reduce((acc, r) => acc + toNumberSafe(r.Unidades), 0);
}

function sumImporte(rows) {
  return round2(rows.reduce((acc, r) => acc + toNumberSafe(r.ImporteBruto), 0));
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
  const baselineInicio = String(campana.baselineInicio || '').trim();
  const baselineFin = String(campana.baselineFin || '').trim();
  const tipoIncentivo = String(campana.tipoIncentivo || '').trim();
  const valorIncentivo = toNumberSafe(campana.valorIncentivo);
  const destinatario = String(campana.destinatario || 'equipo').trim();

  const diasBaseline = daysBetweenInclusive(baselineInicio, baselineFin);
  const diasCampana = daysBetweenInclusive(fechaInicio, fechaFin);

  const fechaMin = [baselineInicio, fechaInicio].filter(Boolean).sort()[0];
  const fechaMax = [baselineFin, fechaFin].filter(Boolean).sort().pop();

  const ventasPorLocal = new Map();
  for (const localId of locales) {
    const rows = await queryVentasPorLocalRango(docClient, localId, fechaMin, fechaMax);
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

    let udsBaselineTotal = 0;
    let udsCampanaTotal = 0;
    let udsIncrementalesTotal = 0;
    let baselineIncompletoProducto = false;

    const campanaRowsAll = [];
    const margenRowsAll = [];

    for (const localId of locales) {
      const allRows = ventasPorLocal.get(localId) || [];
      const baselineRows = filterRows(allRows, productId, baselineInicio, baselineFin);
      const campanaRows = filterRows(allRows, productId, fechaInicio, fechaFin);

      campanaRowsAll.push(...campanaRows);
      margenRowsAll.push(...campanaRows);

      const udsBaselineLocal = sumUnidades(baselineRows);
      const udsCampanaLocal = sumUnidades(campanaRows);

      udsBaselineTotal += udsBaselineLocal;
      udsCampanaTotal += udsCampanaLocal;

      if (udsBaselineLocal <= 0) {
        baselineIncompletoProducto = true;
      } else {
        const udsBaselinePorDiaLocal = udsBaselineLocal / diasBaseline;
        const baselineExtrapoladoLocal = udsBaselinePorDiaLocal * diasCampana;
        udsIncrementalesTotal += Math.max(0, udsCampanaLocal - baselineExtrapoladoLocal);
      }

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
      const loc = localAgg.get(localId);
      loc.unidades += udsCampanaLocal;
    }

    if (baselineIncompletoProducto && !warnings.includes('baseline_incompleto')) {
      warnings.push('baseline_incompleto');
    }

    const udsBaselinePorDia = diasBaseline > 0 ? udsBaselineTotal / diasBaseline : 0;
    const udsCampanaPorDia = diasCampana > 0 ? udsCampanaTotal / diasCampana : 0;
    const udsIncrementales = baselineIncompletoProducto ? 0 : round2(udsIncrementalesTotal);

    const margenUnitario = resolveMargenUnitario(prod, margenRowsAll, agoraProduct, warnings);
    const margenIncremental = round2(udsIncrementales * margenUnitario);
    const costeIncentivo = calcIncentivoProducto(
      udsCampanaTotal,
      margenUnitario,
      tipoIncentivo,
      valorIncentivo,
    );
    const resultadoNeto = round2(margenIncremental - costeIncentivo);

    porProductoMap.set(productId, {
      productId,
      productName,
      udsBaselinePorDia: round2(udsBaselinePorDia),
      udsCampanaPorDia: round2(udsCampanaPorDia),
      udsCampanaTotal: round2(udsCampanaTotal),
      udsIncrementales,
      margenUnitario,
      margenIncremental,
      costeIncentivo,
      resultadoNeto,
      veredicto: veredictoProducto(resultadoNeto, warnings),
      baselineIncompleto: baselineIncompletoProducto,
    });

    if (destinatario === 'individual') {
      for (const localId of locales) {
        const campanaRows = filterRows(ventasPorLocal.get(localId) || [], productId, fechaInicio, fechaFin);
        const byUser = new Map();
        for (const r of campanaRows) {
          const uid = String(r.AgoraUserId || '0');
          if (!byUser.has(uid)) byUser.set(uid, 0);
          byUser.set(uid, byUser.get(uid) + toNumberSafe(r.Unidades));
        }
        for (const [uid, uds] of byUser) {
          const empKey = `${localId}|${uid}`;
          const emp = empleadoAgg.get(empKey);
          if (!emp) continue;
          emp.incentivoDevengado = round2(
            emp.incentivoDevengado +
            calcIncentivoProducto(uds, margenUnitario, tipoIncentivo, valorIncentivo),
          );
        }
      }
    } else {
      for (const localId of locales) {
        const campanaRows = filterRows(ventasPorLocal.get(localId) || [], productId, fechaInicio, fechaFin);
        const udsLocal = sumUnidades(campanaRows);
        const loc = localAgg.get(localId);
        if (loc) {
          loc.incentivoDevengado = round2(
            loc.incentivoDevengado +
            calcIncentivoProducto(udsLocal, margenUnitario, tipoIncentivo, valorIncentivo),
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
      margenIncremental: round2(acc.margenIncremental + p.margenIncremental),
      costeIncentivo: round2(acc.costeIncentivo + p.costeIncentivo),
      resultadoNeto: round2(acc.resultadoNeto + p.resultadoNeto),
    }),
    { margenIncremental: 0, costeIncentivo: 0, resultadoNeto: 0 },
  );

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

/** Baseline por defecto: mismo número de días inmediatamente anterior a fechaInicio. */
export function defaultBaselinePeriod(fechaInicio, fechaFin) {
  const dias = daysBetweenInclusive(fechaInicio, fechaFin);
  const fin = new Date(fechaInicio + 'T12:00:00');
  fin.setDate(fin.getDate() - 1);
  const inicio = new Date(fechaInicio + 'T12:00:00');
  inicio.setDate(inicio.getDate() - dias);
  return {
    baselineInicio: inicio.toISOString().slice(0, 10),
    baselineFin: fin.toISOString().slice(0, 10),
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
      if (!cost) warnings.push(`coste_desconocido:${productId}`);
      out._costPrice = cost;
      out._productName = String(r.Item?.Name || out.productName).trim();
      if (out._productName) out.productName = out._productName;
    }
    resolved.push(out);
  }
  return { productos: resolved, warnings };
}
