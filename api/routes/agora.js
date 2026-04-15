import { Router } from 'express';
import {
  QueryCommand,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import {
  exportSystemCloseOuts,
  exportPosCloseOuts,
  exportInvoices,
  exportWarehouses,
  exportFamilies,
  exportVats,
  exportIncomingDeliveryNotes,
} from '../lib/agora/client.js';
import { upsertBatch } from '../lib/dynamo/salesCloseOuts.js';
import {
  syncProducts,
  getLastSync,
  setLastSync,
  shouldSkipSyncByThrottle,
  toApiProduct,
  pickAllowedFields,
  updatePurchaseVatRates,
} from '../lib/dynamo/agoraProducts.js';
import {
  MONTH_LABELS,
  extractNumberFromSk,
  formatFechaNegocio,
  addExcelStyleFields,
  normalizeCloseOutForResponse,
} from '../lib/agora/closeoutReadHelpers.js';
import {
  enrichItemsOpenCloseDatesFromAuxiliary,
  accumulateOpenCloseEnrichmentTotals,
} from '../lib/agora/closeoutSyncHelpers.js';
import {
  GSI_COMPRAS_NAME,
  isGsiReady,
} from '../lib/dynamo/comprasProveedor.js';

const router = Router();
const env = () => ({
  AGORA_API_BASE_URL: process.env.AGORA_API_BASE_URL || '',
  AGORA_API_TOKEN: process.env.AGORA_API_TOKEN || '',
});

const tableAgoraProductsName = tables.agoraProducts;
const tableSaleCentersName = tables.saleCenters;
const tableSalesCloseOutsName = tables.salesCloseOuts;
const tableAlmacenesName = tables.almacenes;
const tableLocalesName = tables.locales;
const tableComprasProveedorName = tables.comprasProveedor;

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

// --- Cierres de ventas: constantes y helpers ---
const AGORA_PAYMENT_METHOD_ID = {
  1: 'Efectivo',
  2: 'Tarjeta',
  4: 'Pendiente de cobro',
  5: 'Prepago Transferencia',
  7: 'AgoraPay',
};
const STRING_KEY_TO_CANONICAL = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  card: 'Tarjeta',
  'pendiente de cobro': 'Pendiente de cobro',
  pending: 'Pendiente de cobro',
  'prepago transferencia': 'Prepago Transferencia',
  transferencia: 'Prepago Transferencia',
  agorapay: 'AgoraPay',
  'agora pay': 'AgoraPay',
};
const CANONICAL_PAYMENT_NAMES = [
  'Efectivo',
  'Tarjeta',
  'Pendiente de cobro',
  'Prepago Transferencia',
  'AgoraPay',
];

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
  const toMerge = [
    raw?.CloseOut ?? raw?.closeOut,
    raw?.Data ?? raw?.data,
    raw?.Record ?? raw?.record,
  ].filter((x) => x != null && typeof x === 'object' && !Array.isArray(x));
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
  const totalsByMethod =
    r?.TotalsByMethod ??
    r?.totalsByMethod ??
    r?.PaymentsByMethod ??
    r?.paymentsByMethod ??
    amounts?.TotalsByMethod;
  let gross =
    findValue(amounts, [
      'GrossAmount',
      'grossAmount',
      'Total',
      'total',
      'Importe',
      'importe',
      'Ventas',
      'ventas',
      'Sales',
      'sales',
    ]) ?? findValue(r, ['GrossAmount', 'grossAmount', 'Total', 'total', 'Ventas', 'ventas']);
  const net = findValue(amounts, ['NetAmount', 'netAmount']) ?? null;
  const vat = findValue(amounts, ['VatAmount', 'vatAmount']) ?? null;
  const surcharge = findValue(amounts, ['SurchargeAmount', 'surchargeAmount']) ?? null;

  if (
    (gross == null || gross === 0) &&
    totalsByMethod &&
    typeof totalsByMethod === 'object' &&
    !Array.isArray(totalsByMethod)
  ) {
    const sumFromTotals = Object.values(totalsByMethod).reduce((s, v) => {
      const n =
        typeof v === 'number' ? v : parseFloat(String(v || 0).replace(',', '.')) || 0;
      return s + n;
    }, 0);
    if (sumFromTotals > 0) gross = sumFromTotals;
  }
  const balances = r?.Balances ?? r?.balances ?? [];
  if ((gross == null || gross === 0) && Array.isArray(balances) && balances.length > 1) {
    const sumBalances = balances.reduce(
      (s, b) => s + (Number(b?.ActualEndAmount ?? b?.actualEndAmount ?? b?.ExpectedEndAmount ?? 0) || 0),
      0
    );
    if (sumBalances > 0) gross = sumBalances;
  }

  const toPayment = (b) => {
    const id = b?.PaymentMethodId ?? b?.paymentMethodId ?? b?.Id ?? b?.id;
    const name =
      findValue(b, ['MethodName', 'methodName', 'Name', 'name']) ??
      (id != null ? AGORA_PAYMENT_METHOD_ID[id] ?? AGORA_PAYMENT_METHOD_ID[String(id)] ?? `Método ${id}` : null);
    const amt =
      b?.ActualEndAmount ??
      b?.actualEndAmount ??
      b?.ExpectedEndAmount ??
      b?.expectedEndAmount ??
      b?.Amount ??
      b?.amount ??
      0;
    return {
      MethodName: name,
      Amount: typeof amt === 'number' ? amt : parseFloat(String(amt).replace(',', '.')) || 0,
    };
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
  if (
    totalsByMethod &&
    typeof totalsByMethod === 'object' &&
    !Array.isArray(totalsByMethod)
  ) {
    for (const [key, val] of Object.entries(totalsByMethod)) {
      if (val == null || (typeof val !== 'number' && String(val).trim() === '')) continue;
      const name = resolveMethodName(key);
      const amt =
        typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.')) || 0;
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
      if (
        p?.PaymentMethodId != null ||
        p?.paymentMethodId != null ||
        p?.Id != null ||
        p?.id != null
      )
        allPayments.push(toPayment(p));
      else {
        const name = findValue(p, ['MethodName', 'methodName', 'Name', 'name']);
        const amt =
          findValue(p, [
            'Amount',
            'amount',
            'Value',
            'value',
            'ActualEndAmount',
            'actualEndAmount',
          ]) ?? 0;
        if (name != null || amt != null)
          allPayments.push({
            MethodName: name ?? 'Sin nombre',
            Amount:
              typeof amt === 'number' ? amt : parseFloat(String(amt).replace(',', '.')) || 0,
          });
      }
    }
  }

  const byMethod = new Map();
  for (const p of allPayments) {
    const name = (p.MethodName ?? 'Sin nombre').toString().trim() || 'Sin nombre';
    const amt =
      typeof p.Amount === 'number' ? p.Amount : parseFloat(String(p.Amount || 0).replace(',', '.')) || 0;
    const prev = byMethod.get(name) ?? 0;
    byMethod.set(name, prev + amt);
  }
  allPayments = [...byMethod.entries()]
    .map(([name, amt]) => ({ MethodName: name === 'Sin nombre' ? null : name, Amount: amt }))
    .filter((p) => p.MethodName != null || p.Amount != null);

  if (allPayments.length > 0) {
    const byName = new Map(
      allPayments.map((p) => [String(p.MethodName || '').trim(), p.Amount]).filter(([n]) => n)
    );
    const extras = [...byName.entries()].filter(([n]) => !CANONICAL_PAYMENT_NAMES.includes(n));
    allPayments = [
      ...CANONICAL_PAYMENT_NAMES.map((name) => ({ MethodName: name, Amount: byName.get(name) ?? 0 })),
      ...extras.map(([name, amt]) => ({ MethodName: name, Amount: amt })),
    ];
    if (gross == null || gross === 0) {
      const sumPayments = allPayments.reduce(
        (s, p) => s + (Number(p?.Amount ?? 0) || 0),
        0
      );
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
  const posId =
    findValue(r, ['PosId', 'posId', 'PointOfSaleId', 'pointOfSaleId']) ??
    r?.Pos?.Id ??
    r?.PointOfSale?.Id ??
    r?.PointsOfSale?.[0]?.Id ??
    null;
  const posName =
    findValue(r, ['PosName', 'posName', 'PointOfSaleName', 'pointOfSaleName']) ??
    r?.Pos?.Name ??
    r?.PointOfSale?.Name ??
    r?.PointsOfSale?.[0]?.Name ??
    null;
  return { posId, posName };
}

function extractCloseOutNumber(raw) {
  const r = getMappableRaw(raw);
  let v = findValue(r, [
    'CloseOutNumber',
    'closeOutNumber',
    'Number',
    'number',
    'Numero',
    'numero',
    'Id',
    'id',
    'CloseOutId',
    'CloseOutNo',
    'Sequence',
  ]);
  if (v != null && v !== '') return v;
  const docs = r?.Documents ?? r?.documents ?? [];
  if (Array.isArray(docs) && docs.length > 0) {
    const d = docs[0];
    v =
      findValue(d, ['LastNumber', 'lastNumber', 'UltimoNumero']) ??
      findValue(d, ['FirstNumber', 'firstNumber']) ??
      findValue(d, ['Number', 'number']);
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

function aggregateInvoicesByWorkplaceAndPos(invoices, businessDay) {
  if (!Array.isArray(invoices) || invoices.length === 0) return [];
  const groups = new Map();
  const CANONICAL_NAMES = [
    'Efectivo',
    'Tarjeta',
    'Pendiente de cobro',
    'Prepago Transferencia',
    'AgoraPay',
  ];

  for (const inv of invoices) {
    const workplaceId = String(
      inv?.Workplace?.Id ?? inv?.workplace?.id ?? inv?.WorkplaceId ?? inv?.workplaceId ?? ''
    ).trim() || '0';
    const posId = inv?.Pos?.Id ?? inv?.pos?.id ?? inv?.PosId ?? inv?.posId ?? null;
    const posName = inv?.Pos?.Name ?? inv?.pos?.name ?? inv?.PosName ?? inv?.posName ?? null;
    const workplaceName =
      inv?.Workplace?.Name ?? inv?.workplace?.name ?? inv?.WorkplaceName ?? inv?.workplaceName ?? null;
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
      const amt =
        typeof p?.Amount === 'number'
          ? p.Amount
          : parseFloat(String(p?.Amount ?? p?.amount ?? 0).replace(',', '.')) || 0;
      if (name) {
        const canon = CANONICAL_NAMES.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
        g.InvoicePayments[canon] = (g.InvoicePayments[canon] ?? 0) + amt;
      }
    }
  }

  return [...groups.values()]
    .map((g) => {
      const payments = [
        ...CANONICAL_NAMES.filter((n) => (g.InvoicePayments[n] ?? 0) > 0).map((n) => ({
          MethodName: n,
          Amount: g.InvoicePayments[n],
        })),
        ...Object.entries(g.InvoicePayments)
          .filter(([n]) => !CANONICAL_NAMES.includes(n) && (g.InvoicePayments[n] ?? 0) > 0)
          .map(([n, a]) => ({ MethodName: n, Amount: a })),
      ];
      return { ...g, InvoicePayments: payments };
    })
    .filter((g) => g.Amounts.GrossAmount > 0 || g.InvoicePayments.some((p) => (p?.Amount ?? 0) > 0));
}

function getGrossFromRaw(r) {
  const raw = getMappableRaw(r);
  const amounts = raw?.Amounts ?? raw?.amounts ?? raw?.Totals ?? raw?.totals ?? {};
  let gross =
    findValue(amounts, ['GrossAmount', 'grossAmount', 'Total', 'total']) ??
    raw?.ActualEndAmount ??
    raw?.actualEndAmount ??
    raw?.ExpectedEndAmount ??
    0;
  const balances = raw?.Balances ?? raw?.balances ?? [];
  if ((gross == null || gross === 0) && Array.isArray(balances) && balances.length > 0) {
    gross = balances.reduce(
      (s, b) => s + (Number(b?.ActualEndAmount ?? b?.actualEndAmount ?? b?.ExpectedEndAmount ?? 0) || 0),
      0
    );
  }
  return typeof gross === 'number' ? gross : parseFloat(String(gross || 0).replace(',', '.')) || 0;
}

function buildPaymentSourceByRecord(rawList, sysByWorkplace, usePos) {
  const map = new Map();
  if (!usePos || sysByWorkplace.size === 0) {
    for (const r of rawList) {
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
        Amount:
          (typeof p?.Amount === 'number'
            ? p.Amount
            : parseFloat(String(p?.Amount || 0).replace(',', '.')) || 0) * ratio,
      }));
      map.set(r, { InvoicePayments: scaledPayments });
    }
  }
  return map;
}

