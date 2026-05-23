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
  exportPaymentMethods,
  exportUsers,
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
  syncUsers as syncAgoraUsers,
  getLastSync as getLastUsersSync,
  setLastSync as setLastUsersSync,
  shouldSkipSyncByThrottle as shouldSkipUsersByThrottle,
  toApiUser,
  getAllUsersMap,
} from '../lib/dynamo/agoraUsuarios.js';
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
const tableAgoraUsuariosName = tables.agoraUsuarios;
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
// Fallback hardcodeado para los IDs históricos de Ágora (Guía 8.1.6 p.27).
// Se usa si Ágora aún no ha respondido al primer fetch o si la primera carga falla.
const INITIAL_PAYMENT_METHOD_ID = {
  1: 'Efectivo',
  2: 'Tarjeta',
  4: 'Pendiente de cobro',
  5: 'Prepago Transferencia',
  7: 'AgoraPay',
};
// Mutable: se rellena dinámicamente desde la caché de PaymentMethods de Ágora.
// Los accesos síncronos (extractAmountsAndPayments) lo leen como un mapa Id->Name.
const AGORA_PAYMENT_METHOD_ID = { ...INITIAL_PAYMENT_METHOD_ID };

// Caché en memoria de las formas de pago de Ágora.
// Estrategia: TTL 1h + stale-while-error + lazy bootstrap en background.
const PAYMENT_METHODS_CACHE_TTL_MS = 60 * 60 * 1000;
const paymentMethodsCache = {
  data: null, // array de PaymentMethod (sin las borradas)
  fetchedAt: 0, // timestamp último fetch con éxito
  inFlight: null, // Promise en curso (evita stampede)
  bgRefreshing: false, // refresh en background ya disparado
};

function isPaymentMethodsCacheFresh() {
  return (
    paymentMethodsCache.data != null &&
    Date.now() - paymentMethodsCache.fetchedAt < PAYMENT_METHODS_CACHE_TTL_MS
  );
}

async function fetchPaymentMethodsAndUpdateMap() {
  if (paymentMethodsCache.inFlight) return paymentMethodsCache.inFlight;
  paymentMethodsCache.inFlight = (async () => {
    const list = await exportPaymentMethods();
    paymentMethodsCache.data = Array.isArray(list) ? list : [];
    paymentMethodsCache.fetchedAt = Date.now();
    // Rellena AGORA_PAYMENT_METHOD_ID. Los IDs canónicos históricos (INITIAL) NO se
    // sobrescriben con el nombre que llegue de Ágora — si en Ágora alguien renombra
    // "Tarjeta" a "Tarjeta Manual", aquí seguimos viéndolo como "Tarjeta" para no
    // partir las columnas en cierres-teóricos / revisión de formas de pago.
    // Los IDs nuevos (no canónicos) sí se añaden con el nombre que les ponga Ágora.
    Object.keys(AGORA_PAYMENT_METHOD_ID).forEach((k) => delete AGORA_PAYMENT_METHOD_ID[k]);
    Object.assign(AGORA_PAYMENT_METHOD_ID, INITIAL_PAYMENT_METHOD_ID);
    for (const pm of paymentMethodsCache.data) {
      if (pm && pm.Id != null && pm.Name) {
        if (INITIAL_PAYMENT_METHOD_ID[pm.Id] != null) continue;
        AGORA_PAYMENT_METHOD_ID[pm.Id] = String(pm.Name);
        AGORA_PAYMENT_METHOD_ID[String(pm.Id)] = String(pm.Name);
      }
    }
    return paymentMethodsCache.data;
  })();
  try {
    return await paymentMethodsCache.inFlight;
  } finally {
    paymentMethodsCache.inFlight = null;
  }
}

// Lazy bootstrap: se dispara en background la primera vez que algún consumidor
// síncrono (extractAmountsAndPayments) toca el mapa, o cuando expira el TTL.
// Si falla, se vuelve a intentar en la próxima invocación.
function ensurePaymentMethodsFreshness() {
  if (paymentMethodsCache.bgRefreshing) return;
  if (isPaymentMethodsCacheFresh()) return;
  paymentMethodsCache.bgRefreshing = true;
  fetchPaymentMethodsAndUpdateMap()
    .catch((err) => {
      console.warn(
        '[agora] Refresh PaymentMethods (background) falló:',
        err?.message || err,
      );
    })
    .finally(() => {
      paymentMethodsCache.bgRefreshing = false;
    });
}

// Versión async para la ruta GET: garantiza una respuesta con datos cacheados o
// fallback. Aplica stale-while-error: si la recarga falla pero hay valor previo,
// devuelve el previo marcado como stale.
async function getPaymentMethodsCached() {
  if (isPaymentMethodsCacheFresh()) {
    return {
      items: paymentMethodsCache.data,
      fetchedAt: paymentMethodsCache.fetchedAt,
      stale: false,
      source: 'cache',
    };
  }
  try {
    const items = await fetchPaymentMethodsAndUpdateMap();
    return {
      items,
      fetchedAt: paymentMethodsCache.fetchedAt,
      stale: false,
      source: 'agora',
    };
  } catch (err) {
    if (paymentMethodsCache.data != null) {
      console.warn(
        '[agora] Recarga PaymentMethods falló, sirvo caché obsoleta:',
        err?.message || err,
      );
      return {
        items: paymentMethodsCache.data,
        fetchedAt: paymentMethodsCache.fetchedAt,
        stale: true,
        source: 'cache-stale',
      };
    }
    console.warn(
      '[agora] Bootstrap PaymentMethods falló, sirvo fallback inicial:',
      err?.message || err,
    );
    const fallback = Object.entries(INITIAL_PAYMENT_METHOD_ID).map(([id, name]) => ({
      Id: Number(id),
      Name: name,
    }));
    return { items: fallback, fetchedAt: 0, stale: true, source: 'fallback', error: err?.message || String(err) };
  }
}

const STRING_KEY_TO_CANONICAL = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  'tarjeta manual': 'Tarjeta',
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
  // Lazy bootstrap: dispara refresh en background si la caché está vacía o expirada.
  // No bloquea esta llamada; usa el valor actual de AGORA_PAYMENT_METHOD_ID
  // (que arranca con INITIAL_PAYMENT_METHOD_ID y se rellena cuando Ágora responde).
  ensurePaymentMethodsFreshness();
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
    // Prioridad: si hay Id válido y está en el mapa (incluye canónicos blindados),
    // usamos su nombre canónico. Esto evita partir columnas cuando Ágora renombra
    // un método (p.ej. "Tarjeta" -> "Tarjeta Manual"). Solo se usa el MethodName
    // del JSON si no hay Id o el Id es desconocido.
    const fromId =
      id != null
        ? (AGORA_PAYMENT_METHOD_ID[id] ?? AGORA_PAYMENT_METHOD_ID[String(id)] ?? null)
        : null;
    const name =
      fromId ??
      findValue(b, ['MethodName', 'methodName', 'Name', 'name']) ??
      (id != null ? `Método ${id}` : null);
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
});

router.get('/agora/closeouts/totals-by-local', async (req, res) => {
  const businessDay = (req.query.businessDay && String(req.query.businessDay).trim()) || '';
  if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'businessDay obligatorio (YYYY-MM-DD)' });
  }
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
});

router.get('/agora/closeouts/totals-by-local-ytd', async (req, res) => {
  const year = (req.query.year && String(req.query.year).trim()) || '';
  const dateTo = (req.query.dateTo && String(req.query.dateTo).trim()) || '';
  if (!year || !/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: 'year obligatorio (YYYY)' });
  }
  const prefix = year + '-';
  const useDateTo = dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) && dateTo.startsWith(year + '-');
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
});

router.get('/agora/closeouts/totals-by-month', async (req, res) => {
  const year = (req.query.year && String(req.query.year).trim()) || '';
  const dateTo = (req.query.dateTo && String(req.query.dateTo).trim()) || '';
  if (!year || !/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: 'year obligatorio (YYYY)' });
  }
  const prefix = year + '-';
  const useDateTo = dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) && dateTo.startsWith(year + '-');
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
});

