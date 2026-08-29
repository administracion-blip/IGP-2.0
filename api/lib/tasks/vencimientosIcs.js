/**
 * Feed ICS de vencimientos de tareas (Fase 3, D-24 / D-25).
 *
 * Cada usuario genera un token opaco; el feed se sirve sin JWT en
 * `GET /api/tasks/vencimientos.ics?token=…`. En `Igp_Ajustes` solo se guarda el
 * **hash** del token (`PK=tareas`, `SK=ics_token#<id_usuario>`). Rotar escribe un
 * hash nuevo y deja inválida la URL anterior.
 *
 * El calendario solo lleva SUMMARY (título) y DTSTART (fecha_limite, all-day).
 * **Sin DESCRIPTION**: no debe salir contenido sensible ni de reuniones.
 */

import crypto from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { logger } from '../logger.js';
import { FECHA_SIN_LIMITE } from './tipos.js';

export const ICS_AJUSTE_PK = 'tareas';
export const ICS_TOKEN_SK_PREFIJO = 'ics_token#';
export const IDX_RESPONSABLE = 'Responsable-Vencimiento-index';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function skToken(idUsuario) {
  return `${ICS_TOKEN_SK_PREFIJO}${idUsuario}`;
}

/** Hash SHA-256 hex del token en claro. Nunca se persiste el token. */
export function hashTokenIcs(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Forma del token: `<id_usuario>.<secreto_base64url>`.
 * El id permite un Get O(1) al ítem `ics_token#<id>`; el secreto es lo que se hashea.
 * No loguear nunca el token completo.
 */
export function generarTokenIcs(usuarioId) {
  const uid = texto(usuarioId);
  const secreto = crypto.randomBytes(32).toString('base64url');
  return `${uid}.${secreto}`;
}

/**
 * Genera o rota el token del usuario. Devuelve el token **en claro una sola vez**.
 *
 * @param {{ usuarioId: string }} opts
 * @returns {Promise<{ ok: true, token: string, creado_en: string } | { ok: false, error: string }>}
 */
export async function rotarTokenIcs({ usuarioId } = {}) {
  const uid = texto(usuarioId);
  if (!uid) return { ok: false, error: 'Falta el usuario' };

  const token = generarTokenIcs(uid);
  const creadoEn = new Date().toISOString();
  await docClient.send(
    new PutCommand({
      TableName: tables.ajustes,
      Item: {
        PK: ICS_AJUSTE_PK,
        SK: skToken(uid),
        token_hash: hashTokenIcs(token),
        creado_en: creadoEn,
        updatedAt: creadoEn,
        id_usuario: uid,
      },
    }),
  );
  return { ok: true, token, creado_en: creadoEn };
}

/**
 * Resuelve el dueño del token con Get al ítem del usuario (O(1)).
 * Compara solo hashes; no registra el token en claro.
 *
 * @param {string} token
 * @returns {Promise<{ ok: true, usuarioId: string } | { ok: false, error: string }>}
 */
export async function validarTokenIcs(token) {
  const bruto = texto(token);
  const punto = bruto.indexOf('.');
  if (punto < 1 || punto === bruto.length - 1) return { ok: false, error: 'Token no válido' };
  const uid = bruto.slice(0, punto);
  if (!uid || bruto.length < 20) return { ok: false, error: 'Token no válido' };

  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.ajustes,
        Key: { PK: ICS_AJUSTE_PK, SK: skToken(uid) },
      }),
    );
    const item = r.Item;
    if (!item || texto(item.token_hash) !== hashTokenIcs(bruto)) {
      return { ok: false, error: 'Token no válido' };
    }
    return { ok: true, usuarioId: uid };
  } catch (err) {
    logger.warn({ err }, '[vencimientos-ics] Error al validar token');
    return { ok: false, error: 'Token no válido' };
  }
}

/** Escapa texto para valores de propiedad ICS (RFC 5545). */
export function escaparIcs(valor) {
  return String(valor ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

function dtstampUtc(fecha = new Date()) {
  const iso = fecha.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return iso.endsWith('Z') ? iso : `${iso}Z`;
}

/**
 * Tareas abiertas del responsable con fecha límite real (no `9999-12-31`).
 */
export async function tareasAbiertasConVencimiento(responsableId) {
  const uid = texto(responsableId);
  if (!uid) return [];
  const items = [];
  let desde = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.tareas,
        IndexName: IDX_RESPONSABLE,
        KeyConditionExpression: 'responsable_id = :r',
        ExpressionAttributeValues: { ':r': uid },
        ProjectionExpression: 'id_tarea, titulo, fecha_limite',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    items.push(...(r.Items || []));
    desde = r.LastEvaluatedKey || null;
  } while (desde);

  return items
    .map((t) => ({
      id_tarea: texto(t.id_tarea),
      titulo: texto(t.titulo) || 'Tarea sin título',
      fecha_limite: texto(t.fecha_limite),
    }))
    .filter(
      (t) =>
        t.id_tarea &&
        RE_FECHA.test(t.fecha_limite) &&
        t.fecha_limite !== FECHA_SIN_LIMITE,
    )
    .sort((a, b) => (a.fecha_limite < b.fecha_limite ? -1 : a.fecha_limite > b.fecha_limite ? 1 : 0));
}

/**
 * Construye el texto ICS. **No incluye DESCRIPTION.**
 *
 * @param {{ tareas: { id_tarea: string, titulo: string, fecha_limite: string }[],
 *           generadoEn?: Date }} opts
 */
export function construirIcs({ tareas = [], generadoEn = new Date() } = {}) {
  const stamp = dtstampUtc(generadoEn);
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IGP Hosteleria//Vencimientos//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:IGP vencimientos',
  ];
  for (const t of tareas) {
    const fecha = texto(t.fecha_limite).replace(/-/g, '');
    if (!/^\d{8}$/.test(fecha)) continue;
    lineas.push(
      'BEGIN:VEVENT',
      `UID:${escaparIcs(t.id_tarea)}@igp-vencimientos`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${fecha}`,
      `SUMMARY:${escaparIcs(t.titulo)}`,
      'END:VEVENT',
    );
  }
  lineas.push('END:VCALENDAR');
  return `${lineas.join('\r\n')}\r\n`;
}

/**
 * Feed completo para el dueño del token: valida, carga tareas, construye ICS.
 *
 * @returns {Promise<{ ok: true, ics: string, usuarioId: string } | { ok: false, error: string }>}
 */
export async function feedVencimientosIcs(token) {
  const validado = await validarTokenIcs(token);
  if (!validado.ok) return validado;
  const tareas = await tareasAbiertasConVencimiento(validado.usuarioId);
  return {
    ok: true,
    usuarioId: validado.usuarioId,
    ics: construirIcs({ tareas }),
  };
}

/**
 * URL pública del feed (si hay `APP_PUBLIC_URL`). No loguear con el token.
 */
export function urlFeedVencimientos(token) {
  const base = texto(process.env.APP_PUBLIC_URL).replace(/\/+$/, '');
  if (!base || !token) return '';
  return `${base}/api/tasks/vencimientos.ics?token=${encodeURIComponent(token)}`;
}
