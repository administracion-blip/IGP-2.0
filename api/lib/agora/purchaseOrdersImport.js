/**
 * Importación de PurchaseOrders (pedidos a proveedor) vía API HTTP de Ágora.
 * POST `${AGORA_BASE_URL}/api/import/` — cuerpo { PurchaseOrders: [...] }.
 *
 * Guía: docs/agora-guia-integracion.md § Pedidos a Proveedor (~819) y export PurchaseOrders (~2143).
 * Formato de línea: OrderedQuantity (~1808).
 */

import { validateAgoraBaseUrl } from './couponsImport.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Number del pedido: Ágora usa Serie+Number como identidad.
 * - Si Number es inferior al último de la serie, sobrescribe ese documento.
 * - Si es superior, avanza el contador de la serie.
 * Usamos Date.now() % 1e9 como correlativo corto único-ish. Si en tu Ágora
 * se acepta omitir Number (asignación automática), preferir omitirlo para no
 * saltar el contador de la serie del almacén.
 */
export function nextPurchaseOrderNumber() {
  return Date.now() % 1_000_000_000;
}

/**
 * Construye un PurchaseOrder mínimo para import.
 *
 * @param {{
 *   serie: string,
 *   number?: number|null,
 *   warehouseId: number|string,
 *   warehouseName?: string|null,
 *   warehouse?: object|null,   maestro Ágora (export-master Warehouses)
 *   supplierId: number|string,
 *   supplierName?: string|null,
 *   supplier?: object|null,    maestro Ágora (export-master Suppliers)
 *   status?: 'Draft'|'Confirmed',
 *   date?: string,
 *   lines: Array<{
 *     productId: number|string,
 *     productName: string,
 *     orderedQuantity: number,
 *     price?: number|null,
 *   }>,
 * }} input
 */