function mapCloseOutToItem(raw, businessDayOverride = '', paymentSource = null) {
  const r = getMappableRaw(raw);
  let workplaceId =
    String(
      findValue(r, [
        'WorkplaceId',
        'workplaceId',
        'WokrplaceId',
        'LocalId',
        'localId',
        'Workplace',
        'workplace',
      ]) ?? r?.WorkplaceId ?? r?.Workplace?.Id ?? ''
    ) || '0';
  if (!workplaceId.trim()) workplaceId = '0';
  const workplaceName =
    findValue(r, ['WorkplaceName', 'workplaceName', 'LocalName', 'localName']) ??
    r?.Workplace?.Name ??
    r?.Workplace?.name ??
    null;
  const businessDay =
    String(
      findValue(r, ['BusinessDay', 'businessDay', 'Fecha', 'fecha', 'Date', 'date']) ??
        r?.BusinessDay ??
        businessDayOverride ??
        ''
    ) || businessDayOverride || '';
  let number =
    extractCloseOutNumber(raw) ??
    findValue(r, ['Number', 'number', 'CloseOutNumber', 'Numero', 'Id']) ??
    '';
  if (number == null || number === '') number = '';
  const numStr = number != null && String(number).trim() !== '' ? String(number) : '0';
  const { posId: posIdVal, posName } = extractPosFromRaw(r);
  const posIdStr = posIdVal != null && posIdVal !== '' ? String(posIdVal) : '0';
  const bd = businessDay || businessDayOverride;
  const sk = bd ? (posIdStr !== '0' ? `${bd}#${posIdStr}#${numStr}` : `${bd}#${numStr}`) : '';
  const extracted = extractAmountsAndPayments(raw);
  const fromSource = paymentSource ? extractAmountsAndPayments(paymentSource) : null;
  const amountsObj = extracted.Amounts;
  const gross =
    typeof amountsObj?.GrossAmount === 'number'
      ? amountsObj.GrossAmount
      : parseFloat(String(amountsObj?.GrossAmount ?? amountsObj?.grossAmount ?? 0).replace(',', '.')) || 0;
  const sumExtracted = (extracted.InvoicePayments ?? []).reduce(
    (s, p) =>
      s +
      (typeof p?.Amount === 'number' ? p.Amount : parseFloat(String(p?.Amount ?? 0).replace(',', '.')) || 0),
    0
  );
  const posPaymentsReasonable =
    (extracted.InvoicePayments?.length ?? 0) > 0 &&
    gross > 0 &&
    Math.abs(sumExtracted - gross) <= Math.max(0.01, gross * 0.02);
  const allPayments = posPaymentsReasonable
    ? extracted.InvoicePayments
    : fromSource?.InvoicePayments?.length > 0
      ? fromSource.InvoicePayments
      : extracted.InvoicePayments;
  const documents = Array.isArray(r?.Documents) ? r.Documents : Array.isArray(r?.documents) ? r.documents : [];
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

function validateAgoraCloseOut(raw) {
  if (!raw || typeof raw !== 'object') return { valid: false, reason: 'Registro vacío o no objeto' };
  const r = getMappableRaw(raw);
  const workplaceId =
    findValue(r, ['WorkplaceId', 'workplaceId', 'LocalId', 'localId']) ??
    r?.WorkplaceId ??
    r?.Workplace?.Id;
  if (!workplaceId && workplaceId !== 0) return { valid: false, reason: 'Falta WorkplaceId' };
  const businessDay =
    findValue(r, ['BusinessDay', 'businessDay', 'Date', 'date']) ?? r?.BusinessDay;
  if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(String(businessDay)))
    return { valid: false, reason: 'BusinessDay inválido o ausente' };
  const amounts = r?.Amounts ?? r?.amounts ?? r?.Totals ?? r?.totals ?? {};
  const gross =
    findValue(amounts, ['GrossAmount', 'grossAmount', 'Total', 'total']) ??
    findValue(r, ['ActualEndAmount', 'actualEndAmount']);
  const balances = r?.Balances ?? r?.balances ?? [];
  const hasAmount =
    (gross != null && (typeof gross === 'number' || !Number.isNaN(parseFloat(String(gross))))) ||
    (Array.isArray(balances) && balances.length > 0);
  if (!hasAmount) return { valid: false, reason: 'Falta importe (GrossAmount/Total/Balances)' };
  return { valid: true };
}

