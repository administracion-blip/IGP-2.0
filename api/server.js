import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env.local') });
dotenv.config({ path: join(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import { DynamoDBClient, DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand, BatchWriteCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand as S3GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { exportSystemCloseOuts, exportPosCloseOuts, exportInvoices, exportWarehouses, exportIncomingDeliveryNotes, exportFamilies, exportVats } from './lib/agora/client.js';
import { upsertBatch } from './lib/dynamo/salesCloseOuts.js';
import { syncProducts, getLastSync, setLastSync, shouldSkipSyncByThrottle, toApiProduct, pickAllowedFields } from './lib/dynamo/agoraProducts.js';
import facturacionRouter from './routes/facturacion.js';

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

// Health check para verificar que el API está en marcha
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'API ERP OK', port: process.env.PORT || 3001 });
});

// Diagnóstico: si esto responde 200, el servidor tiene las rutas de closeouts
app.get('/api/agora/closeouts-ready', (_req, res) => {
  res.json({ ok: true, closeoutsRoute: 'registered' });
});

const region = process.env.AWS_REGION || 'eu-west-3';
const tableName = process.env.DDB_USUARIOS || process.env.DYNAMODB_TABLE || 'igp_usuarios';
const tableLocalesName = process.env.DDB_LOCALES || 'igp_Locales';
const tableEmpresasName = process.env.DDB_EMPRESAS || 'igp_Empresas';
const tableProductosName = process.env.DDB_PRODUCTOS || 'igp_Productos';
const tableAlmacenesName = process.env.DDB_ALMACENES || 'igp_Almacenes';
const tableSaleCentersName = process.env.DDB_SALE_CENTERS_TABLE || 'Igp_SaleCenters';
const tableAgoraProductsName = process.env.DDB_AGORA_PRODUCTS_TABLE || 'Igp_AgoraProducts';
const tableSalesCloseOutsName = process.env.DDB_SALES_CLOSEOUTS_TABLE || 'Igp_SalesCloseouts';
const tableMantenimientoName = process.env.DDB_MANTENIMIENTO_TABLE || 'Igp_Mantenimiento';
const tableRolesPermisosName = process.env.DDB_ROLES_PERMISOS_TABLE || 'Igp_RolesPermisos';
const tableGestionFestivosName = process.env.DDB_GESTION_FESTIVOS_TABLE || 'Igp_Gestionfestivosyestimaciones';
const tablePedidosName = process.env.DDB_PEDIDOS || 'Igp_Pedidos';
const tablePedidosLineasName = process.env.DDB_PEDIDOS_LINEAS || 'Igp_PedidosLineas';
const tableComprasProveedorName = process.env.DDB_COMPRAS_PROVEEDOR || 'Igp_ComprasAProveedor';
const tableAcuerdosName = process.env.DDB_ACUERDOS || 'Igp_Acuerdos';
const tableAcuerdosDetallesName = process.env.DDB_ACUERDOS_DETALLES || 'Igp_AcuerdosDetalles';
const tableAcuerdosImagenName = process.env.DDB_ACUERDOS_IMAGEN || 'Igp_AcuerdosImagen';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region });

const GSI_COMPRAS_NAME = 'ProductId-AlbaranFecha-index';
let gsiComprasReady = false;

async function ensureComprasGSI() {
  try {
    const desc = await client.send(new DescribeTableCommand({ TableName: tableComprasProveedorName }));
    const gsis = desc.Table?.GlobalSecondaryIndexes || [];
    const existing = gsis.find((g) => g.IndexName === GSI_COMPRAS_NAME);
    if (existing) {
      gsiComprasReady = existing.IndexStatus === 'ACTIVE';
      if (!gsiComprasReady) console.log(`[GSI] ${GSI_COMPRAS_NAME} existe pero está en estado ${existing.IndexStatus}, usando Scan como fallback`);
      else console.log(`[GSI] ${GSI_COMPRAS_NAME} activo y listo`);
      return;
    }
    console.log(`[GSI] Creando ${GSI_COMPRAS_NAME} en ${tableComprasProveedorName}…`);
    await client.send(new UpdateTableCommand({
      TableName: tableComprasProveedorName,
      AttributeDefinitions: [
        { AttributeName: 'ProductId', AttributeType: 'S' },
        { AttributeName: 'AlbaranFecha', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexUpdates: [{
        Create: {
          IndexName: GSI_COMPRAS_NAME,
          KeySchema: [
            { AttributeName: 'ProductId', KeyType: 'HASH' },
            { AttributeName: 'AlbaranFecha', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['Quantity', 'PK', 'SK'] },
          ProvisionedThroughput: desc.Table?.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' ? undefined : { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      }],
    }));
    console.log(`[GSI] ${GSI_COMPRAS_NAME} creación iniciada. Estará activo en unos minutos. Usando Scan como fallback mientras tanto.`);
  } catch (err) {
    console.warn('[GSI] No se pudo crear/verificar el GSI:', err.message || err);
  }
}

async function queryComprasPorProductos(productIds, fechaInicio, fechaFin) {
  const comprasPorProducto = {};
  if (!productIds || productIds.size === 0) return comprasPorProducto;

  if (gsiComprasReady) {
    const queries = [...productIds].map(async (pid) => {
      let keyExpr = 'ProductId = :pid';
      const exprVals = { ':pid': pid };
      if (fechaInicio && fechaFin) {
        keyExpr += ' AND AlbaranFecha BETWEEN :fi AND :ff';
        // DynamoDB exige lower <= upper en BETWEEN
        exprVals[':fi'] = fechaInicio <= fechaFin ? fechaInicio : fechaFin;
        exprVals[':ff'] = fechaInicio <= fechaFin ? fechaFin : fechaInicio;
      } else if (fechaInicio) {
        keyExpr += ' AND AlbaranFecha >= :fi';
        exprVals[':fi'] = fechaInicio;
      } else if (fechaFin) {
        keyExpr += ' AND AlbaranFecha <= :ff';
        exprVals[':ff'] = fechaFin;
      }
      let total = 0;
      let lastKey = null;
      do {
        const r = await docClient.send(new QueryCommand({
          TableName: tableComprasProveedorName,
          IndexName: GSI_COMPRAS_NAME,
          KeyConditionExpression: keyExpr,
          ExpressionAttributeValues: exprVals,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        for (const item of (r.Items || [])) {
          total += Number(item.Quantity) || 0;
        }
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
      comprasPorProducto[pid] = total;
    });
    await Promise.all(queries);
  } else {
    let cKey = null;
    const allCompras = [];
    do {
      const r = await docClient.send(new ScanCommand({ TableName: tableComprasProveedorName, ...(cKey && { ExclusiveStartKey: cKey }) }));
      allCompras.push(...(r.Items || []));
      cKey = r.LastEvaluatedKey || null;
    } while (cKey);
    for (const c of allCompras) {
      const pid = String(c.ProductId || '').trim();
      if (!productIds.has(pid)) continue;
      const fecha = c.AlbaranFecha || '';
      if (fechaInicio && fecha < fechaInicio) continue;
      if (fechaFin && fecha > fechaFin) continue;
      comprasPorProducto[pid] = (comprasPorProducto[pid] || 0) + (Number(c.Quantity) || 0);
    }
  }
  return comprasPorProducto;
}

ensureComprasGSI();

// GET /api/agora/closeouts - registrado aquí al inicio para evitar 404
app.get('/api/agora/closeouts', async (req, res) => {
  const businessDay = (req.query.businessDay && String(req.query.businessDay).trim()) || '';
  const workplaceId = (req.query.workplaceId && String(req.query.workplaceId).trim()) || '';
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tableSalesCloseOutsName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    let list = items;
    if (workplaceId) list = list.filter((i) => (i.PK ?? i.pk) === workplaceId);
    if (businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      const sk = (i) => i.SK ?? i.sk ?? '';
      list = list.filter((i) => sk(i) && sk(i).startsWith(businessDay));
    }
    list.sort((a, b) => ((a.SK ?? a.sk) || '').localeCompare((b.SK ?? b.sk) || ''));
    for (const item of list) {
      if ((item.PosId ?? item.posId) != null) continue;
      const sk = String(item.SK ?? item.sk ?? '').trim();
      const parts = sk.split('#');
      if (parts.length === 3 && parts[1] && parts[1] !== '0') item.PosId = parts[1];
    }
    const posIdsNeedingName = [...new Set(list.filter((i) => (i.PosId ?? i.posId) != null && !(i.PosName ?? i.posName)).map((i) => String(i.PosId ?? i.posId)))];
    if (posIdsNeedingName.length > 0) {
      const scItems = [];
      let scLastKey = null;
      do {
        const scResult = await docClient.send(new QueryCommand({
          TableName: tableSaleCentersName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': 'GLOBAL' },
          ...(scLastKey && { ExclusiveStartKey: scLastKey }),
        }));
        scItems.push(...(scResult.Items || []));
        scLastKey = scResult.LastEvaluatedKey || null;
      } while (scLastKey);
      const posIdToNombre = Object.fromEntries(scItems.filter((s) => s.Id != null).map((s) => [String(s.Id), String(s.Nombre ?? s.nombre ?? '').trim()]));
      for (const item of list) {
        const pid = item.PosId ?? item.posId;
        if (pid != null && !(item.PosName ?? item.posName) && posIdToNombre[String(pid)]) {
          item.PosName = posIdToNombre[String(pid)];
        }
      }
    }
    const normalized = list.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const a = item.Amounts ?? item.amounts ?? {};
      const amounts = typeof a === 'object' && a !== null ? a : {};
      const ensureArray = (arr) => (Array.isArray(arr) ? arr : []);
      const toPayment = (p) => ({ MethodName: p?.MethodName ?? p?.methodName ?? p?.Name ?? p?.name ?? null, Amount: p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? null });
      const skVal = item.SK ?? item.sk ?? '';
      const extractNum = (s) => (!s || typeof s !== 'string' ? '' : s.trim().split('#').length >= 2 ? s.trim().split('#').pop() : '');
      const numberVal = item.Number ?? item.number ?? extractNum(skVal);
      const base = {
        ...item,
        PK: item.PK ?? item.pk ?? '',
        SK: skVal,
        BusinessDay: item.BusinessDay ?? item.businessDay ?? (skVal && String(skVal).split('#')[0]) ?? '',
        Number: numberVal,
        Amounts: amounts,
        InvoicePayments: ensureArray(item.InvoicePayments ?? item.invoicePayments).map(toPayment),
        TicketPayments: ensureArray(item.TicketPayments ?? item.ticketPayments).map(toPayment),
        DeliveryNotePayments: ensureArray(item.DeliveryNotePayments ?? item.deliveryNotePayments).map(toPayment),
        SalesOrderPayments: ensureArray(item.SalesOrderPayments ?? item.salesOrderPayments).map(toPayment),
      };
      return addExcelStyleFields(base);
    });
    res.json({ closeouts: normalized });
  } catch (err) {
    console.error('[agora/closeouts]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar cierres' });
  }
});

// POST /api/agora/closeouts - Crear registro manual
app.post('/api/agora/closeouts', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.PK ?? body.pk ?? '').trim();
  const businessDay = String(body.BusinessDay ?? body.businessDay ?? '').trim();
  const posId = body.PosId ?? body.posId ?? null;
  const number = String(body.Number ?? body.number ?? '1').trim() || '1';
  if (!pk || !businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'PK (workplaceId) y BusinessDay (YYYY-MM-DD) obligatorios' });
  }
  const sk = posId != null && posId !== '' && String(posId) !== '0'
    ? `${businessDay}#${posId}#${number}`
    : `${businessDay}#${number}`;
  const now = new Date().toISOString();
  const invoicePayments = Array.isArray(body.InvoicePayments) ? body.InvoicePayments : (Array.isArray(body.invoicePayments) ? body.invoicePayments : []);
  const gross = body.GrossAmount ?? body.grossAmount ?? invoicePayments.reduce((s, p) => s + (Number(p?.Amount ?? p?.amount ?? 0) || 0), 0);
  const item = {
    PK: pk,
    SK: sk,
    BusinessDay: businessDay,
    WorkplaceId: pk,
    WorkplaceName: body.WorkplaceName ?? body.workplaceName ?? pk,
    PosId: posId,
    PosName: body.PosName ?? body.posName ?? null,
    Number: number,
    Amounts: { GrossAmount: gross, NetAmount: body.NetAmount ?? body.netAmount ?? null, VatAmount: body.VatAmount ?? body.vatAmount ?? null, SurchargeAmount: body.SurchargeAmount ?? body.surchargeAmount ?? null },
    InvoicePayments: invoicePayments,
    TicketPayments: body.TicketPayments ?? body.ticketPayments ?? [],
    DeliveryNotePayments: body.DeliveryNotePayments ?? body.deliveryNotePayments ?? [],
    SalesOrderPayments: body.SalesOrderPayments ?? body.salesOrderPayments ?? [],
    Documents: body.Documents ?? body.documents ?? [],
    OpenDate: body.OpenDate ?? body.openDate ?? null,
    CloseDate: body.CloseDate ?? body.closeDate ?? null,
    createdAt: now,
    updatedAt: now,
    source: 'manual',
  };
  try {
    await docClient.send(new PutCommand({ TableName: tableSalesCloseOutsName, Item: item }));
    res.json({ ok: true, item: { PK: item.PK, SK: item.SK } });
  } catch (err) {
    console.error('[agora/closeouts POST]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al crear cierre' });
  }
});

// PUT /api/agora/closeouts - Actualizar registro
// Si BusinessDay cambia, la SK cambia (SK = businessDay#posId#number). DynamoDB no permite
// actualizar la clave primaria, así que hay que borrar el viejo y crear uno nuevo.
app.put('/api/agora/closeouts', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.PK ?? body.pk ?? '').trim();
  const sk = String(body.SK ?? body.sk ?? '').trim();
  if (!pk || !sk) return res.status(400).json({ error: 'PK y SK obligatorios' });

  const businessDay = body.BusinessDay != null ? String(body.BusinessDay).trim() : null;
  const posId = body.PosId ?? body.posId ?? null;
  const number = String(body.Number ?? body.number ?? '1').trim() || '1';

  const newSk = businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)
    ? (posId != null && posId !== '' && String(posId) !== '0'
        ? `${businessDay}#${posId}#${number}`
        : `${businessDay}#${number}`)
    : null;

  const skChanged = newSk && newSk !== sk;

  if (skChanged) {
    try {
      const getRes = await docClient.send(new GetCommand({
        TableName: tableSalesCloseOutsName,
        Key: { PK: pk, SK: sk },
      }));
      const existing = getRes.Item;
      if (!existing) return res.status(404).json({ error: 'Registro no encontrado' });

      const invoicePayments = Array.isArray(body.InvoicePayments) ? body.InvoicePayments : (existing.InvoicePayments ?? []);
      const gross = body.Amounts?.GrossAmount ?? body.GrossAmount ?? invoicePayments.reduce((s, p) => s + (Number(p?.Amount ?? p?.amount ?? 0) || 0), 0);
      const now = new Date().toISOString();
      const newItem = {
        PK: pk,
        SK: newSk,
        BusinessDay: businessDay,
        WorkplaceId: pk,
        WorkplaceName: body.WorkplaceName ?? body.workplaceName ?? existing.WorkplaceName ?? pk,
        PosId: posId ?? existing.PosId,
        PosName: body.PosName ?? body.posName ?? existing.PosName ?? null,
        Number: number,
        Amounts: body.Amounts ?? existing.Amounts ?? { GrossAmount: gross, NetAmount: null, VatAmount: null, SurchargeAmount: null },
        InvoicePayments: invoicePayments,
        TicketPayments: body.TicketPayments ?? body.ticketPayments ?? existing.TicketPayments ?? [],
        DeliveryNotePayments: body.DeliveryNotePayments ?? body.deliveryNotePayments ?? existing.DeliveryNotePayments ?? [],
        SalesOrderPayments: body.SalesOrderPayments ?? body.salesOrderPayments ?? existing.SalesOrderPayments ?? [],
        Documents: body.Documents ?? body.documents ?? existing.Documents ?? [],
        OpenDate: body.OpenDate ?? body.openDate ?? existing.OpenDate ?? null,
        CloseDate: body.CloseDate ?? body.closeDate ?? existing.CloseDate ?? null,
        createdAt: existing.createdAt ?? now,
        updatedAt: now,
        source: existing.source ?? 'manual',
      };
      await docClient.send(new PutCommand({ TableName: tableSalesCloseOutsName, Item: newItem }));
      await docClient.send(new DeleteCommand({
        TableName: tableSalesCloseOutsName,
        Key: { PK: pk, SK: sk },
      }));
      return res.json({ ok: true });
    } catch (err) {
      console.error('[agora/closeouts PUT]', err.message || err);
      return res.status(500).json({ error: err.message || 'Error al actualizar cierre' });
    }
  }

  const updates = [];
  const exprNames = {};
  const exprValues = {};
  let idx = 0;
  const addSet = (attr, val) => {
    if (val === undefined) return;
    const n = `#a${idx}`; const v = `:v${idx}`;
    exprNames[n] = attr; exprValues[v] = val; updates.push(`${n} = ${v}`); idx++;
  };
  if (body.BusinessDay != null) addSet('BusinessDay', String(body.BusinessDay).trim());
  if (body.WorkplaceName != null) addSet('WorkplaceName', String(body.WorkplaceName));
  if (body.PosId !== undefined) addSet('PosId', body.PosId);
  if (body.PosName !== undefined) addSet('PosName', body.PosName);
  if (body.Number != null) addSet('Number', String(body.Number));
  if (body.InvoicePayments != null) addSet('InvoicePayments', Array.isArray(body.InvoicePayments) ? body.InvoicePayments : []);
  if (body.Amounts != null) addSet('Amounts', body.Amounts);
  if (body.OpenDate !== undefined) addSet('OpenDate', body.OpenDate);
  if (body.CloseDate !== undefined) addSet('CloseDate', body.CloseDate);
  addSet('updatedAt', new Date().toISOString());
  if (updates.length <= 1) return res.status(400).json({ error: 'Ningún campo para actualizar' });
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableSalesCloseOutsName,
      Key: { PK: pk, SK: sk },
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[agora/closeouts PUT]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al actualizar cierre' });
  }
});

// DELETE /api/agora/closeouts - Eliminar registro
app.delete('/api/agora/closeouts', async (req, res) => {
  const pk = (req.query.PK ?? req.query.pk ?? req.body?.PK ?? req.body?.pk ?? '').toString().trim();
  const sk = (req.query.SK ?? req.query.sk ?? req.body?.SK ?? req.body?.sk ?? '').toString().trim();
  if (!pk || !sk) return res.status(400).json({ error: 'PK y SK obligatorios' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableSalesCloseOutsName,
      Key: { PK: pk, SK: sk },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[agora/closeouts DELETE]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al eliminar cierre' });
  }
});

// GET /api/agora/closeouts/totals-by-local-range?workplaceId=X&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
// Devuelve sumatorio de total facturado por día para un local en el rango indicado.
app.get('/api/agora/closeouts/totals-by-local-range', async (req, res) => {
  const workplaceId = (req.query.workplaceId && String(req.query.workplaceId).trim()) || '';
  const dateFrom = (req.query.dateFrom && String(req.query.dateFrom).trim()) || '';
  const dateTo = (req.query.dateTo && String(req.query.dateTo).trim()) || '';
  if (!workplaceId) {
    return res.status(400).json({ error: 'workplaceId obligatorio' });
  }
  if (!dateFrom || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !dateTo || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo obligatorios (YYYY-MM-DD)' });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ error: 'dateFrom debe ser <= dateTo' });
  }
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: tableSalesCloseOutsName,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skFrom AND :skTo',
        ExpressionAttributeValues: {
          ':pk': workplaceId,
          ':skFrom': dateFrom,
          ':skTo': `${dateTo}\uffff`,
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const totalsByDay = {};
    for (const item of items) {
      const sk = String(item.SK ?? item.sk ?? '').trim();
      const businessDay = (sk && /^\d{4}-\d{2}-\d{2}/.test(sk) ? sk.slice(0, 10) : (sk && sk.split('#')[0])) || '';
      if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) continue;
      const arr = item.InvoicePayments ?? item.invoicePayments;
      let total = 0;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          total += Number(p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? 0) || 0;
        }
      }
      if (total === 0) {
        const amounts = item.Amounts ?? item.amounts ?? {};
        const gross = amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total;
        total = Number(gross) || 0;
      }
      totalsByDay[businessDay] = (totalsByDay[businessDay] || 0) + total;
    }
    for (const d in totalsByDay) {
      totalsByDay[d] = Math.round(totalsByDay[d] * 100) / 100;
    }
    res.json({ totals: totalsByDay });
  } catch (err) {
    console.error('[agora/closeouts/totals-by-local-range]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al obtener totales' });
  }
});