router.get('/agora/closeouts-ready', (_req, res) => {
  res.json({ ok: true, closeoutsRoute: 'registered' });
});

/**
 * Devuelve el desglose por ticket (y por factura cuando no se puede bajar a ticket)
 * de las formas de pago para un business-day concreto, consultando Ágora en caliente
 * (sin persistir en DynamoDB).
 *
 * Query params:
 *  - businessDay (YYYY-MM-DD, requerido)
 *  - workplaceId (opcional, filtra por local)
 *
 * Estructura de respuesta:
 *  { businessDay, rows: [{ WorkplaceId, WorkplaceName, PosId, PosName, BusinessDay,
 *    DocumentType, TicketNumber, InvoiceNumber, DateTime, GrossAmount,
 *    Payments: [{ MethodId, MethodName, Amount, ExtraInformation }] }] }
 */
const PAYMENTS_REVIEW_CACHE = new Map();
const PAYMENTS_REVIEW_TTL_MS = 2 * 60 * 1000;
const PAYMENTS_REVIEW_CACHE_MAX = 50;

function paymentsReviewCacheKey(dateFrom, dateTo, workplaceIds) {
  const ids = Array.isArray(workplaceIds) ? [...workplaceIds].map(String).sort() : [];
  return `${dateFrom}|${dateTo}|${ids.join(',')}`;
}

function paymentsReviewCacheGet(key) {
  const entry = PAYMENTS_REVIEW_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    PAYMENTS_REVIEW_CACHE.delete(key);
    return null;
  }
  return entry;
}

function paymentsReviewCacheSet(key, rows) {
  if (PAYMENTS_REVIEW_CACHE.size >= PAYMENTS_REVIEW_CACHE_MAX) {
    const firstKey = PAYMENTS_REVIEW_CACHE.keys().next().value;
    if (firstKey) PAYMENTS_REVIEW_CACHE.delete(firstKey);
  }
  PAYMENTS_REVIEW_CACHE.set(key, {
    rows,
    cachedAt: Date.now(),
    expiresAt: Date.now() + PAYMENTS_REVIEW_TTL_MS,
  });
}

const RULE_EPS = 0.0001;
function evalPaymentRule(amount, rule) {
  const v = Number(rule?.value) || 0;
  const v2 = Number(rule?.value2) || 0;
  switch (rule?.op) {
    case 'eq': return Math.abs(amount - v) < RULE_EPS;
    case 'ne': return Math.abs(amount - v) >= RULE_EPS;
    case 'gt': return amount > v + RULE_EPS;
    case 'lt': return amount < v - RULE_EPS;
    case 'gte': return amount >= v - RULE_EPS;
    case 'lte': return amount <= v + RULE_EPS;
    case 'between': {
      const lo = Math.min(v, v2);
      const hi = Math.max(v, v2);
      return amount >= lo - RULE_EPS && amount <= hi + RULE_EPS;
    }
    case 'gt0': return amount > RULE_EPS;
    case 'eq0': return Math.abs(amount) < RULE_EPS;
    default: return true;
  }
}

function rowAmountForMethod(row, methodName) {
  const target = String(methodName || '').trim().toLowerCase();
  if (!target) return 0;
  let total = 0;
  for (const p of row?.Payments || []) {
    if (String(p?.MethodName || '').trim().toLowerCase() === target) {
      total += Number(p?.Amount) || 0;
    }
  }
  return total;
}

function rowMatchesRules(row, rules, combMode) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const results = rules.map((r) => evalPaymentRule(rowAmountForMethod(row, r.method), r));
  return combMode === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

