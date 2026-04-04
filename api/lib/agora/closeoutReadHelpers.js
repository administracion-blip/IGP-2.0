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

export function addExcelStyleFields(item) {
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
