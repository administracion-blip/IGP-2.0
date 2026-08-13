/**
 * Incentivos de campaña del mes (hasta hastaFecha) para Bonus RRHH.
 * Solo lectura de Igp_Campanas + Igp_VentasProducto.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { toNumberSafe } from '../agora/invoiceSaleValidity.js';
import { queryVentasPorLocalRango } from '../dynamo/ventasProducto.js';
import { tables } from '../db.js';
import { estadoEfectivo } from '../campanas/campanaEstado.js';
import {
  calcIncentivoProducto,
  filterRows,
  loadAgoraProductsMap,
  resolveMargenUnitario,
  round2,
  sumUnidades,
  sumUnidadesBonificables,
  udsBonificablesRow,
} from '../campanas/campanaResultados.js';

const ESTADOS_INCLUIDOS = new Set(['Activa', 'Finalizada', 'Bonificada']);
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

async function scanCampanas(docClient) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.campanas,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

function solapaRango(fechaInicio, fechaFin, inicioMes, hastaFecha) {
  return fechaInicio <= hastaFecha && fechaFin >= inicioMes;
}

function interseccionFechas(fechaInicio, fechaFin, inicioMes, hastaFecha) {
  const desde = fechaInicio > inicioMes ? fechaInicio : inicioMes;
  const hasta = fechaFin < hastaFecha ? fechaFin : hastaFecha;
  if (desde > hasta) return null;
  return { desde, hasta };
}

function normalizarValorIncentivo(tipoIncentivo, valorRaw) {
  let valor = toNumberSafe(valorRaw);
  if (['pct_coste', 'pct_margen'].includes(tipoIncentivo) && valor > 1) {
    valor = round2(valor / 100);
  }
  return valor;
}

/**
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {{ inicioMes: string, hastaFecha: string, localIds: string[] }} opts
 * @returns {Promise<Map<string, { totalIncentivo: number, detalle: object[] }>>}
 */
