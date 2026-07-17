/**
 * Persistencia del framework de Informes IA sobre `Igp_InformesIa`.
 *
 * Esquema (crear la tabla a mano en AWS):
 *   PK (String)  — "FUENTE#<clave>"
 *   SK (String)  — "TS#<ISO>#<informeId>"  (entrada de historial)
 *                  "CACHE#<firma>"          (puntero de cache; misma firma se sobrescribe)
 *
 * La cache se sirve por GetItem O(1) sobre el puntero. El historial se lista con
 * Query begins_with(SK, "TS#") en orden descendente.
 */
import { createHash } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function pkFuente(fuente) {
  return `FUENTE#${fuente}`;
}

/**
 * Firma determinista para la cache: fuente + parámetros + plantilla + alcance de
 * locales del usuario. Incluir el alcance evita servir a un usuario datos
 * cacheados de locales que no le corresponden.
 */
export function calcularFirmaCache({ fuente, parametros, promptId, alcanceLocales }) {
  const payload = JSON.stringify({
    fuente,
    parametros: ordenarClaves(parametros || {}),
    promptId: promptId || 'default',
    alcance: Array.isArray(alcanceLocales) ? [...alcanceLocales].sort() : String(alcanceLocales ?? ''),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function ordenarClaves(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** Devuelve el informe cacheado para una firma, o null. */
export async function getInformeCacheado(fuente, firma) {
  const r = await docClient.send(new GetCommand({
    TableName: tables.informesIa,
    Key: { PK: pkFuente(fuente), SK: `CACHE#${firma}` },
  }));
  return r.Item ? limpiarItem(r.Item) : null;
}

/** Guarda el informe como entrada de historial y como puntero de cache. */
export async function guardarInforme(informe) {
  const base = {
    ...informe,
    PK: pkFuente(informe.fuente),
  };
  const historial = { ...base, SK: `TS#${informe.generadoEn}#${informe.informeId}` };
  const cache = { ...base, SK: `CACHE#${informe.firmaCache}` };
  await Promise.all([
    docClient.send(new PutCommand({ TableName: tables.informesIa, Item: historial })),
    docClient.send(new PutCommand({ TableName: tables.informesIa, Item: cache })),
  ]);
  return limpiarItem(historial);
}

/** Historial de una fuente (más recientes primero). Sin datosJson por defecto. */
export async function listarInformes(fuente, limit = 30) {
  const r = await docClient.send(new QueryCommand({
    TableName: tables.informesIa,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :ts)',
    ExpressionAttributeValues: { ':pk': pkFuente(fuente), ':ts': 'TS#' },
    ScanIndexForward: false,
    Limit: Math.min(Number(limit) || 30, 100),
  }));
  return (r.Items || []).map((it) => {
    const { datosJson, ...resto } = limpiarItem(it);
    return resto;
  });
}

/** Detalle de un informe por id (busca en el historial de la fuente). */
export async function getInformeById(fuente, informeId) {
  const r = await docClient.send(new QueryCommand({
    TableName: tables.informesIa,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :ts)',
    ExpressionAttributeValues: { ':pk': pkFuente(fuente), ':ts': 'TS#' },
    ScanIndexForward: false,
    Limit: 100,
  }));
  const item = (r.Items || []).find((it) => it.informeId === informeId);
  return item ? limpiarItem(item) : null;
}

function limpiarItem(item) {
  const { PK, SK, ...resto } = item;
  return resto;
}

/* ---------------- Rate limit en memoria (por usuario y hora) ---------------- */

const ejecucionesPorUsuario = new Map();

/**
 * Registra una ejecución y devuelve true si aún está dentro del límite horario.
 * @param {string} userKey
 * @param {number} maxHora
 */
export function permitirEjecucion(userKey, maxHora) {
  const ahora = Date.now();
  const ventana = 60 * 60 * 1000;
  const previas = (ejecucionesPorUsuario.get(userKey) || []).filter((t) => ahora - t < ventana);
  if (previas.length >= maxHora) {
    ejecucionesPorUsuario.set(userKey, previas);
    return false;
  }
  previas.push(ahora);
  ejecucionesPorUsuario.set(userKey, previas);
  return true;
}