// --- Rutas ---

// --- Fase C: lectura / dashboard de cierres ---

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

router.get('/agora/closeouts/dashboard-home', async (req, res) => {
  const dateTo = (req.query.dateTo && String(req.query.dateTo).trim()) || '';
  if (!dateTo || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateTo obligatorio (YYYY-MM-DD)' });
  }
  const curYear = parseInt(dateTo.slice(0, 4), 10);
  const lastYearNum = curYear - 1;
  const dateToLastYear = `${lastYearNum}-${dateTo.slice(5, 10)}`;
  const prefixCur = `${curYear}-`;
  const prefixLast = `${lastYearNum}-`;
  const useDateToCur = dateTo.startsWith(`${curYear}-`);
  const useDateToLast = dateToLastYear.startsWith(`${lastYearNum}-`);

  const sumInvoicePayments = (item) => {
    const arr = item.InvoicePayments ?? item.invoicePayments;
    let total = 0;
    if (Array.isArray(arr)) {
      for (const p of arr) {
        total += Number(p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? 0) || 0;
      }
    }
    return total;
  };

  try {
    const [items, localeItems] = await Promise.all([
      (async () => {
        const acc = [];
        let lastKey = null;
        do {
          const result = await docClient.send(new ScanCommand({
            TableName: tableSalesCloseOutsName,
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          }));
          acc.push(...(result.Items || []));
          lastKey = result.LastEvaluatedKey || null;
        } while (lastKey);
        return acc;
      })(),
      (async () => {
        const acc = [];
        let locLastKey = null;
        do {
          const locResult = await docClient.send(new ScanCommand({
            TableName: tableLocalesName,
            ...(locLastKey && { ExclusiveStartKey: locLastKey }),
          }));
          acc.push(...(locResult.Items || []));
          locLastKey = locResult.LastEvaluatedKey || null;
        } while (locLastKey);
        return acc;
      })(),
    ]);

    const totalsTickerPk = {};
    const ytdCurPk = {};
    const ytdLastPk = {};
    const monthCur = {};
    const monthLast = {};

    for (const item of items) {
      const sk = String(item.SK ?? item.sk ?? '').trim();
      if (!sk) continue;
      const pk = String(item.PK ?? item.pk ?? '').trim();
      if (!pk) continue;
      const t = sumInvoicePayments(item);

      if (sk.startsWith(dateTo)) {
        totalsTickerPk[pk] = (totalsTickerPk[pk] || 0) + t;
      }

      const datePart = sk.split('#')[0] || '';

      if (sk.startsWith(prefixCur)) {
        if (!(useDateToCur && datePart > dateTo)) {
          ytdCurPk[pk] = (ytdCurPk[pk] || 0) + t;
          const mo = parseInt(datePart.slice(5, 7), 10) || 0;
          if (mo >= 1 && mo <= 12) {
            monthCur[mo] = (monthCur[mo] || 0) + t;
          }
        }
      }
      if (sk.startsWith(prefixLast)) {
        if (!(useDateToLast && datePart > dateToLastYear)) {
          ytdLastPk[pk] = (ytdLastPk[pk] || 0) + t;
          const mo = parseInt(datePart.slice(5, 7), 10) || 0;
          if (mo >= 1 && mo <= 12) {
            monthLast[mo] = (monthLast[mo] || 0) + t;
          }
        }
      }
    }

    const pkToNombre = {};
    for (const loc of localeItems) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) pkToNombre[code] = nombre || code;
    }

    const mapPkToTotals = (totalsByPk) =>
      Object.entries(totalsByPk)
        .filter(([, total]) => total > 0)
        .map(([workplaceId, total]) => ({
          local: pkToNombre[workplaceId] ?? workplaceId,
          total: Math.round(total * 100) / 100,
          workplaceId,
        }))
        .sort((a, b) => b.total - a.total);

    const monthsCurArr = [];
    const monthsLastArr = [];
    for (let m = 1; m <= 12; m++) {
      monthsCurArr.push({
        month: m,
        monthLabel: MONTH_LABELS[m - 1],
        total: Math.round((monthCur[m] || 0) * 100) / 100,
      });
      monthsLastArr.push({
        month: m,
        monthLabel: MONTH_LABELS[m - 1],
        total: Math.round((monthLast[m] || 0) * 100) / 100,
      });
    }

    res.json({
      dateTo,
      totalsTicker: mapPkToTotals(totalsTickerPk),
      ytdCurrent: {
        year: curYear,
        dateTo: useDateToCur ? dateTo : null,
        totals: mapPkToTotals(ytdCurPk),
      },
      ytdLastYear: {
        year: lastYearNum,
        dateTo: useDateToLast ? dateToLastYear : null,
        totals: mapPkToTotals(ytdLastPk),
      },
      monthsCurrent: {
        year: curYear,
        dateTo: useDateToCur ? dateTo : null,
        months: monthsCurArr,
      },
      monthsLastYear: {
        year: lastYearNum,
        dateTo: useDateToLast ? dateToLastYear : null,
        months: monthsLastArr,
      },
    });
  } catch (err) {
    console.error('[agora/closeouts/dashboard-home]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al cargar dashboard' });
  }
});

