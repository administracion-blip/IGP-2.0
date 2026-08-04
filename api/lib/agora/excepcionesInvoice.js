/**
 * Extracción de excepciones (invitaciones, descuentos, anulaciones, etc.)
 * desde facturas Ágora. Compartido por GET /api/agora/invoices/exceptions
 * y el motor IA día a día. Heurísticas idénticas a la ruta original.
 */

export function toNumberSafe(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  return parseFloat(String(v).replace(',', '.')) || 0;
}

export function pickUserId(it) {
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

export function pickUserName(it) {
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
export function isConsumoCustomerEntry(customerId, customerName) {
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
export function extractExceptionsFromInvoiceItem(it, ctx) {
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

/**
 * Construye filas de excepciones a partir de un array de facturas Ágora.
 *
 * @param {array} facturas
 * @param {{
 *   usersMap?: Map<string, string>,
 *   workplaceId?: string,
 *   workplaceName?: string,
 *   businessDay?: string,
 * }} [opts] — overrides opcionales (p. ej. nombre de local IGP)
 * @returns {array} filas planas (mismo shape que GET /api/agora/invoices/exceptions)
 */
export function buildExcepcionesFromInvoices(facturas, opts = {}) {
  const usersMap = opts.usersMap instanceof Map ? opts.usersMap : new Map();
  const built = [];
  const list = Array.isArray(facturas) ? facturas : [];

  for (const inv of list) {
    const workplaceIdFromInv = String(
      inv?.Workplace?.Id ?? inv?.workplace?.id ?? inv?.WorkplaceId ?? inv?.workplaceId ?? '',
    ).trim() || '0';
    // Overrides opcionales (motor IA); la ruta HTTP no los pasa.
    const workplaceId = opts.workplaceId != null && String(opts.workplaceId).trim() !== ''
      ? String(opts.workplaceId).trim()
      : workplaceIdFromInv;
    const workplaceNameFromInv =
      inv?.Workplace?.Name ?? inv?.workplace?.name ??
      inv?.WorkplaceName ?? inv?.workplaceName ?? null;
    const workplaceName = opts.workplaceName != null && String(opts.workplaceName).trim() !== ''
      ? String(opts.workplaceName).trim()
      : workplaceNameFromInv;
    const posId = inv?.Pos?.Id ?? inv?.pos?.id ?? inv?.PosId ?? inv?.posId ?? null;
    const posName = inv?.Pos?.Name ?? inv?.pos?.name ?? inv?.PosName ?? inv?.posName ?? null;
    // Preferir BusinessDay de la factura; opts.businessDay solo como fallback (día del fetch).
    const bdFromInv = String(inv?.BusinessDay ?? inv?.businessDay ?? '').trim();
    const bdFallback = opts.businessDay != null ? String(opts.businessDay).trim() : '';
    const bd = bdFromInv || bdFallback;
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
      workplaceId,
      workplaceName,
      posId,
      posName,
      businessDay: bd,
      invNumber,
      invDate,
      invUserId,
      invUserName,
      invCustomerId,
      invCustomerName,
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

  // Resolver UserName por Id si no venía o si tenemos uno mejor en el maestro.
  for (const r of built) {
    if (r.UserId != null) {
      const named = usersMap.get(String(r.UserId));
      if (named) r.UserName = named;
    }
  }

  return built;
}
