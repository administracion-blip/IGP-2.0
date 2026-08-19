/**
 * Tabla Igp_SaleCenters (PK/SK strings). Tres particiones distintas porque Ágora
 * numera de forma independiente los puntos de venta y los centros de venta:
 *
 * - PK = "GLOBAL"       → puntos de venta / TPV (export-master WorkplacesSummary),
 *                          SK = PointOfSale.Id. Campos Nombre/Tipo/Local/Grupo/WorkplaceId.
 * - PK = "SALECENTER"   → centros de venta (export-master SaleCenters), SK = SaleCenter.Id.
 *                          Campos Id/Nombre/PriceListId/CurrentPriceListId (tarifas de venta).
 * - PK = "LOCAL_TARIFA" → asignación manual local → centro de venta, SK = id_Locales.
 *                          El export de SaleCenters no trae local ni workplace, así que la
 *                          relación se mantiene a mano desde la UI.
 */

import { PutCommand, UpdateCommand, GetCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

export const PK_TPV = 'GLOBAL';
export const PK_CENTRO_VENTA = 'SALECENTER';
export const PK_LOCAL_TARIFA = 'LOCAL_TARIFA';

/**
 * Inserta o actualiza un lote de ítems en Igp_SaleCenters.
 * PutCommand sobrescribe si ya existe el mismo PK/SK.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {Array<Record<string, unknown>>} items - cada uno debe llevar su PK y SK
 * @returns {Promise<number>} cantidad de ítems escritos
 */
export async function upsertBatch(docClient, tableName, items) {
  if (!items.length) return 0;
  for (const item of items) {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }
  return items.length;
}

/**
 * Query paginada de una partición de la tabla.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {string} pk
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function queryPartition(docClient, tableName, pk) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Lista los puntos de venta / TPV (PK = GLOBAL), como GET /agora/sale-centers.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listSaleCenters(docClient, tableName) {
  return queryPartition(docClient, tableName, PK_TPV);
}

/**
 * Lista los centros de venta de Ágora (PK = SALECENTER), con sus tarifas.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listCentrosVenta(docClient, tableName) {
  return queryPartition(docClient, tableName, PK_CENTRO_VENTA);
}

/**
 * Lee un centro de venta por Id (SK). Prueba SK tal cual y String(Number(id))
 * por si el id viene con ceros a la izquierda o como número.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {string|number} id
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function getCentroVentaById(docClient, tableName, id) {
  const raw = id != null ? String(id).trim() : '';
  if (!raw) return null;
  const candidates = [raw];
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) {
    const numSk = String(asNum);
    if (numSk !== raw) candidates.push(numSk);
  }
  for (const sk of candidates) {
    const res = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: PK_CENTRO_VENTA, SK: sk },
      }),
    );
    if (res.Item) return res.Item;
  }
  return null;
}

/**
 * PriceListId efectivo: CurrentPriceListId || PriceListId (string) o null.
 * @param {Record<string, unknown>|null|undefined} item
 * @returns {string|null}
 */
export function pickPriceListId(item) {
  if (!item || typeof item !== 'object') return null;
  const cur = item.CurrentPriceListId ?? item.currentPriceListId;
  const base = item.PriceListId ?? item.priceListId;
  const val = cur != null && String(cur).trim() !== '' ? cur : base;
  if (val == null || String(val).trim() === '') return null;
  return String(val);
}

/**
 * Lista las asignaciones manuales local → centro de venta (PK = LOCAL_TARIFA).
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listLocalesTarifa(docClient, tableName) {
  return queryPartition(docClient, tableName, PK_LOCAL_TARIFA);
}

/**
 * Guarda la asignación local → centro de venta (con su tarifa resuelta).
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {{ localId: string, saleCenterId: string, priceListId: string|null }} data
 * @returns {Promise<void>}
 */
export async function putLocalTarifa(docClient, tableName, { localId, saleCenterId, priceListId }) {
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: PK_LOCAL_TARIFA,
        SK: String(localId),
        localId: String(localId),
        saleCenterId: String(saleCenterId),
        priceListId: priceListId != null && String(priceListId).trim() !== '' ? String(priceListId) : null,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * Borra la asignación de tarifa de un local.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {string} localId
 * @returns {Promise<void>}
 */
export async function deleteLocalTarifa(docClient, tableName, localId) {
  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { PK: PK_LOCAL_TARIFA, SK: String(localId) },
    }),
  );
}

/**
 * Sincroniza los centros de venta de Ágora (export-master SaleCenters) en
 * PK = SALECENTER. Nunca escribe en PK = GLOBAL: los Id de centro de venta y de
 * punto de venta son numeraciones distintas y se pisaban entre sí.
 *
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @param {{ baseUrl: string, token: string }} opts
 * @returns {Promise<{ fetched: number, upserted: number }>}
 */
export async function syncCentrosVentaFromAgora(docClient, tableName, { baseUrl, token }) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const apiToken = String(token || '').trim();
  if (!base || !apiToken) {
    throw new Error('Falta baseUrl o token para sincronizar centros de venta');
  }

  const url = `${base}/api/export-master/?filter=SaleCenters`;
  const r = await fetch(url, {
    method: 'GET',
    headers: { 'Api-Token': apiToken, 'Content-Type': 'application/json' },
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`Agora SaleCenters respondió ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }

  const rawText = await r.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const err = new Error('Agora SaleCenters no devolvió JSON');
    err.status = 502;
    throw err;
  }

  const list =
    data.SaleCenters ??
    data.saleCenters ??
    (Array.isArray(data) ? data : []);
  const centers = Array.isArray(list) ? list : [];

  let upserted = 0;
  for (const sc of centers) {
    const id = sc.Id ?? sc.id;
    if (id == null) continue;
    const sk = String(id);
    const nombre = String(sc.Name ?? sc.name ?? sc.Nombre ?? '').trim();
    const priceListId = sc.PriceListId ?? sc.priceListId ?? null;
    const currentPriceListId = sc.CurrentPriceListId ?? sc.currentPriceListId ?? null;

    const values = {
      ':id': id,
    };
    const sets = ['Id = :id'];
    // Lo que Ágora deja de enviar se borra: si no, una CurrentPriceListId de una
    // tarifa promocional ya terminada se quedaría fija y pickPriceListId la
    // seguiría prefiriendo sobre la PriceListId real.
    const removes = [];

    if (nombre) {
      sets.push('Nombre = :nombre');
      values[':nombre'] = nombre;
    } else {
      removes.push('Nombre');
    }
    if (priceListId != null && String(priceListId).trim() !== '') {
      sets.push('PriceListId = :pl');
      values[':pl'] = priceListId;
    } else {
      removes.push('PriceListId');
    }
    if (currentPriceListId != null && String(currentPriceListId).trim() !== '') {
      sets.push('CurrentPriceListId = :cpl');
      values[':cpl'] = currentPriceListId;
    } else {
      removes.push('CurrentPriceListId');
    }

    let updateExpr = `SET ${sets.join(', ')}`;
    if (removes.length) updateExpr += ` REMOVE ${removes.join(', ')}`;

    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: PK_CENTRO_VENTA, SK: sk },
        UpdateExpression: updateExpr,
        ExpressionAttributeValues: values,
      }),
    );
    upserted++;
  }

  return { fetched: centers.length, upserted };
}
