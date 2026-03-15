import { Router } from 'express';
import {
  QueryCommand,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  BatchWriteCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import {
  exportSystemCloseOuts,
  exportPosCloseOuts,
  exportInvoices,
  exportWarehouses,
} from '../lib/agora/client.js';
import { upsertBatch } from '../lib/dynamo/salesCloseOuts.js';
import {
  syncProducts,
  getLastSync,
  setLastSync,
  shouldSkipSyncByThrottle,
  toApiProduct,
  pickAllowedFields,
} from '../lib/dynamo/agoraProducts.js';

const router = Router();
const AGORA_API_BASE_URL = process.env.AGORA_API_BASE_URL || '';
const AGORA_API_TOKEN = process.env.AGORA_API_TOKEN || '';

const tableAgoraProductsName = tables.agoraProducts;
const tableSaleCentersName = tables.saleCenters;
const tableSalesCloseOutsName = tables.salesCloseOuts;
const tableAlmacenesName = tables.almacenes;

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

function extractNumberFromSk(sk) {
  if (!sk || typeof sk !== 'string') return '';
  const parts = String(sk).trim().split('#');
  return parts.length >= 2 ? parts[parts.length - 1] : '';
}

function formatFechaNegocio(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const parts = String(iso).trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function addExcelStyleFields(item) {
  if (!item || typeof item !== 'object') return item;
  const ensureArray = (arr) => (Array.isArray(arr) ? arr : []);
  const payments = ensureArray(item.InvoicePayments ?? item.invoicePayments);
  const amounts = item.Amounts ?? item.amounts ?? {};
  const gross = amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total;
  const sumPayments = payments.reduce((s, p) => s + (Number(p?.Amount ?? p?.amount ?? 0) || 0), 0);
  const ventas =
    gross != null
      ? typeof gross === 'number'
        ? gross
        : parseFloat(String(gross).replace(',', '.')) || 0
      : sumPayments;
  const EXCEL_PAYMENT_KEYS = [
    'Efectivo',
    'Tarjeta',
    'Pendiente de cobro',
    'Prepago Transferencia',
    'AgoraPay',
  ];
  const byMethod = {};
  for (const k of EXCEL_PAYMENT_KEYS) {
    const p = payments.find((x) => (String(x?.MethodName ?? x?.methodName ?? '').trim()) === k);
    byMethod[k] =
      p != null
        ? typeof p.Amount === 'number'
          ? p.Amount
          : parseFloat(String(p?.Amount ?? p?.amount ?? 0).replace(',', '.')) || 0
        : 0;
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

router.get('/agora/test-connection', async (req, res) => {
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
      const productos = rawList.map((p) => {
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
  const force =
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
    return res.json({ ok: true, fetched: rawList.length, upserted, businessDay, source });
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

export default router;