router.get('/agora/invoices/payments-review', async (req, res) => {
  const businessDay = (req.query.businessDay && String(req.query.businessDay).trim()) || '';
  const dateFromRaw = (req.query.dateFrom && String(req.query.dateFrom).trim()) || '';
  const dateToRaw = (req.query.dateTo && String(req.query.dateTo).trim()) || '';
  const workplaceIdRaw = (req.query.workplaceId && String(req.query.workplaceId).trim()) || '';

  const workplaceIdsRaw = req.query.workplaceIds ?? req.query['workplaceIds[]'];
  let workplaceIds = [];
  if (Array.isArray(workplaceIdsRaw)) {
    workplaceIds = workplaceIdsRaw.map((v) => String(v).trim()).filter(Boolean);
  } else if (typeof workplaceIdsRaw === 'string' && workplaceIdsRaw.trim()) {
    workplaceIds = workplaceIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (workplaceIds.length === 0 && workplaceIdRaw) workplaceIds = [workplaceIdRaw];

  let rules = [];
  const rulesRaw = req.query.rules;
  if (typeof rulesRaw === 'string' && rulesRaw.trim()) {
    try {
      const parsed = JSON.parse(rulesRaw);
      if (Array.isArray(parsed)) rules = parsed;
    } catch {
      return res.status(400).json({ error: 'rules debe ser JSON válido' });
    }
  }
  const combMode = String(req.query.combMode || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
  const refresh = String(req.query.refresh || '') === '1';

  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  let dateFrom = '';
  let dateTo = '';
  if (dateFromRaw || dateToRaw) {
    if (!isIso(dateFromRaw) || !isIso(dateToRaw)) {
      return res.status(400).json({ error: 'dateFrom y dateTo deben ser YYYY-MM-DD' });
    }
    if (dateFromRaw > dateToRaw) {
      return res.status(400).json({ error: 'dateFrom debe ser <= dateTo' });
    }
    dateFrom = dateFromRaw;
    dateTo = dateToRaw;
  } else if (isIso(businessDay)) {
    dateFrom = businessDay;
    dateTo = businessDay;
  } else {
    return res.status(400).json({ error: 'Se requiere businessDay (YYYY-MM-DD) o dateFrom+dateTo' });
  }

  const MAX_DAYS = workplaceIds.length === 1 ? 365 : 31;
  const days = [];
  {
    let d = new Date(dateFrom + 'T12:00:00');
    const end = new Date(dateTo + 'T12:00:00');
    while (d <= end) {
      days.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
      if (days.length > MAX_DAYS) break;
    }
  }
  if (days.length > MAX_DAYS) {
    const msg =
      workplaceIds.length === 1
        ? `Rango máximo permitido: ${MAX_DAYS} días (incluso con 1 solo local)`
        : `Rango máximo permitido: ${MAX_DAYS} días con ${workplaceIds.length === 0 ? 'todos los locales' : `${workplaceIds.length} locales`}. Selecciona 1 solo local para ampliar hasta 365 días.`;
    return res.status(400).json({ error: msg });
  }

  {
    const cacheKey = paymentsReviewCacheKey(dateFrom, dateTo, workplaceIds);
    let cachedEntry = refresh ? null : paymentsReviewCacheGet(cacheKey);
    let allRows;
    let cachedAt;
    let fromCache = false;

    if (cachedEntry) {
      allRows = cachedEntry.rows;
      cachedAt = cachedEntry.cachedAt;
      fromCache = true;
    } else {
      const workplaces = workplaceIds.length > 0 ? workplaceIds : null;

      const CHUNK = 4;
      const invoicesByDay = new Map();
      for (let i = 0; i < days.length; i += CHUNK) {
        const slice = days.slice(i, i + CHUNK);
        const results = await Promise.all(
          slice.map((day) =>
            exportInvoices(day, workplaces ?? undefined)
              .then((data) => ({ day, data, err: null }))
              .catch((err) => ({ day, data: null, err }))
          )
        );
        for (const r of results) {
          if (r.err) {
            console.warn('[agora/invoices/payments-review]', r.day, r.err.message || r.err);
            invoicesByDay.set(r.day, []);
          } else {
            invoicesByDay.set(r.day, extractCloseOutsArray(r.data, ['Invoices', 'invoices']));
          }
        }
      }
      const invList = [];
      for (const day of days) {
        const listForDay = invoicesByDay.get(day) ?? [];
        for (const inv of listForDay) {
          invList.push({ __businessDay: day, ...inv });
        }
      }

      const toNumber = (v) =>
        typeof v === 'number'
          ? v
          : v == null || v === ''
            ? 0
            : parseFloat(String(v).replace(',', '.')) || 0;

      const canonName = (rawName, methodId) => {
        const n = String(rawName ?? '').trim();
        if (n) {
          const lower = n.toLowerCase();
          if (STRING_KEY_TO_CANONICAL[lower]) return STRING_KEY_TO_CANONICAL[lower];
          const found = CANONICAL_PAYMENT_NAMES.find((c) => c.toLowerCase() === lower);
          if (found) return found;
          return n;
        }
        if (methodId != null && AGORA_PAYMENT_METHOD_ID[methodId]) {
          return AGORA_PAYMENT_METHOD_ID[methodId];
        }
        return 'Sin nombre';
      };

      const mapPayments = (payments) => {
        if (!Array.isArray(payments)) return [];
        return payments
          .map((p) => {
            const methodId = p?.MethodId ?? p?.methodId ?? p?.PaymentMethodId ?? p?.paymentMethodId ?? null;
            const rawName = p?.MethodName ?? p?.methodName ?? p?.Name ?? p?.name ?? '';
            return {
              MethodId: methodId != null ? Number(methodId) : null,
              MethodName: canonName(rawName, methodId),
              Amount: toNumber(p?.Amount ?? p?.amount),
              PaidAmount: toNumber(p?.PaidAmount ?? p?.paidAmount),
              ChangeAmount: toNumber(p?.ChangeAmount ?? p?.changeAmount),
              Tip: toNumber(p?.Tip ?? p?.tip),
              IsPrepayment: Boolean(p?.IsPrepayment ?? p?.isPrepayment ?? false),
              ExtraInformation: String(p?.ExtraInformation ?? p?.extraInformation ?? '').trim(),
              Date: String(p?.Date ?? p?.date ?? '').trim(),
            };
          })
          .filter((p) => p.MethodName && p.MethodName !== 'Sin nombre' && Math.abs(p.Amount) > 0.0001);
      };

      const builtRows = [];
      for (const inv of invList) {
        const workplaceId =
          String(
            inv?.Workplace?.Id ?? inv?.workplace?.id ?? inv?.WorkplaceId ?? inv?.workplaceId ?? ''
          ).trim() || '0';
        const workplaceName =
          inv?.Workplace?.Name ?? inv?.workplace?.name ?? inv?.WorkplaceName ?? inv?.workplaceName ?? null;
        const posId = inv?.Pos?.Id ?? inv?.pos?.id ?? inv?.PosId ?? inv?.posId ?? null;
        const posName = inv?.Pos?.Name ?? inv?.pos?.name ?? inv?.PosName ?? inv?.posName ?? null;
        const bd =
          String(inv?.BusinessDay ?? inv?.businessDay ?? inv?.__businessDay ?? '').trim() ||
          String(inv?.__businessDay ?? '').trim();
        const invNumber = String(
          inv?.SerialNumber ?? inv?.serialNumber ?? inv?.Number ?? inv?.number ?? inv?.Id ?? inv?.id ?? ''
        ).trim();
        const invDate = String(inv?.Date ?? inv?.date ?? inv?.DateTime ?? inv?.dateTime ?? '').trim();
        const invPayments = mapPayments(inv?.Payments ?? inv?.payments ?? []);
        const invGross =
          toNumber(inv?.Totals?.GrossAmount ?? inv?.totals?.grossAmount ?? inv?.GrossAmount ?? inv?.grossAmount);

        const items = inv?.InvoiceItems ?? inv?.invoiceItems ?? [];
        const hasItems = Array.isArray(items) && items.length > 0;

        if (hasItems) {
          for (const it of items) {
            const contentType = String(it?.ContentType ?? it?.contentType ?? '').trim();
            const itemPayments = mapPayments(it?.Payments ?? it?.payments ?? []);
            const payments = itemPayments.length > 0 ? itemPayments : invPayments;
            const itemNumber = String(
              it?.SerialNumber ?? it?.serialNumber ?? it?.Number ?? it?.number ?? it?.Id ?? it?.id ?? ''
            ).trim();
            const itemDate = String(it?.Date ?? it?.date ?? it?.DateTime ?? it?.dateTime ?? '').trim() || invDate;
            const itemGross = toNumber(
              it?.Totals?.GrossAmount ??
                it?.totals?.grossAmount ??
                it?.GrossAmount ??
                it?.grossAmount ??
                payments.reduce((s, p) => s + (p.Amount || 0), 0)
            );
            const docType =
              contentType === 'T'
                ? 'Ticket'
                : contentType === 'D'
                  ? 'Albarán'
                  : contentType === 'O'
                    ? 'Pedido'
                    : contentType || 'Item';
            builtRows.push({
              WorkplaceId: workplaceId,
              WorkplaceName: workplaceName,
              PosId: posId,
              PosName: posName,
              BusinessDay: bd,
              DocumentType: docType,
              TicketNumber: itemNumber || invNumber,
              InvoiceNumber: invNumber,
              DateTime: itemDate,
              GrossAmount: itemGross,
              Payments: payments,
            });
          }
        } else {
          builtRows.push({
            WorkplaceId: workplaceId,
            WorkplaceName: workplaceName,
            PosId: posId,
            PosName: posName,
            BusinessDay: bd,
            DocumentType: 'Factura',
            TicketNumber: invNumber,
            InvoiceNumber: invNumber,
            DateTime: invDate,
            GrossAmount: invGross || invPayments.reduce((s, p) => s + (p.Amount || 0), 0),
            Payments: invPayments,
          });
        }
      }

      builtRows.sort((a, b) => {
        const wn = String(a.WorkplaceName ?? a.WorkplaceId ?? '').localeCompare(
          String(b.WorkplaceName ?? b.WorkplaceId ?? '')
        );
        if (wn !== 0) return wn;
        const bd = String(b.BusinessDay ?? '').localeCompare(String(a.BusinessDay ?? ''));
        if (bd !== 0) return bd;
        const dt = String(b.DateTime ?? '').localeCompare(String(a.DateTime ?? ''));
        if (dt !== 0) return dt;
        return String(b.TicketNumber ?? '').localeCompare(String(a.TicketNumber ?? ''));
      });

      paymentsReviewCacheSet(cacheKey, builtRows);
      allRows = builtRows;
      cachedAt = Date.now();
      fromCache = false;
    }

    const filteredRows = rules.length > 0
      ? allRows.filter((r) => rowMatchesRules(r, rules, combMode))
      : allRows;

    res.json({
      dateFrom,
      dateTo,
      businessDay: dateFrom === dateTo ? dateFrom : '',
      workplaceIds,
      rulesApplied: rules.length,
      combMode,
      fromCache,
      cachedAt: new Date(cachedAt).toISOString(),
      totalBeforeRules: allRows.length,
      count: filteredRows.length,
      rows: filteredRows,
    });
  }
});

// =========================================================================
// USUARIOS ÁGORA — maestro cacheado en DynamoDB (Igp_AgoraUsuarios)
// =========================================================================

router.get('/agora/users', async (req, res) => {
  const forceAgora =
    String(req.query.source || '').toLowerCase() === 'agora' ||
    String(req.query.force || '') === '1';

  if (forceAgora) {
    try {
      const list = await exportUsers();
      const usuarios = list.map((u) => toApiUser(u));
      return res.json({ usuarios });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Error al conectar con Agora.' });
    }
  }

  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAgoraUsuariosName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'GLOBAL' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    const onlyActive = String(req.query.activos || '').toLowerCase() === '1' ||
      String(req.query.activos || '').toLowerCase() === 'true';

    let usuarios = items
      .filter((i) => i.PK !== undefined && i.SK !== undefined && i.SK !== '__meta__')
      .map((item) => toApiUser(item));
    if (onlyActive) usuarios = usuarios.filter((u) => u.Active !== false);
    usuarios.sort((a, b) => {
      const na = String(a.FullName ?? a.Name ?? '').toLowerCase();
      const nb = String(b.FullName ?? b.Name ?? '').toLowerCase();
      return na.localeCompare(nb);
    });

    const lastSyncTs = await getLastUsersSync(docClient, tableAgoraUsuariosName);

    return res.json({
      usuarios,
      lastSync: lastSyncTs ? new Date(lastSyncTs).toISOString() : null,
    });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      req.log?.warn?.({ err }, 'Tabla AgoraUsuarios no encontrada');
      return res.json({
        usuarios: [],
        error: 'Tabla Igp_AgoraUsuarios no existe. Ejecuta: node api/scripts/create-agora-users-table.js',
      });
    }
    throw err;
  }
});

