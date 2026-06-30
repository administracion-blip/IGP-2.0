/**
 * Movimientos de caja (tabla Igp_MovimientosCaja).
 *
 * Registra retiradas de efectivo y transferencias de prepago que ocurren en
 * cualquier momento de la jornada, atadas a un TPV concreto. El arqueo de caja
 * los lee para ajustar el real:
 *  - Retiradas → se suman al Efectivo contado (dinero que salió del cajón pero
 *    es recaudación real).
 *  - Transferencias → es el real automático del grupo "Prepago Transferencia".
 *
 * Clave: PK = workplaceId (agoraCode), SK = `${businessDay}#${posId}#${tipo}#${id}`.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

const tableMovimientos = tables.movimientosCaja;

/** Tipos de movimiento y su efecto sobre el real del arqueo. */
export const TIPO_RETIRADA = 'retirada';
export const TIPO_TRANSFERENCIA = 'transferencia';

export const GRUPO_EFECTIVO = 'Efectivo';
export const GRUPO_PREPAGO = 'Prepago Transferencia';

export const TIPOS_MOVIMIENTO = [
  { tipo: TIPO_RETIRADA, label: 'Retirada de efectivo', grupo: GRUPO_EFECTIVO },
  { tipo: TIPO_TRANSFERENCIA, label: 'Transferencia prepago', grupo: GRUPO_PREPAGO },
];

export function esTipoValido(tipo) {
  return tipo === TIPO_RETIRADA || tipo === TIPO_TRANSFERENCIA;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function parseImporte(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? round2(Math.abs(n)) : 0;
}

/**
 * Lista movimientos de caja para un local/jornada.
 * @param {{ workplaceId: string, businessDay: string, posId?: string }} q
 * @returns {Promise<Array<object>>}
 */
export async function listMovimientos({ workplaceId, businessDay, posId } = {}) {
  const pk = String(workplaceId || '').trim();
  const bd = String(businessDay || '').trim();
  if (!pk || !/^\d{4}-\d{2}-\d{2}$/.test(bd)) return [];
  const pos = posId == null ? '' : String(posId).trim();
  const skPrefix = pos !== '' ? `${bd}#${pos}#` : `${bd}#`;
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tableMovimientos,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) out.push(it);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  out.sort((a, b) => String(a.creadoEn || '').localeCompare(String(b.creadoEn || '')));
  return out;
}

/** Suma de importes por tipo a partir de una lista de movimientos. */
export function totalesMovimientos(movs) {
  let retiradas = 0;
  let transferencias = 0;
  for (const m of movs || []) {
    const imp = parseImporte(m?.importe);
    if (m?.tipo === TIPO_RETIRADA) retiradas += imp;
    else if (m?.tipo === TIPO_TRANSFERENCIA) transferencias += imp;
  }
  return { retiradas: round2(retiradas), transferencias: round2(transferencias) };
}

/**
 * Totales de movimientos para un TPV concreto en una jornada.
 * @returns {Promise<{ retiradas: number, transferencias: number, movimientos: object[] }>}
 */
export async function totalesMovimientosTpv(workplaceId, businessDay, posId) {
  const movimientos = await listMovimientos({ workplaceId, businessDay, posId });
  return { ...totalesMovimientos(movimientos), movimientos };
}
