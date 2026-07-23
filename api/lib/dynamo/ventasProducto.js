/**
 * Sync y consulta de ventas agregadas por producto (Igp_VentasProducto).
 */

import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
  PutCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { exportInvoices } from '../agora/client.js';
import {
  esDocumentoAnulado,
  esLineaVentaValidaParaIncentivo,
  factorBonificacionLinea,
  toNumberSafe,
  pickCustomerId,
  pickCustomerName,
  pickLineUserId,
} from '../agora/invoiceSaleValidity.js';
import { client, tables } from '../db.js';
import { getAllUsersMap } from './agoraUsuarios.js';

const TABLE_NAME = tables.ventasProducto;
const BATCH_SIZE = 25;
const META_PK = 'GLOBAL';
const META_SK = '__meta__sales_lines__';

export const GSI_VENTAS_PRODUCTO_NAME = 'ProductId-Fecha-index';

const SYNC_THROTTLE_MINUTES = parseInt(
  process.env.AGORA_SALES_LINES_SYNC_THROTTLE_MINUTES || '30',
  10,
) || 30;

let gsiReady = false;

export function isVentasProductoGsiReady() {
  return gsiReady;
}

export async function ensureVentasProductoGSI() {
  try {
    const desc = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    const gsis = desc.Table?.GlobalSecondaryIndexes || [];
    const existing = gsis.find((g) => g.IndexName === GSI_VENTAS_PRODUCTO_NAME);
    if (existing) {
      gsiReady = existing.IndexStatus === 'ACTIVE';
      if (!gsiReady) {
        console.log(`[GSI] ${GSI_VENTAS_PRODUCTO_NAME} existe pero está en estado ${existing.IndexStatus}`);
      } else {
        console.log(`[GSI] ${GSI_VENTAS_PRODUCTO_NAME} activo y listo`);
      }
      return;
    }
    console.log(`[GSI] Creando ${GSI_VENTAS_PRODUCTO_NAME} en ${TABLE_NAME}…`);
    await client.send(new UpdateTableCommand({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: 'ProductId', AttributeType: 'S' },
        { AttributeName: 'Fecha', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexUpdates: [{
        Create: {
          IndexName: GSI_VENTAS_PRODUCTO_NAME,
          KeySchema: [
            { AttributeName: 'ProductId', KeyType: 'HASH' },
            { AttributeName: 'Fecha', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      }],
    }));
    console.log(`[GSI] ${GSI_VENTAS_PRODUCTO_NAME} creación iniciada.`);
  } catch (err) {
    console.warn('[GSI] No se pudo crear/verificar ventas producto GSI:', err.message || err);
  }
}

export async function getLastSalesLinesSync(docClient) {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: META_PK, SK: META_SK },
    }));
    const ts = r?.Item?.lastSync;
    return typeof ts === 'number' ? ts : null;
  } catch {
    return null;
  }
}

export async function setLastSalesLinesSync(docClient) {
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: META_PK,
      SK: META_SK,
      lastSync: Date.now(),
    },
  }));
}

export function shouldSkipSalesLinesSyncByThrottle(lastSyncTs) {
  if (lastSyncTs == null) return false;
  const elapsed = (Date.now() - lastSyncTs) / (60 * 1000);
  return elapsed < SYNC_THROTTLE_MINUTES;
}

function extractInvoicesArray(data) {
  if (!data) return [];
  const unwrap = (d) => d?.Data ?? d?.data ?? d?.Result ?? d?.result ?? d?.Export ?? d?.export ?? d;
  let cur = unwrap(data);
  for (const key of ['Invoices', 'invoices']) {
    const v = cur?.[key];
    if (Array.isArray(v)) return v;
    if (v?.Items) return v.Items;
    if (v?.items) return v.items;
  }
  if (Array.isArray(cur)) return cur;
  return [];
}

function pickUserId(it) {
  return (
    it?.Cashier?.Id ?? it?.cashier?.id ??
    it?.CashierId ?? it?.cashierId ??
    it?.User?.Id ?? it?.user?.id ??
    it?.UserId ?? it?.userId ??
    it?.Waiter?.Id ?? it?.waiter?.id ??
    it?.WaiterId ?? it?.waiterId ??
    null
  );
}

function pickUserName(it) {
  return (
    it?.Cashier?.Name ?? it?.cashier?.name ??
    it?.CashierName ?? it?.cashierName ??
    it?.User?.Name ?? it?.user?.name ??
    it?.UserName ?? it?.userName ??
    it?.Waiter?.Name ?? it?.waiter?.name ??
    it?.WaiterName ?? it?.waiterName ??
    null
  );
}

function pickProductId(line) {
  const id =
    line?.ProductId ?? line?.productId ??
    line?.Product?.Id ?? line?.product?.id ?? '';
  return String(id).trim();
}