export function buildPurchaseOrderPayload(input) {
  const serie = String(input?.serie || '').trim();
  if (!serie) {
    const err = new Error('Serie de pedido a proveedor es obligatoria');
    err.status = 400;
    throw err;
  }

  const warehouseId = Number(String(input?.warehouseId ?? '').replace(/^0+/, '') || NaN);
  if (!Number.isFinite(warehouseId) || warehouseId <= 0) {
    const err = new Error('Warehouse.Id debe ser un número positivo');
    err.status = 400;
    throw err;
  }

  const supplierId = Number(String(input?.supplierId ?? '').replace(/^0+/, '') || NaN);
  if (!Number.isFinite(supplierId) || supplierId <= 0) {
    const err = new Error('Supplier.Id debe ser un número positivo');
    err.status = 400;
    throw err;
  }

  const statusRaw = String(input?.status || 'Draft').trim();
  const status = statusRaw === 'Confirmed' ? 'Confirmed' : 'Draft';

  const linesIn = Array.isArray(input?.lines) ? input.lines : [];
  if (!linesIn.length) {
    const err = new Error('PurchaseOrder debe tener al menos una línea');
    err.status = 400;
    throw err;
  }

  const Lines = linesIn.map((ln, index) => {
    const productId = Number(String(ln?.productId ?? '').replace(/^0+/, '') || NaN);
    if (!Number.isFinite(productId) || productId <= 0) {
      const err = new Error(`ProductId inválido en línea ${index}`);
      err.status = 400;
      throw err;
    }
    const orderedQuantity = Number(ln?.orderedQuantity);
    if (!Number.isFinite(orderedQuantity) || orderedQuantity <= 0) {
      const err = new Error(`OrderedQuantity inválida en línea ${index}`);
      err.status = 400;
      throw err;
    }

    // Misma forma que una línea exportada (PCFI 2757): todo plano, sin objeto Product.
    // Sin ProductName, unidad de compra o impuesto Ágora responde 500. TotalAmount no se envía.
    const productName = String(ln?.productName ?? '').trim();
    if (!productName) {
      const err = new Error(
        `La línea ${index + 1} (producto ${productId}) no tiene nombre; no se envía el pedido`,
      );
      err.status = 400;
      throw err;
    }
    const unidadId = ln?.purchaseUnitId != null && ln.purchaseUnitId !== ''
      ? Number(ln.purchaseUnitId)
      : NaN;
    const unidadNombre = String(ln?.purchaseUnitName ?? '').trim();
    if (!Number.isInteger(unidadId) || unidadId <= 0 || !unidadNombre) {
      const err = new Error(
        `La línea ${index + 1} (producto ${productId}) no tiene unidad de compra; no se envía el pedido`,
      );
      err.status = 400;
      throw err;
    }
    const vatId = Number(ln?.vatId);
    const vatRate = Number(ln?.vatRate);
    const surchargeRate = Number(ln?.surchargeRate);
    if (
      !Number.isInteger(vatId) || vatId <= 0
      || !Number.isFinite(vatRate) || vatRate < 0
      || !Number.isFinite(surchargeRate) || surchargeRate < 0
    ) {
      const err = new Error(
        `La línea ${index + 1} (producto ${productId}) no tiene impuesto; no se envía el pedido`,
      );
      err.status = 400;
      throw err;
    }
    /** @type {Record<string, string|number>} */
    const line = {
      Index: index,
      ProductId: productId,
      ProductName: productName,
      PurchaseUnitId: unidadId,
      PurchaseUnitName: unidadNombre,
      VatId: vatId,
      VatRate: vatRate,
      SurchargeRate: surchargeRate,
      OrderedQuantity: orderedQuantity,
      DeliveredQuantity: 0,
      DiscountRate: 0,
      CashDiscount: 0,
    };

    const price = Number(ln?.price);
    if (Number.isFinite(price) && price >= 0) line.Price = price;

    return line;
  });

  // Ágora rechaza el import (500 «No ha sido posible deserializar la propiedad Warehouse…»)
  // si Warehouse/Supplier no llegan completos como en el export: todos los textos presentes.
  const w = input?.warehouse || {};
  const s = input?.supplier || {};
  const texto = (v) => (v == null ? '' : String(v).trim());
  const Warehouse = {
    Id: warehouseId,
    Name: texto(w.Name ?? input?.warehouseName) || `Almacén ${warehouseId}`,
    Street: texto(w.Street),
    City: texto(w.City),
    Region: texto(w.Region),
    ZipCode: texto(w.ZipCode),
    Cif: texto(w.Cif ?? w.FiscalInfo?.Cif),
    FiscalName: texto(w.FiscalName ?? w.FiscalInfo?.FiscalName),
  };
  const Supplier = {
    Id: supplierId,
    FiscalName: texto(s.FiscalName ?? input?.supplierName) || `Proveedor ${supplierId}`,
    Cif: texto(s.Cif),
    Street: texto(s.Street),
    City: texto(s.City),
    Region: texto(s.Region),
    ZipCode: texto(s.ZipCode),
    ApplySurcharge: s.ApplySurcharge === true,
    AccountCode: texto(s.AccountCode),
  };

  /** @type {Record<string, unknown>} */
  const po = {
    Serie: serie,
    Warehouse,
    Supplier,
    Status: status,
    Lines,
  };

  // Number: ver comentario de nextPurchaseOrderNumber. Si input.number === null, se omite.
  if (input?.number !== null && input?.number !== undefined) {
    const n = Number(input.number);
    if (Number.isFinite(n) && n >= 0) po.Number = Math.floor(n);
  } else if (input?.number === undefined) {
    po.Number = nextPurchaseOrderNumber();
  }

  const date = input?.date != null ? String(input.date).trim() : '';
  if (date) po.Date = date;

  return po;
}

/**
 * Importa pedidos a proveedor en Ágora.
 * Credenciales desde env (mismo patrón que exportStocks / client.js).
 *
 * @param {{ purchaseOrders: object[] }} opts
 */
export async function importPurchaseOrders({ purchaseOrders }) {
  const baseUrl = (process.env.AGORA_BASE_URL || process.env.AGORA_API_BASE_URL || '').replace(/\/$/, '');
  const token = process.env.AGORA_API_TOKEN || '';
  if (!baseUrl || !token) {
    const err = new Error('AGORA_BASE_URL y AGORA_API_TOKEN son obligatorios');
    err.status = 500;
    throw err;
  }
  const normalizedBase = validateAgoraBaseUrl(baseUrl);

  if (!Array.isArray(purchaseOrders) || purchaseOrders.length === 0) {
    const err = new Error('Debe indicar al menos un PurchaseOrder');
    err.status = 400;
    throw err;
  }

  const url = `${normalizedBase}/api/import/`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Api-Token': token,
        Accept: 'application/json; charset=utf-8',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ PurchaseOrders: purchaseOrders }),
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 500) };
      }
    }

    if (!res.ok) {
      const detail =
        (data && (data.message || data.error || data.Message)) ||
        (typeof text === 'string' ? text.slice(0, 300) : '');
      const err = new Error(`Ágora respondió ${res.status}${detail ? `: ${detail}` : ''}`);
      err.status = 502;
      err.agoraStatus = res.status;
      err.agoraBody = data;
      throw err;
    }

    return { ok: true, status: res.status, data };
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error('Timeout al importar PurchaseOrders en Ágora');
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
