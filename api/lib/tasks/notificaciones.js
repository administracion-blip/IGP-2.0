/**
 * Notificaciones del módulo de dirección (campana, Fase 3).
 *
 * Tabla `Igp_Notificaciones`: PK `USER#<id>`, SK `NOTIF#<iso>#<uuid>`.
 * Contador de no leídas vía GSI disperso `NoLeidas-index` (HASH
 * `usuario_no_leida`, RANGE `creado_en`, KEYS_ONLY): el atributo solo existe
 * mientras la notificación no está leída. Al marcar leída se borra y sale del
 * índice. Sin Scan.
 *
 * Tipos admitidos (D-27): `mencion`, `asignacion`, `vencimiento`,
 * `compra_pendiente`, `acta_lista`. Los dos últimos no tienen emisor en Fase 3.
 */

import crypto from 'node:crypto';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { logger } from '../logger.js';
import { TIPOS_NOTIFICACION, PK, SK, enLista } from './tipos.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';

export const IDX_NO_LEIDAS = 'NoLeidas-index';
/** Purga automática (~90 días). */
export const TTL_DIAS = 90;

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function ahora() {
  return new Date().toISOString();
}

function ttlEpoch(desde = new Date()) {
  return Math.floor(desde.getTime() / 1000) + TTL_DIAS * 24 * 60 * 60;
}

function mismaEntidad(a, b) {
  return texto(a?.tipo) === texto(b?.tipo) && texto(a?.id) === texto(b?.id);
}

function salidaNotificacion(item) {
  if (!item) return null;
  const { PK: _pk, SK: sk, usuario_no_leida: _u, ttl: _ttl, ...resto } = item;
  return {
    id: sk,
    id_notificacion: texto(resto.id_notificacion) || sk,
    tipo: resto.tipo,
    titulo: resto.titulo,
    cuerpo: resto.cuerpo || '',
    entidad_ref: resto.entidad_ref || null,
    leida: resto.leida === true,
    leida_en: resto.leida_en || null,
    creado_en: resto.creado_en,
  };
}

/**
 * ¿Ya hay un aviso de vencimiento hoy para la misma entidad?
 * Query por partición del usuario + prefijo del día; sin Scan.
 */
async function yaHayVencimientoHoy(usuarioId, entidadRef, diaIso) {
  if (!entidadRef || !diaIso) return false;
  const prefijo = `NOTIF#${diaIso}`;
  let desde = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.notificaciones,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
        ExpressionAttributeValues: {
          ':pk': PK.usuario(usuarioId),
          ':pref': prefijo,
        },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const item of r.Items || []) {
      if (item.tipo !== 'vencimiento') continue;
      if (mismaEntidad(item.entidad_ref, entidadRef)) return true;
    }
    desde = r.LastEvaluatedKey || null;
  } while (desde);
  return false;
}

/**
 * Crea una notificación para un usuario.
 *
 * @param {{ usuarioId: string, tipo: string, titulo: string, cuerpo?: string,
 *           entidad_ref?: { tipo: string, id: string, etiqueta?: string },
 *           diaIdempotencia?: string }} opts
 *   `diaIdempotencia` (YYYY-MM-DD): para `vencimiento`, evita duplicar la misma
 *   `entidad_ref` el mismo día.
 * @returns {Promise<{ ok: true, notificacion: object|null, omitida?: boolean } | { ok: false, error: string }>}
 */