router.get('/agora/closeouts-ready', (_req, res) => {
  res.json({ ok: true, closeoutsRoute: 'registered' });
});

router.get('/agora/test-connection', async (req, res) => {
  const { AGORA_API_BASE_URL, AGORA_API_TOKEN } = env();
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

router.get('/agora/products', async (req, res) => {
  const forceAgora = (req.query.source || req.query.force || '').toString().toLowerCase() === 'agora';
  if (forceAgora) {
    const { AGORA_API_BASE_URL, AGORA_API_TOKEN } = env();
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
        return res.status(401).json({
          error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.',
        });
      }
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({ error: `Agora respondió ${r.status}: ${text.slice(0, 200)}` });
      }
      const data = await r.json().catch(() => null);
      const rawList = Array.isArray(data)
        ? data
        : (data?.productos ?? data?.Products ?? data?.Items ?? data?.data ?? []);
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

    const onlyIgp =
      (req.query.igp || req.query.IGP || '').toString() === '1' ||
      (req.query.igp || '').toString().toLowerCase() === 'true';
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
      return res.json({
        productos: [],
        error: 'Tabla Igp_AgoraProducts no existe. Ejecuta sync o crea la tabla.',
      });
    }
    console.error('[agora/products list]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar productos Ágora' });
  }
});