function pickProductName(line) {
  return String(
    line?.ProductName ?? line?.productName ??
    line?.Product?.Name ?? line?.product?.name ??
    line?.Name ?? line?.name ?? '',
  ).trim();
}

function buildSk(fecha, productId, agoraUserId) {
  return `DIA#${fecha}#PROD#${productId}#USER#${agoraUserId}`;
}

/**
 * Carga locales con agoraCode → id_Locales.
 * @returns {Promise<{ workplaceToLocalId: Map<string,string>, workplaces: string[] }>}
 */
export async function loadLocalesWorkplaceMap(docClient, tableLocalesName) {
  const workplaceToLocalId = new Map();
  const locales = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tableLocalesName,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    locales.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  for (const loc of locales) {
    const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
    const localId = String(loc.id_Locales ?? loc.id_locales ?? '').trim();
    if (code && localId) workplaceToLocalId.set(code, localId);
  }
  return {
    workplaceToLocalId,
    workplaces: [...workplaceToLocalId.keys()],
  };
}

/**
 * Agrega líneas válidas de facturas en memoria.
 */
export function buildSalesAggregatesFromInvoices(invoices, businessDay, workplaceToLocalId, userMap = new Map()) {
  const agg = new Map();

  for (const inv of invoices) {
    const workplaceId = String(
      inv?.Workplace?.Id ?? inv?.workplace?.id ?? inv?.WorkplaceId ?? inv?.workplaceId ?? '',
    ).trim();
    if (!workplaceId) continue;

    const localId = workplaceToLocalId.get(workplaceId) ?? workplaceId;
    const bd = String(inv?.BusinessDay ?? inv?.businessDay ?? businessDay).trim() || businessDay;
    const invCustomerId = pickCustomerId(inv);
    const invCustomerName = pickCustomerName(inv);

    const items = inv?.InvoiceItems ?? inv?.invoiceItems ?? [];
    const invoiceItems = Array.isArray(items) && items.length > 0 ? items : [inv];

    for (const it of invoiceItems) {
      if (esDocumentoAnulado(it)) continue;

      // Usuario del documento/ticket: solo fallback si la línea no trae comandante.
      const docUserIdRaw = pickUserId(it) ?? pickUserId(inv);
      const docUserId = docUserIdRaw != null && String(docUserIdRaw).trim() !== ''
        ? String(docUserIdRaw).trim()
        : '0';
      const docUserName = (() => {
        const n = pickUserName(it) ?? pickUserName(inv);
        return n ? String(n).trim() : null;
      })();

      const saleLines =
        it?.SaleLines ?? it?.saleLines ??
        it?.Lines ?? it?.lines ??
        it?.DocumentLines ?? it?.documentLines ?? [];
      if (!Array.isArray(saleLines)) continue;

      const lineCtx = { it, invCustomerId, invCustomerName };

      for (const line of saleLines) {
        if (!esLineaVentaValidaParaIncentivo(line, lineCtx)) continue;

        const productId = pickProductId(line);
        if (!productId) continue;

        // Usuario que comandó esta línea; si falta, el del ticket.
        const lineUserIdRaw = pickLineUserId(line);
        const agoraUserId = lineUserIdRaw != null && String(lineUserIdRaw).trim() !== ''
          ? String(lineUserIdRaw).trim()
          : docUserId;
        const userName = userMap.get(agoraUserId)
          ?? (agoraUserId === docUserId ? docUserName : null)
          ?? null;

        const qty = toNumberSafe(line?.Quantity ?? line?.quantity);
        const lineGross = toNumberSafe(
          line?.TotalAmount ?? line?.totalAmount ??
          line?.LineGrossAmount ?? line?.lineGrossAmount ??
          line?.GrossAmount ?? line?.grossAmount ??
          line?.Total ?? line?.total ??
          line?.NetAmount ?? line?.netAmount ??
          line?.Amount ?? line?.amount,
        );
        const productName = pickProductName(line) || productId;
        const key = `${localId}|${bd}|${productId}|${agoraUserId}`;

        if (!agg.has(key)) {
          agg.set(key, {
            PK: `LOCAL#${localId}`,
            SK: buildSk(bd, productId, agoraUserId),
            Fecha: bd,
            LocalId: localId,
            WorkplaceId: workplaceId,
            ProductId: productId,
            ProductName: productName,
            AgoraUserId: agoraUserId,
            UserName: userName || '',
            Unidades: 0,
            UnidadesBonificables: 0,
            ImporteBruto: 0,
          });
        }
        const row = agg.get(key);
        const factorBonif = factorBonificacionLinea(line, qty, lineGross);
        row.Unidades += qty;
        row.UnidadesBonificables += qty * factorBonif;
        row.ImporteBruto = Math.round((row.ImporteBruto + Math.abs(lineGross)) * 100) / 100;
        if (!row.ProductName && productName) row.ProductName = productName;
        if (!row.UserName && userName) row.UserName = userName;
      }
    }
  }

  return [...agg.values()];
}