export async function crearNotificacion({
  usuarioId,
  tipo,
  titulo,
  cuerpo,
  entidad_ref: entidadRef,
  diaIdempotencia,
} = {}) {
  const uid = texto(usuarioId);
  if (!uid) return { ok: false, error: 'Falta el destinatario de la notificación' };
  if (!enLista(TIPOS_NOTIFICACION, tipo)) {
    return { ok: false, error: `Tipo de notificación no válido: «${tipo}»` };
  }
  const tit = texto(titulo);
  if (!tit) return { ok: false, error: 'El título de la notificación es obligatorio' };

  const ref =
    entidadRef && texto(entidadRef.tipo) && texto(entidadRef.id)
      ? {
          tipo: texto(entidadRef.tipo),
          id: texto(entidadRef.id),
          ...(texto(entidadRef.etiqueta) ? { etiqueta: texto(entidadRef.etiqueta) } : {}),
        }
      : null;

  if (tipo === 'vencimiento' && ref) {
    const dia = texto(diaIdempotencia) || ahora().slice(0, 10);
    try {
      if (await yaHayVencimientoHoy(uid, ref, dia)) {
        return { ok: true, notificacion: null, omitida: true };
      }
    } catch (err) {
      logger.warn({ err, usuarioId: uid }, '[notificaciones] No se pudo comprobar idempotencia de vencimiento');
    }
  }

  // Para vencimiento, el prefijo del SK usa el día de idempotencia (Madrid) para
  // que la Query `begins_with NOTIF#<día>` encuentre duplicados aunque UTC diga otra fecha.
  const diaSk =
    tipo === 'vencimiento' && texto(diaIdempotencia) ? texto(diaIdempotencia) : null;
  const instante = diaSk ? `${diaSk}T12:00:00.000Z` : ahora();
  const id = crypto.randomUUID();
  const sk = SK.notificacion(instante, id);
  const item = {
    PK: PK.usuario(uid),
    SK: sk,
    id_notificacion: id,
    tipo,
    titulo: tit,
    cuerpo: texto(cuerpo),
    ...(ref && { entidad_ref: ref }),
    leida: false,
    creado_en: instante,
    // Atributo disperso del GSI: solo mientras no está leída.
    usuario_no_leida: uid,
    ttl: ttlEpoch(),
  };

  await docClient.send(new PutCommand({ TableName: tables.notificaciones, Item: item }));
  return { ok: true, notificacion: salidaNotificacion(item) };
}

/**
 * Lista las notificaciones del usuario (más recientes primero).
 *
 * El cursor es la clave del **último ítem procesado** (no `LastEvaluatedKey` a
 * pelo): si la página se llena a mitad de una Query de Dynamo, la siguiente
 * petición retoma justo después y no se salta el resto de esa página.
 *
 * @param {{ usuarioId: string, limite?: number, cursor?: string, soloNoLeidas?: boolean }} opts
 */
export async function listarNotificaciones({
  usuarioId,
  limite,
  cursor,
  soloNoLeidas = false,
} = {}) {
  const uid = texto(usuarioId);
  if (!uid) return { ok: false, status: 400, error: 'Falta el usuario' };

  const pageSize = limiteValido(limite, { porDefecto: 30, maximo: 100 });
  const exclusivas = [];
  let desde = decodificarCursor(cursor);
  let ultimoClave = null;
  let hayMas = false;

  while (exclusivas.length < pageSize) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.notificaciones,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
        ExpressionAttributeValues: {
          ':pk': PK.usuario(uid),
          ':pref': 'NOTIF#',
        },
        ScanIndexForward: false,
        Limit: pageSize,
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    const items = r.Items || [];
    let cortado = false;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      ultimoClave = { PK: item.PK, SK: item.SK };
      if (soloNoLeidas && item.leida === true) continue;
      exclusivas.push(item);
      if (exclusivas.length >= pageSize) {
        cortado = true;
        // Quedan ítems en esta respuesta de Dynamo después del que acabamos de coger,
        // o hay otra página: en ambos casos el cliente debe poder continuar.
        hayMas = i + 1 < items.length || !!r.LastEvaluatedKey;
        break;
      }
    }
    if (cortado) break;
    if (!r.LastEvaluatedKey) {
      hayMas = false;
      break;
    }
    desde = r.LastEvaluatedKey;
    hayMas = true;
  }

  return {
    ok: true,
    notificaciones: exclusivas.map(salidaNotificacion),
    cursor: hayMas && ultimoClave ? codificarCursor(ultimoClave) : null,
  };
}