router.post('/agora/products/sync', async (req, res) => {
  const { AGORA_API_BASE_URL, AGORA_API_TOKEN } = env();
  const force =
    req.body?.force === true ||
    (req.query.force || req.body?.force || '').toString() === '1' ||
    (req.query.force || '').toString().toLowerCase() === 'true';
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
      return res.status(401).json({
        error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.',
      });
    }
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: `Agora respondió ${r.status}: ${text.slice(0, 200)}` });
    }

    const data = await r.json().catch(() => ({}));
    const rawList = Array.isArray(data)
      ? data
      : (data.productos ?? data.Products ?? data.Items ?? data.data ?? []);

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

    const { added, updated, unchanged } = await syncProducts(
      docClient,
      tableAgoraProductsName,
      rawList
    );

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
        error:
          'Tabla Igp_AgoraProducts no existe. Ejecuta: node api/scripts/create-agora-products-table.js',
      });
    }
    console.error('[agora/products/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar productos Ágora' });
  }
});

router.patch('/agora/products/igp/batch', async (req, res) => {
  const body = req.body || {};
  const raw = body.updates ?? body.Updates ?? [];
  const updates = Array.isArray(raw) ? raw : [];
  if (updates.length === 0) {
    return res.status(400).json({ error: 'Indica updates: [{ id, IGP }]' });
  }
  const valid = updates
    .map((u) => {
      const id = u.id ?? u.Id ?? u.ID;
      const igp = u.IGP ?? u.igp;
      if (id == null || id === '') return null;
      if (typeof igp !== 'boolean') return null;
      return { id: String(id), IGP: igp };
    })
    .filter(Boolean);
  if (valid.length === 0) {
    return res.status(400).json({ error: 'Ningún elemento válido (id + IGP boolean)' });
  }
  const PARALLEL_SIZE = 25;
  let updated = 0;
  const failed = [];
  for (let i = 0; i < valid.length; i += PARALLEL_SIZE) {
    const chunk = valid.slice(i, i + PARALLEL_SIZE);
    const results = await Promise.allSettled(
      chunk.map(({ id, IGP }) =>
        docClient.send(
          new UpdateCommand({
            TableName: tableAgoraProductsName,
            Key: { PK: 'GLOBAL', SK: String(id) },
            UpdateExpression: 'SET #igp = :v',
            ExpressionAttributeNames: { '#igp': 'IGP' },
            ExpressionAttributeValues: { ':v': IGP },
          })
        )
      )
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') updated++;
      else failed.push(chunk[idx].id);
    });
  }
  return res.json({
    ok: true,
    totalSolicitados: valid.length,
    totalActualizados: updated,
    totalFallidos: failed.length,
    idsFallidos: failed.length > 0 ? failed : undefined,
  });
});

