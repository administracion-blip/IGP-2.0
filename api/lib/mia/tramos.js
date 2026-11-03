/**
 * Tramos del multiplicador por previsión de facturación.
 *
 * Igp_Ajustes, PK = mia_tramos, SK = <ámbito>#<orden>.
 * Ámbito GLOBAL o el id de almacén (6 dígitos). Desde inclusive, hasta exclusive.
 * El primero empieza en 0, van pegados (sin hueco ni solape) y el último no tiene tope.
 */

import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { normalizeWarehouseId } from './keys.js';

export const PK_MIA_TRAMOS = 'mia_tramos';
export const AMBITO_GLOBAL = 'GLOBAL';

function fallo(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400, expose: true });
}

/** '' o null → todos los almacenes. Si no, id de almacén. */
export function ambitoDe(warehouseId) {
  if (warehouseId == null || String(warehouseId).trim() === '' || String(warehouseId).trim() === AMBITO_GLOBAL) {
    return AMBITO_GLOBAL;
  }
  const id = normalizeWarehouseId(warehouseId);
  if (!id || id === '000000') throw fallo('Almacén del tramo no válido');
  return id;
}

function numero(raw, campo) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw fallo(`${campo} debe ser un número ≥ 0`);
  return Math.round(n * 100) / 100;
}

/**
 * Ordena y comprueba que los tramos cubran desde 0 sin huecos ni solapes.
 * @param {Array<{ desde: number, hasta?: number|null, multiplicador: number }>} tramos
 */
export function validarTramos(tramos) {
  if (!Array.isArray(tramos) || tramos.length === 0) {
    throw fallo('Hace falta al menos un tramo');
  }
  const lista = tramos.map((t) => {
    const desde = numero(t?.desde, 'desde');
    const multiplicador = numero(t?.multiplicador, 'multiplicador');
    if (multiplicador <= 0) throw fallo('El multiplicador tiene que ser mayor que 0');
    const sinTope = t?.hasta == null || t?.hasta === '';
    const hasta = sinTope ? null : numero(t.hasta, 'hasta');
    if (hasta != null && hasta <= desde) throw fallo('El importe hasta tiene que ser mayor que el desde');
    return { desde, hasta, multiplicador };
  }).sort((a, b) => a.desde - b.desde);

  if (lista[0].desde !== 0) throw fallo('El primer tramo tiene que empezar en 0');
  for (let i = 0; i < lista.length; i += 1) {
    const t = lista[i];
    const ultimo = i === lista.length - 1;
    if (t.hasta == null && !ultimo) throw fallo('Solo el último tramo puede ir sin tope');
    if (ultimo && t.hasta != null) throw fallo('El último tramo no puede tener tope: quedaría un hueco por encima');
    if (i === 0) continue;
    const prev = lista[i - 1];
    if (t.desde < prev.hasta) throw fallo('Los tramos se solapan');
    if (t.desde > prev.hasta) throw fallo('Hay un hueco entre tramos');
  }
  return lista;
}

function skDe(ambito, orden) {
  return `${ambito}#${String(orden).padStart(4, '0')}`;
}

async function listarItems(ambito) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.ajustes,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
      ExpressionAttributeValues: { ':pk': PK_MIA_TRAMOS, ':pref': `${ambito}#` },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

export function mapTramo(it) {
  return {
    ambito: String(it.ambito || ''),
    desde: Number(it.desde),
    hasta: it.hasta == null ? null : Number(it.hasta),
    multiplicador: Number(it.multiplicador),
    orden: Number(it.orden) || 0,
  };
}

/**
 * Tramo que cubre un importe. `desde` inclusive, `hasta` exclusive.
 * El último, sin tope, cubre cualquier importe por encima.
 * @param {number} importe
 * @param {Array<{ desde: number, hasta: number|null, multiplicador: number }>} tramos
 * @returns {object|null}
 */
export function elegirTramo(importe, tramos) {
  const n = Number(importe);
  if (!Number.isFinite(n) || n < 0) return null;
  const lista = [...(tramos || [])].sort((a, b) => Number(a.desde) - Number(b.desde));
  for (const t of lista) {
    const hasta = t.hasta == null || t.hasta === '' ? null : Number(t.hasta);
    if (n >= Number(t.desde) && (hasta == null || n < hasta)) return t;
  }
  return null;
}

/** Tramos de un ámbito, de menor a mayor importe. */
export async function listarTramos(warehouseId) {
  const ambito = ambitoDe(warehouseId);
  const items = await listarItems(ambito);
  return items.map(mapTramo).sort((a, b) => a.desde - b.desde);
}

/**
 * Sustituye los tramos del ámbito. Valida el conjunto entero antes de escribir.
 * @param {string|null} warehouseId
 * @param {Array<object>} tramos
 */
export async function guardarTramos(warehouseId, tramos) {
  const ambito = ambitoDe(warehouseId);
  const lista = validarTramos(tramos);
  const previos = await listarItems(ambito);
  for (const it of previos) {
    await docClient.send(new DeleteCommand({
      TableName: tables.ajustes,
      Key: { PK: PK_MIA_TRAMOS, SK: it.SK },
    }));
  }
  const ahora = new Date().toISOString();
  const guardados = [];
  for (let i = 0; i < lista.length; i += 1) {
    const t = lista[i];
    const Item = {
      PK: PK_MIA_TRAMOS,
      SK: skDe(ambito, i + 1),
      ambito,
      orden: i + 1,
      desde: t.desde,
      hasta: t.hasta,
      multiplicador: t.multiplicador,
      actualizadoEn: ahora,
    };
    await docClient.send(new PutCommand({ TableName: tables.ajustes, Item }));
    guardados.push(mapTramo(Item));
  }
  return guardados;
}