/**
 * Contador de no leídas vía `NoLeidas-index` (Query, sin Scan).
 *
 * @param {{ usuarioId: string }} opts
 * @returns {Promise<{ ok: true, total: number } | { ok: false, status: number, error: string }>}
 */
export async function contarNoLeidas({ usuarioId } = {}) {
  const uid = texto(usuarioId);
  if (!uid) return { ok: false, status: 400, error: 'Falta el usuario' };

  let total = 0;
  let desde = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.notificaciones,
        IndexName: IDX_NO_LEIDAS,
        KeyConditionExpression: 'usuario_no_leida = :u',
        ExpressionAttributeValues: { ':u': uid },
        // KEYS_ONLY: basta con contar filas.
        ProjectionExpression: 'PK, SK, usuario_no_leida, creado_en',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    total += (r.Items || []).length;
    desde = r.LastEvaluatedKey || null;
  } while (desde);

  return { ok: true, total };
}

/**
 * Marca notificaciones como leídas: quita `usuario_no_leida` (salen del GSI).
 *
 * @param {{ usuarioId: string, ids?: string[], todas?: boolean }} opts
 *   `ids` son los SK (`NOTIF#…`) o `id_notificacion` (uuid) resueltos en la partición.
 */
export async function marcarLeidas({ usuarioId, ids, todas = false } = {}) {
  const uid = texto(usuarioId);
  if (!uid) return { ok: false, status: 400, error: 'Falta el usuario' };

  const pk = PK.usuario(uid);
  const instante = ahora();
  let claves = [];

  if (todas === true) {
    let desde = null;
    do {
      const r = await docClient.send(
        new QueryCommand({
          TableName: tables.notificaciones,
          IndexName: IDX_NO_LEIDAS,
          KeyConditionExpression: 'usuario_no_leida = :u',
          ExpressionAttributeValues: { ':u': uid },
          ...(desde && { ExclusiveStartKey: desde }),
        }),
      );
      for (const item of r.Items || []) {
        if (item.PK && item.SK) claves.push({ PK: item.PK, SK: item.SK });
      }
      desde = r.LastEvaluatedKey || null;
    } while (desde);
  } else {
    const lista = Array.isArray(ids) ? ids.map(texto).filter(Boolean) : [];
    if (lista.length === 0) {
      return { ok: false, status: 400, error: 'Indica ids o { todas: true }' };
    }
    // SK completos o uuid: resolvemos contra la partición del usuario.
    const porSk = new Set(lista.filter((id) => id.startsWith('NOTIF#')));
    const porUuid = new Set(lista.filter((id) => !id.startsWith('NOTIF#')));
    if (porUuid.size > 0) {
      let desde = null;
      do {
        const r = await docClient.send(
          new QueryCommand({
            TableName: tables.notificaciones,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
            ExpressionAttributeValues: { ':pk': pk, ':pref': 'NOTIF#' },
            ...(desde && { ExclusiveStartKey: desde }),
          }),
        );
        for (const item of r.Items || []) {
          if (porUuid.has(texto(item.id_notificacion)) || porSk.has(item.SK)) {
            claves.push({ PK: item.PK, SK: item.SK });
          }
        }
        desde = r.LastEvaluatedKey || null;
      } while (desde);
    } else {
      claves = [...porSk].map((sk) => ({ PK: pk, SK: sk }));
    }
  }

  // Deduplicar.
  const vistos = new Set();
  const unicas = [];
  for (const k of claves) {
    const firma = `${k.PK}|${k.SK}`;
    if (vistos.has(firma)) continue;
    vistos.add(firma);
    unicas.push(k);
  }

  let marcadas = 0;
  for (const key of unicas) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tables.notificaciones,
          Key: key,
          UpdateExpression: 'SET leida = :si, leida_en = :ahora REMOVE usuario_no_leida',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':si': true, ':ahora': instante },
        }),
      );
      marcadas += 1;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') continue;
      throw err;
    }
  }

  return { ok: true, marcadas };
}