export async function agregarIncentivosMes(docClient, { inicioMes, hastaFecha, localIds }) {
  const result = new Map();
  const ids = (localIds || []).map(String).filter(Boolean);
  for (const id of ids) {
    result.set(id, { totalIncentivo: 0, detalle: [] });
  }
  if (!ids.length || !RE_FECHA.test(inicioMes) || !RE_FECHA.test(hastaFecha)) {
    return result;
  }

  const campanas = await scanCampanas(docClient);
  const relevantes = [];
  for (const c of campanas) {
    const fechaInicio = String(c.fechaInicio || '').trim();
    const fechaFin = String(c.fechaFin || '').trim();
    if (!RE_FECHA.test(fechaInicio) || !RE_FECHA.test(fechaFin)) continue;
    if (!solapaRango(fechaInicio, fechaFin, inicioMes, hastaFecha)) continue;
    const estado = estadoEfectivo(c, hastaFecha);
    if (!ESTADOS_INCLUIDOS.has(estado)) continue;
    const localesCampana = (Array.isArray(c.locales) ? c.locales : []).map(String);
    if (!localesCampana.some((lid) => result.has(lid))) continue;
    relevantes.push(c);
  }

  if (!relevantes.length) return result;

  const productIds = new Set();
  for (const c of relevantes) {
    for (const p of Array.isArray(c.productos) ? c.productos : []) {
      const pid = String(p?.productId || '').trim();
      if (pid) productIds.add(pid);
    }
  }
  const agoraProducts = await loadAgoraProductsMap(docClient, [...productIds]);

  const ventasPorLocal = new Map();
  for (const localId of ids) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await queryVentasPorLocalRango(docClient, localId, inicioMes, hastaFecha);
    ventasPorLocal.set(localId, rows);
  }

  for (const campana of relevantes) {
    const campanaId = String(campana.campanaId || '').trim();
    const campanaNombre = String(campana.nombre || campanaId).trim();
    const fechaInicio = String(campana.fechaInicio || '').trim();
    const fechaFin = String(campana.fechaFin || '').trim();
    const rango = interseccionFechas(fechaInicio, fechaFin, inicioMes, hastaFecha);
    if (!rango) continue;

    const tipoIncentivo = String(campana.tipoIncentivo || '').trim();
    const valorIncentivo = normalizarValorIncentivo(tipoIncentivo, campana.valorIncentivo);
    const destinatario = String(campana.destinatario || 'equipo').trim();
    const localesCampana = (Array.isArray(campana.locales) ? campana.locales : []).map(String)
      .filter((lid) => result.has(lid));
    const productos = Array.isArray(campana.productos) ? campana.productos : [];

    for (const prod of productos) {
      const productId = String(prod.productId || '').trim();
      if (!productId) continue;
      const productName = String(prod.productName || productId).trim();
      const agoraProduct = agoraProducts.get(productId) || null;
      const costeUnitario = toNumberSafe(agoraProduct?.CostPrice);

      const rowsAllForMargen = [];
      for (const localId of localesCampana) {
        const rows = filterRows(ventasPorLocal.get(localId) || [], productId, rango.desde, rango.hasta);
        rowsAllForMargen.push(...rows);
      }
      const warnings = [];
      const margenUnitario = tipoIncentivo === 'pct_margen'
        ? resolveMargenUnitario(prod, rowsAllForMargen, agoraProduct, warnings)
        : 0;

      for (const localId of localesCampana) {
        const bucket = result.get(localId);
        if (!bucket) continue;
        const campanaRows = filterRows(
          ventasPorLocal.get(localId) || [],
          productId,
          rango.desde,
          rango.hasta,
        );
        if (!campanaRows.length) continue;

        if (destinatario === 'individual') {
          const byUser = new Map();
          for (const r of campanaRows) {
            const uid = String(r.AgoraUserId || '0');
            if (!byUser.has(uid)) {
              byUser.set(uid, {
                agoraUserId: uid,
                userName: String(r.UserName || '').trim(),
                uds: 0,
                udsBonif: 0,
              });
            }
            const acc = byUser.get(uid);
            acc.uds += toNumberSafe(r.Unidades);
            acc.udsBonif += udsBonificablesRow(r);
            if (!acc.userName && r.UserName) acc.userName = String(r.UserName).trim();
          }
          for (const row of byUser.values()) {
            const incentivoEur = calcIncentivoProducto(
              row.uds,
              row.udsBonif,
              margenUnitario,
              costeUnitario,
              tipoIncentivo,
              valorIncentivo,
            );
            if (incentivoEur === 0 && row.uds === 0) continue;
            bucket.totalIncentivo = round2(bucket.totalIncentivo + incentivoEur);
            bucket.detalle.push({
              campanaId,
              campanaNombre,
              destinatario: 'individual',
              productId,
              productName,
              agoraUserId: row.agoraUserId,
              userName: row.userName || row.agoraUserId,
              unidades: round2(row.uds),
              incentivoEur,
            });
          }
        } else {
          const uds = sumUnidades(campanaRows);
          const udsBonif = sumUnidadesBonificables(campanaRows);
          const incentivoEur = calcIncentivoProducto(
            uds,
            udsBonif,
            margenUnitario,
            costeUnitario,
            tipoIncentivo,
            valorIncentivo,
          );
          if (incentivoEur === 0 && uds === 0) continue;
          bucket.totalIncentivo = round2(bucket.totalIncentivo + incentivoEur);
          bucket.detalle.push({
            campanaId,
            campanaNombre,
            destinatario: 'equipo',
            productId,
            productName,
            agoraUserId: null,
            userName: 'Equipo',
            unidades: round2(uds),
            incentivoEur,
          });
        }
      }
    }
  }

  for (const bucket of result.values()) {
    bucket.detalle.sort((a, b) => {
      const byUser = String(a.userName || '').localeCompare(String(b.userName || ''), 'es', { sensitivity: 'base' });
      if (byUser !== 0) return byUser;
      return String(a.productName || '').localeCompare(String(b.productName || ''), 'es', { sensitivity: 'base' });
    });
  }

  return result;
}