router.patch('/agora/products/:id', async (req, res) => {
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
    return res.status(400).json({
      error:
        'Indica al menos un campo a actualizar (IGP, Name, CostPrice, BaseSaleFormatId, FamilyId, VatId)',
    });
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
    if (removeParts.length)
      updateExpr += (updateExpr ? ' REMOVE ' : 'REMOVE ') + removeParts.join(', ');
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

router.get('/agora/sale-centers', async (req, res) => {
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

router.patch('/agora/sale-centers', async (req, res) => {
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

router.post('/agora/sale-centers/sync', async (req, res) => {
  const { AGORA_API_BASE_URL, AGORA_API_TOKEN } = env();
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
      return res.status(401).json({
        error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.',
      });
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
      return res.status(502).json({
        error:
          'Agora no devolvió JSON. Revisa el formato del API (export-master WorkplacesSummary).',
      });
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
          UpdateExpression:
            'SET Id = :id, Nombre = :nombre, Tipo = :tipo, #loc = :local, Grupo = :grupo, Activo = if_not_exists(Activo, :true)',
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

router.post('/agora/warehouses/sync', async (req, res) => {
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

      await docClient.send(
        new PutCommand({
          TableName: tableAlmacenesName,
          Item: item,
        })
      );

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

router.post('/agora/closeouts/sync', async (req, res) => {
  const body = req.body || {};
  const businessDay = body.businessDay
    ? String(body.businessDay).trim()
    : new Date().toISOString().slice(0, 10);
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
      if (
        Array.isArray(s?.InvoicePayments ?? s?.invoicePayments) &&
        (s.InvoicePayments ?? s.invoicePayments).length > 0
      ) {
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

    if (rawList.length === 0) {
      return res.json({ ok: true, fetched: 0, upserted: 0, businessDay, source });
    }

    const usePos = source === 'PosCloseOuts';
    const paymentSourceByRecord =
      source === 'Invoices' ? new Map() : buildPaymentSourceByRecord(rawList, sysByWorkplace, usePos);
    const items = rawList
      .map((r, idx) => {
        const paymentSource = paymentSourceByRecord.get(r) ?? null;
        const item = mapCloseOutToItem(r, businessDay, paymentSource);
        if (!item.Number || item.Number === '') item.Number = String(idx + 1);
        if (!item.SK || String(item.SK).trim() === '') {
          item.SK = businessDay
            ? item.PosId
              ? `${businessDay}#${item.PosId}#${item.Number}`
              : `${businessDay}#${item.Number}`
            : '';
        }
        return item;
      })
      .filter(
        (i) => i.PK && i.SK && String(i.PK).trim() !== '' && String(i.SK).trim() !== ''
      );

    const openCloseEnrichment = enrichItemsOpenCloseDatesFromAuxiliary(items, businessDay, sysList, posList);
    console.log('[agora/closeouts/open-close-enrich]', businessDay, openCloseEnrichment);

    const workplaceIds = [...new Set(items.map((i) => i.PK).filter(Boolean))];
    const keysToDeleteMap = new Map();
    for (const pk of workplaceIds) {
      let lastKey = null;
      do {
        const q = await docClient.send(
          new QueryCommand({
            TableName: tableSalesCloseOutsName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: { ':pk': pk, ':sk': `${businessDay}#` },
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          })
        );
        for (const rec of q.Items || []) keysToDeleteMap.set(`${rec.PK}#${rec.SK}`, { PK: rec.PK, SK: rec.SK });
        lastKey = q.LastEvaluatedKey || null;
      } while (lastKey);
    }
    const keysToDelete = [...keysToDeleteMap.values()];
    for (let i = 0; i < keysToDelete.length; i += 25) {
      const chunk = keysToDelete.slice(i, i + 25);
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableSalesCloseOutsName]: chunk.map((k) => ({ DeleteRequest: { Key: k } })),
          },
        })
      );
    }

    const upserted = await upsertBatch(docClient, tableSalesCloseOutsName, items);
    console.log(
      '[agora/closeouts] Sync:',
      businessDay,
      'fetched:',
      rawList.length,
      'upserted:',
      upserted,
      'source:',
      source
    );
    return res.json({
      ok: true,
      fetched: rawList.length,
      upserted,
      businessDay,
      source,
      openCloseEnrichment,
    });
  } catch (err) {
    console.error('[agora/closeouts/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar cierres' });
  }
});

router.post('/agora/closeouts/full-sync', async (req, res) => {
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
        const scanRes = await docClient.send(
          new ScanCommand({
            TableName: tableSalesCloseOutsName,
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          })
        );
        allItems.push(...(scanRes.Items || []));
        lastKey = scanRes.LastEvaluatedKey || null;
      } while (lastKey);

      const keysToDelete = [];
      const seenBusinessKey = new Set();
      for (const item of allItems) {
        const pk = item.PK ?? item.pk;
        const sk = item.SK ?? item.sk;
        const bd = item.BusinessDay ?? item.businessDay ?? (typeof sk === 'string' ? sk.split('#')[0] : '');
        const posId =
          item.PosId ?? item.posId ?? (typeof sk === 'string' ? sk.split('#')[1] : '') ?? '';
        const num =
          item.Number ?? item.number ?? (typeof sk === 'string' ? sk.split('#').pop() : '') ?? '';
        const outOfRange = !bd || bd < dateFrom || bd > dateTo;
        const businessKey = `${pk}|${bd}|${posId}|${num}`;
        const isDuplicate = seenBusinessKey.has(businessKey);
        if (outOfRange || isDuplicate) keysToDelete.push({ PK: pk, SK: sk });
        if (!outOfRange) seenBusinessKey.add(businessKey);
      }

      for (let i = 0; i < keysToDelete.length; i += 25) {
        const chunk = keysToDelete.slice(i, i + 25);
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableSalesCloseOutsName]: chunk.map((k) => ({ DeleteRequest: { Key: k } })),
            },
          })
        );
        deletedOutOfRange += chunk.length;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (deletedOutOfRange > 0)
        console.log(
          '[agora/closeouts/full-sync] Eliminados fuera de rango o duplicados:',
          deletedOutOfRange
        );
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
    const openCloseEnrichmentTotals = {
      itemsTotal: 0,
      vaciosOpenAntes: 0,
      vaciosCloseAntes: 0,
      rellenadosOpen: 0,
      rellenadosClose: 0,
      vaciosOpenDespues: 0,
      vaciosCloseDespues: 0,
    };

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
          if (
            Array.isArray(s?.InvoicePayments ?? s?.invoicePayments) &&
            (s.InvoicePayments ?? s.invoicePayments).length > 0
          ) {
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
        const paymentSourceByRecord =
          source === 'Invoices' ? new Map() : buildPaymentSourceByRecord(validRaw, sysByWorkplace, usePos);
        const items = validRaw
          .map((r, idx) => {
            const paymentSource = paymentSourceByRecord.get(r) ?? null;
            const item = mapCloseOutToItem(r, businessDay, paymentSource);
            if (!item.Number || item.Number === '') item.Number = String(idx + 1);
            if (!item.SK || String(item.SK).trim() === '') {
              item.SK = businessDay
                ? item.PosId
                  ? `${businessDay}#${item.PosId}#${item.Number}`
                  : `${businessDay}#${item.Number}`
                : '';
            }
            return item;
          })
          .filter(
            (i) => i.PK && i.SK && String(i.PK).trim() !== '' && String(i.SK).trim() !== ''
          );

        const openCloseEnrichment = enrichItemsOpenCloseDatesFromAuxiliary(items, businessDay, sysList, posList);
        console.log('[agora/closeouts/open-close-enrich]', businessDay, openCloseEnrichment);
        accumulateOpenCloseEnrichmentTotals(openCloseEnrichmentTotals, openCloseEnrichment);

        const workplaceIds = [...new Set(items.map((i) => i.PK).filter(Boolean))];
        const keysToDeleteMap = new Map();
        for (const pk of workplaceIds) {
          let lastKey = null;
          do {
            const q = await docClient.send(
              new QueryCommand({
                TableName: tableSalesCloseOutsName,
                KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
                ExpressionAttributeValues: { ':pk': pk, ':sk': `${businessDay}#` },
                ...(lastKey && { ExclusiveStartKey: lastKey }),
              })
            );
            for (const rec of q.Items || [])
              keysToDeleteMap.set(`${rec.PK}#${rec.SK}`, { PK: rec.PK, SK: rec.SK });
            lastKey = q.LastEvaluatedKey || null;
          } while (lastKey);
        }
        const keysToDelete = [...keysToDeleteMap.values()];
        for (let j = 0; j < keysToDelete.length; j += 25) {
          const chunk = keysToDelete.slice(j, j + 25);
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [tableSalesCloseOutsName]: chunk.map((k) => ({ DeleteRequest: { Key: k } })),
              },
            })
          );
        }

        const upserted = await upsertBatch(docClient, tableSalesCloseOutsName, items);
        totalFetched += validRaw.length;
        totalUpserted += upserted;

        if ((i + 1) % 30 === 0)
          console.log('[agora/closeouts/full-sync] Progreso:', i + 1, '/', days.length, 'días');
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        errors.push({ day: businessDay, error: err.message || String(err) });
      }
    }

    console.log('[agora/closeouts/full-sync] Completado:', {
      dateFrom,
      dateTo,
      deletedOutOfRange,
      totalFetched,
      totalUpserted,
      totalSkipped,
      errors: errors.length,
      openCloseEnrichmentTotals,
    });
    return res.json({
      ok: true,
      dateFrom,
      dateTo,
      deletedOutOfRange,
      totalFetched,
      totalUpserted,
      totalSkipped,
      daysProcessed: days.length,
      openCloseEnrichmentTotals,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('[agora/closeouts/full-sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error en sincronización completa' });
  }
});