// GET /api/agora/closeouts/totals-by-local?businessDay=YYYY-MM-DD
// Devuelve sumatorio de total facturado (InvoicePayments) por local para el día indicado.
app.get('/api/agora/closeouts/totals-by-local', async (req, res) => {
  const businessDay = (req.query.businessDay && String(req.query.businessDay).trim()) || '';
  if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'businessDay obligatorio (YYYY-MM-DD)' });
  }
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tableSalesCloseOutsName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const list = items.filter((i) => {
      const sk = String(i.SK ?? i.sk ?? '').trim();
      return sk && sk.startsWith(businessDay);
    });
    const totalsByPk = {};
    for (const item of list) {
      const pk = String(item.PK ?? item.pk ?? '').trim();
      const arr = item.InvoicePayments ?? item.invoicePayments;
      let total = 0;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          total += Number(p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? 0) || 0;
        }
      }
      if (pk) {
        totalsByPk[pk] = (totalsByPk[pk] || 0) + total;
      }
    }
    const localeItems = [];
    let locLastKey = null;
    do {
      const locResult = await docClient.send(new ScanCommand({
        TableName: tableLocalesName,
        ...(locLastKey && { ExclusiveStartKey: locLastKey }),
      }));
      localeItems.push(...(locResult.Items || []));
      locLastKey = locResult.LastEvaluatedKey || null;
    } while (locLastKey);
    const pkToNombre = {};
    for (const loc of localeItems) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) pkToNombre[code] = nombre || code;
    }
    const result = Object.entries(totalsByPk)
      .filter(([, total]) => total > 0)
      .map(([workplaceId, total]) => ({
        local: pkToNombre[workplaceId] ?? workplaceId,
        total: Math.round(total * 100) / 100,
        workplaceId,
      }))
      .sort((a, b) => b.total - a.total);
    res.json({ businessDay, totals: result });
  } catch (err) {
    console.error('[agora/closeouts/totals-by-local]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al obtener totales' });
  }
});

// GET /api/agora/closeouts/totals-by-local-ytd?year=YYYY&dateTo=YYYY-MM-DD
// Devuelve sumatorio de total facturado (InvoicePayments) por local para el año hasta dateTo (inclusive).
// Si dateTo no se indica, incluye todo el año.
app.get('/api/agora/closeouts/totals-by-local-ytd', async (req, res) => {
  const year = (req.query.year && String(req.query.year).trim()) || '';
  const dateTo = (req.query.dateTo && String(req.query.dateTo).trim()) || '';
  if (!year || !/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: 'year obligatorio (YYYY)' });
  }
  const prefix = year + '-';
  const useDateTo = dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) && dateTo.startsWith(year + '-');
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tableSalesCloseOutsName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const list = items.filter((i) => {
      const sk = String(i.SK ?? i.sk ?? '').trim();
      if (!sk || !sk.startsWith(prefix)) return false;
      if (useDateTo) {
        const datePart = sk.split('#')[0] || '';
        if (datePart > dateTo) return false;
      }
      return true;
    });
    const totalsByPk = {};
    for (const item of list) {
      const pk = String(item.PK ?? item.pk ?? '').trim();
      const arr = item.InvoicePayments ?? item.invoicePayments;
      let total = 0;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          total += Number(p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? 0) || 0;
        }
      }
      if (pk) {
        totalsByPk[pk] = (totalsByPk[pk] || 0) + total;
      }
    }
    const localeItems = [];
    let locLastKey = null;
    do {
      const locResult = await docClient.send(new ScanCommand({
        TableName: tableLocalesName,
        ...(locLastKey && { ExclusiveStartKey: locLastKey }),
      }));
      localeItems.push(...(locResult.Items || []));
      locLastKey = locResult.LastEvaluatedKey || null;
    } while (locLastKey);
    const pkToNombre = {};
    for (const loc of localeItems) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) pkToNombre[code] = nombre || code;
    }
    const result = Object.entries(totalsByPk)
      .filter(([, total]) => total > 0)
      .map(([workplaceId, total]) => ({
        local: pkToNombre[workplaceId] ?? workplaceId,
        total: Math.round(total * 100) / 100,
        workplaceId,
      }))
      .sort((a, b) => b.total - a.total);
    res.json({ year, dateTo: useDateTo ? dateTo : null, totals: result });
  } catch (err) {
    console.error('[agora/closeouts/totals-by-local-ytd]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al obtener totales YTD' });
  }
});

// GET /api/agora/closeouts/totals-by-month?year=YYYY&dateTo=YYYY-MM-DD
// Devuelve facturación total por mes hasta dateTo (inclusive). Para comparar con año anterior.
const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
app.get('/api/agora/closeouts/totals-by-month', async (req, res) => {
  const year = (req.query.year && String(req.query.year).trim()) || '';
  const dateTo = (req.query.dateTo && String(req.query.dateTo).trim()) || '';
  if (!year || !/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: 'year obligatorio (YYYY)' });
  }
  const prefix = year + '-';
  const useDateTo = dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) && dateTo.startsWith(year + '-');
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tableSalesCloseOutsName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const list = items.filter((i) => {
      const sk = String(i.SK ?? i.sk ?? '').trim();
      if (!sk || !sk.startsWith(prefix)) return false;
      if (useDateTo) {
        const datePart = sk.split('#')[0] || '';
        if (datePart > dateTo) return false;
      }
      return true;
    });
    const totalsByMonth = {};
    for (const item of list) {
      const sk = String(item.SK ?? item.sk ?? '').trim();
      const datePart = sk.split('#')[0] || '';
      const month = parseInt(datePart.slice(5, 7), 10) || 0;
      if (month < 1 || month > 12) continue;
      const arr = item.InvoicePayments ?? item.invoicePayments;
      let total = 0;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          total += Number(p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? 0) || 0;
        }
      }
      totalsByMonth[month] = (totalsByMonth[month] || 0) + total;
    }
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const total = Math.round((totalsByMonth[m] || 0) * 100) / 100;
      months.push({ month: m, monthLabel: MONTH_LABELS[m - 1], total });
    }
    res.json({ year, dateTo: useDateTo ? dateTo : null, months });
  } catch (err) {
    console.error('[agora/closeouts/totals-by-month]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al obtener totales por mes' });
  }
});

// Cache en memoria para listado mínimo de locales (dropdowns). TTL 5 min.
let cachedLocalesMinimal = null;
let cachedLocalesMinimalTime = 0;
const CACHE_LOCALES_TTL_MS = 5 * 60 * 1000;

// Formato mínimo 6 dígitos para campos id_ (000001, 000002, ...).
function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

function normalizeCif(val) {
  return String(val ?? '').trim().toUpperCase();
}

// Estructura exacta de la tabla igp_usuarios en AWS: solo estos atributos. No crear otros.
const TABLE_USUARIOS_ATTRS = ['id_usuario', 'Nombre', 'Apellidos', 'Email', 'Password', 'Telefono', 'Rol', 'Local'];

function normalizeLocal(val) {
  if (Array.isArray(val)) return val.filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim());
  if (val != null && String(val).trim() !== '') return [String(val).trim()];
  return [];
}

// Estructura exacta de la tabla igp_Locales en AWS (orden: id_Locales, nombre, agoraCode, empresa, ...).
const TABLE_LOCALES_ATTRS = ['id_Locales', 'nombre', 'agoraCode', 'empresa', 'direccion', 'cp', 'municipio', 'provincia', 'almacen origen', 'sede', 'lat', 'lng', 'imagen'];

// Estructura exacta de la tabla igp_Empresas en AWS (clave de partición id_empresa; orden de columnas).
const TABLE_EMPRESAS_ATTRS = ['id_empresa', 'Nombre', 'Cif', 'Iban', 'IbanAlternativo', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Email', 'Telefono', 'Tipo de recibo', 'Vencimiento', 'Etiqueta', 'Cuenta contable', 'Administrador', 'Sede', 'CCC'];

// Estructura de la tabla igp_Productos en AWS (clave de partición id_producto).
const TABLE_PRODUCTOS_ATTRS = ['id_producto', 'Identificacion', 'Nombre', 'CostoPrecio'];

// Estructura de la tabla igp_Almacenes en AWS (clave de partición Id).
const TABLE_ALMACENES_ATTRS = ['Id', 'Nombre', 'Descripcion', 'Direccion'];

// Tabla DynamoDB: atributos Email, Password; opcionales Nombre, id_usuario
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan email o password' });
  }

  const emailNorm = email.trim().toLowerCase();

  try {
    const cmd = new ScanCommand({
      TableName: tableName,
      FilterExpression: '#Email = :email AND #Password = :password',
      ExpressionAttributeNames: { '#Email': 'Email', '#Password': 'Password' },
      ExpressionAttributeValues: {
        ':email': emailNorm,
        ':password': password,
      },
    });

    const result = await docClient.send(cmd);
    const items = result.Items || [];

    if (items.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = items[0];
    const rawLocal = user.Local;
    const locales = Array.isArray(rawLocal)
      ? rawLocal.filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim())
      : (rawLocal != null && String(rawLocal).trim() !== '' ? [String(rawLocal).trim()] : []);
    res.json({
      user: {
        id_usuario: user.id_usuario ?? user.Email ?? '',
        email: user.Email ?? '',
        Nombre: user.Nombre ?? user.Email ?? user.email ?? '',
        Rol: user.Rol ?? '',
        Locales: locales,
      },
    });
  } catch (err) {
    console.error('DynamoDB error:', err);
    const message = err.message || 'Error al verificar credenciales';
    res.status(500).json({ error: message });
  }
});

// Listar usuarios (campos de la tabla, sin Password)
app.get('/api/usuarios', async (req, res) => {
  try {
    const cmd = new ScanCommand({
      TableName: tableName,
    });
    const result = await docClient.send(cmd);
    const items = result.Items || [];
    const usuarios = items.map((item) => {
      const out = {};
      for (const key of TABLE_USUARIOS_ATTRS) {
        if (key === 'Password') continue;
        if (key === 'Local') {
          out[key] = normalizeLocal(item[key]);
          continue;
        }
        if (item[key] !== undefined) out[key] = item[key];
      }
      return out;
    });
    res.json({ usuarios });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar usuarios' });
  }
});

// Crear usuario (guardar en DynamoDB). Solo se escriben atributos de TABLE_USUARIOS_ATTRS.
app.post('/api/usuarios', async (req, res) => {
  const body = req.body || {};
  if (!body.Email || !body.Password) {
    return res.status(400).json({ error: 'Email y Password son obligatorios' });
  }

  try {
    const item = {};
    for (const key of TABLE_USUARIOS_ATTRS) {
      if (key === 'id_usuario') {
        const v = body.id_usuario;
        item[key] = v != null ? formatId6(v) : '000000';
      } else if (key === 'Email') {
        item[key] = String(body.Email ?? '').trim().toLowerCase();
      } else if (key === 'Password') {
        item[key] = String(body.Password ?? '');
      } else if (key === 'Local') {
        item[key] = normalizeLocal(body.Local);
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }

    const cmd = new PutCommand({
      TableName: tableName,
      Item: item,
    });

    await docClient.send(cmd);
    res.json({ ok: true, usuario: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el usuario' });
  }
});

// Actualizar usuario (por id_usuario). Si Password viene vacío, se mantiene el actual.
app.put('/api/usuarios', async (req, res) => {
  const body = req.body || {};
  const idUsuario = body.id_usuario != null ? String(body.id_usuario) : '';
  if (!idUsuario) {
    return res.status(400).json({ error: 'id_usuario es obligatorio para editar' });
  }
  if (!body.Email || !body.Email.trim()) {
    return res.status(400).json({ error: 'Email es obligatorio' });
  }

  try {
    const getCmd = new GetCommand({
      TableName: tableName,
      Key: { id_usuario: idUsuario },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};

    const item = {};
    for (const key of TABLE_USUARIOS_ATTRS) {
      if (key === 'id_usuario') {
        item[key] = idUsuario;
      } else if (key === 'Email') {
        item[key] = String(body.Email ?? '').trim().toLowerCase();
      } else if (key === 'Password') {
        const newPass = body.Password != null && String(body.Password).trim() !== '' ? String(body.Password) : (existing.Password ?? '');
        item[key] = newPass;
      } else if (key === 'Local') {
        item[key] = body.Local !== undefined ? normalizeLocal(body.Local) : normalizeLocal(existing.Local);
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }

    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: item,
    }));
    res.json({ ok: true, usuario: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el usuario' });
  }
});

// Borrar usuario por id_usuario (clave de la tabla).
app.delete('/api/usuarios', async (req, res) => {
  const idUsuario = req.body?.id_usuario != null ? String(req.body.id_usuario) : req.query?.id_usuario != null ? String(req.query.id_usuario) : '';
  if (!idUsuario) {
    return res.status(400).json({ error: 'id_usuario es obligatorio para borrar' });
  }

  try {
    await docClient.send(new DeleteCommand({
      TableName: tableName,
      Key: { id_usuario: idUsuario },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el usuario' });
  }
});

// --- Locales (tabla igp_Locales) ---
// Acepta body con claves en minúsculas (API) o PascalCase (frontend).
function bodyLocalesVal(body, key) {
  if (body[key] != null && body[key] !== '') return body[key];
  const cap = key.split(' ').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  if (body[cap] != null && body[cap] !== '') return body[cap];
  // Fallback: "Almacen origen" (solo primera palabra capitalizada, resto original)
  const alt = key.split(' ').map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p)).join(' ');
  return body[alt];
}

app.get('/api/locales', async (req, res) => {
  try {
    const minimal = req.query.minimal === '1' || req.query.minimal === 'true';
    if (minimal && cachedLocalesMinimal != null && (Date.now() - cachedLocalesMinimalTime) < CACHE_LOCALES_TTL_MS) {
      return res.json({ locales: cachedLocalesMinimal });
    }
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableLocalesName,
        ...(minimal && { ProjectionExpression: 'id_Locales, nombre' }),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const locales = items.map((item) => (item ? { ...item } : {}));
    if (minimal) {
      cachedLocalesMinimal = locales;
      cachedLocalesMinimalTime = Date.now();
    }
    res.json({ locales });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar locales' });
  }
});

app.post('/api/locales', async (req, res) => {
  const body = req.body || {};
  if (!bodyLocalesVal(body, 'nombre') || !String(bodyLocalesVal(body, 'nombre')).trim()) {
    return res.status(400).json({ error: 'nombre es obligatorio' });
  }
  try {
    const item = {};
    for (const key of TABLE_LOCALES_ATTRS) {
      if (key === 'id_Locales') {
        const v = body.id_Locales ?? body.Id_Locales;
        item[key] = v != null ? formatId6(v) : '000000';
      } else {
        const v = bodyLocalesVal(body, key);
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableLocalesName,
      Item: item,
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true, local: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el local' });
  }
});

app.put('/api/locales', async (req, res) => {
  const body = req.body || {};
  const idLocales = (body.id_Locales ?? body.Id_Locales) != null ? String(body.id_Locales ?? body.Id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para editar' });
  if (!bodyLocalesVal(body, 'nombre') || !String(bodyLocalesVal(body, 'nombre')).trim()) return res.status(400).json({ error: 'nombre es obligatorio' });
  try {
    const getCmd = new GetCommand({
      TableName: tableLocalesName,
      Key: { id_Locales: idLocales },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = {};
    for (const key of TABLE_LOCALES_ATTRS) {
      if (key === 'id_Locales') item[key] = idLocales;
      else {
        const v = bodyLocalesVal(body, key);
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableLocalesName,
      Item: item,
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true, local: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el local' });
  }
});

app.delete('/api/locales', async (req, res) => {
  const idLocales = req.body?.id_Locales != null ? String(req.body.id_Locales) : req.query?.id_Locales != null ? String(req.query.id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableLocalesName,
      Key: { id_Locales: idLocales },
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el local' });
  }
});

// --- Empresas (tabla igp_Empresas) ---

function normalizarEtiqueta(val) {
  if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
  if (val != null && val !== '') return [String(val).trim()];
  return [];
}

app.get('/api/empresas', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const empresas = items.map((item) => {
      if (!item) return {};
      const out = { ...item };
      if (out.Etiqueta == null && out.Alias != null) out.Etiqueta = normalizarEtiqueta(out.Alias);
      if (out.Etiqueta != null && !Array.isArray(out.Etiqueta)) out.Etiqueta = normalizarEtiqueta(out.Etiqueta);
      return out;
    });
    res.json({ empresas });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar empresas' });
  }
});

// Comprobar si un CIF ya existe (para validación en tiempo real)
app.get('/api/empresas/check-cif', async (req, res) => {
  const cif = normalizeCif(req.query?.cif);
  const excludeId = req.query?.excludeId != null ? String(req.query.excludeId).trim() : '';
  if (!cif) return res.status(400).json({ error: 'cif es obligatorio' });
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const exists = items.some((item) => {
      const itemCif = normalizeCif(item?.Cif);
      return itemCif && itemCif === cif && String(item.id_empresa ?? '') !== excludeId;
    });
    return res.json({ exists });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al comprobar CIF' });
  }
});

app.post('/api/empresas', async (req, res) => {
  const body = req.body || {};
  if (!body.Nombre || !String(body.Nombre).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  if (!body.Cif || !String(body.Cif).trim()) {
    return res.status(400).json({ error: 'CIF es obligatorio' });
  }
  const cifValue = normalizeCif(body.Cif);
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const dup = items.some((item) => normalizeCif(item?.Cif) === cifValue);
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') {
        const v = body.id_empresa;
        item[key] = v != null ? formatId6(v) : '000000';
      } else if (key === 'Etiqueta') {
        item[key] = normalizarEtiqueta(body[key]);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableEmpresasName,
      Item: item,
    }));
    res.json({ ok: true, empresa: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar la empresa' });
  }
});

app.put('/api/empresas', async (req, res) => {
  const body = req.body || {};
  const idEmpresa = body.id_empresa != null ? String(body.id_empresa) : '';
  if (!idEmpresa) return res.status(400).json({ error: 'id_empresa es obligatorio para editar' });
  if (!body.Nombre || !String(body.Nombre).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  if (!body.Cif || !String(body.Cif).trim()) return res.status(400).json({ error: 'CIF es obligatorio' });
  const cifValue = normalizeCif(body.Cif);
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const dup = items.find(
      (item) => normalizeCif(item?.Cif) === cifValue && String(item.id_empresa ?? '') !== idEmpresa
    );
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const getCmd = new GetCommand({
      TableName: tableEmpresasName,
      Key: { id_empresa: idEmpresa },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') item[key] = idEmpresa;
      else if (key === 'Etiqueta') {
        item[key] = body[key] != null ? normalizarEtiqueta(body[key]) : normalizarEtiqueta(existing[key] ?? existing.Alias);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableEmpresasName,
      Item: item,
    }));
    res.json({ ok: true, empresa: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar la empresa' });
  }
});

app.delete('/api/empresas', async (req, res) => {
  const idEmpresa = req.body?.id_empresa != null ? String(req.body.id_empresa) : req.query?.id_empresa != null ? String(req.query.id_empresa) : '';
  if (!idEmpresa) return res.status(400).json({ error: 'id_empresa es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableEmpresasName,
      Key: { id_empresa: idEmpresa },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar la empresa' });
  }
});

// --- Almacenes (tabla igp_Almacenes) ---
app.get('/api/almacenes', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableAlmacenesName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    res.json({ almacenes: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar almacenes' });
  }
});

app.post('/api/almacenes', async (req, res) => {
  const body = req.body || {};
  if (!body.Nombre || !String(body.Nombre).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  try {
    const item = {};
    for (const key of TABLE_ALMACENES_ATTRS) {
      if (key === 'Id') {
        item[key] = body.Id != null ? formatId6(body.Id) : '000000';
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableAlmacenesName,
      Item: item,
    }));
    res.json({ ok: true, almacen: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el almacén' });
  }
});

app.put('/api/almacenes', async (req, res) => {
  const body = req.body || {};
  const idAlmacenes = body.Id != null ? String(body.Id) : '';
  if (!idAlmacenes) return res.status(400).json({ error: 'Id es obligatorio para editar' });
  if (!body.Nombre || !String(body.Nombre).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  try {
    const getCmd = new GetCommand({
      TableName: tableAlmacenesName,
      Key: { Id: idAlmacenes },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = {};
    for (const key of TABLE_ALMACENES_ATTRS) {
      if (key === 'Id') item[key] = idAlmacenes;
      else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableAlmacenesName,
      Item: item,
    }));
    res.json({ ok: true, almacen: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el almacén' });
  }
});

app.delete('/api/almacenes', async (req, res) => {
  const idAlmacenes = req.body?.Id != null ? String(req.body.Id) : req.query?.Id != null ? String(req.query.Id) : '';
  if (!idAlmacenes) return res.status(400).json({ error: 'Id es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableAlmacenesName,
      Key: { Id: idAlmacenes },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el almacén' });
  }
});

// --- Pedidos (tabla Igp_Pedidos) ---
app.get('/api/pedidos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tablePedidosName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    // Calcular TotalAlbaran como suma de TotalLinea del detalle de cada pedido
    const lineasItems = [];
    let lineasLastKey = null;
    do {
      const lineasResult = await docClient.send(new ScanCommand({
        TableName: tablePedidosLineasName,
        ...(lineasLastKey && { ExclusiveStartKey: lineasLastKey }),
      }));
      lineasItems.push(...(lineasResult.Items || []));
      lineasLastKey = lineasResult.LastEvaluatedKey || null;
    } while (lineasLastKey);

    const totalesPorPedido = {};
    for (const linea of lineasItems) {
      const pid = String(linea.PedidoId ?? '');
      if (!pid) continue;
      const totalLinea = Number(linea.TotalLinea ?? 0);
      totalesPorPedido[pid] = (totalesPorPedido[pid] ?? 0) + totalLinea;
    }

    for (const p of items) {
      const pid = String(p.Id ?? '');
      p.TotalAlbaran = totalesPorPedido[pid] ?? 0;
    }

    items.sort((a, b) => String(b.Fecha ?? b.Id ?? '').localeCompare(String(a.Fecha ?? a.Id ?? '')));
    res.json({ pedidos: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar pedidos' });
  }
});

app.post('/api/pedidos', async (req, res) => {
  const body = req.body || {};
  const id = body.Id != null ? String(body.Id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio' });
  try {
    const ahora = new Date().toISOString();
    const item = {
      Id: id,
      LocalId: String(body.LocalId ?? '').trim(),
      AlmacenOrigenId: String(body.AlmacenOrigenId ?? '').trim(),
      AlmacenDestinoId: String(body.AlmacenDestinoId ?? '').trim(),
      TotalAlbaran: typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran ?? 0)) || 0,
      Fecha: String(body.Fecha ?? '').trim(),
      Estado: String(body.Estado ?? 'Borrador').trim() || 'Borrador',
      CreadoEn: body.CreadoEn ?? ahora,
      CreadoPor: String(body.CreadoPor ?? '').trim(),
      Notas: String(body.Notas ?? '').trim(),
    };
    await docClient.send(new PutCommand({ TableName: tablePedidosName, Item: item }));
    res.json({ ok: true, pedido: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear pedido' });
  }
});

app.put('/api/pedidos', async (req, res) => {
  const body = req.body || {};
  const id = body.Id != null ? String(body.Id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para editar' });
  try {
    const got = await docClient.send(new GetCommand({ TableName: tablePedidosName, Key: { Id: id } }));
    const existing = got.Item || {};
    const item = {
      Id: id,
      LocalId: body.LocalId != null ? String(body.LocalId).trim() : String(existing.LocalId ?? ''),
      AlmacenOrigenId: body.AlmacenOrigenId != null ? String(body.AlmacenOrigenId).trim() : String(existing.AlmacenOrigenId ?? ''),
      AlmacenDestinoId: body.AlmacenDestinoId != null ? String(body.AlmacenDestinoId).trim() : String(existing.AlmacenDestinoId ?? ''),
      TotalAlbaran: body.TotalAlbaran != null ? (typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran)) || 0) : (existing.TotalAlbaran ?? 0),
      Fecha: body.Fecha != null ? String(body.Fecha).trim() : String(existing.Fecha ?? ''),
      Estado: body.Estado != null ? String(body.Estado).trim() : String(existing.Estado ?? 'Borrador'),
      CreadoEn: existing.CreadoEn,
      CreadoPor: existing.CreadoPor,
      Notas: body.Notas != null ? String(body.Notas).trim() : String(existing.Notas ?? ''),
    };
    await docClient.send(new PutCommand({ TableName: tablePedidosName, Item: item }));
    res.json({ ok: true, pedido: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar pedido' });
  }
});

app.delete('/api/pedidos', async (req, res) => {
  const id = req.body?.Id != null ? String(req.body.Id).trim() : req.query?.id != null ? String(req.query.id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({ TableName: tablePedidosName, Key: { Id: id } }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar pedido' });
  }
});

// --- Pedidos Lineas (tabla Igp_PedidosLineas) - productos por pedido ---
app.get('/api/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tablePedidosLineasName,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ lineas: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar líneas del pedido' });
  }
});

// --- Pedidos Details (alias, tabla Igp_PedidosLineas) ---
app.get('/api/pedidos/:pedidoId/details', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tablePedidosLineasName,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ details: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar detalles del pedido' });
  }
});

app.post('/api/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  const body = req.body || {};
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tablePedidosLineasName,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const existing = result.Items || [];
    const maxIdx = existing.reduce((m, i) => {
      const n = parseInt(String(i.LineaIndex ?? '-1'), 10);
      return Number.isNaN(n) ? m : Math.max(m, n);
    }, -1);
    const lineaIndex = String(maxIdx + 1);
    const cantidad = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad ?? 0)) || 0;
    const precioUnitario = typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario ?? 0)) || 0;
    const totalLinea = cantidad * precioUnitario;
    const vatRate = body.VatRate != null ? (typeof body.VatRate === 'number' ? body.VatRate : parseFloat(String(body.VatRate)) || 0) : undefined;
    const totalRappel = body.TotalRappel != null ? (typeof body.TotalRappel === 'number' ? body.TotalRappel : parseFloat(String(body.TotalRappel)) || 0) : undefined;
    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: String(body.ProductId ?? '').trim(),
      ProductoNombre: String(body.ProductoNombre ?? '').trim(),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      TotalLinea: totalLinea,
      Preparada: false,
      ...(vatRate != null && !Number.isNaN(vatRate) && { VatRate: vatRate }),
      ...(totalRappel != null && !Number.isNaN(totalRappel) && { TotalRappel: totalRappel }),
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : undefined,
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : undefined,
      Notas: body.Notas != null ? String(body.Notas).trim() : undefined,
    };
    await docClient.send(new PutCommand({ TableName: tablePedidosLineasName, Item: item }));
    res.json({ ok: true, linea: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear línea' });
  }
});

app.put('/api/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  const body = req.body || {};
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tablePedidosLineasName,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    const existing = got.Item || {};
    const cantidad = body.Cantidad != null ? (typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad)) || 0) : (existing.Cantidad ?? 0);
    const precioUnitario = body.PrecioUnitario != null ? (typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario)) || 0) : (existing.PrecioUnitario ?? 0);
    const totalLinea = cantidad * precioUnitario;
    const preparada = body.Preparada != null ? !!body.Preparada : !!(existing.Preparada ?? false);
    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: body.ProductId != null ? String(body.ProductId).trim() : String(existing.ProductId ?? ''),
      ProductoNombre: body.ProductoNombre != null ? String(body.ProductoNombre).trim() : String(existing.ProductoNombre ?? ''),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      TotalLinea: totalLinea,
      Preparada: preparada,
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : (existing.PurchaseUnitId ?? undefined),
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : (existing.PurchaseUnitName ?? undefined),
      Notas: body.Notas != null ? String(body.Notas).trim() : (existing.Notas ?? undefined),
    };
    await docClient.send(new PutCommand({ TableName: tablePedidosLineasName, Item: item }));
    res.json({ ok: true, linea: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar línea' });
  }
});

app.delete('/api/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : req.query?.lineaIndex != null ? String(req.query.lineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tablePedidosLineasName,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar línea' });
  }
});

