/**
 * Sincronización de productos Ágora en DynamoDB (Igp_AgoraProducts).
 * PK = "GLOBAL", SK = Id del producto (string).
 * Solo escribe registros nuevos o actualizados (detección por hash).
 * Metadata de última sync: PK=GLOBAL, SK=__meta__.
 */

import crypto from 'node:crypto';
import { QueryCommand, BatchWriteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const BATCH_SIZE = 25;
const META_SK = '__meta__';

/** Campos permitidos: solo estos se guardan en DynamoDB y se devuelven por API */
const ALLOWED_FIELDS = ['Id', 'IGP', 'Name', 'CostPrice', 'BaseSaleFormatId', 'FamilyId', 'VatId'];

/**
 * Extrae solo los campos permitidos de un producto (sin IGP, que se gestiona aparte).
 * @param {Record<string, unknown>} p
 * @returns {Record<string, unknown>}
 */
export function pickAllowedFields(p) {
  if (!p || typeof p !== 'object') return {};
  const out = {};
  for (const key of ALLOWED_FIELDS) {
    if (key === 'IGP') continue;
    const val = p[key] ?? p[key.toLowerCase()];
    if (val !== undefined && val !== null) out[key] = val;
  }
  return out;
}

/**
 * Devuelve un producto con solo los campos permitidos para la respuesta API.
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
export function toApiProduct(item) {
  const picked = pickAllowedFields(item);
  picked.IGP = item.IGP === true;
  return picked;
}

/**
 * Crea un hash determinista del producto (excluyendo PK, SK, _hash).
 * @param {Record<string, unknown>} product
 * @returns {string}
 */
export function hashProduct(product) {
  if (!product || typeof product !== 'object') return '';
  const copy = { ...product };
  delete copy.PK;
  delete copy.SK;
  delete copy._hash;
  delete copy.IGP; // Campo propio IGP: no forma parte del hash (datos Ágora)
  const keys = Object.keys(copy).sort();
  const obj = {};
  for (const k of keys) obj[k] = copy[k];
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Normaliza un producto de Ágora para almacenar en DynamoDB.
 * Solo incluye los campos permitidos (Id, Name, CostPrice, BaseSaleFormatId, FamilyId, VatId).
 * @param {Record<string, unknown>} p
 * @returns {{ PK: string, SK: string, _hash: string, ... }}
 */
function toDynamoItem(p) {
  const id = p.Id ?? p.id ?? p.Code ?? p.code;
  const sk = id != null ? String(id) : '';
  const item = pickAllowedFields(p);
  item.Id = id;
  const hash = hashProduct({ ...item });
  return {
    PK: 'GLOBAL',
    SK: sk,
    _hash: hash,
    ...item,
  };
}

/**
 * Sincroniza productos desde Ágora a DynamoDB.
 * Solo escribe registros nuevos o con datos modificados.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {Array<Record<string, unknown>>} productsFromAgora
 * @returns {Promise<{ added: number, updated: number, unchanged: number }>}
 */
export async function syncProducts(docClient, tableName, productsFromAgora) {
  const rawList = Array.isArray(productsFromAgora) ? productsFromAgora : [];
  if (!rawList.length) return { added: 0, updated: 0, unchanged: 0 };

  // Cargar existentes de DynamoDB (solo los que tenemos ids)
  const existingMap = new Map();
  // Cargar todos los productos existentes con una Query (PK=GLOBAL)
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

  for (const p of rawList) {
    const id = p.Id ?? p.id ?? p.Code ?? p.code;
    if (id == null) continue;
    const sk = String(id);
    const item = toDynamoItem(p);
    const existing = existingMap.get(sk);
    if (!existing) {
      item.IGP = false;
      toWrite.push(item);
      added++;
    } else if ((existing._hash ?? '') !== item._hash) {
      item.IGP = existing.IGP === true;
      toWrite.push(item);
      updated++;
    } else {
      unchanged++;
    }
  }

  // BatchWrite
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

/** Minutos de throttle: no llamar a Ágora si la última sync fue hace menos de esto */
const SYNC_THROTTLE_MINUTES = parseInt(process.env.AGORA_PRODUCTS_SYNC_THROTTLE_MINUTES || '30', 10) || 30;

/**
 * Obtiene la fecha de la última sincronización.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @returns {Promise<number | null>} timestamp en ms o null si nunca se ha sincronizado
 */
export async function getLastSync(docClient, tableName) {
  try {
    const res = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { PK: 'GLOBAL', SK: META_SK },
    }));
    const ts = res.Item?.lastSync;
    if (ts == null) return null;
    return typeof ts === 'number' ? ts : parseInt(String(ts), 10) || null;
  } catch {
    return null;
  }
}

/**
 * Guarda la fecha de la última sincronización.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 */
export async function setLastSync(docClient, tableName) {
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: 'GLOBAL',
      SK: META_SK,
      lastSync: Date.now(),
    },
  }));
}

/**
 * Indica si se debe omitir la llamada a Ágora por throttle.
 * @param {number | null} lastSyncTs
 * @returns {boolean}
 */
export function shouldSkipSyncByThrottle(lastSyncTs) {
  if (lastSyncTs == null) return false;
  const elapsed = (Date.now() - lastSyncTs) / (60 * 1000);
  return elapsed < SYNC_THROTTLE_MINUTES;
}
