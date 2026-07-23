/**
 * Reglas compartidas de validez de líneas de venta para incentivos por producto.
 * Debe mantenerse alineado con las heurísticas de excepciones en agora.js.
 */

export const CONSUMO_CUSTOMER_ID = '1';
export const CONSUMO_CUSTOMER_NAME = 'CONSUMO';

/**
 * Umbral de descuento a partir del cual la bonificación por unidad se reduce
 * proporcionalmente al precio realmente cobrado. Por defecto 30%.
 */
export const UMBRAL_DESCUENTO_BONIFICACION =
  (parseFloat(process.env.INCENTIVOS_UMBRAL_DESCUENTO || '30') || 30) / 100;

export function toNumberSafe(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  return parseFloat(String(v).replace(',', '.')) || 0;
}

export function pickCustomerId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    obj?.Customer?.Id ?? obj?.customer?.id ??
    obj?.CustomerId ?? obj?.customerId ??
    null
  );
}

export function pickCustomerName(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    obj?.Customer?.Name ?? obj?.customer?.name ??
    obj?.CustomerName ?? obj?.customerName ??
    obj?.Customer?.FiscalName ?? obj?.customer?.fiscalName ??
    null
  );
}

export function isConsumoCustomerEntry(customerId, customerName) {
  if (customerId != null && String(customerId).trim() === CONSUMO_CUSTOMER_ID) return true;
  if (String(customerName ?? '').trim().toUpperCase() === CONSUMO_CUSTOMER_NAME) return true;
  return false;
}

function hasOriginalRef(v) {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== '' && s !== '0';
}

/** Documento (ticket/factura/item) anulado a nivel entero. */
export function esDocumentoAnulado(it) {
  return (
    it?.IsCancellation === true ||
    it?.isCancellation === true ||
    it?.IsCancelled === true ||
    it?.isCancelled === true ||
    hasOriginalRef(it?.OriginalInvoiceId ?? it?.originalInvoiceId) ||
    hasOriginalRef(it?.OriginalNumber ?? it?.originalNumber)
  );
}

export function pickLineProductPrice(line) {
  return toNumberSafe(
    line?.ProductPrice ?? line?.productPrice ??
    line?.Product?.Price ?? line?.product?.price ??
    line?.MenuPrice ?? line?.menuPrice ??
    line?.StandardPrice ?? line?.standardPrice ??
    line?.BasePrice ?? line?.basePrice,
  );
}