// Sincronizar almacenes desde Ágora (export-master Warehouses) → igp_Almacenes
app.post('/api/agora/warehouses/sync', async (req, res) => {
  try {
    const rawList = await exportWarehouses();
    const list = Array.isArray(rawList) ? rawList : [];

    let added = 0;
    let updated = 0;

    for (const w of list) {
      const id = w.Id ?? w.id;
      if (id == null) continue;

      const idStr = formatId6(id);
      const nombre = String(w.Name ?? w.name ?? '').trim();
      const fiscalInfo = w.FiscalInfo ?? w.fiscalInfo ?? {};
      const descripcion = String(fiscalInfo.FiscalName ?? fiscalInfo.fiscalName ?? '').trim();
      const parts = [
        w.Street ?? w.street ?? '',
        w.City ?? w.city ?? '',
        w.Region ?? w.region ?? '',
        w.ZipCode ?? w.zipCode ?? '',
      ].filter(Boolean);
      const direccion = parts.join(', ');

      const item = {
        Id: idStr,
        Nombre: nombre || idStr,
        Descripcion: descripcion,
        Direccion: direccion,
      };

      const getCmd = new GetCommand({
        TableName: tableAlmacenesName,
        Key: { Id: idStr },
      });
      const got = await docClient.send(getCmd);
      const existed = !!got.Item;

      await docClient.send(new PutCommand({
        TableName: tableAlmacenesName,
        Item: item,
      }));

      if (existed) updated++;
      else added++;
    }

    res.json({
      ok: true,
      totalFetched: list.length,
      added,
      updated,
      totalUpserted: added + updated,
    });
  } catch (err) {
    console.error('[agora/warehouses/sync]', err.message || err);
    res.status(500).json({
      error: err.message || 'Error al sincronizar almacenes desde Ágora',
    });
  }
});

// --- Productos (tabla igp_Productos en AWS) ---
app.get('/api/productos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableProductosName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    res.json({ productos: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar productos' });
  }
});

app.post('/api/productos', async (req, res) => {
  const body = req.body || {};
  const nombreVal = body.Nombre ?? body.nombre ?? '';
  if (!String(nombreVal).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  try {
    const item = { id_producto: body.id_producto != null ? formatId6(body.id_producto) : formatId6(1) };
    for (const key of Object.keys(body)) {
      if (key === 'id_producto') continue;
      item[key] = body[key] != null && body[key] !== '' ? String(body[key]) : '';
    }
    await docClient.send(new PutCommand({
      TableName: tableProductosName,
      Item: item,
    }));
    res.json({ ok: true, producto: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el producto' });
  }
});

app.put('/api/productos', async (req, res) => {
  const body = req.body || {};
  const idProducto = body.id_producto != null ? String(body.id_producto) : '';
  if (!idProducto) return res.status(400).json({ error: 'id_producto es obligatorio para editar' });
  const nombreVal = body.Nombre ?? body.nombre ?? '';
  if (!String(nombreVal).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  try {
    const getCmd = new GetCommand({
      TableName: tableProductosName,
      Key: { id_producto: idProducto },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = { id_producto: idProducto };
    const allKeys = new Set([...Object.keys(existing), ...Object.keys(body)]);
    for (const key of allKeys) {
      if (key === 'id_producto') continue;
      if (body[key] !== undefined) {
        item[key] = body[key] != null && body[key] !== '' ? String(body[key]) : '';
      } else {
        item[key] = existing[key] != null ? String(existing[key]) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableProductosName,
      Item: item,
    }));
    res.json({ ok: true, producto: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el producto' });
  }
});

app.delete('/api/productos', async (req, res) => {
  const idProducto = req.body?.id_producto != null ? String(req.body.id_producto) : req.query?.id_producto != null ? String(req.query.id_producto) : '';
  if (!idProducto) return res.status(400).json({ error: 'id_producto es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableProductosName,
      Key: { id_producto: idProducto },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el producto' });
  }
});

// --- Gestión festivos y estimaciones (Igp_Gestionfestivosyestimaciones) ---
// Campos en DynamoDB: FechaComparativa, Festivo, NombreFestivo (PK, SK)
app.get('/api/gestion-festivos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tableGestionFestivosName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const registros = items
      .filter((i) => i.PK != null && i.SK != null)
      .map(({ PK, SK, ...rest }) => ({ id: `${PK}#${SK}`, PK, _pk: PK, _sk: SK, ...rest }))
      .sort((a, b) => String(a.FechaComparativa ?? a.Fecha ?? '').localeCompare(String(b.FechaComparativa ?? b.Fecha ?? '')));
    res.json({ registros });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return res.json({ registros: [], error: 'Tabla no existe. Ejecuta: node api/scripts/create-gestion-festivos-table.js' });
    }
    console.error('[gestion-festivos GET]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar' });
  }
});

app.post('/api/gestion-festivos', async (req, res) => {
  const body = req.body || {};
  const fechaComparativa = String(body.FechaComparativa ?? body.fechaComparativa ?? body.Fecha ?? body.fecha ?? '').trim();
  if (!fechaComparativa) {
    return res.status(400).json({ error: 'FechaComparativa obligatoria' });
  }
  try {
    const id = crypto.randomUUID();
    const festivo = body.Festivo === true || body.festivo === true || body.Festivo === 'true' || body.festivo === 'true';
    const item = {
      PK: 'GLOBAL',
      SK: id,
      FechaComparativa: fechaComparativa,
      Festivo: festivo,
      NombreFestivo: String(body.NombreFestivo ?? body.nombreFestivo ?? '').trim(),
    };
    await docClient.send(new PutCommand({
      TableName: tableGestionFestivosName,
      Item: item,
    }));
    res.json({ ok: true, registro: { id: `GLOBAL#${id}`, ...item } });
  } catch (err) {
    console.error('[gestion-festivos POST]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al crear' });
  }
});

app.put('/api/gestion-festivos', async (req, res) => {
  const body = req.body || {};
  const idRaw = String(body.id ?? body.ID ?? '').trim();
  if (!idRaw) return res.status(400).json({ error: 'id es obligatorio para editar' });
  const [pk, sk] = idRaw.includes('#') ? idRaw.split('#') : ['GLOBAL', idRaw];
  const fechaComparativa = String(body.FechaComparativa ?? body.fechaComparativa ?? body.Fecha ?? body.fecha ?? '').trim();
  if (!fechaComparativa) {
    return res.status(400).json({ error: 'FechaComparativa obligatoria' });
  }
  try {
    const festivo = body.Festivo === true || body.festivo === true || body.Festivo === 'true' || body.festivo === 'true';
    const item = {
      PK: pk,
      SK: sk,
      FechaComparativa: fechaComparativa,
      Festivo: festivo,
      NombreFestivo: String(body.NombreFestivo ?? body.nombreFestivo ?? '').trim(),
    };
    await docClient.send(new PutCommand({
      TableName: tableGestionFestivosName,
      Item: item,
    }));
    res.json({ ok: true, registro: { id: `${pk}#${sk}`, ...item } });
  } catch (err) {
    console.error('[gestion-festivos PUT]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al actualizar' });
  }
});

app.delete('/api/gestion-festivos', async (req, res) => {
  const idRaw = (req.query?.id ?? req.body?.id ?? '').toString().trim();
  if (!idRaw) return res.status(400).json({ error: 'id es obligatorio para borrar' });
  const [pk, sk] = idRaw.includes('#') ? idRaw.split('#') : ['GLOBAL', idRaw];
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableGestionFestivosName,
      Key: { PK: pk, SK: sk },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[gestion-festivos DELETE]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al borrar' });
  }
});

// POST /api/gestion-festivos/generar-rango - Crea registros por día en el rango (PK=fecha, SK=0)
app.post('/api/gestion-festivos/generar-rango', async (req, res) => {
  const body = req.body || {};
  const dateFrom = String(body.dateFrom ?? body.fechaDesde ?? body.fechaInicio ?? '').trim();
  const dateTo = String(body.dateTo ?? body.fechaHasta ?? body.fechaFin ?? '').trim();
  if (!dateFrom || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !dateTo || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo obligatorios (YYYY-MM-DD)' });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ error: 'dateFrom debe ser <= dateTo' });
  }
  try {
    let count = 0;
    const start = new Date(dateFrom + 'T12:00:00');
    const end = new Date(dateTo + 'T12:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const fecha = d.toISOString().slice(0, 10);
      const item = {
        PK: fecha,
        SK: '0',
        FechaComparativa: fecha,
        Festivo: false,
        NombreFestivo: '',
      };
      await docClient.send(new PutCommand({
        TableName: tableGestionFestivosName,
        Item: item,
      }));
      count++;
    }
    res.json({ ok: true, creados: count });
  } catch (err) {
    console.error('[gestion-festivos generar-rango]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al generar registros' });
  }
});

// Autocompletado de direcciones: Google Places (si hay key) + fallback Nominatim (OpenStreetMap)
const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || '';
const NOMINATIM_USER_AGENT = 'Tabolize-ERP/1.0';

async function fetchNominatimSuggestions(input) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(input)}&format=json&addressdetails=1&limit=5`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT },
  });
  const data = await resp.json();
  if (!Array.isArray(data)) return [];
  return data.map((r) => ({
    description: r.display_name || '',
    place_id: `nominatim:${r.osm_type || 'node'}:${r.osm_id || ''}`,
    lat: r.lat != null ? parseFloat(r.lat) : undefined,
    lng: r.lon != null ? parseFloat(r.lon) : undefined,
  }));
}

app.get('/api/places/autocomplete', async (req, res) => {
  const input = (req.query.input || '').toString().trim();
  if (!input || input.length < 2) {
    return res.json({ predictions: [] });
  }

  let predictions = [];
  let configOk = true;

  if (googleMapsKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${googleMapsKey}&language=es`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.status === 'OK' && Array.isArray(data.predictions) && data.predictions.length > 0) {
        predictions = (data.predictions || []).map((p) => ({
          description: p.description || '',
          place_id: p.place_id || '',
        }));
        return res.json({ predictions });
      }
    } catch (err) {
      console.error('Places autocomplete error:', err);
    }
  } else {
    configOk = false;
  }

  try {
    predictions = await fetchNominatimSuggestions(input);
  } catch (err) {
    console.error('Nominatim autocomplete error:', err);
  }

  res.json({ predictions, configOk: configOk ? undefined : false });
});

app.get('/api/places/details', async (req, res) => {
  const placeId = (req.query.place_id || '').toString().trim();
  if (!placeId || !googleMapsKey) {
    return res.json({ lat: null, lng: null });
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=geometry&key=${googleMapsKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const loc = data.result?.geometry?.location;
    if (!loc) return res.json({ lat: null, lng: null });
    res.json({ lat: loc.lat, lng: loc.lng });
  } catch (err) {
    console.error('Places details error:', err);
    res.json({ lat: null, lng: null });
  }
});

// Código postal → municipio y provincia (GeoAPI España o fallback Zippopotam)
const geoApiKey = process.env.GEOAPI_KEY || process.env.GEOAPI_ES_KEY || '';

function getGeoApiName(item) {
  if (!item || typeof item !== 'object') return '';
  return item.NM ?? item.NOMBRE ?? item.name ?? item.nombre ?? '';
}

async function fetchZippopotam(cp) {
  const url = `https://api.zippopotam.us/es/${encodeURIComponent(cp)}`;
  const resp = await fetch(url);
  if (!resp.ok) return { municipio: '', provincia: '' };
  const data = await resp.json();
  const places = data.places;
  if (!Array.isArray(places) || places.length === 0) return { municipio: '', provincia: '' };
  const first = places[0];
  const municipio = (first['place name'] ?? first.place_name ?? '').trim();
  const provincia = (first.state ?? '').trim();
  return { municipio, provincia };
}

app.get('/api/codigo-postal', async (req, res) => {
  const cp = (req.query.cp || '').toString().trim().replace(/\s/g, '');
  if (!cp || !/^\d{5}$/.test(cp)) {
    return res.json({ municipio: '', provincia: '' });
  }
  let municipio = '';
  let provincia = '';

  if (geoApiKey) {
    try {
      const [provResp, muniResp] = await Promise.all([
        fetch(`https://apiv1.geoapi.es/provincias/?CPOS=${encodeURIComponent(cp)}&FORMAT=json&KEY=${encodeURIComponent(geoApiKey)}`),
        fetch(`https://apiv1.geoapi.es/municipios/?CPOS=${encodeURIComponent(cp)}&FORMAT=json&KEY=${encodeURIComponent(geoApiKey)}`),
      ]);
      const provData = await provResp.json();
      const muniData = await muniResp.json();
      const provList = Array.isArray(provData) ? provData : (provData?.data ?? provData?.results ?? []);
      const muniList = Array.isArray(muniData) ? muniData : (muniData?.data ?? muniData?.results ?? []);
      provincia = getGeoApiName(provList[0]) || '';
      municipio = getGeoApiName(muniList[0]) || '';
    } catch (err) {
      console.error('Codigo postal GeoAPI error:', err);
    }
  }

  if (!municipio && !provincia) {
    try {
      const z = await fetchZippopotam(cp);
      municipio = z.municipio;
      provincia = z.provincia;
    } catch (err) {
      console.error('Codigo postal Zippopotam error:', err);
    }
  }

  res.json({ municipio, provincia });
});

// --- Verificación de conexión con la API de Agora (antes de crear tablas/sincronizar) ---
const AGORA_API_BASE_URL = process.env.AGORA_API_BASE_URL || '';
const AGORA_API_TOKEN = process.env.AGORA_API_TOKEN || '';

app.get('/api/agora/test-connection', async (req, res) => {
  const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (AGORA_API_TOKEN || '').trim();

  if (!baseUrl) {
    return res.status(400).json({
      ok: false,
      error: 'Falta AGORA_API_BASE_URL en .env.local (ej: http://192.168.1.100:8984)',
    });
  }
  if (!token) {
    return res.status(400).json({
      ok: false,
      error: 'Falta AGORA_API_TOKEN en .env.local',
    });
  }

  const url = `${baseUrl}/api/export/?limit=1`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Api-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (r.ok) {
      return res.json({ ok: true, message: 'Conexión con Agora correcta' });
    }
    if (r.status === 401) {
      return res.json({
        ok: false,
        error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.',
      });
    }
    const text = await r.text();
    return res.json({
      ok: false,
      error: `Agora respondió ${r.status}: ${text.slice(0, 200)}`,
    });
  } catch (err) {
    const msg = err.message || String(err);
    return res.json({
      ok: false,
      error: `No se pudo conectar con Agora: ${msg}. Comprueba URL y que el servidor esté accesible.`,
    });
  }
});