router.post('/agora/users/sync', async (req, res) => {
  const { AGORA_API_BASE_URL, AGORA_API_TOKEN } = env();
  const force =
    req.body?.force === true ||
    String(req.query.force || req.body?.force || '') === '1' ||
    String(req.query.force || '').toLowerCase() === 'true';
  const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (AGORA_API_TOKEN || '').trim();

  if (!baseUrl) return res.status(400).json({ error: 'Falta AGORA_API_BASE_URL en .env.local' });
  if (!token) return res.status(400).json({ error: 'Falta AGORA_API_TOKEN en .env.local' });

  try {
    if (!force) {
      const lastSync = await getLastUsersSync(docClient, tableAgoraUsuariosName);
      if (shouldSkipUsersByThrottle(lastSync)) {
        return res.json({
          ok: true,
          skipped: true,
          reason: 'recent',
          message: 'Sincronización reciente. Usa ?force=1 para forzar.',
        });
      }
    }

    const rawList = await exportUsers();
    const { added, updated, unchanged } = await syncAgoraUsers(
      docClient,
      tableAgoraUsuariosName,
      rawList,
    );
    await setLastUsersSync(docClient, tableAgoraUsuariosName);

    return res.json({
      ok: true,
      fetched: rawList.length,
      added,
      updated,
      unchanged,
    });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      const e = new Error(
        'Tabla Igp_AgoraUsuarios no existe. Ejecuta: node api/scripts/create-agora-users-table.js',
      );
      e.status = 404;
      throw e;
    }
    throw err;
  }
});

// =========================================================================
// CONTROL DE EXCEPCIONES — invitaciones, descuentos manuales y anulaciones
// =========================================================================
//
// Recorre las facturas de Ágora (export filter=Invoices) y extrae las
// "excepciones" relevantes:
//   - Invitaciones      → líneas regaladas
//   - Descuentos        → líneas con descuento manual aplicado por el cajero
//   - Anulaciones       → tickets/líneas anulados o reembolsados
//
// Devuelve filas planas (una por excepción) listas para tabular.

const EXCEPTIONS_CACHE = new Map();
const EXCEPTIONS_TTL_MS = 2 * 60 * 1000;
const EXCEPTIONS_CACHE_MAX = 50;

function exceptionsCacheKey(dateFrom, dateTo, workplaceIds) {
  const wp = [...workplaceIds].map(String).sort().join(',');
  return `${dateFrom}|${dateTo}|${wp}`;
}

function exceptionsCacheGet(key) {
  const entry = EXCEPTIONS_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > EXCEPTIONS_TTL_MS) {
    EXCEPTIONS_CACHE.delete(key);
    return null;
  }
  return entry;
}

function exceptionsCacheSet(key, rows) {
  if (EXCEPTIONS_CACHE.size >= EXCEPTIONS_CACHE_MAX) {
    const firstKey = EXCEPTIONS_CACHE.keys().next().value;
    if (firstKey != null) EXCEPTIONS_CACHE.delete(firstKey);
  }
  EXCEPTIONS_CACHE.set(key, { rows, cachedAt: Date.now() });
}

function toNumberSafe(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  return parseFloat(String(v).replace(',', '.')) || 0;
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

function pickCustomerId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    obj?.Customer?.Id ?? obj?.customer?.id ??
    obj?.CustomerId ?? obj?.customerId ??
    null
  );
}

function pickCustomerName(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    obj?.Customer?.Name ?? obj?.customer?.name ??
    obj?.CustomerName ?? obj?.customerName ??
    obj?.Customer?.FiscalName ?? obj?.customer?.fiscalName ??
    null
  );
}

/** Cliente Ágora asociado a una excepción (línea → item → factura). */
function exceptionCustomerFields(line, it, ctx) {
  return {
    CustomerId:
      pickCustomerId(line) ?? pickCustomerId(it) ?? ctx.invCustomerId ?? null,
    CustomerName:
      pickCustomerName(line) ?? pickCustomerName(it) ?? ctx.invCustomerName ?? null,
  };
}

/** Cliente Ágora "CONSUMO" (Id 1): operativa permitida pero auditable. */
const CONSUMO_CUSTOMER_ID = '1';
const CONSUMO_CUSTOMER_NAME = 'CONSUMO';
function isConsumoCustomerEntry(customerId, customerName) {
  if (customerId != null && String(customerId).trim() === CONSUMO_CUSTOMER_ID) return true;
  if (String(customerName ?? '').trim().toUpperCase() === CONSUMO_CUSTOMER_NAME) return true;
  return false;
}

function docTypeLabel(contentType) {
  const c = String(contentType ?? '').trim().toUpperCase();
  if (c === 'T') return 'Ticket';
  if (c === 'D') return 'Albarán';
  if (c === 'O') return 'Pedido';
  if (c === 'F' || c === 'I') return 'Factura';
  return c || 'Documento';
}

/** Precio de carta / tarifa del producto (no el precio cobrado en la línea). */
function pickLineProductPrice(line) {
  return toNumberSafe(
    line?.ProductPrice ?? line?.productPrice ??
    line?.Product?.Price ?? line?.product?.price ??
    line?.MenuPrice ?? line?.menuPrice ??
    line?.StandardPrice ?? line?.standardPrice ??
    line?.BasePrice ?? line?.basePrice,
  );
}

/**
 * ¿La línea pertenece a una promoción / oferta automática de Ágora?
 * Detectado por `OfferId` o `OfferCode` en la línea.
 */
function pickLineOffer(line) {
  const code = String(line?.OfferCode ?? line?.offerCode ?? '').trim();
  if (!code) return null;
  const offerId = line?.OfferId ?? line?.offerId ?? null;
  const id = offerId != null && String(offerId).trim() !== '' && String(offerId) !== '0'
    ? String(offerId).trim()
    : null;
  return { id, code };
}

/** Línea secundaria de un combo (mezclador, complemento, modificador incluido). */
function isSaleLineSubComponent(line) {
  const parentId =
    line?.ParentLineId ?? line?.parentLineId ??
    line?.ParentSaleLineId ?? line?.parentSaleLineId ??
    line?.ParentId ?? line?.parentId ??
    line?.MainLineId ?? line?.mainLineId ?? null;
  if (parentId != null && String(parentId).trim() !== '' && String(parentId) !== '0') {
    return true;
  }
  if (line?.IsModifier === true || line?.isModifier === true) return true;
  if (line?.IsComplement === true || line?.isComplement === true) return true;
  const lineType = String(
    line?.LineType ?? line?.lineType ??
    line?.SaleLineType ?? line?.saleLineType ?? '',
  ).trim().toUpperCase();
  if (['MODIFIER', 'COMPLEMENT', 'ADDIN', 'ADDON', 'SUBPRODUCT', 'COMPONENT', 'M'].includes(lineType)) {
    return true;
  }
  const level = toNumberSafe(line?.Level ?? line?.level ?? line?.IndentLevel ?? line?.indentLevel);
  return level > 0;
}