router.post('/agora/closeouts/complete-fields', async (req, res) => {
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
        const q = await docClient.send(
          new QueryCommand({
            TableName: tableSalesCloseOutsName,
            KeyConditionExpression: keyCond,
            ExpressionAttributeValues: exprValues,
            Limit: Math.min(limit - items.length, 100),
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          })
        );
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
    const uniquePosIds = [
      ...new Set(needPosName.map((it) => String(it.PosId ?? it.posId ?? ''))),
    ].filter(Boolean);

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
        await docClient.send(
          new UpdateCommand({
            TableName: tableSalesCloseOutsName,
            Key: { PK: it.PK, SK: it.SK },
            UpdateExpression: 'SET PosName = if_not_exists(PosName, :nombre)',
            ExpressionAttributeValues: { ':nombre': posName },
          })
        );
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
      const hasGross =
        gross != null &&
        (typeof gross === 'number' || !Number.isNaN(parseFloat(String(gross))));
      const hasPayments = Array.isArray(payments) && payments.length > 0;
      const businessDay = (it.SK ?? it.sk ?? '').split('#')[0];
      return (
        businessDay &&
        /^\d{4}-\d{2}-\d{2}$/.test(businessDay) &&
        (!hasGross || !openDate || !closeDate || !hasPayments)
      );
    });

    const daysToFetch = [
      ...new Set(
        needAgora.map((it) => {
          const bd = (it.SK ?? it.sk ?? '').split('#')[0];
          return `${it.PK}|${bd}`;
        })
      ),
    ];

    for (const dayKey of daysToFetch) {
      const [workplaceId, businessDay] = dayKey.split('|');
      if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) continue;
      try {
        let rawList = [];
        const [posData, sysData] = await Promise.all([
          exportPosCloseOuts(businessDay, [workplaceId]).catch((e) => ({ _err: e })),
          exportSystemCloseOuts(businessDay, [workplaceId]).catch((e) => ({ _err: e })),
        ]);
        const posList = !posData?._err
          ? extractCloseOutsArray(posData, ['PosCloseOuts', 'PosCloseouts', 'posCloseOuts'])
          : [];
        const sysList = !sysData?._err
          ? extractCloseOutsArray(sysData, ['SystemCloseOuts', 'SystemCloseouts', 'systemCloseOuts'])
          : [];
        const sysByWorkplace = new Map();
        for (const s of sysList) {
          const pk = String(s?.WorkplaceId ?? s?.workplaceId ?? '').trim() || '0';
          if (
            Array.isArray(s?.InvoicePayments ?? s?.invoicePayments) &&
            (s.InvoicePayments ?? s.invoicePayments).length > 0
          ) {
            sysByWorkplace.set(pk, s);
          }
        }
        rawList = posList.length > 0 ? posList : sysList;
        if (rawList.length === 0) continue;

        const usePosLocal = posList.length > 0;
        const paymentSourceByRecord = buildPaymentSourceByRecord(
          rawList,
          sysByWorkplace,
          usePosLocal
        );
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
          if (!it.OpenDate && !it.openDate && mapped.OpenDate)
            addSet('#open', 'OpenDate', mapped.OpenDate);
          if (!it.CloseDate && !it.closeDate && mapped.CloseDate)
            addSet('#close', 'CloseDate', mapped.CloseDate);
          const payments = it.InvoicePayments ?? it.invoicePayments ?? [];
          if (
            (!payments || payments.length === 0) &&
            mapped.InvoicePayments?.length > 0
          ) {
            addSet('#inv', 'InvoicePayments', mapped.InvoicePayments);
          }
          if (updates.length === 0) continue;

          try {
            await docClient.send(
              new UpdateCommand({
                TableName: tableSalesCloseOutsName,
                Key: { PK: it.PK, SK: it.SK },
                UpdateExpression: `SET ${updates.join(', ')}`,
                ExpressionAttributeNames: exprNames,
                ExpressionAttributeValues: exprValues,
              })
            );
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

    console.log('[agora/closeouts/complete-fields]', {
      scanned: items.length,
      posNameUpdated,
      agoraUpdated,
      errors: errors.length,
    });
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

// ──────────────────────────────────────────
// Compras a Proveedor (Purchases)
// ──────────────────────────────────────────

router.get('/agora/purchases/por-producto', async (req, res) => {
  const { productId, fechaInicio, fechaFin } = req.query;
  if (!productId) return res.status(400).json({ error: 'productId es obligatorio' });

  try {
    let items = [];

    if (isGsiReady()) {
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

// --- Caché en memoria para GET /agora/purchases (TTL 5 min) ---
const _purchasesCache = { data: null, ts: 0 };
const _PURCHASES_TTL = 5 * 60 * 1000;

function invalidatePurchasesCache() {
  _purchasesCache.data = null;
  _purchasesCache.ts = 0;
}

router.get('/agora/purchases', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    if (!forceRefresh && _purchasesCache.data && (now - _purchasesCache.ts) < _PURCHASES_TTL) {
      return res.json({ ..._purchasesCache.data, cached: true });
    }

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

    const payload = { ok: true, items, total: items.length };
    _purchasesCache.data = payload;
    _purchasesCache.ts = now;

    return res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('[agora/purchases GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar compras a proveedor' });
  }
});

router.post('/agora/purchases/sync', async (req, res) => {
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
    const purchaseVatMap = new Map();

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
            const lineNotes = line.Notes ?? line.notes ?? '';

            if (productId && typeof vatRate === 'number' && vatRate > 0) {
              purchaseVatMap.set(String(productId), vatRate);
            }

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
              LineNotes: lineNotes,
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

    let purchaseVatUpdated = 0;
    if (purchaseVatMap.size > 0) {
      try {
        purchaseVatUpdated = await updatePurchaseVatRates(docClient, tableAgoraProductsName, purchaseVatMap);
        console.log('[agora/purchases/sync] PurchaseVatPercent actualizado en', purchaseVatUpdated, 'productos');
      } catch (err) {
        console.error('[agora/purchases/sync] Error actualizando PurchaseVatPercent:', err.message || err);
      }
    }

    invalidatePurchasesCache();
    console.log('[agora/purchases/sync] Completado:', { dateFrom, dateTo, totalFetched, totalUpserted, purchaseVatUpdated, errors: errors.length });
    return res.json({
      ok: true,
      dateFrom,
      dateTo,
      totalFetched,
      totalUpserted,
      purchaseVatUpdated,
      daysProcessed: days.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('[agora/purchases/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar compras a proveedor' });
  }
});

export default router;