// Listar productos Ágora desde DynamoDB (Igp_AgoraProducts). Lectura rápida.
// Los datos se obtienen tras sincronizar con POST /api/agora/products/sync.
app.get('/api/agora/products', async (req, res) => {
  const forceAgora = (req.query.source || req.query.force || '').toString().toLowerCase() === 'agora';
  if (forceAgora) {
    const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
    const token = (AGORA_API_TOKEN || '').trim();
    if (!baseUrl || !token) {
      return res.status(400).json({
        error: 'Falta AGORA_API_BASE_URL o AGORA_API_TOKEN en .env.local',
      });
    }
    const url = `${baseUrl}/api/export-master/?DataType=Products`;
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers: { 'Api-Token': token, 'Content-Type': 'application/json' },
      });
      if (r.status === 401) {
        return res.status(401).json({ error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.' });
      }
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({ error: `Agora respondió ${r.status}: ${text.slice(0, 200)}` });
      }
      const data = await r.json().catch(() => null);
      const rawList = Array.isArray(data)
        ? data
        : (data?.productos ?? data?.Products ?? data?.Items ?? data?.data ?? []);
      // Enriquecer con maestros de familias e impuestos (fallback silencioso)
      const [fams, vts] = await Promise.all([
        exportFamilies().catch(() => []),
        exportVats().catch(() => []),
      ]);
      const fMap = new Map();
      for (const f of fams) { const id = f.Id ?? f.id; if (id != null) fMap.set(String(id), f.Name ?? f.name ?? ''); }
      const vMap = new Map();
      for (const v of vts) { const id = v.Id ?? v.id; if (id != null) { const rate = v.VatRate ?? v.vatRate ?? 0; vMap.set(String(id), { name: v.Name ?? v.name ?? '', percent: typeof rate === 'number' ? Math.round(rate * 10000) / 100 : 0 }); } }
      const productos = rawList.map((p) => {
        const fid = p.FamilyId ?? p.familyId;
        if (fid != null && fMap.has(String(fid))) p.FamilyName = fMap.get(String(fid));
        const vid = p.VatId ?? p.vatId;
        if (vid != null && vMap.has(String(vid))) { const vat = vMap.get(String(vid)); p.VatName = vat.name; p.VatPercent = vat.percent; }
        const picked = pickAllowedFields(p);
        picked.Id = p.Id ?? p.id ?? p.Code ?? p.code ?? picked.Id;
        picked.IGP = false;
        return picked;
      });
      return res.json({ productos });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Error al conectar con Agora.' });
    }
  }

  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAgoraProductsName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'GLOBAL' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    const onlyIgp = (req.query.igp || req.query.IGP || '').toString() === '1' || (req.query.igp || '').toString().toLowerCase() === 'true';
    let productos = items
      .filter((i) => i.PK !== undefined && i.SK !== undefined && i.SK !== '__meta__')
      .map((item) => toApiProduct(item));
    if (onlyIgp) productos = productos.filter((p) => p.IGP === true);
    productos = productos.sort((a, b) => {
        const idA = a.Id ?? a.id ?? a.Code ?? a.code ?? 0;
        const idB = b.Id ?? b.id ?? b.Code ?? b.code ?? 0;
        const na = typeof idA === 'number' ? idA : parseInt(String(idA).replace(/^0+/, ''), 10) || 0;
        const nb = typeof idB === 'number' ? idB : parseInt(String(idB).replace(/^0+/, ''), 10) || 0;
        return na - nb;
      });

    return res.json({ productos });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return res.json({ productos: [], error: 'Tabla Igp_AgoraProducts no existe. Ejecuta sync o crea la tabla.' });
    }
    console.error('[agora/products list]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar productos Ágora' });
  }
});

// Sincronizar productos Ágora → DynamoDB. Solo escribe registros nuevos o actualizados.
// Solo llama al API de Ágora si han pasado AGORA_PRODUCTS_SYNC_THROTTLE_MINUTES (default 30)
// o si se pasa ?force=1 para forzar.
app.post('/api/agora/products/sync', async (req, res) => {
  const force = (req.query.force || req.body?.force || '').toString() === '1' || (req.query.force || '').toString().toLowerCase() === 'true';
  const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (AGORA_API_TOKEN || '').trim();

  if (!baseUrl) {
    return res.status(400).json({ error: 'Falta AGORA_API_BASE_URL en .env.local' });
  }
  if (!token) {
    return res.status(400).json({ error: 'Falta AGORA_API_TOKEN en .env.local' });
  }

  try {
    if (!force) {
      const lastSync = await getLastSync(docClient, tableAgoraProductsName);
      if (shouldSkipSyncByThrottle(lastSync)) {
        return res.json({
          ok: true,
          skipped: true,
          reason: 'recent',
          message: 'Sincronización reciente. Usa ?force=1 para forzar.',
        });
      }
    }

    const url = `${baseUrl}/api/export-master/?DataType=Products`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Api-Token': token, 'Content-Type': 'application/json' },
    });

    if (r.status === 401) {
      return res.status(401).json({ error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.' });
    }
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: `Agora respondió ${r.status}: ${text.slice(0, 200)}` });
    }

    const data = await r.json().catch(() => ({}));
    const rawList = Array.isArray(data)
      ? data
      : (data.productos ?? data.Products ?? data.Items ?? data.data ?? []);

    // Cargar maestros de familias e impuestos en paralelo (fallback silencioso)
    const [familiesRaw, vatsRaw] = await Promise.all([
      exportFamilies().catch(() => []),
      exportVats().catch(() => []),
    ]);
    const familyMap = new Map();
    for (const f of familiesRaw) {
      const id = f.Id ?? f.id;
      if (id != null) familyMap.set(String(id), f.Name ?? f.name ?? '');
    }
    const vatMap = new Map();
    for (const v of vatsRaw) {
      const id = v.Id ?? v.id;
      if (id != null) {
        const rate = v.VatRate ?? v.vatRate ?? 0;
        vatMap.set(String(id), {
          name: v.Name ?? v.name ?? '',
          percent: typeof rate === 'number' ? Math.round(rate * 10000) / 100 : 0,
        });
      }
    }
    // Enriquecer productos con nombres de familia e impuesto
    for (const p of rawList) {
      const fid = p.FamilyId ?? p.familyId;
      if (fid != null && familyMap.has(String(fid))) p.FamilyName = familyMap.get(String(fid));
      const vid = p.VatId ?? p.vatId;
      if (vid != null && vatMap.has(String(vid))) {
        const vat = vatMap.get(String(vid));
        p.VatName = vat.name;
        p.VatPercent = vat.percent;
      }
    }

    const { added, updated, unchanged } = await syncProducts(docClient, tableAgoraProductsName, rawList);

    await setLastSync(docClient, tableAgoraProductsName);

    return res.json({
      ok: true,
      fetched: rawList.length,
      added,
      updated,
      unchanged,
    });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return res.status(404).json({
        error: 'Tabla Igp_AgoraProducts no existe. Ejecuta: node api/scripts/create-agora-products-table.js',
      });
    }
    console.error('[agora/products/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar productos Ágora' });
  }
});

// Actualizar producto Ágora en DynamoDB. Campos editables: IGP, Name, CostPrice, BaseSaleFormatId, FamilyId, VatId.
app.patch('/api/agora/products/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  if (id == null || id === '') {
    return res.status(400).json({ error: 'Falta id en la URL' });
  }
  const sk = String(id);
  const EDITABLE_FIELDS = ['IGP', 'Name', 'CostPrice', 'BaseSaleFormatId', 'FamilyId', 'VatId'];
  const updates = {};
  const removes = [];
  for (const key of EDITABLE_FIELDS) {
    const val = body[key] ?? body[key.toLowerCase()];
    if (val === undefined) continue;
    if (key === 'IGP') {
      if (typeof val !== 'boolean') continue;
      updates.IGP = val;
    } else if (key === 'Name') {
      updates.Name = String(val ?? '').trim();
    } else if (key === 'CostPrice') {
      const n = parseFloat(String(val).replace(',', '.'));
      updates.CostPrice = Number.isNaN(n) ? 0 : n;
    } else if (['BaseSaleFormatId', 'FamilyId', 'VatId'].includes(key)) {
      const v = val != null ? String(val).trim() : '';
      if (v) updates[key] = v;
      else removes.push(key);
    }
  }
  if (Object.keys(updates).length === 0 && removes.length === 0) {
    return res.status(400).json({ error: 'Indica al menos un campo a actualizar (IGP, Name, CostPrice, BaseSaleFormatId, FamilyId, VatId)' });
  }
  try {
    const exprNames = {};
    const exprValues = {};
    const setParts = [];
    let vi = 0;
    for (const [k, v] of Object.entries(updates)) {
      exprNames[`#${k}`] = k;
      exprValues[`:v${vi}`] = v;
      setParts.push(`#${k} = :v${vi}`);
      vi++;
    }
    const removeParts = removes.map((k) => {
      exprNames[`#${k}`] = k;
      return `#${k}`;
    });
    let updateExpr = '';
    if (setParts.length) updateExpr += 'SET ' + setParts.join(', ');
    if (removeParts.length) updateExpr += (updateExpr ? ' REMOVE ' : 'REMOVE ') + removeParts.join(', ');
    const updateParams = {
      TableName: tableAgoraProductsName,
      Key: { PK: 'GLOBAL', SK: sk },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
    };
    if (Object.keys(exprValues).length) updateParams.ExpressionAttributeValues = exprValues;
    await docClient.send(new UpdateCommand(updateParams));
    return res.json({ ok: true, id: sk, ...updates });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    console.error('[agora/products PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar producto' });
  }
});

// Listar puntos de venta guardados en DynamoDB (Igp_SaleCenters). PK=GLOBAL. Datos de WorkplacesSummary.
app.get('/api/agora/sale-centers', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableSaleCentersName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'GLOBAL' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => String(a.SK ?? '').localeCompare(String(b.SK ?? '')));
    const saleCenters = items.map((i) => ({
      Id: i.Id,
      Nombre: i.Nombre,
      Tipo: i.Tipo,
      Local: i.Local,
      Grupo: i.Grupo,
      Activo: i.Activo !== false,
    }));
    res.json({ saleCenters });
  } catch (err) {
    console.error('[agora/sale-centers list]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar puntos de venta' });
  }
});

// Actualizar Activo de un punto de venta.
app.patch('/api/agora/sale-centers', async (req, res) => {
  const { id, Activo } = req.body || {};
  if (id == null) {
    return res.status(400).json({ error: 'Falta id en el body' });
  }
  if (typeof Activo !== 'boolean') {
    return res.status(400).json({ error: 'Activo debe ser true o false' });
  }
  const sk = String(id);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableSaleCentersName,
        Key: { PK: 'GLOBAL', SK: sk },
        UpdateExpression: 'SET Activo = :activo',
        ExpressionAttributeValues: { ':activo': Activo },
        ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
      })
    );
    return res.json({ ok: true, id, Activo });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: `Punto de venta con id ${id} no encontrado` });
    }
    console.error('[agora/sale-centers PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar punto de venta' });
  }
});

app.post('/api/agora/sale-centers/sync', async (req, res) => {
  const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (AGORA_API_TOKEN || '').trim();

  if (!baseUrl) {
    return res.status(400).json({ error: 'Falta AGORA_API_BASE_URL en .env.local' });
  }
  if (!token) {
    return res.status(400).json({ error: 'Falta AGORA_API_TOKEN en .env.local' });
  }

  const url = `${baseUrl}/api/export-master/?filter=WorkplacesSummary`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Api-Token': token, 'Content-Type': 'application/json' },
    });

    if (r.status === 401) {
      return res.status(401).json({ error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.' });
    }
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: `Agora respondió ${r.status}: ${text.slice(0, 200)}` });
    }

    const rawText = await r.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'Agora no devolvió JSON. Revisa el formato del API (export-master WorkplacesSummary).' });
    }

    const summary = data.WorkplacesSummary ?? data.workplacesSummary ?? (Array.isArray(data) ? data : []);
    const rawList = Array.isArray(summary) ? summary : [];

    const items = [];
    for (const workplace of rawList) {
      const localName = String(workplace.Name ?? workplace.name ?? '').trim();
      const posGroups = workplace.PosGroups ?? workplace.posGroups ?? [];
      const groups = Array.isArray(posGroups) ? posGroups : [];
      for (const posGroup of groups) {
        const grupoName = String(posGroup.Name ?? posGroup.name ?? '').trim();
        const grupoNameLower = grupoName.toLowerCase();
        const tipo = grupoNameLower.includes('comandera') ? 'COMANDERA' : 'TPV';
        const pointsOfSale = posGroup.PointsOfSale ?? posGroup.pointsOfSale ?? [];
        const posList = Array.isArray(pointsOfSale) ? pointsOfSale : [];
        for (const pos of posList) {
          const id = pos.Id ?? pos.id;
          if (id == null) continue;
          const sk = String(id);
          items.push({
            PK: 'GLOBAL',
            SK: sk,
            Id: id,
            Nombre: String(pos.Name ?? pos.name ?? '').trim(),
            Tipo: tipo,
            Local: localName,
            Grupo: grupoName,
          });
        }
      }
    }

    let upserted = 0;
    for (const it of items) {
      await docClient.send(
        new UpdateCommand({
          TableName: tableSaleCentersName,
          Key: { PK: 'GLOBAL', SK: it.SK },
          UpdateExpression: 'SET Id = :id, Nombre = :nombre, Tipo = :tipo, #loc = :local, Grupo = :grupo, Activo = if_not_exists(Activo, :true)',
          ExpressionAttributeNames: { '#loc': 'Local' },
          ExpressionAttributeValues: {
            ':id': it.Id,
            ':nombre': it.Nombre,
            ':tipo': it.Tipo,
            ':local': it.Local,
            ':grupo': it.Grupo,
            ':true': true,
          },
        })
      );
      upserted++;
    }
    return res.json({ ok: true, fetched: items.length, upserted });
  } catch (err) {
    console.error('[agora/sale-centers/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar puntos de venta' });
  }
});

// --- Cierres de ventas (Ágora → Igp_SalesCloseouts) ---
const AGORA_PAYMENT_METHOD_ID = {
  1: 'Efectivo', 2: 'Tarjeta', 4: 'Pendiente de cobro', 5: 'Prepago Transferencia', 7: 'AgoraPay',
};
const STRING_KEY_TO_CANONICAL = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', card: 'Tarjeta',
  'pendiente de cobro': 'Pendiente de cobro', pending: 'Pendiente de cobro',
  'prepago transferencia': 'Prepago Transferencia', transferencia: 'Prepago Transferencia',
  agorapay: 'AgoraPay', 'agora pay': 'AgoraPay',
};
const CANONICAL_PAYMENT_NAMES = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];

function findValue(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  const keyList = Array.isArray(keys) ? keys : [keys];
  const lower = (k) => String(k).toLowerCase();
  for (const key of keyList) {
    const v = obj[key];
    if (v != null && v !== '') return v;
    const found = Object.keys(obj || {}).find((k) => lower(k) === lower(key));
    if (found && obj[found] != null && obj[found] !== '') return obj[found];
  }
  for (const val of Object.values(obj || {})) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const v = findValue(val, keyList, depth + 1);
      if (v != null && v !== '') return v;
    }
  }
  return null;
}

function getMappableRaw(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let out = { ...raw };
  const toMerge = [raw?.CloseOut ?? raw?.closeOut, raw?.Data ?? raw?.data, raw?.Record ?? raw?.record].filter((x) => x != null && typeof x === 'object' && !Array.isArray(x));
  for (const obj of toMerge) {
    out = { ...out, ...obj };
    const inner = obj?.CloseOut ?? obj?.closeOut ?? obj?.Data ?? obj?.data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) out = { ...out, ...inner };
  }
  return out;
}

function extractAmountsAndPayments(raw) {
  const r = getMappableRaw(raw);
  const amounts = r?.Amounts ?? r?.amounts ?? r?.Totals ?? r?.totals ?? {};
  const totalsByMethod = r?.TotalsByMethod ?? r?.totalsByMethod ?? r?.PaymentsByMethod ?? r?.paymentsByMethod ?? amounts?.TotalsByMethod;
  let gross = findValue(amounts, ['GrossAmount', 'grossAmount', 'Total', 'total', 'Importe', 'importe', 'Ventas', 'ventas', 'Sales', 'sales'])
    ?? findValue(r, ['GrossAmount', 'grossAmount', 'Total', 'total', 'Ventas', 'ventas']);
  const net = findValue(amounts, ['NetAmount', 'netAmount']) ?? null;
  const vat = findValue(amounts, ['VatAmount', 'vatAmount']) ?? null;
  const surcharge = findValue(amounts, ['SurchargeAmount', 'surchargeAmount']) ?? null;

  if ((gross == null || gross === 0) && totalsByMethod && typeof totalsByMethod === 'object' && !Array.isArray(totalsByMethod)) {
    const sumFromTotals = Object.values(totalsByMethod).reduce((s, v) => {
      const n = typeof v === 'number' ? v : parseFloat(String(v || 0).replace(',', '.')) || 0;
      return s + n;
    }, 0);
    if (sumFromTotals > 0) gross = sumFromTotals;
  }
  const balances = r?.Balances ?? r?.balances ?? [];
  if ((gross == null || gross === 0) && Array.isArray(balances) && balances.length > 1) {
    const sumBalances = balances.reduce((s, b) => s + (Number(b?.ActualEndAmount ?? b?.actualEndAmount ?? b?.ExpectedEndAmount ?? 0) || 0), 0);
    if (sumBalances > 0) gross = sumBalances;
  }

  const toPayment = (b) => {
    const id = b?.PaymentMethodId ?? b?.paymentMethodId ?? b?.Id ?? b?.id;
    const name = findValue(b, ['MethodName', 'methodName', 'Name', 'name'])
      ?? (id != null ? (AGORA_PAYMENT_METHOD_ID[id] ?? AGORA_PAYMENT_METHOD_ID[String(id)] ?? `Método ${id}`) : null);
    const amt = b?.ActualEndAmount ?? b?.actualEndAmount ?? b?.ExpectedEndAmount ?? b?.expectedEndAmount ?? b?.Amount ?? b?.amount ?? 0;
    return { MethodName: name, Amount: typeof amt === 'number' ? amt : parseFloat(String(amt).replace(',', '.')) || 0 };
  };

  const resolveMethodName = (keyOrId) => {
    if (keyOrId == null) return null;
    const str = String(keyOrId).trim();
    if (/^\d+$/.test(str)) {
      const id = parseInt(str, 10);
      return AGORA_PAYMENT_METHOD_ID[id] ?? AGORA_PAYMENT_METHOD_ID[String(id)] ?? null;
    }
    return (STRING_KEY_TO_CANONICAL[str.toLowerCase()] ?? str) || null;
  };

  let allPayments = [];
  if (totalsByMethod && typeof totalsByMethod === 'object' && !Array.isArray(totalsByMethod)) {
    for (const [key, val] of Object.entries(totalsByMethod)) {
      if (val == null || (typeof val !== 'number' && String(val).trim() === '')) continue;
      const name = resolveMethodName(key);
      const amt = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.')) || 0;
      if (name && amt >= 0) allPayments.push({ MethodName: name, Amount: amt });
    }
  }
  const baseArrays = [
    r?.InvoicePayments ?? r?.invoicePayments,
    r?.TicketPayments ?? r?.ticketPayments ?? r?.TicketPayment ?? r?.ticketPayment,
    r?.DeliveryNotePayments ?? r?.deliveryNotePayments,
    r?.SalesOrderPayments ?? r?.salesOrderPayments,
    r?.Payments ?? r?.payments,
    r?.PaymentMethods ?? r?.paymentMethods,
    r?.FormasPago ?? r?.formasPago,
    balances.length > 1 ? balances : [],
  ].filter(Array.isArray);
  for (const arr of baseArrays) {
    for (const p of arr) {
      if (p?.PaymentMethodId != null || p?.paymentMethodId != null || p?.Id != null || p?.id != null) allPayments.push(toPayment(p));
      else {
        const name = findValue(p, ['MethodName', 'methodName', 'Name', 'name']);
        const amt = findValue(p, ['Amount', 'amount', 'Value', 'value', 'ActualEndAmount', 'actualEndAmount']) ?? 0;
        if (name != null || amt != null) allPayments.push({ MethodName: name ?? 'Sin nombre', Amount: typeof amt === 'number' ? amt : parseFloat(String(amt).replace(',', '.')) || 0 });
      }
    }
  }

  const byMethod = new Map();
  for (const p of allPayments) {
    const name = (p.MethodName ?? 'Sin nombre').toString().trim() || 'Sin nombre';
    const amt = typeof p.Amount === 'number' ? p.Amount : parseFloat(String(p.Amount || 0).replace(',', '.')) || 0;
    const prev = byMethod.get(name) ?? 0;
    byMethod.set(name, prev + amt);
  }
  allPayments = [...byMethod.entries()].map(([name, amt]) => ({ MethodName: name === 'Sin nombre' ? null : name, Amount: amt })).filter((p) => p.MethodName != null || p.Amount != null);

  if (allPayments.length > 0) {
    const byName = new Map(allPayments.map((p) => [String(p.MethodName || '').trim(), p.Amount]).filter(([n]) => n));
    const extras = [...byName.entries()].filter(([n]) => !CANONICAL_PAYMENT_NAMES.includes(n));
    allPayments = [
      ...CANONICAL_PAYMENT_NAMES.map((name) => ({ MethodName: name, Amount: byName.get(name) ?? 0 })),
      ...extras.map(([name, amt]) => ({ MethodName: name, Amount: amt })),
    ];
    if ((gross == null || gross === 0)) {
      const sumPayments = allPayments.reduce((s, p) => s + (Number(p?.Amount ?? 0) || 0), 0);
      if (sumPayments > 0) gross = sumPayments;
    }
  }

  return {
    Amounts: { GrossAmount: gross, NetAmount: net, VatAmount: vat, SurchargeAmount: surcharge },
    InvoicePayments: allPayments,
  };
}

