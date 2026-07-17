/**
 * Análisis de variaciones de compras a proveedor (solo lectura).
 *
 * Motor determinista: compara el gasto de compras de los últimos `dias` días
 * (hasta ayer) con el periodo inmediatamente anterior de la misma duración,
 * agrupado por proveedor, familia o producto. Devuelve un JSON compacto pensado
 * para que la IA lo interprete: totales, mayores subidas/bajadas y top gasto.
 *
 * Fuente de datos: tabla `Igp_ComprasAProveedor` (líneas de albarán sincronizadas
 * desde Ágora). Se filtra por `AlbaranFecha` (fecha documental del albarán).
 *
 * No expone datos personales: solo nombres de negocio (proveedor/familia/producto)
 * e importes agregados.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

const TABLE_NAME = tables.comprasProveedor;

const AGRUPACIONES = {
  proveedor: { campoNombre: 'SupplierName', campoId: 'SupplierId', etiqueta: 'proveedor' },
  familia: { campoNombre: 'FamilyName', campoId: 'FamilyId', etiqueta: 'familia' },
  producto: { campoNombre: 'ProductName', campoId: 'ProductId', etiqueta: 'producto' },
};

const TOP_N = 10;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** YYYY-MM-DD de una fecha desplazada `offsetDias` respecto de hoy. */
function fechaIso(offsetDias) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  return d.toISOString().slice(0, 10);
}

/** Variación porcentual segura (null si no hay base anterior). */
function variacionPct(actual, anterior) {
  if (!anterior || anterior === 0) return actual > 0 ? null : 0;
  return round1(((actual - anterior) / anterior) * 100);
}

/**
 * @param {{ dias?: number|string, agrupacion?: string }} opts
 */
export async function buildAnalisisComprasVariaciones(opts = {}) {
  let dias = Math.trunc(Number(opts.dias));
  if (!Number.isFinite(dias) || dias <= 0) dias = 30;
  dias = Math.max(7, Math.min(120, dias));

  const agrupClave = AGRUPACIONES[String(opts.agrupacion || 'proveedor')]
    ? String(opts.agrupacion)
    : 'proveedor';
  const agrup = AGRUPACIONES[agrupClave];

  // Periodo actual: últimos `dias` días terminando ayer (evita el día en curso,
  // parcial). Periodo anterior: los `dias` días inmediatamente previos.
  const finActual = fechaIso(-1);
  const inicioActual = fechaIso(-dias);
  const finAnterior = fechaIso(-dias - 1);
  const inicioAnterior = fechaIso(-2 * dias);

  const items = [];
  let lastKey = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'AlbaranFecha BETWEEN :ini AND :fin',
      ExpressionAttributeValues: { ':ini': inicioAnterior, ':fin': finActual },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  const grupos = new Map();
  let gastoActualTotal = 0;
  let gastoAnteriorTotal = 0;
  let lineasActual = 0;
  let lineasAnterior = 0;

  for (const it of items) {
    const fecha = String(it.AlbaranFecha || '').trim();
    if (!fecha) continue;
    const esActual = fecha >= inicioActual && fecha <= finActual;
    const esAnterior = fecha >= inicioAnterior && fecha <= finAnterior;
    if (!esActual && !esAnterior) continue;

    const importe = Number(it.TotalAmount) || 0;
    const cantidad = Number(it.Quantity) || 0;

    const claveGrupo = String(it[agrup.campoId] ?? it[agrup.campoNombre] ?? '—').trim() || '—';
    const nombre = String(it[agrup.campoNombre] || it[agrup.campoId] || '—').trim() || '—';

    let g = grupos.get(claveGrupo);
    if (!g) {
      g = { nombre, gastoActual: 0, gastoAnterior: 0, cantidadActual: 0, cantidadAnterior: 0 };
      grupos.set(claveGrupo, g);
    }
    if (esActual) {
      g.gastoActual += importe;
      g.cantidadActual += cantidad;
      gastoActualTotal += importe;
      lineasActual += 1;
    } else {
      g.gastoAnterior += importe;
      g.cantidadAnterior += cantidad;
      gastoAnteriorTotal += importe;
      lineasAnterior += 1;
    }
  }

  const lista = [...grupos.values()].map((g) => {
    const varAbs = round2(g.gastoActual - g.gastoAnterior);
    return {
      nombre: g.nombre,
      gastoActual: round2(g.gastoActual),
      gastoAnterior: round2(g.gastoAnterior),
      variacionAbs: varAbs,
      variacionPct: variacionPct(g.gastoActual, g.gastoAnterior),
      cantidadActual: round2(g.cantidadActual),
    };
  });

  const topSubidas = [...lista]
    .filter((g) => g.variacionAbs > 0)
    .sort((a, b) => b.variacionAbs - a.variacionAbs)
    .slice(0, TOP_N);

  const topBajadas = [...lista]
    .filter((g) => g.variacionAbs < 0)
    .sort((a, b) => a.variacionAbs - b.variacionAbs)
    .slice(0, TOP_N);

  const topGasto = [...lista]
    .sort((a, b) => b.gastoActual - a.gastoActual)
    .slice(0, TOP_N)
    .map((g) => ({ nombre: g.nombre, gastoActual: g.gastoActual, cantidadActual: g.cantidadActual }));

  return {
    agrupacion: agrup.etiqueta,
    periodoActual: { desde: inicioActual, hasta: finActual },
    periodoAnterior: { desde: inicioAnterior, hasta: finAnterior },
    diasPorPeriodo: dias,
    totales: {
      gastoActual: round2(gastoActualTotal),
      gastoAnterior: round2(gastoAnteriorTotal),
      variacionAbs: round2(gastoActualTotal - gastoAnteriorTotal),
      variacionPct: variacionPct(gastoActualTotal, gastoAnteriorTotal),
      lineasActual,
      lineasAnterior,
    },
    topSubidas,
    topBajadas,
    topGasto,
  };
}