async function deleteDayAggregatesForLocal(docClient, localId, businessDay) {
  const pk = `LOCAL#${localId}`;
  const prefix = `DIA#${businessDay}#`;
  const keysToDelete = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': prefix },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const item of r.Items || []) {
      keysToDelete.push({ PK: item.PK, SK: item.SK });
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  for (let i = 0; i < keysToDelete.length; i += BATCH_SIZE) {
    const chunk = keysToDelete.slice(i, i + BATCH_SIZE);
    await docClient.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk.map((k) => ({ DeleteRequest: { Key: k } })),
      },
    }));
  }
  return keysToDelete.length;
}

async function upsertAggregates(docClient, items) {
  const syncedAt = new Date().toISOString();
  let upserted = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE).map((item) => ({
      ...item,
      Unidades: Math.round(item.Unidades * 1000) / 1000,
      UnidadesBonificables: Math.round(toNumberSafe(item.UnidadesBonificables) * 1000) / 1000,
      ImporteBruto: Math.round(item.ImporteBruto * 100) / 100,
      SyncedAt: syncedAt,
    }));
    await docClient.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk.map((item) => ({ PutRequest: { Item: item } })),
      },
    }));
    upserted += chunk.length;
  }
  return upserted;
}

/**
 * Sincroniza un business-day: idempotente (borra y reescribe por local).
 */
export async function syncSalesLinesForDay(docClient, businessDay, options = {}) {
  const {
    workplaces: workplacesFilter = null,
    localId: localIdFilter = null,
    tableLocalesName = tables.locales,
    tableAgoraUsuariosName = tables.agoraUsuarios,
  } = options;

  const { workplaceToLocalId, workplaces: allWorkplaces } =
    await loadLocalesWorkplaceMap(docClient, tableLocalesName);

  let workplaces = workplacesFilter && workplacesFilter.length > 0
    ? workplacesFilter.map(String)
    : allWorkplaces;

  if (localIdFilter) {
    const target = String(localIdFilter);
    workplaces = workplaces.filter((wp) => workplaceToLocalId.get(wp) === target);
    if (workplaces.length === 0) {
      const reverse = [...workplaceToLocalId.entries()].find(([, id]) => id === target);
      if (reverse) workplaces = [reverse[0]];
    }
  }

  if (workplaces.length === 0) {
    return {
      ok: true,
      businessDay,
      locales: 0,
      items: 0,
      deleted: 0,
      warning: 'sin_locales_con_agoraCode',
    };
  }

  let userMap = new Map();
  try {
    userMap = await getAllUsersMap(docClient, tableAgoraUsuariosName);
  } catch (e) {
    console.warn('[sales-lines/sync] usersMap', e.message || e);
  }

  const data = await exportInvoices(businessDay, workplaces);
  const invoices = extractInvoicesArray(data);
  const aggregates = buildSalesAggregatesFromInvoices(
    invoices,
    businessDay,
    workplaceToLocalId,
    userMap,
  );

  const localIdsToClear = new Set();
  if (localIdFilter) {
    localIdsToClear.add(String(localIdFilter));
  } else {
    for (const wp of workplaces) {
      const lid = workplaceToLocalId.get(wp);
      if (lid) localIdsToClear.add(lid);
    }
  }
  for (const a of aggregates) localIdsToClear.add(a.LocalId);

  let deleted = 0;
  for (const localId of localIdsToClear) {
    deleted += await deleteDayAggregatesForLocal(docClient, localId, businessDay);
  }

  const upserted = await upsertAggregates(docClient, aggregates);

  return {
    ok: true,
    businessDay,
    locales: localIdsToClear.size,
    items: upserted,
    deleted,
    invoicesFetched: invoices.length,
    workplaces: workplaces.length,
  };
}

export function listDaysBetween(dateFrom, dateTo) {
  const days = [];
  let d = new Date(dateFrom + 'T12:00:00');
  const end = new Date(dateTo + 'T12:00:00');
  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export function daysBetweenInclusive(dateFrom, dateTo) {
  if (!dateFrom || !dateTo || dateFrom > dateTo) return 0;
  return listDaysBetween(dateFrom, dateTo).length;
}

/**
 * Ventas agregadas de un local en un rango de fechas (business-day Ágora).
 */
export async function queryVentasPorLocalRango(docClient, localId, fechaDesde, fechaHasta) {
  const pk = `LOCAL#${localId}`;
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skFrom AND :skTo',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':skFrom': `DIA#${fechaDesde}#`,
        ':skTo': `DIA#${fechaHasta}#\uffff`,
      },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}