function extractPosFromRaw(raw) {
  const r = getMappableRaw(raw);
  const posId = findValue(r, ['PosId', 'posId', 'PointOfSaleId', 'pointOfSaleId']) ?? r?.Pos?.Id ?? r?.PointOfSale?.Id ?? r?.PointsOfSale?.[0]?.Id ?? null;
  const posName = findValue(r, ['PosName', 'posName', 'PointOfSaleName', 'pointOfSaleName']) ?? r?.Pos?.Name ?? r?.PointOfSale?.Name ?? r?.PointsOfSale?.[0]?.Name ?? null;
  return { posId, posName };
}

function extractCloseOutNumber(raw) {
  const r = getMappableRaw(raw);
  let v = findValue(r, ['CloseOutNumber', 'closeOutNumber', 'Number', 'number', 'Numero', 'numero', 'Id', 'id', 'CloseOutId', 'CloseOutNo', 'Sequence']);
  if (v != null && v !== '') return v;
  const docs = r?.Documents ?? r?.documents ?? [];
  if (Array.isArray(docs) && docs.length > 0) {
    const d = docs[0];
    v = findValue(d, ['LastNumber', 'lastNumber', 'UltimoNumero']) ?? findValue(d, ['FirstNumber', 'firstNumber']) ?? findValue(d, ['Number', 'number']);
    if (v != null && v !== '') return v;
  }
  return null;
}

function extractCloseOutsArray(data, keys) {
  if (!data) return [];
  const unwrap = (d) => d?.Data ?? d?.data ?? d?.Result ?? d?.result ?? d?.Export ?? d?.export ?? d;
  let cur = unwrap(data);
  const k = Array.isArray(keys) ? keys : [keys];
  for (const key of k) {
    const v = cur?.[key];
    if (Array.isArray(v)) return v;
    if (v?.Items) return v.Items;
    if (v?.items) return v.items;
  }
  if (Array.isArray(cur)) return cur;
  return [];
}

/**
 * Agrega facturas por WorkplaceId + PosId para obtener Ventas/Efectivo/Tarjeta por TPV.
 * Devuelve array de objetos compatibles con mapCloseOutToItem.
 */
function aggregateInvoicesByWorkplaceAndPos(invoices, businessDay) {
  if (!Array.isArray(invoices) || invoices.length === 0) return [];
  const groups = new Map(); // key: "workplaceId|posId"
  const CANONICAL_NAMES = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];

  for (const inv of invoices) {
    const workplaceId = String(inv?.Workplace?.Id ?? inv?.workplace?.id ?? inv?.WorkplaceId ?? inv?.workplaceId ?? '').trim() || '0';
    const posId = inv?.Pos?.Id ?? inv?.pos?.id ?? inv?.PosId ?? inv?.posId ?? null;
    const posName = inv?.Pos?.Name ?? inv?.pos?.name ?? inv?.PosName ?? inv?.posName ?? null;
    const workplaceName = inv?.Workplace?.Name ?? inv?.workplace?.name ?? inv?.WorkplaceName ?? inv?.workplaceName ?? null;
    const bd = String(inv?.BusinessDay ?? inv?.businessDay ?? businessDay ?? '').trim() || businessDay;

    const key = `${workplaceId}|${posId ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        WorkplaceId: workplaceId,
        WorkplaceName: workplaceName,
        PosId: posId,
        PosName: posName,
        BusinessDay: bd,
        Amounts: { GrossAmount: 0 },
        InvoicePayments: Object.fromEntries(CANONICAL_NAMES.map((n) => [n, 0])),
      });
    }
    const g = groups.get(key);
    if (!g.PosName && posName) g.PosName = posName;
    if (!g.WorkplaceName && workplaceName) g.WorkplaceName = workplaceName;

    const totals = inv?.Totals ?? inv?.totals ?? {};
    const gross = totals?.GrossAmount ?? totals?.grossAmount ?? 0;
    g.Amounts.GrossAmount += typeof gross === 'number' ? gross : parseFloat(String(gross).replace(',', '.')) || 0;

    const payments = inv?.Payments ?? inv?.payments ?? [];
    for (const p of payments) {
      const name = (p?.MethodName ?? p?.methodName ?? p?.Name ?? p?.name ?? '').toString().trim();
      const amt = typeof p?.Amount === 'number' ? p.Amount : parseFloat(String(p?.Amount ?? p?.amount ?? 0).replace(',', '.')) || 0;
      if (name) {
        const canon = CANONICAL_NAMES.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
        g.InvoicePayments[canon] = (g.InvoicePayments[canon] ?? 0) + amt;
      }
    }
  }

  return [...groups.values()].map((g) => {
    const payments = [
      ...CANONICAL_NAMES.filter((n) => (g.InvoicePayments[n] ?? 0) > 0).map((n) => ({ MethodName: n, Amount: g.InvoicePayments[n] })),
      ...Object.entries(g.InvoicePayments).filter(([n]) => !CANONICAL_NAMES.includes(n) && (g.InvoicePayments[n] ?? 0) > 0).map(([n, a]) => ({ MethodName: n, Amount: a })),
    ];
    return { ...g, InvoicePayments: payments };
  }).filter((g) => g.Amounts.GrossAmount > 0 || g.InvoicePayments.some((p) => (p?.Amount ?? 0) > 0));
}

function getGrossFromRaw(r) {
  const raw = getMappableRaw(r);
  const amounts = raw?.Amounts ?? raw?.amounts ?? raw?.Totals ?? raw?.totals ?? {};
  let gross = findValue(amounts, ['GrossAmount', 'grossAmount', 'Total', 'total'])
    ?? raw?.ActualEndAmount ?? raw?.actualEndAmount ?? raw?.ExpectedEndAmount ?? 0;
  const balances = raw?.Balances ?? raw?.balances ?? [];
  if ((gross == null || gross === 0) && Array.isArray(balances) && balances.length > 0) {
    gross = balances.reduce((s, b) => s + (Number(b?.ActualEndAmount ?? b?.actualEndAmount ?? b?.ExpectedEndAmount ?? 0) || 0), 0);
  }
  return typeof gross === 'number' ? gross : parseFloat(String(gross || 0).replace(',', '.')) || 0;
}

function buildPaymentSourceByRecord(rawList, sysByWorkplace, usePos) {
  const map = new Map();
  if (!usePos || sysByWorkplace.size === 0) {
    for (let i = 0; i < rawList.length; i++) {
      const r = rawList[i];
      const pk = String(r?.WorkplaceId ?? r?.workplaceId ?? '').trim() || '0';
      const sys = sysByWorkplace.get(pk);
      if (sys) map.set(r, sys);
    }
    return map;
  }
  const byWorkplace = new Map();
  for (const r of rawList) {
    const pk = String(r?.WorkplaceId ?? r?.workplaceId ?? '').trim() || '0';
    if (!byWorkplace.has(pk)) byWorkplace.set(pk, []);
    byWorkplace.get(pk).push(r);
  }
  for (const [pk, records] of byWorkplace) {
    const sys = sysByWorkplace.get(pk);
    if (!sys || !Array.isArray(sys?.InvoicePayments ?? sys?.invoicePayments)) continue;
    const sysPayments = sys.InvoicePayments ?? sys.invoicePayments;
    const totalGross = records.reduce((s, r) => s + getGrossFromRaw(r), 0);
    const n = records.length;
    for (const r of records) {
      const recordGross = getGrossFromRaw(r);
      if (recordGross === 0) continue;
      const ratio = totalGross > 0 ? recordGross / totalGross : 1 / n;
      const scaledPayments = sysPayments.map((p) => ({
        MethodName: p?.MethodName ?? p?.methodName,
        Amount: ((typeof p?.Amount === 'number' ? p.Amount : parseFloat(String(p?.Amount || 0).replace(',', '.')) || 0) * ratio),
      }));
      map.set(r, { InvoicePayments: scaledPayments });
    }
  }
  return map;
}

function mapCloseOutToItem(raw, businessDayOverride = '', paymentSource = null) {
  const r = getMappableRaw(raw);
  let workplaceId = String(findValue(r, ['WorkplaceId', 'workplaceId', 'WokrplaceId', 'LocalId', 'localId', 'Workplace', 'workplace']) ?? r?.WorkplaceId ?? r?.Workplace?.Id ?? '') || '0';
  if (!workplaceId.trim()) workplaceId = '0';
  const workplaceName = findValue(r, ['WorkplaceName', 'workplaceName', 'LocalName', 'localName'])
    ?? r?.Workplace?.Name ?? r?.Workplace?.name ?? null;
  const businessDay = String(findValue(r, ['BusinessDay', 'businessDay', 'Fecha', 'fecha', 'Date', 'date']) ?? r?.BusinessDay ?? businessDayOverride ?? '') || businessDayOverride || '';
  let number = extractCloseOutNumber(raw) ?? findValue(r, ['Number', 'number', 'CloseOutNumber', 'Numero', 'Id']) ?? '';
  if (number == null || number === '') number = '';
  const numStr = number != null && String(number).trim() !== '' ? String(number) : '0';
  const { posId: posIdVal, posName } = extractPosFromRaw(r);
  const posIdStr = posIdVal != null && posIdVal !== '' ? String(posIdVal) : '0';
  const bd = businessDay || businessDayOverride;
  const sk = bd ? (posIdStr !== '0' ? `${bd}#${posIdStr}#${numStr}` : `${bd}#${numStr}`) : '';
  const extracted = extractAmountsAndPayments(raw);
  const fromSource = paymentSource ? extractAmountsAndPayments(paymentSource) : null;
  const amountsObj = extracted.Amounts;
  const gross = typeof amountsObj?.GrossAmount === 'number' ? amountsObj.GrossAmount : parseFloat(String(amountsObj?.GrossAmount ?? amountsObj?.grossAmount ?? 0).replace(',', '.')) || 0;
  const sumExtracted = (extracted.InvoicePayments ?? []).reduce((s, p) => s + (typeof p?.Amount === 'number' ? p.Amount : parseFloat(String(p?.Amount ?? 0).replace(',', '.')) || 0), 0);
  const posPaymentsReasonable = (extracted.InvoicePayments?.length ?? 0) > 0 && gross > 0 && Math.abs(sumExtracted - gross) <= Math.max(0.01, gross * 0.02);
  const allPayments = posPaymentsReasonable ? extracted.InvoicePayments : (fromSource?.InvoicePayments?.length > 0 ? fromSource.InvoicePayments : extracted.InvoicePayments);
  const documents = Array.isArray(r?.Documents) ? r.Documents : (Array.isArray(r?.documents) ? r.documents : []);
  const openDate = findValue(r, ['OpenDate', 'openDate', 'FechaApertura']) ?? r?.OpenDate ?? null;
  const closeDate = findValue(r, ['CloseDate', 'closeDate', 'FechaCierre']) ?? r?.CloseDate ?? null;
  const now = new Date().toISOString();
  return {
    PK: workplaceId,
    SK: sk,
    Number: number,
    BusinessDay: bd,
    OpenDate: openDate,
    CloseDate: closeDate,
    WorkplaceId: workplaceId,
    WorkplaceName: workplaceName,
    PosId: posIdVal,
    PosName: posName,
    Amounts: amountsObj,
    Documents: documents.map((d) => ({
      Serie: findValue(d, ['Serie', 'serie']) ?? null,
      FirstNumber: findValue(d, ['FirstNumber', 'firstNumber']) ?? null,
      LastNumber: findValue(d, ['LastNumber', 'lastNumber']) ?? null,
      Count: findValue(d, ['Count', 'count']) ?? null,
      Amount: findValue(d, ['Amount', 'amount']) ?? null,
    })),
    InvoicePayments: allPayments,
    TicketPayments: [],
    DeliveryNotePayments: [],
    SalesOrderPayments: [],
    createdAt: now,
    updatedAt: now,
    source: 'agora',
  };
}

function mapPosCloseOutToItem(raw, businessDayOverride = '') {
  return mapCloseOutToItem(raw, businessDayOverride);
}

function extractNumberFromSk(sk) {
  if (!sk || typeof sk !== 'string') return '';
  const parts = String(sk).trim().split('#');
  return parts.length >= 2 ? parts[parts.length - 1] : '';
}

/** Formato dd/mm/yyyy para Fecha Negocio (estructura Excel Ágora). */
function formatFechaNegocio(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const parts = String(iso).trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

/** Añade campos estilo Excel Ágora (TPV, FechaNegocio, Ventas, Efectivo, Tarjeta, etc.). */
function addExcelStyleFields(item) {
  if (!item || typeof item !== 'object') return item;
  const ensureArray = (arr) => (Array.isArray(arr) ? arr : []);
  const payments = ensureArray(item.InvoicePayments ?? item.invoicePayments);
  const amounts = item.Amounts ?? item.amounts ?? {};
  const gross = amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total;
  const sumPayments = payments.reduce((s, p) => s + (Number(p?.Amount ?? p?.amount ?? 0) || 0), 0);
  const ventas = gross != null ? (typeof gross === 'number' ? gross : parseFloat(String(gross).replace(',', '.')) || 0) : sumPayments;
  const EXCEL_PAYMENT_KEYS = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];
  const byMethod = {};
  for (const k of EXCEL_PAYMENT_KEYS) {
    const p = payments.find((x) => (String(x?.MethodName ?? x?.methodName ?? '').trim()) === k);
    byMethod[k] = p != null ? (typeof p.Amount === 'number' ? p.Amount : parseFloat(String(p?.Amount ?? p?.amount ?? 0).replace(',', '.')) || 0) : 0;
  }
  const posName = item.PosName ?? item.posName ?? '';
  const posId = item.PosId ?? item.posId;
  const tpvLabel = posName || (posId != null && posId !== '' ? `TPV ${posId}` : 'Cierre sistema');
  return {
    ...item,
    TPV: tpvLabel,
    FechaNegocio: formatFechaNegocio(item.BusinessDay ?? item.businessDay ?? ''),
    Ventas: ventas,
    Efectivo: byMethod.Efectivo,
    Tarjeta: byMethod.Tarjeta,
    'Pendiente de cobro': byMethod['Pendiente de cobro'],
    'Prepago Transferencia': byMethod['Prepago Transferencia'],
    AgoraPay: byMethod.AgoraPay,
  };
}

function normalizeCloseOutForResponse(item) {
  if (!item || typeof item !== 'object') return item;
  const a = item.Amounts ?? item.amounts ?? {};
  const amounts = typeof a === 'object' && a !== null ? a : {};
  const ensureArray = (arr) => (Array.isArray(arr) ? arr : []);
  const toPayment = (p) => ({
    MethodName: p?.MethodName ?? p?.methodName ?? p?.Name ?? p?.name ?? null,
    Amount: p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? null,
  });
  const skVal = item.SK ?? item.sk ?? '';
  const numberVal = item.Number ?? item.number ?? extractNumberFromSk(skVal);
  return {
    ...item,
    PK: item.PK ?? item.pk ?? '',
    SK: skVal,
    BusinessDay: item.BusinessDay ?? item.businessDay ?? (skVal && String(skVal).split('#')[0]) ?? '',
    Number: numberVal !== '' && numberVal != null ? String(numberVal) : extractNumberFromSk(skVal) || '',
    OpenDate: item.OpenDate ?? item.openDate ?? null,
    CloseDate: item.CloseDate ?? item.closeDate ?? null,
    WorkplaceId: item.WorkplaceId ?? item.workplaceId ?? item.PK ?? item.pk ?? '',
    PosId: item.PosId ?? item.posId ?? null,
    PosName: item.PosName ?? item.posName ?? null,
    Amounts: {
      GrossAmount: amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total ?? null,
      NetAmount: amounts.NetAmount ?? amounts.netAmount ?? null,
      VatAmount: amounts.VatAmount ?? amounts.vatAmount ?? null,
      SurchargeAmount: amounts.SurchargeAmount ?? amounts.surchargeAmount ?? null,
    },
    InvoicePayments: ensureArray(item.InvoicePayments ?? item.invoicePayments).map(toPayment),
    TicketPayments: ensureArray(item.TicketPayments ?? item.ticketPayments).map(toPayment),
    DeliveryNotePayments: ensureArray(item.DeliveryNotePayments ?? item.deliveryNotePayments).map(toPayment),
    SalesOrderPayments: ensureArray(item.SalesOrderPayments ?? item.salesOrderPayments).map(toPayment),
  };
}

