/**
 * Persistencia DynamoDB del módulo Entradas (Coupons Ágora).
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';

export const AGORA_SYNC = Object.freeze({
  PENDING: 'PENDING',
  SYNCING: 'SYNCING',
  SYNCED: 'SYNCED',
  ERROR: 'ERROR',
});

export const WHATSAPP_STATUS = Object.freeze({
  NONE: 'NONE',
  SENT: 'SENT',
  ERROR: 'ERROR',
  STUB_LINK: 'STUB_LINK',
});

export function nowIso() {
  return new Date().toISOString();
}

export function pkLocal(localId) {
  return `LOCAL#${formatId6(localId)}`;
}

export function skTipo(tipoId) {
  return `TIPO#${String(tipoId).trim()}`;
}

export function skEntrada(creadoEn, entradaId) {
  return `ENT#${creadoEn}#${entradaId}`;
}

export function pkEvento(entradaId) {
  return `ENT#${String(entradaId).trim()}`;
}

export function skEvento(iso, id = randomUUID()) {
  return `EVT#${iso}#${id}`;
}

/** Respuesta pública de config: nunca incluye apiToken. */
export function configToPublic(item) {
  if (!item) {
    return {
      localId: null,
      agoraBaseUrl: '',
      enabled: false,
      hasToken: false,
      actualizadoEn: null,
      actualizadoPor: null,
    };
  }
  const token = String(item.agoraApiToken || '').trim();
  return {
    localId: item.localId || String(item.PK || '').replace(/^LOCAL#/, '') || null,
    agoraBaseUrl: String(item.agoraBaseUrl || '').trim(),
    enabled: item.enabled === true,
    hasToken: Boolean(token),
    actualizadoEn: item.actualizadoEn || null,
    actualizadoPor: item.actualizadoPor || null,
  };
}

export function tipoToPublic(item) {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest;
}

export function entradaToPublic(item) {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest;
}

export async function getConfig(localId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.entradasAgoraConfig,
      Key: { PK: pkLocal(localId), SK: 'CONFIG' },
    }),
  );
  return r.Item || null;
}

/**
 * Guarda config. Si apiToken viene vacío/omitido y ya hay token, se conserva.
 * @param {string} localId
 * @param {{ agoraBaseUrl?: string, agoraApiToken?: string, enabled?: boolean }} data
 * @param {{ email?: string, sub?: string }} user
 */
export async function putConfig(localId, data, user) {
  const id = formatId6(localId);
  const existing = await getConfig(id);
  const now = nowIso();

  const baseUrl =
    data.agoraBaseUrl !== undefined
      ? String(data.agoraBaseUrl || '').trim()
      : String(existing?.agoraBaseUrl || '').trim();

  let token = String(existing?.agoraApiToken || '').trim();
  if (data.agoraApiToken !== undefined && data.agoraApiToken !== null) {
    const incoming = String(data.agoraApiToken).trim();
    if (incoming) token = incoming;
    // Si envían '' explícitamente no borramos el token existente (write-only UX).
  }

  const enabled =
    data.enabled !== undefined ? data.enabled === true : existing?.enabled === true;

  const item = {
    PK: pkLocal(id),
    SK: 'CONFIG',
    localId: id,
    agoraBaseUrl: baseUrl,
    agoraApiToken: token,
    enabled,
    actualizadoEn: now,
    actualizadoPor: String(user?.email || user?.sub || '').trim() || null,
  };

  await docClient.send(
    new PutCommand({
      TableName: tables.entradasAgoraConfig,
      Item: item,
    }),
  );
  return item;
}

export async function listTipos(localId) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.entradasTipos,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': pkLocal(localId),
          ':sk': 'TIPO#',
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

export async function getTipo(localId, tipoId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.entradasTipos,
      Key: { PK: pkLocal(localId), SK: skTipo(tipoId) },
    }),
  );
  return r.Item || null;
}

export async function putTipo(item) {
  await docClient.send(
    new PutCommand({
      TableName: tables.entradasTipos,
      Item: item,
    }),
  );
  return item;
}

export async function deleteTipo(localId, tipoId) {
  await docClient.send(
    new DeleteCommand({
      TableName: tables.entradasTipos,
      Key: { PK: pkLocal(localId), SK: skTipo(tipoId) },
    }),
  );
}

/**
 * Busca por GSI Code-index (code + localId).
 * @returns {Promise<object|null>}
 */