/** ¿La línea tiene descuento manual con importe o tasa > 0? */
function lineHasManualDiscount(line) {
  const discountList =
    line?.Discounts ?? line?.discounts ??
    line?.SaleLineDiscounts ?? line?.saleLineDiscounts ??
    line?.LineDiscounts ?? line?.lineDiscounts ?? [];
  if (Array.isArray(discountList) && discountList.length > 0) {
    for (const d of discountList) {
      const amount = toNumberSafe(
        d?.DiscountAmount ?? d?.discountAmount ?? d?.Amount ?? d?.amount,
      );
      const rate = toNumberSafe(d?.DiscountRate ?? d?.discountRate ?? d?.Rate ?? d?.rate);
      if (amount > 0.001 || rate > 0.0001) return true;
    }
  }
  const lineDiscountAmt = toNumberSafe(
    line?.DiscountAmount ?? line?.discountAmount ??
    line?.CashDiscount ?? line?.cashDiscount,
  );
  const lineDiscountRate = toNumberSafe(line?.DiscountRate ?? line?.discountRate);
  return lineDiscountAmt > 0.001 || lineDiscountRate > 0.0001;
}

/**
 * Normaliza un `DiscountRate` de Ágora a porcentaje (0–100).
 * Ágora exporta a veces como fracción (0–1) y a veces como porcentaje (0–100).
 */
function normalizeDiscountRate(rate) {
  const r = toNumberSafe(rate);
  if (r <= 0) return 0;
  if (r <= 1.0001) return r * 100;
  return r;
}

/**
 * Emite registros de descuento manual o invitación según el % aplicado.
 * Descuentos del 100% (línea regalada) se clasifican como invitación.
 * @returns {boolean} true si se emitió al menos un registro
 */
function pushLineManualDiscounts(out, line, it, ctx, meta) {
  const {
    itemDate, docType, itemNumber, userId, userName,
    qty, productName, lineGross,
  } = meta;
  const unitPrice = toNumberSafe(
    line?.UnitPrice ?? line?.unitPrice ?? line?.Price ?? line?.price,
  );
  const productPrice = pickLineProductPrice(line);
  /** Precio base sobre el que se aplica el descuento (precio carta × qty si está disponible). */
  const baseAmount =
    productPrice > 0.001 && qty > 0 ? productPrice * qty
    : unitPrice > 0.001 && qty > 0 ? unitPrice * qty
    : 0;
  let pushed = false;

  const emitDiscountEntry = (rawName, rawAmount, rawRate) => {
    const ratePct = normalizeDiscountRate(rawRate);
    let amount = toNumberSafe(rawAmount);
    if (amount <= 0.001 && ratePct > 0 && baseAmount > 0) {
      amount = (baseAmount * ratePct) / 100;
    }
    if (amount <= 0.001 && ratePct <= 0.001) return false;
    const name = String(rawName ?? '').trim();
    // Descuento al 100% (o línea regalada con base > 0 y cobro 0) → invitación
    const isFullDiscount =
      ratePct >= 99.5 ||
      (baseAmount > 0.001 && Math.abs(lineGross) < 0.001 && amount >= baseAmount - 0.01);
    if (isFullDiscount) {
      out.push({
        Type: 'invitacion',
        WorkplaceId: ctx.workplaceId, WorkplaceName: ctx.workplaceName,
        PosId: ctx.posId, PosName: ctx.posName,
        BusinessDay: ctx.businessDay,
        DateTime: itemDate,
        DocumentType: docType,
        TicketNumber: itemNumber, InvoiceNumber: ctx.invNumber,
        UserId: userId, UserName: userName,
        Amount: baseAmount > 0 ? baseAmount : amount,
        Quantity: qty,
        ProductName: productName,
        Reason: name && !/descuento\s*manual/i.test(name) ? name : 'Invitación',
        DiscountRate: ratePct >= 99.5 ? 100 : null,
        OriginalInvoiceId: null,
        ...exceptionCustomerFields(line, it, ctx),
      });
      return true;
    }
    out.push({
      Type: 'descuento',
      WorkplaceId: ctx.workplaceId, WorkplaceName: ctx.workplaceName,
      PosId: ctx.posId, PosName: ctx.posName,
      BusinessDay: ctx.businessDay,
      DateTime: itemDate,
      DocumentType: docType,
      TicketNumber: itemNumber, InvoiceNumber: ctx.invNumber,
      UserId: userId, UserName: userName,
      Amount: amount,
      Quantity: qty,
      ProductName: productName,
      Reason: name || 'Descuento manual',
      DiscountRate: ratePct > 0 ? Math.round(ratePct * 100) / 100 : null,
      OriginalInvoiceId: null,
      ...exceptionCustomerFields(line, it, ctx),
    });
    return true;
  };

  const discountList =
    line?.Discounts ?? line?.discounts ??
    line?.SaleLineDiscounts ?? line?.saleLineDiscounts ??
    line?.LineDiscounts ?? line?.lineDiscounts ?? [];
  if (Array.isArray(discountList) && discountList.length > 0) {
    for (const d of discountList) {
      const name = d?.DiscountName ?? d?.discountName ?? d?.Name ?? d?.name;
      const amount = d?.DiscountAmount ?? d?.discountAmount ?? d?.Amount ?? d?.amount;
      const rate = d?.DiscountRate ?? d?.discountRate ?? d?.Rate ?? d?.rate;
      if (emitDiscountEntry(name, amount, rate)) pushed = true;
    }
    return pushed;
  }
  const lineDiscountAmt =
    line?.DiscountAmount ?? line?.discountAmount ??
    line?.CashDiscount ?? line?.cashDiscount;
  const lineDiscountRate = line?.DiscountRate ?? line?.discountRate;
  if (emitDiscountEntry(null, lineDiscountAmt, lineDiscountRate)) pushed = true;
  return pushed;
}

/**
 * Resuelve conflictos entre excepciones del mismo ticket:
 *  - Producto cortesía prevalece sobre descuento manual e invitación pura.
 *  - Descuento manual prevalece sobre invitación pura (sin cortesía).
 */
function dedupeInvitacionesSuperseded(rows) {
  const hasCortesia = rows.some(
    (r) => r.Type === 'invitacion' && r.Reason === 'Producto cortesía',
  );
  const hasDescuento = rows.some((r) => r.Type === 'descuento');
  if (!hasCortesia && !hasDescuento) return rows;
  return rows.filter((r) => {
    if (hasCortesia && r.Type === 'descuento') return false;
    // Invitación heurística (sin DiscountRate explícito) queda absorbida si hay cortesía/descuento.
    // Las invitaciones detectadas como descuento 100% conservan DiscountRate=100 y se mantienen.
    if (
      r.Type === 'invitacion' &&
      r.Reason === 'Invitación' &&
      (r.DiscountRate == null)
    ) {
      return !hasCortesia && !hasDescuento;
    }
    return true;
  });
}

/**
 * Extrae las "excepciones" de un InvoiceItem (ticket, albarán, pedido o factura).
 * Heurísticas pragmáticas (la guía no expone un campo único), todas defensivas:
 *
 *  - Anulación de documento entero: campo `IsCancellation === true` o existencia
 *    de `OriginalInvoiceId`/`OriginalNumber`.
 *  - Invitación de línea: flags IsInvitation / SaleType=I / invitación clásica
 *    (precio carta > 0, cobrado ≈ 0). Prioridad inferior a producto cortesía y
 *    descuento manual en la misma línea o ticket.
 *  - Producto cortesía: IsCourtesy o precio carta > 0 cobrado a 0 (no complementos
 *    de combo incluidos a 0 € en carta).
 *  - Descuento manual: Discounts[] o DiscountAmount/DiscountRate en línea.
 *    Prioridad: cortesía > descuento > invitación (misma línea y mismo ticket).
 *  - Anulación de línea: IsCancellation / IsCancelled / Cancellations[].
 */