app.post('/api/agora/closeouts/sync', async (req, res) => {
  const body = req.body || {};
  const businessDay = body.businessDay ? String(body.businessDay).trim() : new Date().toISOString().slice(0, 10);
  const workplaces = body.workplaces != null ? (Array.isArray(body.workplaces) ? body.workplaces : [body.workplaces]) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'businessDay obligatorio (YYYY-MM-DD)' });
  }

  try {
    let rawList = [];
    let source = 'none';
    const [invData, posData, sysData] = await Promise.all([
      exportInvoices(businessDay, workplaces ?? undefined).catch((e) => ({ _err: e })),
      exportPosCloseOuts(businessDay, workplaces ?? undefined).catch((e) => ({ _err: e })),
      exportSystemCloseOuts(businessDay, workplaces ?? undefined).catch((e) => ({ _err: e })),
    ]);

    const invList = !invData?._err ? extractCloseOutsArray(invData, ['Invoices', 'invoices']) : [];
    const posList = !posData?._err ? extractCloseOutsArray(posData, ['PosCloseOuts', 'PosCloseouts', 'posCloseOuts']) : [];
    const sysList = !sysData?._err ? extractCloseOutsArray(sysData, ['SystemCloseOuts', 'SystemCloseouts', 'systemCloseOuts']) : [];
    const sysByWorkplace = new Map();
    for (const s of sysList) {
      const pk = String(s?.WorkplaceId ?? s?.workplaceId ?? '').trim() || '0';
      if (Array.isArray(s?.InvoicePayments ?? s?.invoicePayments) && (s.InvoicePayments ?? s.invoicePayments).length > 0) {
        sysByWorkplace.set(pk, s);
      }
    }
    // Prioridad: Invoices (TPV+formas de pago) > SystemCloseOuts (por local) > PosCloseOuts (solo efectivo)
    const aggregatedFromInvoices = aggregateInvoicesByWorkplaceAndPos(invList, businessDay);
    if (aggregatedFromInvoices.length > 0) {
      rawList = aggregatedFromInvoices;
      source = 'Invoices';
    } else if (sysList.length > 0) {
      rawList = sysList;
      source = 'SystemCloseOuts';
    } else if (posList.length > 0) {
      rawList = posList;
      source = 'PosCloseOuts';
    }

    if (rawList.length === 0) {
      return res.json({ ok: true, fetched: 0, upserted: 0, businessDay, source });
    }

    const usePos = source === 'PosCloseOuts';
    const paymentSourceByRecord = source === 'Invoices' ? new Map() : buildPaymentSourceByRecord(rawList, sysByWorkplace, usePos);
    const items = rawList.map((r, idx) => {
      const paymentSource = paymentSourceByRecord.get(r) ?? null;
      const item = mapCloseOutToItem(r, businessDay, paymentSource);
      if (!item.Number || item.Number === '') item.Number = String(idx + 1);
      if (!item.SK || String(item.SK).trim() === '') {
        item.SK = businessDay ? (item.PosId ? `${businessDay}#${item.PosId}#${item.Number}` : `${businessDay}#${item.Number}`) : '';
      }
      return item;
    }).filter((i) => i.PK && i.SK && String(i.PK).trim() !== '' && String(i.SK).trim() !== '');

    const workplaceIds = [...new Set(items.map((i) => i.PK).filter(Boolean))];
    const keysToDeleteMap = new Map();
    for (const pk of workplaceIds) {
      let lastKey = null;
      do {
        const q = await docClient.send(new QueryCommand({
          TableName: tableSalesCloseOutsName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': pk, ':sk': `${businessDay}#` },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        for (const rec of q.Items || []) keysToDeleteMap.set(`${rec.PK}#${rec.SK}`, { PK: rec.PK, SK: rec.SK });
        lastKey = q.LastEvaluatedKey || null;
      } while (lastKey);
    }
    const keysToDelete = [...keysToDeleteMap.values()];
    for (let i = 0; i < keysToDelete.length; i += 25) {
      const chunk = keysToDelete.slice(i, i + 25);
      await docClient.send(new BatchWriteCommand({
        RequestItems: { [tableSalesCloseOutsName]: chunk.map((k) => ({ DeleteRequest: { Key: k } })) },
      }));
    }

    const upserted = await upsertBatch(docClient, tableSalesCloseOutsName, items);
    console.log('[agora/closeouts] Sync:', businessDay, 'fetched:', rawList.length, 'upserted:', upserted, 'source:', source);
    return res.json({ ok: true, fetched: rawList.length, upserted, businessDay, source });
  } catch (err) {
    console.error('[agora/closeouts/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar cierres' });
  }
});

/** Valida que un registro crudo de Ágora tenga la estructura mínima esperada (Guía 8.1.6). */
function validateAgoraCloseOut(raw) {
  if (!raw || typeof raw !== 'object') return { valid: false, reason: 'Registro vacío o no objeto' };
  const r = getMappableRaw(raw);
  const workplaceId = findValue(r, ['WorkplaceId', 'workplaceId', 'LocalId', 'localId']) ?? r?.WorkplaceId ?? r?.Workplace?.Id;
  if (!workplaceId && workplaceId !== 0) return { valid: false, reason: 'Falta WorkplaceId' };
  const businessDay = findValue(r, ['BusinessDay', 'businessDay', 'Date', 'date']) ?? r?.BusinessDay;
  if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(String(businessDay))) return { valid: false, reason: 'BusinessDay inválido o ausente' };
  const amounts = r?.Amounts ?? r?.amounts ?? r?.Totals ?? r?.totals ?? {};
  const gross = findValue(amounts, ['GrossAmount', 'grossAmount', 'Total', 'total']) ?? findValue(r, ['ActualEndAmount', 'actualEndAmount']);
  const balances = r?.Balances ?? r?.balances ?? [];
  const hasAmount = (gross != null && (typeof gross === 'number' || !Number.isNaN(parseFloat(String(gross))))) ||
    (Array.isArray(balances) && balances.length > 0);
  if (!hasAmount) return { valid: false, reason: 'Falta importe (GrossAmount/Total/Balances)' };
  return { valid: true };
}

/**
 * Sincronización completa: borra duplicados, elimina registros fuera de rango,
 * y re-sincroniza desde Ágora para el rango indicado.
 * POST /api/agora/closeouts/full-sync
 * Body: { dateFrom?: 'YYYY-MM-DD', dateTo?: 'YYYY-MM-DD', deleteOutOfRange?: boolean }
 * Por defecto: dateFrom=2025-01-01, dateTo=hoy
 */
app.post('/api/agora/closeouts/full-sync', async (req, res) => {
  const body = req.body || {};
  const today = new Date().toISOString().slice(0, 10);
  const dateFrom = (body.dateFrom || '2025-01-01').toString().trim();
  const dateTo = (body.dateTo || today).toString().trim();
  const deleteOutOfRange = body.deleteOutOfRange !== false;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo deben ser YYYY-MM-DD' });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ error: 'dateFrom no puede ser mayor que dateTo' });
  }

  try {
    let deletedOutOfRange = 0;
    if (deleteOutOfRange) {
      const allItems = [];
      let lastKey = null;
      do {
        const scanRes = await docClient.send(new ScanCommand({
          TableName: tableSalesCloseOutsName,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        allItems.push(...(scanRes.Items || []));
        lastKey = scanRes.LastEvaluatedKey || null;
      } while (lastKey);

      const keysToDelete = [];
      const seenBusinessKey = new Set();
      for (const item of allItems) {
        const pk = item.PK ?? item.pk;
        const sk = item.SK ?? item.sk;
        const bd = item.BusinessDay ?? item.businessDay ?? (typeof sk === 'string' ? sk.split('#')[0] : '');
        const posId = item.PosId ?? item.posId ?? (typeof sk === 'string' ? sk.split('#')[1] : '') ?? '';
        const num = item.Number ?? item.number ?? (typeof sk === 'string' ? sk.split('#').pop() : '') ?? '';
        const outOfRange = !bd || bd < dateFrom || bd > dateTo;
        const businessKey = `${pk}|${bd}|${posId}|${num}`;
        const isDuplicate = seenBusinessKey.has(businessKey);
        if (outOfRange || isDuplicate) keysToDelete.push({ PK: pk, SK: sk });
        if (!outOfRange) seenBusinessKey.add(businessKey);
      }

      for (let i = 0; i < keysToDelete.length; i += 25) {
        const chunk = keysToDelete.slice(i, i + 25);
        await docClient.send(new BatchWriteCommand({
          RequestItems: { [tableSalesCloseOutsName]: chunk.map((k) => ({ DeleteRequest: { Key: k } })) },
        }));
        deletedOutOfRange += chunk.length;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (deletedOutOfRange > 0) console.log('[agora/closeouts/full-sync] Eliminados fuera de rango o duplicados:', deletedOutOfRange);
    }

    const days = [];
    let d = new Date(dateFrom + 'T12:00:00');
    const end = new Date(dateTo + 'T12:00:00');
    while (d <= end) {
      days.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }

    let totalFetched = 0;
    let totalUpserted = 0;
    let totalSkipped = 0;
    const errors = [];

    for (let i = 0; i < days.length; i++) {
      const businessDay = days[i];
      try {
        let rawList = [];
        let source = 'none';
        const [invData, posData, sysData] = await Promise.all([
          exportInvoices(businessDay).catch((e) => ({ _err: e })),
          exportPosCloseOuts(businessDay).catch((e) => ({ _err: e })),
          exportSystemCloseOuts(businessDay).catch((e) => ({ _err: e })),
        ]);

        const invList = !invData?._err ? extractCloseOutsArray(invData, ['Invoices', 'invoices']) : [];
        const posList = !posData?._err ? extractCloseOutsArray(posData, ['PosCloseOuts', 'PosCloseouts', 'posCloseOuts']) : [];
        const sysList = !sysData?._err ? extractCloseOutsArray(sysData, ['SystemCloseOuts', 'SystemCloseouts', 'systemCloseOuts']) : [];
        const sysByWorkplace = new Map();
        for (const s of sysList) {
          const pk = String(s?.WorkplaceId ?? s?.workplaceId ?? '').trim() || '0';
          if (Array.isArray(s?.InvoicePayments ?? s?.invoicePayments) && (s.InvoicePayments ?? s.invoicePayments).length > 0) {
            sysByWorkplace.set(pk, s);
          }
        }
        const aggregatedFromInvoices = aggregateInvoicesByWorkplaceAndPos(invList, businessDay);
        if (aggregatedFromInvoices.length > 0) {
          rawList = aggregatedFromInvoices;
          source = 'Invoices';
        } else if (sysList.length > 0) {
          rawList = sysList;
          source = 'SystemCloseOuts';
        } else if (posList.length > 0) {
          rawList = posList;
          source = 'PosCloseOuts';
        }

        const validRaw = [];
        for (const r of rawList) {
          const v = validateAgoraCloseOut(r);
          if (v.valid) validRaw.push(r);
          else totalSkipped++;
        }

        if (validRaw.length === 0) continue;

        const usePos = source === 'PosCloseOuts';
        const paymentSourceByRecord = source === 'Invoices' ? new Map() : buildPaymentSourceByRecord(validRaw, sysByWorkplace, usePos);
        const items = validRaw.map((r, idx) => {
          const paymentSource = paymentSourceByRecord.get(r) ?? null;
          const item = mapCloseOutToItem(r, businessDay, paymentSource);
          if (!item.Number || item.Number === '') item.Number = String(idx + 1);
          if (!item.SK || String(item.SK).trim() === '') {
            item.SK = businessDay ? (item.PosId ? `${businessDay}#${item.PosId}#${item.Number}` : `${businessDay}#${item.Number}`) : '';
          }
          return item;
        }).filter((i) => i.PK && i.SK && String(i.PK).trim() !== '' && String(i.SK).trim() !== '');

        const workplaceIds = [...new Set(items.map((i) => i.PK).filter(Boolean))];
        const keysToDeleteMap = new Map();
        for (const pk of workplaceIds) {
          let lastKey = null;
          do {
            const q = await docClient.send(new QueryCommand({
              TableName: tableSalesCloseOutsName,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
              ExpressionAttributeValues: { ':pk': pk, ':sk': `${businessDay}#` },
              ...(lastKey && { ExclusiveStartKey: lastKey }),
            }));
            for (const rec of q.Items || []) keysToDeleteMap.set(`${rec.PK}#${rec.SK}`, { PK: rec.PK, SK: rec.SK });
            lastKey = q.LastEvaluatedKey || null;
          } while (lastKey);
        }
        const keysToDelete = [...keysToDeleteMap.values()];
        for (let j = 0; j < keysToDelete.length; j += 25) {
          const chunk = keysToDelete.slice(j, j + 25);
          await docClient.send(new BatchWriteCommand({
            RequestItems: { [tableSalesCloseOutsName]: chunk.map((k) => ({ DeleteRequest: { Key: k } })) },
          }));
        }

        const upserted = await upsertBatch(docClient, tableSalesCloseOutsName, items);
        totalFetched += validRaw.length;
        totalUpserted += upserted;

        if ((i + 1) % 30 === 0) console.log('[agora/closeouts/full-sync] Progreso:', i + 1, '/', days.length, 'días');
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        errors.push({ day: businessDay, error: err.message || String(err) });
      }
    }

    console.log('[agora/closeouts/full-sync] Completado:', { dateFrom, dateTo, deletedOutOfRange, totalFetched, totalUpserted, totalSkipped, errors: errors.length });
    return res.json({
      ok: true,
      dateFrom,
      dateTo,
      deletedOutOfRange,
      totalFetched,
      totalUpserted,
      totalSkipped,
      daysProcessed: days.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('[agora/closeouts/full-sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error en sincronización completa' });
  }
});

/**
 * Completa campos faltantes en Igp_SalesCloseouts:
 * - PosName desde Igp_SaleCenters (PK=GLOBAL, SK=PosId)
 * - Amounts, OpenDate, CloseDate, InvoicePayments desde Ágora cuando falten
 * POST /api/agora/closeouts/complete-fields
 * Body: { limit?: number, dateFrom?: 'YYYY-MM-DD', dateTo?: 'YYYY-MM-DD', workplaceId?: string }
 */
app.post('/api/agora/closeouts/complete-fields', async (req, res) => {
  const body = req.body || {};
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5000, 1), 10000);
  const dateFrom = (body.dateFrom || '').toString().trim();
  const dateTo = (body.dateTo || '').toString().trim();
  const filterWorkplaceId = (body.workplaceId || '').toString().trim();

  try {
    const items = [];
    let lastKey = null;

    if (filterWorkplaceId) {
      let keyCond = 'PK = :pk';
      const exprValues = { ':pk': filterWorkplaceId };
      if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        keyCond += ' AND SK >= :dateFrom';
        exprValues[':dateFrom'] = dateFrom;
      }
      if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        keyCond += ' AND SK <= :dateToMax';
        exprValues[':dateToMax'] = `${dateTo}\uffff`;
      }
      do {
        const q = await docClient.send(new QueryCommand({
          TableName: tableSalesCloseOutsName,
          KeyConditionExpression: keyCond,
          ExpressionAttributeValues: exprValues,
          Limit: Math.min(limit - items.length, 100),
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        items.push(...(q.Items || []));
        lastKey = q.LastEvaluatedKey || null;
        if (items.length >= limit) break;
      } while (lastKey);
    } else {
      const filterExpr = [];
      const exprValues = {};
      if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        filterExpr.push('SK >= :dateFrom');
        exprValues[':dateFrom'] = dateFrom;
      }
      if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        filterExpr.push('SK <= :dateToMax');
        exprValues[':dateToMax'] = `${dateTo}\uffff`;
      }
      do {
        const scanParams = {
          TableName: tableSalesCloseOutsName,
          Limit: Math.min(limit - items.length, 100),
          ...(lastKey && { ExclusiveStartKey: lastKey }),
          ...(filterExpr.length > 0 && {
            FilterExpression: filterExpr.join(' AND '),
            ExpressionAttributeValues: exprValues,
          }),
        };
        const scanRes = await docClient.send(new ScanCommand(scanParams));
        items.push(...(scanRes.Items || []));
        lastKey = scanRes.LastEvaluatedKey || null;
        if (items.length >= limit) break;
      } while (lastKey);
    }

    let posNameUpdated = 0;
    let agoraUpdated = 0;
    const errors = [];

    const needPosName = items.filter((it) => {
      const posId = it.PosId ?? it.posId;
      const posName = it.PosName ?? it.posName ?? '';
      return posId != null && posId !== '' && (!posName || String(posName).trim() === '');
    });
    const uniquePosIds = [...new Set(needPosName.map((it) => String(it.PosId ?? it.posId ?? '')))].filter(Boolean);

    const posNameMap = new Map();
    for (let i = 0; i < uniquePosIds.length; i += 100) {
      const chunk = uniquePosIds.slice(i, i + 100);
      const keys = chunk.map((id) => ({ PK: 'GLOBAL', SK: String(id) }));
      let reqItems = { [tableSaleCentersName]: { Keys: keys } };
      do {
        const batchRes = await docClient.send(new BatchGetCommand({ RequestItems: reqItems }));
        const results = batchRes.Responses?.[tableSaleCentersName] || [];
        for (const r of results) {
          const sk = r.SK ?? r.sk;
          const nombre = r.Nombre ?? r.nombre ?? '';
          if (sk && nombre) posNameMap.set(String(sk), nombre);
        }
        reqItems = batchRes.UnprocessedKeys || {};
        if (Object.keys(reqItems).length > 0) await new Promise((r) => setTimeout(r, 100));
      } while (Object.keys(reqItems).length > 0);
    }

    for (const it of needPosName) {
      const posId = String(it.PosId ?? it.posId ?? '');
      const posName = posNameMap.get(posId);
      if (!posName) continue;
      try {
        await docClient.send(new UpdateCommand({
          TableName: tableSalesCloseOutsName,
          Key: { PK: it.PK, SK: it.SK },
          UpdateExpression: 'SET PosName = if_not_exists(PosName, :nombre)',
          ExpressionAttributeValues: { ':nombre': posName },
        }));
        posNameUpdated++;
      } catch (e) {
        errors.push({ type: 'PosName', key: `${it.PK}#${it.SK}`, error: e.message });
      }
    }

    const needAgora = items.filter((it) => {
      const amounts = it.Amounts ?? it.amounts ?? {};
      const gross = amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total;
      const openDate = it.OpenDate ?? it.openDate;
      const closeDate = it.CloseDate ?? it.closeDate;
      const payments = it.InvoicePayments ?? it.invoicePayments ?? [];
      const hasGross = gross != null && (typeof gross === 'number' || !Number.isNaN(parseFloat(String(gross))));
      const hasPayments = Array.isArray(payments) && payments.length > 0;
      const businessDay = (it.SK ?? it.sk ?? '').split('#')[0];
      return businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay) && (!hasGross || !openDate || !closeDate || !hasPayments);
    });

    const daysToFetch = [...new Set(needAgora.map((it) => {
      const bd = (it.SK ?? it.sk ?? '').split('#')[0];
      return `${it.PK}|${bd}`;
    }))];

    for (const dayKey of daysToFetch) {
      const [workplaceId, businessDay] = dayKey.split('|');
      if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) continue;
      try {
        let rawList = [];
        let usePos = false;
        const [posData, sysData] = await Promise.all([
          exportPosCloseOuts(businessDay, [workplaceId]).catch((e) => ({ _err: e })),
          exportSystemCloseOuts(businessDay, [workplaceId]).catch((e) => ({ _err: e })),
        ]);
        const posList = !posData?._err ? extractCloseOutsArray(posData, ['PosCloseOuts', 'PosCloseouts', 'posCloseOuts']) : [];
        const sysList = !sysData?._err ? extractCloseOutsArray(sysData, ['SystemCloseOuts', 'SystemCloseouts', 'systemCloseOuts']) : [];
        const sysByWorkplace = new Map();
        for (const s of sysList) {
          const pk = String(s?.WorkplaceId ?? s?.workplaceId ?? '').trim() || '0';
          if (Array.isArray(s?.InvoicePayments ?? s?.invoicePayments) && (s.InvoicePayments ?? s.invoicePayments).length > 0) {
            sysByWorkplace.set(pk, s);
          }
        }
        rawList = posList.length > 0 ? posList : sysList;
        if (rawList.length === 0) continue;

        const usePosLocal = posList.length > 0;
        const paymentSourceByRecord = buildPaymentSourceByRecord(rawList, sysByWorkplace, usePosLocal);
        const rawByKey = new Map();
        for (const r of rawList) {
          const paymentSource = paymentSourceByRecord.get(r) ?? null;
          const mapped = mapCloseOutToItem(r, businessDay, paymentSource);
          const mpk = mapped.PK ?? workplaceId;
          const sk = mapped.SK ?? '';
          if (mpk && sk) rawByKey.set(`${mpk}#${sk}`, mapped);
        }

        for (const it of needAgora) {
          if (it.PK !== workplaceId) continue;
          const bd = (it.SK ?? it.sk ?? '').split('#')[0];
          if (bd !== businessDay) continue;
          const key = `${it.PK}#${it.SK}`;
          const mapped = rawByKey.get(key);
          if (!mapped) continue;

          const updates = [];
          const exprNames = {};
          const exprValues = {};
          let idx = 0;
          const addSet = (name, attr, val) => {
            const n = name;
            const v = `:v${idx}`;
            exprNames[n] = attr;
            exprValues[v] = val;
            updates.push(`${n} = if_not_exists(${n}, ${v})`);
            idx++;
          };

          const amounts = it.Amounts ?? it.amounts ?? {};
          const gross = amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total;
          if ((gross == null || gross === '') && mapped.Amounts) {
            addSet('#amt', 'Amounts', mapped.Amounts);
          }
          if (!it.OpenDate && !it.openDate && mapped.OpenDate) addSet('#open', 'OpenDate', mapped.OpenDate);
          if (!it.CloseDate && !it.closeDate && mapped.CloseDate) addSet('#close', 'CloseDate', mapped.CloseDate);
          const payments = it.InvoicePayments ?? it.invoicePayments ?? [];
          if ((!payments || payments.length === 0) && mapped.InvoicePayments?.length > 0) {
            addSet('#inv', 'InvoicePayments', mapped.InvoicePayments);
          }
          if (updates.length === 0) continue;

          try {
            await docClient.send(new UpdateCommand({
              TableName: tableSalesCloseOutsName,
              Key: { PK: it.PK, SK: it.SK },
              UpdateExpression: `SET ${updates.join(', ')}`,
              ExpressionAttributeNames: exprNames,
              ExpressionAttributeValues: exprValues,
            }));
            agoraUpdated++;
          } catch (e) {
            errors.push({ type: 'Agora', key: `${it.PK}#${it.SK}`, error: e.message });
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      } catch (e) {
        errors.push({ type: 'AgoraFetch', day: dayKey, error: e.message });
      }
    }

    console.log('[agora/closeouts/complete-fields]', { scanned: items.length, posNameUpdated, agoraUpdated, errors: errors.length });
    return res.json({
      ok: true,
      scanned: items.length,
      posNameUpdated,
      agoraUpdated,
      totalUpdated: posNameUpdated + agoraUpdated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('[agora/closeouts/complete-fields]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al completar campos' });
  }
});

// --- Mantenimiento: Incidencias ---
const ZONAS = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'];
const CATEGORIAS = ['electricidad', 'fontanería', 'frío', 'mobiliario', 'limpieza técnica', 'IT', 'plagas', 'otros'];
const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'];

app.post('/api/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? body.id_Locales ?? '').toString().trim();
  const zona = (body.zona ?? '').toString().trim().toLowerCase();
  const categoria = (body.categoria ?? '').toString().trim().toLowerCase();
  const titulo = (body.titulo ?? '').toString().trim();
  const descripcion = (body.descripcion ?? '').toString().trim();
  const prioridadReportada = (body.prioridad_reportada ?? 'media').toString().trim().toLowerCase();
  const fotos = Array.isArray(body.fotos) ? body.fotos.filter((f) => typeof f === 'string' && f.length > 0).slice(0, 3) : [];
  const creadoPor = (body.creado_por_id_usuario ?? req.headers['x-user-id'] ?? '').toString().trim();

  if (!localId) return res.status(400).json({ error: 'local_id es obligatorio' });
  if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });
  if (!ZONAS.includes(zona)) return res.status(400).json({ error: 'zona no válida' });
  if (!CATEGORIAS.includes(categoria)) return res.status(400).json({ error: 'categoria no válida' });
  if (!PRIORIDADES.includes(prioridadReportada)) return res.status(400).json({ error: 'prioridad_reportada no válida' });

  try {
    const getLocal = await docClient.send(
      new GetCommand({
        TableName: tableLocalesName,
        Key: { id_Locales: localId },
      })
    );
    if (!getLocal.Item) {
      return res.status(400).json({ error: 'Local no encontrado' });
    }

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString();
    const sk = `INC#${now}#${uuid}`;
    const pk = `LOCAL#${localId}`;
    const item = {
      PK: pk,
      SK: sk,
      tipo: 'INC',
      id_incidencia: uuid,
      fecha_creacion: now,
      creado_por_id_usuario: creadoPor || undefined,
      local_id: localId,
      zona,
      categoria,
      titulo,
      descripcion,
      prioridad_reportada: prioridadReportada,
      estado: 'Nuevo',
      ...(fotos.length > 0 && { fotos }),
    };

    await docClient.send(
      new PutCommand({
        TableName: tableMantenimientoName,
        Item: item,
      })
    );
    return res.json({ ok: true, incidencia: item });
  } catch (err) {
    console.error('[mantenimiento/incidencias POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear incidencia' });
  }
});

