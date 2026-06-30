import { ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

/** Compara IDs de producto tolerando ceros a la izquierda. */
function idsProductoCoinciden(a, b) {
  const ta = String(a ?? '').trim();
  const tb = String(b ?? '').trim();
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  const na = ta.replace(/^0+/, '') || '0';
  const nb = tb.replace(/^0+/, '') || '0';
  return na === nb;
}

/** Total aportación unitaria (€/ud) del detalle de acuerdo. */
export function totalAportacionUnitaria(detalle) {
  return (Number(detalle?.Aportacion) || 0) + (Number(detalle?.Rappel) || 0) + (Number(detalle?.DescuentoExtra) || 0);
}

function fechaAIso(fecha) {
  const t = String(fecha ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    return `${m[3]}-${mo}-${d}`;
  }
  return t.slice(0, 10);
}

export function fechaEnRangoAcuerdo(fechaPedido, inicio, fin) {
  const f = fechaAIso(fechaPedido);
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const ini = inicio ? fechaAIso(inicio) : '';
  const end = fin ? fechaAIso(fin) : '';
  if (ini && f < ini) return false;
  if (end && f > end) return false;
  return true;
}

/**
 * Total aportación unitaria para un producto según acuerdo activo y fecha del pedido.
 * Devuelve 0 si no hay acuerdo aplicable.
 */
export async function resolveTotalAportacionUnitaria(productId, fechaPedido) {
  const pid = String(productId ?? '').trim();
  const fecha = fechaAIso(fechaPedido);
  if (!pid || !fecha) return 0;

  const detalles = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.acuerdosDetalles,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    detalles.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  const candidatos = detalles.filter((d) => idsProductoCoinciden(String(d.ProductId ?? d.SK ?? '').trim(), pid));
  let mejor = 0;

  for (const d of candidatos) {
    const acuerdo = await docClient.send(new GetCommand({
      TableName: tables.acuerdos,
      Key: { PK: d.PK, SK: 'META' },
    }));
    const a = acuerdo.Item;
    if (!a || String(a.Estado ?? '') !== 'Activo') continue;
    let inicio = a.FechaInicio || '';
    let fin = a.FechaFin || '';
    if (inicio && fin && inicio > fin) [inicio, fin] = [fin, inicio];
    if (!fechaEnRangoAcuerdo(fecha, inicio, fin)) continue;
    mejor = Math.max(mejor, totalAportacionUnitaria(d));
  }

  return mejor;
}