function extractExceptionsFromInvoiceItem(it, ctx) {
  const out = [];
  const itemNumber = String(
    it?.SerialNumber ?? it?.serialNumber ?? it?.Number ?? it?.number ?? it?.Id ?? it?.id ?? '',
  ).trim();
  const itemDate = String(
    it?.Date ?? it?.date ?? it?.DateTime ?? it?.dateTime ?? '',
  ).trim() || ctx.invDate;
  const contentType = it?.ContentType ?? it?.contentType ?? '';
  const docType = docTypeLabel(contentType);
  const userId = pickUserId(it) ?? ctx.invUserId;
  const userName = pickUserName(it) ?? ctx.invUserName;

  const hasOriginalRef = (v) => {
    if (v == null) return false;
    const s = String(v).trim();
    return s !== '' && s !== '0';
  };
  const itemIsCancellation =
    it?.IsCancellation === true ||
    it?.isCancellation === true ||
    it?.IsCancelled === true ||
    it?.isCancelled === true ||
    hasOriginalRef(it?.OriginalInvoiceId ?? it?.originalInvoiceId) ||
    hasOriginalRef(it?.OriginalNumber ?? it?.originalNumber);

  const itemAmount = toNumberSafe(
    it?.Totals?.GrossAmount ?? it?.totals?.grossAmount ??
    it?.GrossAmount ?? it?.grossAmount,
  );

  if (itemIsCancellation) {
    out.push({
      Type: 'anulacion',
      WorkplaceId: ctx.workplaceId,
      WorkplaceName: ctx.workplaceName,
      PosId: ctx.posId,
      PosName: ctx.posName,
      BusinessDay: ctx.businessDay,
      DateTime: itemDate,
      DocumentType: docType,
      TicketNumber: itemNumber,
      InvoiceNumber: ctx.invNumber,
      UserId: userId,
      UserName: userName,
      Amount: itemAmount,
      Quantity: null,
      ProductName: null,
      Reason: 'Documento anulado',
      DiscountRate: null,
      OriginalInvoiceId:
        it?.OriginalInvoiceId ?? it?.originalInvoiceId ??
        it?.OriginalNumber ?? it?.originalNumber ?? null,
      ...exceptionCustomerFields(null, it, ctx),
    });
  }

  const saleLines =
    it?.SaleLines ?? it?.saleLines ??
    it?.Lines ?? it?.lines ??
    it?.DocumentLines ?? it?.documentLines ?? [];

  if (!Array.isArray(saleLines)) return dedupeInvitacionesSuperseded(out);

  const lineMetaBase = {
    itemDate, docType, itemNumber, userId, userName,
  };

  // Cliente CONSUMO a nivel item (Id 1 / nombre "CONSUMO"): cualquier línea
  // que no genere otra excepción se registrará como Type: 'consumo'.
  const itemCustomerId = pickCustomerId(it) ?? ctx.invCustomerId ?? null;
  const itemCustomerName = pickCustomerName(it) ?? ctx.invCustomerName ?? null;
  const isItemConsumo = isConsumoCustomerEntry(itemCustomerId, itemCustomerName);

  for (const line of saleLines) {
    const qty = toNumberSafe(line?.Quantity ?? line?.quantity);
    const productName = String(
      line?.ProductName ?? line?.productName ??
      line?.Product?.Name ?? line?.product?.name ??
      line?.Name ?? line?.name ?? '',
    ).trim() || null;
    const lineGross = toNumberSafe(
      line?.TotalAmount ?? line?.totalAmount ??
      line?.LineGrossAmount ?? line?.lineGrossAmount ??
      line?.GrossAmount ?? line?.grossAmount ??
      line?.Total ?? line?.total ??
      line?.NetAmount ?? line?.netAmount ??
      line?.Amount ?? line?.amount,
    );
    const unitPrice = toNumberSafe(
      line?.UnitPrice ?? line?.unitPrice ?? line?.Price ?? line?.price,
    );
    const productPrice = pickLineProductPrice(line);

    // Anulación de línea
    const lineCancelled =
      line?.IsCancellation === true || line?.isCancellation === true ||
      line?.IsCancelled === true || line?.isCancelled === true ||
      (Array.isArray(line?.Cancellations) && line.Cancellations.length > 0) ||
      (Array.isArray(line?.cancellations) && line.cancellations.length > 0);

    /** true = línea ya procesada (emitida como excepción o saltada como subcomponente). */
    let lineHandled = false;

    if (lineCancelled) {
      out.push({
        Type: 'anulacion',
        WorkplaceId: ctx.workplaceId, WorkplaceName: ctx.workplaceName,
        PosId: ctx.posId, PosName: ctx.posName,
        BusinessDay: ctx.businessDay,
        DateTime: itemDate,
        DocumentType: docType,
        TicketNumber: itemNumber, InvoiceNumber: ctx.invNumber,
        UserId: userId, UserName: userName,
        Amount: Math.abs(lineGross),
        Quantity: qty,
        ProductName: productName,
        Reason: 'Línea anulada',
        DiscountRate: null,
        OriginalInvoiceId: null,
        ...exceptionCustomerFields(line, it, ctx),
      });
      lineHandled = true;
    }

    // Mezcladores / complementos incluidos en combo (p. ej. "c. GINGER ALE" a 0 €)
    if (
      !lineHandled &&
      isSaleLineSubComponent(line) &&
      unitPrice <= 0.001 &&
      Math.abs(lineGross) < 0.001
    ) {
      lineHandled = true; // saltado, no genera excepción ni consumo
    }

    // Promoción / oferta automática de Ágora (OfferCode).
    // Solo se emite como promoción si hay un descuento monetario detectable
    // (CashDiscount, DiscountRate, o lineGross < baseAmt). Si la línea va a 0
    // sin descuento explícito, se trata como cortesía / regalo en el flujo siguiente.
    if (!lineHandled) {
      const offer = pickLineOffer(line);
      if (offer && !isSaleLineSubComponent(line)) {
        const baseAmt =
          productPrice > 0.001 && qty > 0 ? productPrice * qty
          : unitPrice > 0.001 && qty > 0 ? unitPrice * qty
          : 0;
        const lineDiscountAmt = toNumberSafe(
          line?.CashDiscount ?? line?.cashDiscount ??
          line?.DiscountAmount ?? line?.discountAmount,
        );
        const lineDiscountRate = normalizeDiscountRate(
          line?.DiscountRate ?? line?.discountRate,
        );
        let amountPromo = lineDiscountAmt;
        if (amountPromo <= 0.001 && baseAmt > 0 && lineGross > 0.001) {
          amountPromo = Math.max(0, baseAmt - lineGross);
        }
        if (amountPromo <= 0.001 && lineDiscountRate > 0 && baseAmt > 0) {
          amountPromo = (baseAmt * lineDiscountRate) / 100;
        }
        if (amountPromo > 0.001 || lineDiscountRate > 0.001) {
          const ratePct = lineDiscountRate > 0
            ? lineDiscountRate
            : (amountPromo > 0 && baseAmt > 0 ? (amountPromo / baseAmt) * 100 : 0);
          out.push({
            Type: 'promocion',
            WorkplaceId: ctx.workplaceId, WorkplaceName: ctx.workplaceName,
            PosId: ctx.posId, PosName: ctx.posName,
            BusinessDay: ctx.businessDay,
            DateTime: itemDate,
            DocumentType: docType,
            TicketNumber: itemNumber, InvoiceNumber: ctx.invNumber,
            UserId: userId, UserName: userName,
            Amount: amountPromo,
            Quantity: qty,
            ProductName: productName,
            Reason: `Promoción ${offer.code}`,
            DiscountRate: ratePct > 0 ? Math.round(ratePct * 100) / 100 : null,
            OriginalInvoiceId: null,
            ...exceptionCustomerFields(line, it, ctx),
          });
          lineHandled = true;
        }
        // OfferCode presente pero sin descuento monetario calculable → cae al flujo cortesía
      }
    }

    if (!lineHandled) {
      // Invitación / producto cortesía / descuento manual (prioridad: cortesía > descuento > invitación)
      const saleType = String(line?.SaleType ?? line?.saleType ?? '').trim().toUpperCase();
      const hasExplicitInvitation =
        line?.IsInvitation === true || line?.isInvitation === true ||
        saleType === 'INVITATION' || saleType === 'INVITACION';

      const isCourtesyFlag = line?.IsCourtesy === true || line?.isCourtesy === true;
      const cobradoCero =
        qty > 0 && unitPrice <= 0.001 && Math.abs(lineGross) < 0.001;
      // Cortesía: línea sin importe que no es subcomponente de combo (mezclador / modificador)
      const productoCortesiaLine =
        cobradoCero && !isSaleLineSubComponent(line);
      const isProductoCortesia = isCourtesyFlag || productoCortesiaLine;
      // Invitación clásica: precio carta > 0 con cobro a 0 (requiere conocer ProductPrice)
      const invitacionClasica =
        qty > 0 && productPrice > 0.001 &&
        unitPrice <= 0.001 && Math.abs(lineGross) < 0.001;
      const isInvitacionPura =
        !isProductoCortesia &&
        cobradoCero &&
        (hasExplicitInvitation || invitacionClasica);
      const hasManualDiscount = lineHasManualDiscount(line);
      const lineMeta = { ...lineMetaBase, qty, productName, lineGross };

      if (isProductoCortesia) {
        out.push({
          Type: 'invitacion',
          WorkplaceId: ctx.workplaceId, WorkplaceName: ctx.workplaceName,
          PosId: ctx.posId, PosName: ctx.posName,
          BusinessDay: ctx.businessDay,
          DateTime: itemDate,
          DocumentType: docType,
          TicketNumber: itemNumber, InvoiceNumber: ctx.invNumber,
          UserId: userId, UserName: userName,
          Amount: Math.abs(lineGross || (productPrice > 0 ? productPrice * qty : unitPrice)),
          Quantity: qty,
          ProductName: productName,
          Reason: 'Producto cortesía',
          DiscountRate: null,
          OriginalInvoiceId: null,
          ...exceptionCustomerFields(line, it, ctx),
        });
        lineHandled = true;
      } else if (hasManualDiscount) {
        const pushed = pushLineManualDiscounts(out, line, it, ctx, lineMeta);
        if (pushed) lineHandled = true;
      } else if (isInvitacionPura) {
        out.push({
          Type: 'invitacion',
          WorkplaceId: ctx.workplaceId, WorkplaceName: ctx.workplaceName,
          PosId: ctx.posId, PosName: ctx.posName,
          BusinessDay: ctx.businessDay,
          DateTime: itemDate,
          DocumentType: docType,
          TicketNumber: itemNumber, InvoiceNumber: ctx.invNumber,
          UserId: userId, UserName: userName,
          Amount: qty > 0 && unitPrice > 0 ? qty * unitPrice : Math.abs(lineGross || unitPrice),
          Quantity: qty,
          ProductName: productName,
          Reason: 'Invitación',
          DiscountRate: null,
          OriginalInvoiceId: null,
          ...exceptionCustomerFields(line, it, ctx),
        });
        lineHandled = true;
      } else {
        const pushed = pushLineManualDiscounts(out, line, it, ctx, lineMeta);
        if (pushed) lineHandled = true;
      }
    }

    // Cliente CONSUMO: si la línea no generó ninguna excepción y es una venta
    // real (qty > 0 con importe), registrarla como Type: 'consumo'.
    if (!lineHandled && isItemConsumo && qty > 0 && Math.abs(lineGross) > 0.001) {
      out.push({
        Type: 'consumo',
        WorkplaceId: ctx.workplaceId, WorkplaceName: ctx.workplaceName,
        PosId: ctx.posId, PosName: ctx.posName,
        BusinessDay: ctx.businessDay,
        DateTime: itemDate,
        DocumentType: docType,
        TicketNumber: itemNumber, InvoiceNumber: ctx.invNumber,
        UserId: userId, UserName: userName,
        Amount: Math.abs(lineGross),
        Quantity: qty,
        ProductName: productName,
        Reason: 'Cliente CONSUMO',
        DiscountRate: null,
        OriginalInvoiceId: null,
        ...exceptionCustomerFields(line, it, ctx),
      });
    }
  }

  return dedupeInvitacionesSuperseded(out);
}