app.get('/api/mantenimiento/incidencias', async (req, res) => {
  const localId = (req.query.local_id ?? '').toString().trim();
  const creadoPor = (req.query.creado_por ?? '').toString().trim();
  const estado = (req.query.estado ?? '').toString().trim().toUpperCase();

  try {
    let items = [];
    if (localId) {
      let lastKey = null;
      do {
        const cmd = new QueryCommand({
          TableName: tableMantenimientoName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `LOCAL#${localId}`, ':sk': 'INC#' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    } else {
      let lastKey = null;
      do {
        const cmd = new ScanCommand({
          TableName: tableMantenimientoName,
          FilterExpression: 'tipo = :tipo',
          ExpressionAttributeValues: { ':tipo': 'INC' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    }
    if (creadoPor) items = items.filter((i) => (i.creado_por_id_usuario ?? '') === creadoPor);
    if (estado) items = items.filter((i) => (i.estado ?? '') === estado);
    items.sort((a, b) => (b.fecha_creacion || '').localeCompare(a.fecha_creacion || ''));
    const incidencias = items.map((i) => ({
      id_incidencia: i.id_incidencia,
      fecha_creacion: i.fecha_creacion,
      fecha_programada: i.fecha_programada,
      creado_por_id_usuario: i.creado_por_id_usuario,
      local_id: i.local_id,
      zona: i.zona,
      categoria: i.categoria,
      titulo: i.titulo,
      descripcion: i.descripcion,
      prioridad_reportada: i.prioridad_reportada,
      estado: i.estado,
      fotos: i.fotos ?? [],
      fecha_completada: i.FechaCompletada ?? null,
      estado_valoracion: i.EstadoValoracion ?? null,
    }));
    return res.json({ incidencias });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tableMantenimientoName} no existe en DynamoDB. Créala en AWS con PK (String) y SK (String). Ver api/MANTENIMIENTO.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al listar incidencias' });
  }
});

app.patch('/api/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();
  const fechaProgramada = (body.fecha_programada ?? '').toString().trim();
  const marcarReparado = body.marcar_reparado === true;

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  try {
    const pk = `LOCAL#${localId}`;
    const sk = `INC#${fechaCreacion}#${idIncidencia}`;

    if (marcarReparado) {
      const fechaCompletada = new Date().toISOString();
      await docClient.send(
        new UpdateCommand({
          TableName: tableMantenimientoName,
          Key: { PK: pk, SK: sk },
          UpdateExpression: 'SET FechaCompletada = :fc, EstadoValoracion = :ev, #est = :est',
          ExpressionAttributeNames: { '#est': 'estado' },
          ExpressionAttributeValues: { ':fc': fechaCompletada, ':ev': 'Reparado', ':est': 'Reparacion' },
        })
      );
      return res.json({ ok: true });
    }

    if (!fechaProgramada || !/^\d{4}-\d{2}-\d{2}$/.test(fechaProgramada)) {
      await docClient.send(
        new UpdateCommand({
          TableName: tableMantenimientoName,
          Key: { PK: pk, SK: sk },
          UpdateExpression: 'REMOVE fecha_programada',
        })
      );
      return res.json({ ok: true });
    }

    const programada = new Date(fechaProgramada + 'T12:00:00');
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    programada.setHours(0, 0, 0, 0);
    if (programada.getTime() < hoy.getTime()) {
      return res.status(400).json({ error: 'No se puede asignar una fecha anterior al día actual' });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: tableMantenimientoName,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'SET fecha_programada = :fp, #est = :est',
        ExpressionAttributeNames: { '#est': 'estado' },
        ExpressionAttributeValues: { ':fp': fechaProgramada, ':est': 'Programado' },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias PATCH]', msg);
    return res.status(500).json({ error: msg || 'Error al actualizar incidencia' });
  }
});

app.delete('/api/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  try {
    const pk = `LOCAL#${localId}`;
    const sk = `INC#${fechaCreacion}#${idIncidencia}`;

    await docClient.send(
      new DeleteCommand({
        TableName: tableMantenimientoName,
        Key: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias DELETE]', msg);
    return res.status(500).json({ error: msg || 'Error al borrar incidencia' });
  }
});

// --- Roles y permisos (tabla Igp_RolesPermisos: PK = ROL#<rol>, SK = PERMISO#<codigo>) ---
app.get('/api/permisos', async (req, res) => {
  const rol = (req.query.rol ?? '').toString().trim();
  if (!rol) {
    return res.json({ permisos: [] });
  }
  const pk = `ROL#${rol}`;
  try {
    let items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableRolesPermisosName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': 'PERMISO#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const permisos = items.map((i) => (i.SK || '').replace(/^PERMISO#/, '')).filter(Boolean);
    return res.json({ permisos });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tableRolesPermisosName} no existe. Créala en DynamoDB con PK (String) y SK (String). Ver api/ROLES-PERMISOS.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al obtener permisos' });
  }
});

// Listar todos los ítems rol-permiso (para la tabla del módulo Permisos)
app.get('/api/permisos/todos', async (req, res) => {
  try {
    let items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableRolesPermisosName,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: { ':pk': 'ROL#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const list = items.map((i) => ({
      rol: (i.PK || '').replace(/^ROL#/, ''),
      permiso: (i.SK || '').replace(/^PERMISO#/, ''),
    })).filter((x) => x.rol && x.permiso);
    list.sort((a, b) => (a.rol + a.permiso).localeCompare(b.rol + b.permiso));
    return res.json({ items: list });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos/todos GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tableRolesPermisosName} no existe. Ver api/ROLES-PERMISOS.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al listar permisos' });
  }
});

// Añadir permiso a un rol
app.post('/api/permisos', async (req, res) => {
  const rol = (req.body?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  try {
    await docClient.send(
      new PutCommand({
        TableName: tableRolesPermisosName,
        Item: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos POST]', msg);
    return res.status(500).json({ error: msg || 'Error al añadir permiso' });
  }
});

// Quitar permiso de un rol
app.delete('/api/permisos', async (req, res) => {
  const rol = (req.body?.rol ?? req.query?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? req.query?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableRolesPermisosName,
        Key: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos DELETE]', msg);
    return res.status(500).json({ error: msg || 'Error al borrar permiso' });
  }
});

// ──────────────────────────────────────────
// Acuerdos con Marcas (Rappel)
// ──────────────────────────────────────────

app.get('/api/acuerdos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableAcuerdosName,
        ConsistentRead: true,
        FilterExpression: '#sk = :meta',
        ExpressionAttributeNames: { '#sk': 'SK' },
        ExpressionAttributeValues: { ':meta': 'META' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[acuerdos GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar acuerdos' });
  }
});

app.get('/api/acuerdos/:id', async (req, res) => {
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tableAcuerdosName,
      Key: { PK: req.params.id, SK: 'META' },
      ConsistentRead: true,
    }));
    if (!got.Item) return res.status(404).json({ error: 'Acuerdo no encontrado' });
    return res.json({ ok: true, item: got.Item });
  } catch (err) {
    console.error('[acuerdos GET :id]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener acuerdo' });
  }
});

app.post('/api/acuerdos', async (req, res) => {
  const body = req.body || {};
  const pk = body.PK || crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    PK: pk,
    SK: 'META',
    Nombre: (body.Nombre || '').trim(),
    Marca: (body.Marca || '').trim(),
    FechaInicio: (body.FechaInicio || '').trim(),
    FechaFin: (body.FechaFin || '').trim(),
    Contacto: (body.Contacto || '').trim(),
    Telefono: (body.Telefono || '').trim(),
    Email: (body.Email || '').trim(),
    Notas: (body.Notas || '').trim(),
    Estado: body.Estado || 'Activo',
    createdAt: now,
    updatedAt: now,
  };
  if (!item.PK) return res.status(400).json({ error: 'El identificador (PK) es obligatorio' });
  if (item.FechaInicio && item.FechaFin && item.FechaInicio > item.FechaFin) {
    return res.status(400).json({ error: 'La fecha de inicio no puede ser mayor que la fecha final' });
  }
  try {
    await docClient.send(new PutCommand({ TableName: tableAcuerdosName, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[acuerdos POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear acuerdo' });
  }
});

app.patch('/api/acuerdos/:id', async (req, res) => {
  const pk = req.params.id;
  const body = req.body || {};
  const FIELDS = ['Nombre', 'Marca', 'FechaInicio', 'FechaFin', 'Contacto', 'Telefono', 'Email', 'Notas', 'Estado'];
  const setParts = ['#updAt = :updAt'];
  const exprNames = { '#updAt': 'updatedAt' };
  const exprValues = { ':updAt': new Date().toISOString() };
  let vi = 0;
  for (const key of FIELDS) {
    if (body[key] === undefined) continue;
    const val = typeof body[key] === 'string' ? body[key].trim() : body[key];
    exprNames[`#f${vi}`] = key;
    exprValues[`:v${vi}`] = val;
    setParts.push(`#f${vi} = :v${vi}`);
    vi++;
  }
  if (vi === 0) return res.status(400).json({ error: 'Indica al menos un campo a actualizar' });
  if (body.FechaInicio !== undefined || body.FechaFin !== undefined) {
    const got = await docClient.send(new GetCommand({ TableName: tableAcuerdosName, Key: { PK: pk, SK: 'META' } }));
    const existing = got.Item || {};
    const fechaInicio = body.FechaInicio !== undefined ? String(body.FechaInicio || '').trim() : (existing.FechaInicio || '');
    const fechaFin = body.FechaFin !== undefined ? String(body.FechaFin || '').trim() : (existing.FechaFin || '');
    if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
      return res.status(400).json({ error: 'La fecha de inicio no puede ser mayor que la fecha final' });
    }
  }
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdosName,
      Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET ' + setParts.join(', '),
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ConditionExpression: 'attribute_exists(PK)',
    }));
    return res.json({ ok: true, id: pk });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return res.status(404).json({ error: 'Acuerdo no encontrado' });
    console.error('[acuerdos PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar acuerdo' });
  }
});

app.delete('/api/acuerdos/:id', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({ TableName: tableAcuerdosName, Key: { PK: req.params.id, SK: 'META' } }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar acuerdo' });
  }
});

// Detalles de acuerdo (productos asignados)

app.get('/api/acuerdos/:id/detalles', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAcuerdosDetallesName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': req.params.id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => (a.ProductName || '').localeCompare(b.ProductName || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[acuerdos detalles GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar detalles' });
  }
});

app.get('/api/acuerdos/totales', async (req, res) => {
  try {
    const acuerdosItems = [];
    let aKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tableAcuerdosName,
        ConsistentRead: true,
        FilterExpression: '#sk = :meta',
        ExpressionAttributeNames: { '#sk': 'SK' },
        ExpressionAttributeValues: { ':meta': 'META' },
        ...(aKey && { ExclusiveStartKey: aKey }),
      }));
      acuerdosItems.push(...(r.Items || []));
      aKey = r.LastEvaluatedKey || null;
    } while (aKey);

    const allDetalles = [];
    let dKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tableAcuerdosDetallesName,
        ConsistentRead: true,
        ...(dKey && { ExclusiveStartKey: dKey }),
      }));
      allDetalles.push(...(r.Items || []));
      dKey = r.LastEvaluatedKey || null;
    } while (dKey);

    const detallesPorAcuerdo = {};
    for (const d of allDetalles) {
      if (!detallesPorAcuerdo[d.PK]) detallesPorAcuerdo[d.PK] = [];
      detallesPorAcuerdo[d.PK].push(d);
    }

    const result = {};
    const totalesPromises = acuerdosItems.map(async (acuerdo) => {
      const pk = acuerdo.PK;
      const detalles = detallesPorAcuerdo[pk] || [];
      if (detalles.length === 0) {
        result[pk] = { totalAcordado: 0, totalCompradas: 0, porcentaje: 0 };
        return;
      }
      const productIds = new Set(detalles.map((d) => String(d.ProductId || d.SK || '').trim()));
      const fechaInicio = acuerdo.FechaInicio || '';
      const fechaFin = acuerdo.FechaFin || '';

      const comprasPorProd = await queryComprasPorProductos(productIds, fechaInicio, fechaFin);

      let totalAcordado = 0, totalCompradas = 0;
      for (const d of detalles) {
        const pid = String(d.ProductId ?? d.SK ?? '').trim();
        totalAcordado += d.Cantidad || 0;
        totalCompradas += comprasPorProd[pid] || 0;
      }
      const porcentaje = totalAcordado > 0 ? Math.round((totalCompradas / totalAcordado) * 1000) / 10 : 0;
      result[pk] = { totalAcordado, totalCompradas, porcentaje };
    });
    await Promise.all(totalesPromises);

    return res.json({ ok: true, totales: result });
  } catch (err) {
    console.error('[acuerdos totales]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener totales' });
  }
});

app.get('/api/acuerdos/:id/detalles-con-compras', async (req, res) => {
  const acuerdoId = req.params.id;
  try {
    const acuerdoRes = await docClient.send(new GetCommand({ TableName: tableAcuerdosName, Key: { PK: acuerdoId, SK: 'META' } }));
    const acuerdo = acuerdoRes.Item;
    if (!acuerdo) return res.status(404).json({ error: 'Acuerdo no encontrado' });

    const detalles = [];
    let dKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAcuerdosDetallesName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': acuerdoId },
        ConsistentRead: true,
        ...(dKey && { ExclusiveStartKey: dKey }),
      });
      const r = await docClient.send(cmd);
      detalles.push(...(r.Items || []));
      dKey = r.LastEvaluatedKey || null;
    } while (dKey);

    if (detalles.length === 0) {
      return res.json({ ok: true, items: [], totalAcordado: 0, totalCompradas: 0, totalRestante: 0 });
    }

    const productIds = new Set(detalles.map((d) => String(d.ProductId || d.SK || '').trim()));
    let fechaInicio = acuerdo.FechaInicio || '';
    let fechaFin = acuerdo.FechaFin || '';
    // Garantizar que fechaInicio <= fechaFin para el BETWEEN de DynamoDB
    if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
      [fechaInicio, fechaFin] = [fechaFin, fechaInicio];
    }

    const comprasPorProducto = await queryComprasPorProductos(productIds, fechaInicio, fechaFin);

    let totalAcordado = 0;
    let totalCompradas = 0;
    const items = detalles.map((d) => {
      const acordado = d.Cantidad || 0;
      const pid = String(d.ProductId ?? d.SK ?? '').trim();
      const compradas = comprasPorProducto[pid] || 0;
      const restante = acordado - compradas;
      const porcentaje = acordado > 0 ? Math.round((compradas / acordado) * 1000) / 10 : 0;
      totalAcordado += acordado;
      totalCompradas += compradas;
      return { ...d, Compradas: compradas, Restante: restante, Porcentaje: porcentaje };
    });
    items.sort((a, b) => (a.ProductName || '').localeCompare(b.ProductName || ''));

    return res.json({ ok: true, items, totalAcordado, totalCompradas, totalRestante: totalAcordado - totalCompradas });
  } catch (err) {
    console.error('[acuerdos detalles-con-compras]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener detalles con compras' });
  }
});

app.post('/api/acuerdos/:id/detalles', async (req, res) => {
  const pk = req.params.id;
  const body = req.body || {};
  const productId = (body.ProductId || '').trim();
  const productName = (body.ProductName || '').trim();
  const cantidad = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(body.Cantidad) || 0;
  if (!productId) return res.status(400).json({ error: 'ProductId es obligatorio' });
  const now = new Date().toISOString();
  const aportacion = typeof body.Aportacion === 'number' ? body.Aportacion : parseFloat(body.Aportacion) || 0;
  const rappel = typeof body.Rappel === 'number' ? body.Rappel : parseFloat(body.Rappel) || 0;
  const descuentoExtra = typeof body.DescuentoExtra === 'number' ? body.DescuentoExtra : parseFloat(body.DescuentoExtra) || 0;
  const item = {
    PK: pk,
    SK: productId,
    ProductId: productId,
    ProductName: productName,
    Cantidad: cantidad,
    Aportacion: aportacion,
    Rappel: rappel,
    DescuentoExtra: descuentoExtra,
    createdAt: now,
  };
  try {
    await docClient.send(new PutCommand({ TableName: tableAcuerdosDetallesName, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[acuerdos detalles POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al añadir producto' });
  }
});

app.patch('/api/acuerdos/:id/detalles/:productId', async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = {};
  if (body.Cantidad !== undefined) { const v = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(body.Cantidad) || 0; updates.push('Cantidad = :c'); values[':c'] = v; }
  if (body.Aportacion !== undefined) { const v = typeof body.Aportacion === 'number' ? body.Aportacion : parseFloat(body.Aportacion) || 0; updates.push('Aportacion = :ap'); values[':ap'] = v; }
  if (body.Rappel !== undefined) { const v = typeof body.Rappel === 'number' ? body.Rappel : parseFloat(body.Rappel) || 0; updates.push('Rappel = :ra'); values[':ra'] = v; }
  if (body.DescuentoExtra !== undefined) { const v = typeof body.DescuentoExtra === 'number' ? body.DescuentoExtra : parseFloat(body.DescuentoExtra) || 0; updates.push('DescuentoExtra = :de'); values[':de'] = v; }
  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdosDetallesName,
      Key: { PK: req.params.id, SK: req.params.productId },
      UpdateExpression: 'SET ' + updates.join(', '),
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
    }));
    return res.json({ ok: true });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return res.status(404).json({ error: 'Detalle no encontrado' });
    console.error('[acuerdos detalles PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar detalle' });
  }
});

app.delete('/api/acuerdos/:id/detalles/:productId', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableAcuerdosDetallesName,
      Key: { PK: req.params.id, SK: req.params.productId },
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos detalles DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar producto' });
  }
});