export async function findEntradaByCode(code, localId) {
  const codeNorm = String(code || '').trim();
  const id = formatId6(localId);
  if (!codeNorm) return null;

  try {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.entradas,
        IndexName: 'Code-index',
        KeyConditionExpression: 'code = :code AND localId = :localId',
        ExpressionAttributeValues: {
          ':code': codeNorm,
          ':localId': id,
        },
        Limit: 1,
      }),
    );
    return r.Items?.[0] || null;
  } catch (err) {
    // Fallback sin GSI: query local + filter
    console.warn('[entradas] Code-index no disponible, fallback:', err.message || err);
    const items = await listEntradas(id);
    return items.find((e) => String(e.code || '') === codeNorm) || null;
  }
}

/**
 * Lista entradas de un local. Opcionalmente filtra por agoraSyncStatus.
 */
export async function listEntradas(localId, { agoraSyncStatus } = {}) {
  const items = [];
  let lastKey = null;
  const status = agoraSyncStatus ? String(agoraSyncStatus).trim().toUpperCase() : '';

  do {
    const params = {
      TableName: tables.entradas,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': pkLocal(localId),
        ':sk': 'ENT#',
      },
      ScanIndexForward: false,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    };
    if (status) {
      params.FilterExpression = 'agoraSyncStatus = :st';
      params.ExpressionAttributeValues[':st'] = status;
    }
    const r = await docClient.send(new QueryCommand(params));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  return items;
}

/**
 * Obtiene una entrada por localId + entradaId (filter sobre partición del local).
 */
export async function getEntrada(localId, entradaId) {
  const id = String(entradaId || '').trim();
  if (!id) return null;
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.entradas,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression: 'entradaId = :eid',
        ExpressionAttributeValues: {
          ':pk': pkLocal(localId),
          ':sk': 'ENT#',
          ':eid': id,
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    if (r.Items?.length) return r.Items[0];
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return null;
}

export async function putEntrada(item) {
  await docClient.send(
    new PutCommand({
      TableName: tables.entradas,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    }),
  );
  return item;
}

/** SK de reserva atómica de código por local (evita carreras). */
export function skCodeLock(code) {
  return `CODE#${String(code || '').trim().toUpperCase()}`;
}

/**
 * Crea la entrada y un ítem CODE#… en la misma transacción.
 * Si el código ya está reservado → ConditionalCheckFailedException.
 */
export async function putEntradaWithCodeLock(item) {
  const code = String(item.code || '').trim().toUpperCase();
  if (!code) throw new Error('code obligatorio para reserva');
  const lockItem = {
    PK: item.PK,
    SK: skCodeLock(code),
    entityType: 'code_lock',
    code,
    localId: item.localId,
    entradaId: item.entradaId,
    creadoEn: item.creadoEn,
  };
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tables.entradas,
            Item: lockItem,
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
          },
        },
        {
          Put: {
            TableName: tables.entradas,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
          },
        },
      ],
    }),
  );
  return item;
}

/**
 * Actualiza campos de sync / whatsapp / anulación.
 * @param {object} entrada — ítem con PK/SK
 * @param {Record<string, unknown>} fields
 */
export async function updateEntradaFields(entrada, fields) {
  if (!entrada?.PK || !entrada?.SK) {
    throw new Error('Entrada sin clave Dynamo');
  }
  const names = {};
  const values = {};
  const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === 'PK' || k === 'SK') continue;
    const nk = `#k${i}`;
    const vk = `:v${i}`;
    names[nk] = k;
    values[vk] = v;
    sets.push(`${nk} = ${vk}`);
    i += 1;
  }
  if (sets.length === 0) return entrada;

  const r = await docClient.send(
    new UpdateCommand({
      TableName: tables.entradas,
      Key: { PK: entrada.PK, SK: entrada.SK },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return r.Attributes || { ...entrada, ...fields };
}

export async function putEvento({ entradaId, tipo, detalle, usuario }) {
  const iso = nowIso();
  const eventoId = randomUUID();
  const item = {
    PK: pkEvento(entradaId),
    SK: skEvento(iso, eventoId),
    eventoId,
    entradaId: String(entradaId),
    tipo: String(tipo || 'info'),
    detalle: detalle != null ? String(detalle) : null,
    usuario: usuario ? String(usuario) : null,
    creadoEn: iso,
  };
  await docClient.send(
    new PutCommand({
      TableName: tables.entradasEventos,
      Item: item,
    }),
  );
  return item;
}

export async function listEventos(entradaId) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.entradasEventos,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': pkEvento(entradaId),
          ':sk': 'EVT#',
        },
        ScanIndexForward: false,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}