router.get('/agora/invoices/exceptions', async (req, res) => {
  const dateFromRaw = String(req.query.dateFrom || '').trim();
  const dateToRaw = String(req.query.dateTo || '').trim();
  const workplaceIdsRaw = req.query.workplaceIds ?? req.query['workplaceIds[]'];
  let workplaceIds = [];
  if (Array.isArray(workplaceIdsRaw)) {
    workplaceIds = workplaceIdsRaw.map((v) => String(v).trim()).filter(Boolean);
  } else if (typeof workplaceIdsRaw === 'string' && workplaceIdsRaw.trim()) {
    workplaceIds = workplaceIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const refresh = String(req.query.refresh || '') === '1';

  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isIso(dateFromRaw) || !isIso(dateToRaw)) {
    return res.status(400).json({ error: 'dateFrom y dateTo deben ser YYYY-MM-DD' });
  }
  if (dateFromRaw > dateToRaw) {
    return res.status(400).json({ error: 'dateFrom debe ser <= dateTo' });
  }

  const MAX_DAYS = workplaceIds.length === 1 ? 365 : 31;
  const days = [];
  {
    let d = new Date(dateFromRaw + 'T12:00:00');
    const end = new Date(dateToRaw + 'T12:00:00');
    while (d <= end) {
      days.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
      if (days.length > MAX_DAYS) break;
    }
  }
  if (days.length > MAX_DAYS) {
    const msg = workplaceIds.length === 1
      ? `Rango máximo permitido: ${MAX_DAYS} días`
      : `Rango máximo permitido: ${MAX_DAYS} días con ${workplaceIds.length === 0 ? 'todos los locales' : `${workplaceIds.length} locales`}. Selecciona 1 solo local para ampliar hasta 365 días.`;
    return res.status(400).json({ error: msg });
  }

  const cacheKey = exceptionsCacheKey(dateFromRaw, dateToRaw, workplaceIds);
  let cached = refresh ? null : exceptionsCacheGet(cacheKey);
  let allRows;
  let cachedAt;
  let fromCache = false;

  if (cached) {
    allRows = cached.rows;
    cachedAt = cached.cachedAt;
    fromCache = true;
  } else {
    const workplaces = workplaceIds.length > 0 ? workplaceIds : null;
    const CHUNK = 4;
    const invoicesByDay = new Map();
    for (let i = 0; i < days.length; i += CHUNK) {
      const slice = days.slice(i, i + CHUNK);
      const results = await Promise.all(
        slice.map((day) =>
          exportInvoices(day, workplaces ?? undefined)
            .then((data) => ({ day, data, err: null }))
            .catch((err) => ({ day, data: null, err })),
        ),
      );
      for (const r of results) {
        if (r.err) {
          console.warn('[agora/invoices/exceptions]', r.day, r.err.message || r.err);
          invoicesByDay.set(r.day, []);
        } else {
          invoicesByDay.set(r.day, extractCloseOutsArray(r.data, ['Invoices', 'invoices']));
        }
      }
    }

    // Resolución de nombres de usuario por Id (a partir del maestro cacheado).
    let userMap = new Map();
    try {
      userMap = await getAllUsersMap(docClient, tableAgoraUsuariosName);
    } catch (e) {
      console.warn('[agora/invoices/exceptions] usersMap', e.message || e);
    }

    const built = [];
    for (const day of days) {
      const listForDay = invoicesByDay.get(day) ?? [];
      for (const inv of listForDay) {
        const workplaceId = String(
          inv?.Workplace?.Id ?? inv?.workplace?.id ?? inv?.WorkplaceId ?? inv?.workplaceId ?? '',
        ).trim() || '0';
        const workplaceName =
          inv?.Workplace?.Name ?? inv?.workplace?.name ??
          inv?.WorkplaceName ?? inv?.workplaceName ?? null;
        const posId = inv?.Pos?.Id ?? inv?.pos?.id ?? inv?.PosId ?? inv?.posId ?? null;
        const posName = inv?.Pos?.Name ?? inv?.pos?.name ?? inv?.PosName ?? inv?.posName ?? null;
        const bd = String(
          inv?.BusinessDay ?? inv?.businessDay ?? day,
        ).trim() || day;
        const invNumber = String(
          inv?.SerialNumber ?? inv?.serialNumber ??
          inv?.Number ?? inv?.number ??
          inv?.Id ?? inv?.id ?? '',
        ).trim();
        const invDate = String(inv?.Date ?? inv?.date ?? inv?.DateTime ?? inv?.dateTime ?? '').trim();
        const invUserId = pickUserId(inv);
        const invUserName = pickUserName(inv);
        const invCustomerId = pickCustomerId(inv);
        const invCustomerName = pickCustomerName(inv);
        const ctx = {
          workplaceId, workplaceName, posId, posName,
          businessDay: bd, invNumber, invDate, invUserId, invUserName,
          invCustomerId, invCustomerName,
        };

        const items = inv?.InvoiceItems ?? inv?.invoiceItems ?? [];
        if (Array.isArray(items) && items.length > 0) {
          for (const it of items) {
            built.push(...extractExceptionsFromInvoiceItem(it, ctx));
          }
        } else {
          // Factura plana (sin InvoiceItems): la tratamos como un "item" virtual.
          built.push(...extractExceptionsFromInvoiceItem(inv, ctx));
        }
      }
    }

    // Resolver UserName por Id si no venía o si tenemos uno mejor en el maestro.
    for (const r of built) {
      if (r.UserId != null) {
        const named = userMap.get(String(r.UserId));
        if (named) r.UserName = named;
      }
    }

    built.sort((a, b) => {
      const wn = String(a.WorkplaceName ?? a.WorkplaceId ?? '').localeCompare(
        String(b.WorkplaceName ?? b.WorkplaceId ?? ''),
      );
      if (wn !== 0) return wn;
      const bd = String(b.BusinessDay ?? '').localeCompare(String(a.BusinessDay ?? ''));
      if (bd !== 0) return bd;
      const dt = String(b.DateTime ?? '').localeCompare(String(a.DateTime ?? ''));
      if (dt !== 0) return dt;
      return String(b.TicketNumber ?? '').localeCompare(String(a.TicketNumber ?? ''));
    });

    exceptionsCacheSet(cacheKey, built);
    allRows = built;
    cachedAt = Date.now();
    fromCache = false;
  }

  res.json({
    dateFrom: dateFromRaw,
    dateTo: dateToRaw,
    workplaceIds,
    fromCache,
    cachedAt: new Date(cachedAt).toISOString(),
    count: allRows.length,
    rows: allRows,
  });
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

// Formas de pago de Ágora (Guía 8.1.6 p.27-29, 206).
// Devuelve el catálogo de PaymentMethods cacheado en memoria (TTL 1h, stale-while-error).
// Si la caché está fresca, no se llama a Ágora. Si está expirada o vacía, se recarga.
// Si Ágora falla y hay caché previa se devuelve marcada como stale; si no hay caché,
// se sirve el fallback inicial hardcodeado.
router.get('/agora/payment-methods', async (req, res) => {
  const force = String(req.query.force || '').toLowerCase() === 'true';
  if (force) {
    paymentMethodsCache.fetchedAt = 0;
  }
  try {
    const result = await getPaymentMethodsCached();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Error obteniendo formas de pago' });
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
      // Contrato preservado: devolver 200 con productos:[] para no romper el frontend
      // que renderiza la lista aunque esté vacía y muestra el mensaje como banner.
      req.log.warn({ err }, 'Tabla AgoraProducts no encontrada');
      return res.json({
        productos: [],
        error: 'Tabla Igp_AgoraProducts no existe. Ejecuta sync o crea la tabla.',
      });
    }
    throw err;
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
      const e = new Error(
        'Tabla Igp_AgoraProducts no existe. Ejecuta: node api/scripts/create-agora-products-table.js'
      );
      e.status = 404;
      throw e;
    }
    throw err;
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
      const e = new Error('Producto no encontrado');
      e.status = 404;
      throw e;
    }
    throw err;
  }
});