app.get('/api/acuerdos/:id/seguimiento', async (req, res) => {
  const id = req.params.id;
  try {
    const getRes = await docClient.send(new GetCommand({ TableName: tableAcuerdosName, Key: { PK: id, SK: 'META' } }));
    const acuerdo = getRes.Item;
    if (!acuerdo) return res.status(404).json({ error: 'Acuerdo no encontrado' });

    const detallesItems = [];
    let dKey = null;
    do {
      const dCmd = new QueryCommand({
        TableName: tableAcuerdosDetallesName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': id },
        ...(dKey && { ExclusiveStartKey: dKey }),
      });
      const dResult = await docClient.send(dCmd);
      detallesItems.push(...(dResult.Items || []));
      dKey = dResult.LastEvaluatedKey || null;
    } while (dKey);

    const productIds = new Set(detallesItems.map((p) => String(p.ProductId || p.SK || '').trim()).filter(Boolean));
    if (productIds.size === 0) {
      return res.json({ ok: true, acuerdo, compras: [], resumenProductos: [], totalUnidades: 0, objetivo: acuerdo.ObjetivoUnidades || 0, porcentaje: 0 });
    }

    const fechaInicio = acuerdo.FechaInicio || '';
    const fechaFin = acuerdo.FechaFin || '';

    const comprasPorProd = await queryComprasPorProductos(productIds, fechaInicio, fechaFin);

    const totalUnidades = Object.values(comprasPorProd).reduce((sum, qty) => sum + qty, 0);
    const objetivo = acuerdo.ObjetivoUnidades || 0;
    const porcentaje = objetivo > 0 ? Math.min((totalUnidades / objetivo) * 100, 100) : 0;

    const resumenProductos = [...productIds].map((pid) => {
      const det = detallesItems.find((d) => String(d.ProductId || d.SK || '').trim() === pid);
      return {
        ProductId: pid,
        ProductName: det?.ProductName || pid,
        totalUnidades: comprasPorProd[pid] || 0,
        totalImporte: 0,
      };
    }).filter((r) => r.totalUnidades > 0);

    return res.json({
      ok: true,
      acuerdo,
      compras: [],
      resumenProductos,
      totalUnidades,
      objetivo,
      porcentaje: Math.round(porcentaje * 100) / 100,
    });
  } catch (err) {
    console.error('[acuerdos seguimiento]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener seguimiento' });
  }
});

// ──────────────────────────────────────────
// Acuerdos - Pagos por Imagen
// ──────────────────────────────────────────

app.get('/api/acuerdos/:id/imagen', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAcuerdosImagenName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': req.params.id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const r = await docClient.send(cmd);
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[acuerdos imagen GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener pagos por imagen' });
  }
});

app.post('/api/acuerdos/:id/imagen', async (req, res) => {
  const body = req.body || {};
  const sk = crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    PK: req.params.id,
    SK: sk,
    Locales: Array.isArray(body.Locales) ? body.Locales : [],
    Acciones: Array.isArray(body.Acciones) ? body.Acciones : [],
    Importe: typeof body.Importe === 'number' ? body.Importe : parseFloat(body.Importe) || 0,
    Justificantes: Array.isArray(body.Justificantes) ? body.Justificantes : [],
    Descripcion: body.Descripcion || '',
    Realizado: body.Realizado === true,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await docClient.send(new PutCommand({ TableName: tableAcuerdosImagenName, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[acuerdos imagen POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear pago por imagen' });
  }
});

app.patch('/api/acuerdos/:id/imagen/:sk', async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = {};
  const names = {};
  if (body.Locales !== undefined) { updates.push('#lo = :lo'); values[':lo'] = Array.isArray(body.Locales) ? body.Locales : []; names['#lo'] = 'Locales'; }
  if (body.Acciones !== undefined) { updates.push('#ac = :ac'); values[':ac'] = Array.isArray(body.Acciones) ? body.Acciones : []; names['#ac'] = 'Acciones'; }
  if (body.Importe !== undefined) { updates.push('Importe = :im'); values[':im'] = typeof body.Importe === 'number' ? body.Importe : parseFloat(body.Importe) || 0; }
  if (body.Justificantes !== undefined) { updates.push('Justificantes = :ju'); values[':ju'] = Array.isArray(body.Justificantes) ? body.Justificantes : []; }
  if (body.Descripcion !== undefined) { updates.push('Descripcion = :de'); values[':de'] = body.Descripcion || ''; }
  if (body.Realizado !== undefined) { updates.push('Realizado = :re'); values[':re'] = body.Realizado === true; }
  updates.push('updatedAt = :ua'); values[':ua'] = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdosImagenName,
      Key: { PK: req.params.id, SK: req.params.sk },
      UpdateExpression: 'SET ' + updates.join(', '),
      ExpressionAttributeValues: values,
      ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos imagen PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar pago por imagen' });
  }
});

app.delete('/api/acuerdos/:id/imagen/:sk', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableAcuerdosImagenName,
      Key: { PK: req.params.id, SK: req.params.sk },
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos imagen DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar pago por imagen' });
  }
});

// ──────────────────────────────────────────
// ──────────────────────────────────────────
// Archivos de Acuerdos  (S3 + metadata en DynamoDB)
// ──────────────────────────────────────────

app.post('/api/acuerdos/:id/files/presign-upload', async (req, res) => {
  try {
    const { id } = req.params;
    const { fileName, contentType } = req.body;
    if (!fileName || !contentType) return res.status(400).json({ error: 'fileName y contentType requeridos' });

    const fileKey = `acuerdos/${id}/${Date.now()}_${fileName}`;
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    res.json({ uploadUrl, fileKey });
  } catch (err) {
    console.error('presign-upload error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/acuerdos/:id/files', async (req, res) => {
  try {
    const { id } = req.params;
    const { fileKey, fileName, contentType, size } = req.body;
    if (!fileKey || !fileName) return res.status(400).json({ error: 'fileKey y fileName requeridos' });

    const acuerdoRes = await docClient.send(new GetCommand({
      TableName: tableAcuerdosName,
      Key: { PK: id, SK: 'META' },
    }));
    const acuerdo = acuerdoRes.Item;
    if (!acuerdo) return res.status(404).json({ error: 'Acuerdo no encontrado' });

    const archivos = acuerdo.Archivos || [];
    archivos.push({ fileKey, fileName, contentType: contentType || '', size: size || 0, uploadedAt: new Date().toISOString() });

    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdosName,
      Key: { PK: id, SK: 'META' },
      UpdateExpression: 'SET Archivos = :a',
      ExpressionAttributeValues: { ':a': archivos },
    }));

    res.json({ archivos });
  } catch (err) {
    console.error('save file meta error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/acuerdos/:id/files', async (req, res) => {
  try {
    const { id } = req.params;
    const acuerdoRes = await docClient.send(new GetCommand({
      TableName: tableAcuerdosName,
      Key: { PK: id, SK: 'META' },
    }));
    const archivos = acuerdoRes.Item?.Archivos || [];

    const withUrls = await Promise.all(archivos.map(async (f) => {
      const cmd = new S3GetObjectCommand({ Bucket: S3_BUCKET, Key: f.fileKey });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      return { ...f, url };
    }));

    res.json(withUrls);
  } catch (err) {
    console.error('list files error', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/acuerdos/:id/files/:encodedKey', async (req, res) => {
  try {
    const { id, encodedKey } = req.params;
    const fileKey = decodeURIComponent(encodedKey);

    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: fileKey }));

    const acuerdoRes = await docClient.send(new GetCommand({
      TableName: tableAcuerdosName,
      Key: { PK: id, SK: 'META' },
    }));
    const archivos = (acuerdoRes.Item?.Archivos || []).filter(f => f.fileKey !== fileKey);

    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdosName,
      Key: { PK: id, SK: 'META' },
      UpdateExpression: 'SET Archivos = :a',
      ExpressionAttributeValues: { ':a': archivos },
    }));

    res.json({ ok: true, archivos });
  } catch (err) {
    console.error('delete file error', err);
    res.status(500).json({ error: err.message });
  }
});

// Compras a Proveedor – detalle por producto (registros completos)
app.get('/api/agora/purchases/por-producto', async (req, res) => {
  const { productId, fechaInicio, fechaFin } = req.query;
  if (!productId) return res.status(400).json({ error: 'productId es obligatorio' });

  try {
    let items = [];

    if (gsiComprasReady) {
      let keyExpr = 'ProductId = :pid';
      const exprVals = { ':pid': String(productId) };
      if (fechaInicio && fechaFin) {
        keyExpr += ' AND AlbaranFecha BETWEEN :fi AND :ff';
        exprVals[':fi'] = fechaInicio <= fechaFin ? fechaInicio : fechaFin;
        exprVals[':ff'] = fechaInicio <= fechaFin ? fechaFin : fechaInicio;
      } else if (fechaInicio) {
        keyExpr += ' AND AlbaranFecha >= :fi';
        exprVals[':fi'] = fechaInicio;
      } else if (fechaFin) {
        keyExpr += ' AND AlbaranFecha <= :ff';
        exprVals[':ff'] = fechaFin;
      }

      const keys = [];
      let lastKey = null;
      do {
        const r = await docClient.send(new QueryCommand({
          TableName: tableComprasProveedorName,
          IndexName: GSI_COMPRAS_NAME,
          KeyConditionExpression: keyExpr,
          ExpressionAttributeValues: exprVals,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        for (const item of (r.Items || [])) {
          if (item.PK && item.SK) keys.push({ PK: item.PK, SK: item.SK });
        }
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);

      if (keys.length > 0) {
        for (let i = 0; i < keys.length; i += 100) {
          const chunk = keys.slice(i, i + 100);
          const r = await docClient.send(new BatchGetCommand({
            RequestItems: { [tableComprasProveedorName]: { Keys: chunk } },
          }));
          items.push(...(r.Responses?.[tableComprasProveedorName] || []));
        }
      }
    } else {
      let cKey = null;
      const all = [];
      do {
        const r = await docClient.send(new ScanCommand({ TableName: tableComprasProveedorName, ...(cKey && { ExclusiveStartKey: cKey }) }));
        all.push(...(r.Items || []));
        cKey = r.LastEvaluatedKey || null;
      } while (cKey);

      const pid = String(productId).trim();
      items = all.filter((c) => {
        if (String(c.ProductId || '').trim() !== pid) return false;
        const f = c.AlbaranFecha || '';
        if (fechaInicio && f < fechaInicio) return false;
        if (fechaFin && f > fechaFin) return false;
        return true;
      });
    }

    items.sort((a, b) => (b.AlbaranFecha || '').localeCompare(a.AlbaranFecha || ''));
    return res.json({ ok: true, items, total: items.length });
  } catch (err) {
    console.error('[agora/purchases/por-producto]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al buscar compras por producto' });
  }
});

// Compras a Proveedor (Albaranes de Entrada)
// ──────────────────────────────────────────

app.get('/api/agora/purchases', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableComprasProveedorName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    items.sort((a, b) => {
      const da = a.AlbaranFecha || '';
      const db = b.AlbaranFecha || '';
      if (da !== db) return db.localeCompare(da);
      const sa = `${a.AlbaranSerie || ''}${a.AlbaranNumero || ''}`;
      const sb = `${b.AlbaranSerie || ''}${b.AlbaranNumero || ''}`;
      return sa.localeCompare(sb);
    });

    return res.json({ ok: true, items, total: items.length });
  } catch (err) {
    console.error('[agora/purchases GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar compras a proveedor' });
  }
});

app.post('/api/agora/purchases/sync', async (req, res) => {
  const body = req.body || {};
  const today = new Date().toISOString().slice(0, 10);
  const default60daysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateFrom = (body.dateFrom || default60daysAgo).toString().trim();
  const dateTo = (body.dateTo || today).toString().trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo deben ser YYYY-MM-DD' });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ error: 'dateFrom no puede ser mayor que dateTo' });
  }

  try {
    const days = [];
    let d = new Date(dateFrom + 'T12:00:00');
    const end = new Date(dateTo + 'T12:00:00');
    while (d <= end) {
      days.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }

    let totalFetched = 0;
    let totalUpserted = 0;
    const errors = [];

    for (let i = 0; i < days.length; i++) {
      const businessDay = days[i];
      try {
        const data = await exportIncomingDeliveryNotes(businessDay);
        const notes =
          data?.IncomingDeliveryNotes ??
          data?.incomingDeliveryNotes ??
          (Array.isArray(data) ? data : []);
        if (!Array.isArray(notes) || notes.length === 0) continue;

        const flatLines = [];
        for (const note of notes) {
          const serie = note.Serie ?? note.serie ?? '';
          const number = note.Number ?? note.number ?? '';
          const noteDate = note.Date ?? note.date ?? businessDay;
          const supplierDocNum = note.SupplierDocumentNumber ?? note.supplierDocumentNumber ?? '';
          const confirmed = note.Confirmed ?? note.confirmed ?? false;
          const invoiced = note.Invoiced ?? note.invoiced ?? false;

          const supplier = note.Supplier ?? note.supplier ?? {};
          const supplierId = supplier.Id ?? supplier.id ?? '';
          const supplierName = supplier.FiscalName ?? supplier.fiscalName ?? '';
          const supplierCif = supplier.Cif ?? supplier.cif ?? '';

          const warehouse = note.Warehouse ?? note.warehouse ?? {};
          const warehouseId = warehouse.Id ?? warehouse.id ?? '';
          const warehouseName = warehouse.Name ?? warehouse.name ?? '';

          const totals = note.Totals ?? note.totals ?? {};
          const discounts = note.Discounts ?? note.discounts ?? {};

          const lines = note.Lines ?? note.lines ?? [];
          if (!Array.isArray(lines)) continue;

          for (const line of lines) {
            const idx = line.Index ?? line.index ?? 0;
            const productId = line.ProductId ?? line.productId ?? '';
            const productName = line.ProductName ?? line.productName ?? '';
            const quantity = line.Quantity ?? line.quantity ?? 0;
            const price = line.Price ?? line.price ?? 0;
            const discountRate = line.DiscountRate ?? line.discountRate ?? 0;
            const cashDiscount = line.CashDiscount ?? line.cashDiscount ?? 0;
            const totalAmount = line.TotalAmount ?? line.totalAmount ?? 0;
            const vatRate = line.VatRate ?? line.vatRate ?? 0;
            const surchargeRate = line.SurchargeRate ?? line.surchargeRate ?? 0;
            const purchaseUnitName = line.PurchaseUnitName ?? line.purchaseUnitName ?? '';
            const familyId = line.FamilyId ?? line.familyId ?? '';
            const familyName = line.FamilyName ?? line.familyName ?? '';
            const lotNumber = line.LotNumber ?? line.lotNumber ?? '';
            const notes = line.Notes ?? line.notes ?? '';

            const pk = `${serie}#${number}`;
            const sk = `${String(idx).padStart(4, '0')}`;

            flatLines.push({
              PK: pk,
              SK: sk,
              AlbaranSerie: serie,
              AlbaranNumero: String(number),
              AlbaranFecha: noteDate,
              SupplierDocumentNumber: supplierDocNum,
              Confirmed: confirmed,
              Invoiced: invoiced,
              SupplierId: String(supplierId),
              SupplierName: supplierName,
              SupplierCif: supplierCif,
              WarehouseId: String(warehouseId),
              WarehouseName: warehouseName,
              LineIndex: idx,
              ProductId: String(productId),
              ProductName: productName,
              Quantity: typeof quantity === 'number' ? quantity : parseFloat(String(quantity)) || 0,
              Price: typeof price === 'number' ? price : parseFloat(String(price)) || 0,
              DiscountRate: typeof discountRate === 'number' ? discountRate : parseFloat(String(discountRate)) || 0,
              CashDiscount: typeof cashDiscount === 'number' ? cashDiscount : parseFloat(String(cashDiscount)) || 0,
              TotalAmount: typeof totalAmount === 'number' ? totalAmount : parseFloat(String(totalAmount)) || 0,
              VatRate: typeof vatRate === 'number' ? vatRate : parseFloat(String(vatRate)) || 0,
              SurchargeRate: typeof surchargeRate === 'number' ? surchargeRate : parseFloat(String(surchargeRate)) || 0,
              PurchaseUnitName: purchaseUnitName,
              FamilyId: String(familyId),
              FamilyName: familyName,
              LotNumber: lotNumber,
              LineNotes: notes,
              AlbaranGrossAmount: totals.GrossAmount ?? totals.grossAmount ?? null,
              AlbaranNetAmount: totals.NetAmount ?? totals.netAmount ?? null,
              AlbaranDiscountRate: discounts.DiscountRate ?? discounts.discountRate ?? 0,
              syncedAt: new Date().toISOString(),
            });
          }
        }

        if (flatLines.length === 0) continue;
        totalFetched += flatLines.length;

        for (let j = 0; j < flatLines.length; j += 25) {
          const chunk = flatLines.slice(j, j + 25);
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [tableComprasProveedorName]: chunk.map((item) => ({
                  PutRequest: { Item: item },
                })),
              },
            })
          );
          totalUpserted += chunk.length;
        }
      } catch (err) {
        errors.push({ day: businessDay, error: err.message || String(err) });
      }

      if ((i + 1) % 30 === 0) {
        console.log('[agora/purchases/sync] Progreso:', i + 1, '/', days.length, 'días');
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    console.log('[agora/purchases/sync] Completado:', { dateFrom, dateTo, totalFetched, totalUpserted, errors: errors.length });
    return res.json({
      ok: true,
      dateFrom,
      dateTo,
      totalFetched,
      totalUpserted,
      daysProcessed: days.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('[agora/purchases/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar compras a proveedor' });
  }
});

const port = process.env.PORT || 3001;
const host = '0.0.0.0';
const SYNC_CLOSEOUTS_INTERVAL_MS = parseInt(process.env.SYNC_CLOSEOUTS_INTERVAL_MS || '120000', 10) || 120000;
const SYNC_CLOSEOUTS_RECENT_DAYS = parseInt(process.env.SYNC_CLOSEOUTS_RECENT_DAYS || '7', 10) || 7;
const SYNC_CLOSEOUTS_ENABLED = process.env.SYNC_CLOSEOUTS_ENABLED === 'true';

async function runCloseoutsSync() {
  if (!SYNC_CLOSEOUTS_ENABLED) return;
  const today = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - SYNC_CLOSEOUTS_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${baseUrl}/api/agora/closeouts/full-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateFrom, dateTo: today, deleteOutOfRange: false }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`[closeouts/sync] OK: ${dateFrom} → ${today} | upserted: ${data.totalUpserted ?? 0}`);
    } else {
      console.error('[closeouts/sync] Error:', data.error || res.statusText);
    }
  } catch (err) {
    console.error('[closeouts/sync]', err.message || err);
  }
}

app.use('/api', facturacionRouter);

// ─── Check vencimientos facturas ───
const VENCIMIENTOS_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

async function checkVencimientosFacturas() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/facturacion/check-vencimientos`, { method: 'POST' });
    const data = await res.json();
    if (data.actualizadas > 0) {
      console.log(`[vencimientos] ${data.actualizadas} factura(s) marcada(s) como vencida(s)`);
    }
  } catch (err) {
    console.error('[vencimientos]', err.message || err);
  }

  if (process.env.SMTP_USER) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/facturacion/enviar-recordatorios`, { method: 'POST' });
      const data = await res.json();
      if (data.enviados > 0) {
        console.log(`[recordatorios] ${data.enviados} recordatorio(s) de cobro enviado(s)`);
      }
    } catch (err) {
      console.error('[recordatorios]', err.message || err);
    }
  }
}

app.listen(port, host, () => {
  console.log(`API ERP escuchando en http://localhost:${port} (también http://127.0.0.1:${port})`);
  console.log(`Tabla usuarios: ${tableName} | Tabla locales: ${tableLocalesName} | Tabla empresas: ${tableEmpresasName} | Tabla productos: ${tableProductosName} | Centros venta: ${tableSaleCentersName} | Cierres ventas: ${tableSalesCloseOutsName} | Mantenimiento: ${tableMantenimientoName} | Roles/permisos: ${tableRolesPermisosName}`);
  if (SYNC_CLOSEOUTS_ENABLED) {
    console.log(`Sincronización cierres Ágora: cada ${SYNC_CLOSEOUTS_INTERVAL_MS / 1000}s (últimos ${SYNC_CLOSEOUTS_RECENT_DAYS} días)`);
    setTimeout(() => runCloseoutsSync(), 2000);
    setInterval(runCloseoutsSync, SYNC_CLOSEOUTS_INTERVAL_MS);
  }
  setTimeout(() => checkVencimientosFacturas(), 5000);
  setInterval(checkVencimientosFacturas, VENCIMIENTOS_INTERVAL_MS);
  console.log(`[vencimientos] Check automático cada ${VENCIMIENTOS_INTERVAL_MS / 60000} min`);
});