export function isSaleLineSubComponent(line) {
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

function normalizeDiscountRate(rate) {
  const r = toNumberSafe(rate);
  if (r <= 0) return 0;
  if (r <= 1.0001) return r * 100;
  return r;
}

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

/** Descuento manual al 100% o línea regalada → no devenga incentivo. */
function esInvitacionPorDescuentoTotal(line, qty, lineGross) {
  if (!lineHasManualDiscount(line)) return false;
  const unitPrice = toNumberSafe(
    line?.UnitPrice ?? line?.unitPrice ?? line?.Price ?? line?.price,
  );
  const productPrice = pickLineProductPrice(line);
  const baseAmount =
    productPrice > 0.001 && qty > 0 ? productPrice * qty
    : unitPrice > 0.001 && qty > 0 ? unitPrice * qty
    : 0;

  const discountList =
    line?.Discounts ?? line?.discounts ??
    line?.SaleLineDiscounts ?? line?.saleLineDiscounts ??
    line?.LineDiscounts ?? line?.lineDiscounts ?? [];
  if (Array.isArray(discountList) && discountList.length > 0) {
    for (const d of discountList) {
      const ratePct = normalizeDiscountRate(d?.DiscountRate ?? d?.discountRate ?? d?.Rate ?? d?.rate);
      const amount = toNumberSafe(
        d?.DiscountAmount ?? d?.discountAmount ?? d?.Amount ?? d?.amount,
      );
      if (ratePct >= 99.5) return true;
      if (baseAmount > 0.001 && Math.abs(lineGross) < 0.001 && amount >= baseAmount - 0.01) return true;
    }
  }
  const lineDiscountRate = normalizeDiscountRate(line?.DiscountRate ?? line?.discountRate);
  if (lineDiscountRate >= 99.5) return true;
  if (baseAmount > 0.001 && Math.abs(lineGross) < 0.001) return true;
  return false;
}

/**
 * Descuento efectivo de la línea en tanto por uno (0..1).
 * Combina la tasa de descuento explícita (rate/importe) con el descuento
 * derivado del precio (precio realmente cobrado vs. precio de tarifa), para
 * capturar tanto descuentos por porcentaje como por importe.
 */
export function descuentoLinea(line, qty, lineGross) {
  let descuento = 0;

  const discountList =
    line?.Discounts ?? line?.discounts ??
    line?.SaleLineDiscounts ?? line?.saleLineDiscounts ??
    line?.LineDiscounts ?? line?.lineDiscounts ?? [];
  if (Array.isArray(discountList)) {
    for (const d of discountList) {
      const ratePct = normalizeDiscountRate(d?.DiscountRate ?? d?.discountRate ?? d?.Rate ?? d?.rate);
      if (ratePct / 100 > descuento) descuento = ratePct / 100;
    }
  }
  const lineRatePct = normalizeDiscountRate(line?.DiscountRate ?? line?.discountRate);
  if (lineRatePct / 100 > descuento) descuento = lineRatePct / 100;

  // Descuento derivado del precio (captura descuentos por importe).
  const q = toNumberSafe(qty);
  const productPrice = pickLineProductPrice(line);
  const unitPrice = toNumberSafe(
    line?.UnitPrice ?? line?.unitPrice ?? line?.Price ?? line?.price,
  );
  const tarifaUnit = productPrice > 0.001 ? productPrice : unitPrice;
  if (tarifaUnit > 0.001 && q > 0) {
    const realUnit = Math.abs(toNumberSafe(lineGross)) / q;
    const descPrecio = 1 - realUnit / tarifaUnit;
    if (descPrecio > descuento) descuento = descPrecio;
  }

  if (descuento < 0) descuento = 0;
  if (descuento > 1) descuento = 1;
  return descuento;
}

/**
 * Factor de bonificación por unidad (0..1).
 * - Descuento ≤ umbral (30% por defecto): factor 1 (bonificación entera).
 * - Descuento > umbral: factor = precio realmente cobrado / precio de tarifa,
 *   es decir, la bonificación se reduce proporcionalmente al descuento.
 */
export function factorBonificacionLinea(line, qty, lineGross, umbral = UMBRAL_DESCUENTO_BONIFICACION) {
  const descuento = descuentoLinea(line, qty, lineGross);
  if (descuento <= umbral + 1e-9) return 1;
  return 1 - descuento;
}

/**
 * ¿La línea cuenta para unidades de incentivo?
 * @param {object} line — SaleLine de Ágora
 * @param {{ it?: object, invCustomerId?: string|null, invCustomerName?: string|null, ignoreConsumo?: boolean }} invoiceCtx
 *   - ignoreConsumo: si es true, NO se descartan las líneas de clientes CONSUMO
 *     (el llamante decide qué hacer con ellas, p. ej. el Top respeta un toggle).
 */
export function esLineaVentaValidaParaIncentivo(line, invoiceCtx = {}) {
  const qty = toNumberSafe(line?.Quantity ?? line?.quantity);
  if (qty <= 0) return false;

  const lineCancelled =
    line?.IsCancellation === true || line?.isCancellation === true ||
    line?.IsCancelled === true || line?.isCancelled === true ||
    (Array.isArray(line?.Cancellations) && line.Cancellations.length > 0) ||
    (Array.isArray(line?.cancellations) && line.cancellations.length > 0);
  if (lineCancelled) return false;

  const unitPrice = toNumberSafe(
    line?.UnitPrice ?? line?.unitPrice ?? line?.Price ?? line?.price,
  );
  const lineGross = toNumberSafe(
    line?.TotalAmount ?? line?.totalAmount ??
    line?.LineGrossAmount ?? line?.lineGrossAmount ??
    line?.GrossAmount ?? line?.grossAmount ??
    line?.Total ?? line?.total ??
    line?.NetAmount ?? line?.netAmount ??
    line?.Amount ?? line?.amount,
  );
  const productPrice = pickLineProductPrice(line);

  if (
    isSaleLineSubComponent(line) &&
    unitPrice <= 0.001 &&
    Math.abs(lineGross) < 0.001
  ) {
    return false;
  }

  const saleType = String(line?.SaleType ?? line?.saleType ?? '').trim().toUpperCase();
  const hasExplicitInvitation =
    line?.IsInvitation === true || line?.isInvitation === true ||
    saleType === 'INVITATION' || saleType === 'INVITACION';

  const isCourtesyFlag = line?.IsCourtesy === true || line?.isCourtesy === true;
  const cobradoCero =
    qty > 0 && unitPrice <= 0.001 && Math.abs(lineGross) < 0.001;
  const productoCortesiaLine =
    cobradoCero && !isSaleLineSubComponent(line);
  const isProductoCortesia = isCourtesyFlag || productoCortesiaLine;
  const invitacionClasica =
    qty > 0 && productPrice > 0.001 &&
    unitPrice <= 0.001 && Math.abs(lineGross) < 0.001;
  const isInvitacionPura =
    !isProductoCortesia &&
    cobradoCero &&
    (hasExplicitInvitation || invitacionClasica);

  if (isProductoCortesia || isInvitacionPura) return false;
  if (esInvitacionPorDescuentoTotal(line, qty, lineGross)) return false;

  const it = invoiceCtx.it;
  const customerId =
    pickCustomerId(line) ?? pickCustomerId(it) ?? invoiceCtx.invCustomerId ?? null;
  const customerName =
    pickCustomerName(line) ?? pickCustomerName(it) ?? invoiceCtx.invCustomerName ?? null;
  if (
    !invoiceCtx.ignoreConsumo &&
    isConsumoCustomerEntry(customerId, customerName) &&
    Math.abs(lineGross) > 0.001
  ) {
    return false;
  }

  return true;
}

/**
 * Usuario que comandó la LÍNEA (quien añadió el producto), no quien cerró el
 * ticket. Según la guía del integrador de Ágora cada línea trae su `UserId`.
 */
export function pickLineUserId(line) {
  return (
    line?.UserId ?? line?.userId ??
    line?.User?.Id ?? line?.user?.id ??
    null
  );
}
