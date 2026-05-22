export const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export function extractNumberFromSk(sk) {
  if (!sk || typeof sk !== 'string') return '';
  const parts = String(sk).trim().split('#');
  return parts.length >= 2 ? parts[parts.length - 1] : '';
}

export function formatFechaNegocio(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const parts = String(iso).trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// Alias para agrupar nombres de formas de pago en sus canónicos.
// Coincide con STRING_KEY_TO_CANONICAL del backend y PAYMENT_ALIASES del frontend.
// Permite que renames en Ágora (p.ej. "Tarjeta" -> "Tarjeta Manual") sigan agregándose
// en la columna canónica correspondiente sin partir las columnas.
const EXCEL_PAYMENT_ALIASES = {
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
const EXCEL_PAYMENT_KEYS = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];

function canonicalPaymentName(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  if (!k) return null;
  if (EXCEL_PAYMENT_ALIASES[k]) return EXCEL_PAYMENT_ALIASES[k];
  const exact = EXCEL_PAYMENT_KEYS.find((kk) => kk.toLowerCase() === k);
  return exact ?? null;
}

export function addExcelStyleFields(item) {
  if (!item || typeof item !== 'object') return item;
  const ensureArray = (arr) => (Array.isArray(arr) ? arr : []);
  const payments = ensureArray(item.InvoicePayments ?? item.invoicePayments);
  const amounts = item.Amounts ?? item.amounts ?? {};
  const gross = amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total;
  const sumPayments = payments.reduce((s, p) => s + (Number(p?.Amount ?? p?.amount ?? 0) || 0), 0);
  const ventas = gross != null ? (typeof gross === 'number' ? gross : parseFloat(String(gross).replace(',', '.')) || 0) : sumPayments;
  // Suma los importes por canónico aplicando alias. Así un cierre con
  // [{ MethodName: "Tarjeta", Amount: 0 }, { MethodName: "Tarjeta Manual", Amount: 50 }]
  // queda como Tarjeta=50 en lugar de Tarjeta=0 (bug por match estricto que ocultaba el real).
  const byMethod = Object.fromEntries(EXCEL_PAYMENT_KEYS.map((k) => [k, 0]));
  for (const p of payments) {
    const canon = canonicalPaymentName(p?.MethodName ?? p?.methodName);
    if (canon == null) continue;
    const rawAmt = p?.Amount ?? p?.amount ?? 0;
    const amt = typeof rawAmt === 'number' ? rawAmt : parseFloat(String(rawAmt).replace(',', '.')) || 0;
    byMethod[canon] = (byMethod[canon] ?? 0) + amt;
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

export function normalizeCloseOutForResponse(item) {
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