router.get('/agora/sale-centers', async (req, res) => {
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
      // Override explícito: el middleware mapea ConditionalCheckFailedException a 409
      // pero aquí la semántica real es "el ítem no existe" (404), no conflicto de versión.
      const e = new Error(`Punto de venta con id ${id} no encontrado`);
      e.status = 404;
      throw e;
    }
    throw err;
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
  {
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
  }
});

router.post('/agora/warehouses/sync', async (req, res) => {
  {
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
      const nombreFiscal = String(fiscalInfo.FiscalName ?? fiscalInfo.fiscalName ?? '').trim();
      const cif = String(fiscalInfo.Cif ?? fiscalInfo.cif ?? '').trim();
      const parts = [
        w.Street ?? w.street ?? '',
        w.City ?? w.city ?? '',
        w.Region ?? w.region ?? '',
        w.ZipCode ?? w.zipCode ?? '',
      ].filter(Boolean);
      const direccion = parts.join(', ');

      const getCmd = new GetCommand({
        TableName: tableAlmacenesName,
        Key: { Id: idStr },
      });
      const got = await docClient.send(getCmd);
      const existing = got.Item || {};
      const existed = !!got.Item;

      // Conservamos `Descripcion` editada manualmente; el nombre fiscal pasa a su propio campo.
      const item = {
        Id: idStr,
        Nombre: nombre || idStr,
        NombreFiscal: nombreFiscal,
        Cif: cif,
        Descripcion: String(existing.Descripcion ?? ''),
        Direccion: direccion,
      };

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

  {
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

  {
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
  }
});

router.post('/agora/closeouts/complete-fields', async (req, res) => {
  const body = req.body || {};
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5000, 1), 10000);
  const dateFrom = (body.dateFrom || '').toString().trim();
  const dateTo = (body.dateTo || '').toString().trim();
  const filterWorkplaceId = (body.workplaceId || '').toString().trim();

  {
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
  await docClient.send(new PutCommand({ TableName: tableSalesCloseOutsName, Item: item }));
  res.json({ ok: true, item: { PK: item.PK, SK: item.SK } });
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
    {
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
  await docClient.send(new UpdateCommand({
    TableName: tableSalesCloseOutsName,
    Key: { PK: pk, SK: sk },
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues,
  }));
  res.json({ ok: true });
});

router.delete('/agora/closeouts', async (req, res) => {
  const pk = (req.query.PK ?? req.query.pk ?? req.body?.PK ?? req.body?.pk ?? '').toString().trim();
  const sk = (req.query.SK ?? req.query.sk ?? req.body?.SK ?? req.body?.sk ?? '').toString().trim();
  if (!pk || !sk) return res.status(400).json({ error: 'PK y SK obligatorios' });
  await docClient.send(new DeleteCommand({
    TableName: tableSalesCloseOutsName,
    Key: { PK: pk, SK: sk },
  }));
  res.json({ ok: true });
});

// ──────────────────────────────────────────
// Compras a Proveedor (Purchases)
// ──────────────────────────────────────────

router.get('/agora/purchases/por-producto', async (req, res) => {
  const { productId, fechaInicio, fechaFin } = req.query;
  if (!productId) return res.status(400).json({ error: 'productId es obligatorio' });

  {
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
  {
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

  {
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
              const pid = String(productId);
              const sortKey = `${noteDate}|${serie}|${number}`;
              const existing = purchaseVatMap.get(pid);
              if (!existing || sortKey > existing.key) {
                purchaseVatMap.set(pid, { vatRate, key: sortKey });
              }
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
        req.log.info({ count: purchaseVatUpdated }, '[agora/purchases/sync] ultimo_iva_compra actualizado');
      } catch (err) {
        req.log.warn({ err }, '[agora/purchases/sync] Error actualizando ultimo_iva_compra');
      }
    }

    invalidatePurchasesCache();
    req.log.info({ dateFrom, dateTo, totalFetched, totalUpserted, purchaseVatUpdated, errors: errors.length }, '[agora/purchases/sync] Completado');
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
  }
});

export default router;
