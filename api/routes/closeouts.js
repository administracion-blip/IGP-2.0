import express from 'express';
import { ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();
const tableSalesCloseOutsName = tables.salesCloseOuts;
const tableSaleCentersName = tables.saleCenters;
const tableLocalesName = tables.locales;

// Diagnóstico: si esto responde 200, el servidor tiene las rutas de closeouts
router.get('/agora/closeouts-ready', (_req, res) => {
  res.json({ ok: true, closeoutsRoute: 'registered' });
});

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

// GET /agora/closeouts
router.get('/agora/closeouts', async (req, res) => {
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

// POST /agora/closeouts - Crear registro manual
router.post('/agora/closeouts', async (req, res) => {
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

// PUT /agora/closeouts - Actualizar registro
// Si BusinessDay cambia, la SK cambia (SK = businessDay#posId#number). DynamoDB no permite
// actualizar la clave primaria, así que hay que borrar el viejo y crear uno nuevo.
router.put('/agora/closeouts', async (req, res) => {
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

// DELETE /agora/closeouts - Eliminar registro
router.delete('/agora/closeouts', async (req, res) => {
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

// GET /agora/closeouts/totals-by-local-range?workplaceId=X&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
router.get('/agora/closeouts/totals-by-local-range', async (req, res) => {
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

// GET /agora/closeouts/totals-by-local?businessDay=YYYY-MM-DD
router.get('/agora/closeouts/totals-by-local', async (req, res) => {
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

// GET /agora/closeouts/totals-by-local-ytd?year=YYYY&dateTo=YYYY-MM-DD
router.get('/agora/closeouts/totals-by-local-ytd', async (req, res) => {
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

// GET /agora/closeouts/totals-by-month?year=YYYY&dateTo=YYYY-MM-DD
const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
router.get('/agora/closeouts/totals-by-month', async (req, res) => {
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

export default router;
