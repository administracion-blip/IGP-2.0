/**
 * Sincronización de usuarios Ágora en DynamoDB (Igp_AgoraUsuarios).
 * PK = "GLOBAL", SK = Id del usuario (string).
 * Solo escribe registros nuevos o actualizados (detección por hash).
 * Metadata de última sync: PK=GLOBAL, SK=__meta__.
 */

import crypto from 'node:crypto';
import { QueryCommand, BatchWriteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const BATCH_SIZE = 25;
const META_SK = '__meta__';

/** Campos persistidos. Excluye contraseñas y datos sensibles que no usamos. */
const ALLOWED_FIELDS = [
  'Id',
  'Name',
  'FullName',
  'ButtonText',
  'Color',
  'Profile',
  'ShowInClockings',
  'IsTrainee',
  'IsDeliveryPerson',
  'Priority',
  'Nif',
  'Telephone',
  'Email',
  'Active',
];

export function pickAllowedFields(u) {
  if (!u || typeof u !== 'object') return {};
  const out = {};
  for (const key of ALLOWED_FIELDS) {
    if (key === 'Active') continue;
    const val = u[key] ?? u[key.toLowerCase()];
    if (val !== undefined && val !== null && val !== '') out[key] = val;
  }
  const deletionDate = u.DeletionDate ?? u.deletionDate ?? null;
  out.Active = !deletionDate;
  return out;
}

export function toApiUser(item) {
  return pickAllowedFields(item);
}

function hashUser(u) {
  if (!u || typeof u !== 'object') return '';
  const copy = { ...u };
  delete copy.PK;
  delete copy.SK;
  delete copy._hash;
  const keys = Object.keys(copy).sort();
  const obj = {};
  for (const k of keys) obj[k] = copy[k];
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function toDynamoItem(u) {
  const id = u.Id ?? u.id;
  const sk = id != null ? String(id) : '';
  const item = pickAllowedFields(u);
  item.Id = id;
  const hash = hashUser({ ...item });
  return {
    PK: 'GLOBAL',
    SK: sk,
    _hash: hash,
    ...item,
  };
}

/**
 * Sincroniza usuarios desde Ágora a DynamoDB.
 * Solo escribe registros nuevos o con datos modificados.
 */
export async function syncUsers(docClient, tableName, usersFromAgora) {
  const rawList = Array.isArray(usersFromAgora) ? usersFromAgora : [];
  if (!rawList.length) return { added: 0, updated: 0, unchanged: 0 };

  const existingMap = new Map();
  let lastKey = null;
  do {
    const cmd = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'GLOBAL' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    });
    const result = await docClient.send(cmd);
    for (const item of result.Items || []) {
      const sk = item.SK ?? item.sk;
      if (sk != null) existingMap.set(String(sk), item);
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  const toWrite = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const u of rawList) {
    const id = u.Id ?? u.id;
    if (id == null) continue;
    const sk = String(id);
    const item = toDynamoItem(u);
    const existing = existingMap.get(sk);
    if (!existing) {
      toWrite.push(item);
      added++;
    } else if ((existing._hash ?? '') !== item._hash) {
      toWrite.push(item);
      updated++;
    } else {
      unchanged++;
    }
  }

  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const chunk = toWrite.slice(i, i + BATCH_SIZE);
    let req = {
      RequestItems: {
        [tableName]: chunk.map((it) => ({ PutRequest: { Item: it } })),
      },
    };
    let unprocessed;
    do {
      const res = await docClient.send(new BatchWriteCommand(req));
      unprocessed = res.UnprocessedItems?.[tableName];
      if (unprocessed?.length) {
        req = { RequestItems: { [tableName]: unprocessed } };
        await new Promise((r) => setTimeout(r, 100));
      }
    } while (unprocessed?.length);
  }

  return { added, updated, unchanged };
}

const SYNC_THROTTLE_MINUTES =
  parseInt(process.env.AGORA_USERS_SYNC_THROTTLE_MINUTES || '60', 10) || 60;

export async function getLastSync(docClient, tableName) {
  try {
    const res = await docClient.send(
      new GetCommand({ TableName: tableName, Key: { PK: 'GLOBAL', SK: META_SK } }),
    );
    const ts = res.Item?.lastSync;
    if (ts == null) return null;
    return typeof ts === 'number' ? ts : parseInt(String(ts), 10) || null;
  } catch {
    return null;
  }
}

export async function setLastSync(docClient, tableName) {
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: { PK: 'GLOBAL', SK: META_SK, lastSync: Date.now() },
    }),
  );
}

export function shouldSkipSyncByThrottle(lastSyncTs) {
  if (lastSyncTs == null) return false;
  const elapsed = (Date.now() - lastSyncTs) / (60 * 1000);
  return elapsed < SYNC_THROTTLE_MINUTES;
}

/**
 * Devuelve un Map<Id (string), Name> con todos los usuarios cacheados en DynamoDB.
 * Filtra el registro de metadata (SK = __meta__).
 */
export async function getAllUsersMap(docClient, tableName) {
  const map = new Map();
  let lastKey = null;
  do {
    const cmd = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'GLOBAL' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    });
    const result = await docClient.send(cmd);
    for (const item of result.Items || []) {
      const sk = item.SK ?? item.sk;
      if (sk == null || sk === META_SK) continue;
      const id = String(sk);
      const name = item.FullName ?? item.Name ?? null;
      if (name) map.set(id, String(name));
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return map;
}
