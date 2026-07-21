/**
 * Resuelve acuerdo vigente para un producto en una fecha de operación.
 * Persistir siempre acuerdo_id + acuerdo_fecha_fin (FechaFin real), no inventar fechas.
 */
import { ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  totalAportacionUnitaria,
  fechaEnRangoAcuerdo,
} from '../pedidos/rappelAcuerdo.js';

function idsProductoCoinciden(a, b) {
  const ta = String(a ?? '').trim();
  const tb = String(b ?? '').trim();
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  const na = ta.replace(/^0+/, '') || '0';
  const nb = tb.replace(/^0+/, '') || '0';
  return na === nb;
}

function fechaAIso(fecha) {
  const t = String(fecha ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return t.slice(0, 10);
}

/**
 * @returns {Promise<{ vigente: boolean, aportacion_unitaria: number, acuerdo_id: string|null, acuerdo_fecha_fin: string|null, acuerdo_marca: string|null }>}
 */
export async function resolveAcuerdoVigenteProducto(productId, fechaOperacion) {
  const vacio = {
    vigente: false,
    aportacion_unitaria: 0,
    acuerdo_id: null,
    acuerdo_fecha_fin: null,
    acuerdo_marca: null,
  };
  const pid = String(productId ?? '').trim();
  const fecha = fechaAIso(fechaOperacion);
  if (!pid || !fecha) return vacio;

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

  const candidatos = detalles.filter((d) =>
    idsProductoCoinciden(String(d.ProductId ?? d.SK ?? '').trim(), pid),
  );

  let mejorAu = -1;
  let mejor = vacio;

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
    const au = totalAportacionUnitaria(d);
    if (au > mejorAu) {
      mejorAu = au;
      mejor = {
        vigente: true,
        aportacion_unitaria: au,
        acuerdo_id: String(d.PK),
        acuerdo_fecha_fin: fin ? fechaAIso(fin) : null,
        acuerdo_marca: a.Marca ? String(a.Marca) : null,
      };
    }
  }

  return mejor;
}
