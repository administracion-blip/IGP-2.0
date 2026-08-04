/**
 * Cálculo de importes del módulo Refacturación.
 * El incremento es fijo y se recalcula siempre en servidor (no confiar en el cliente).
 */

/** Porcentaje fijo sobre el precio base unitario (sin IVA). */
export const INCREMENTO_REFACTURACION_PCT = 5;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Recalcula precio refacturado e importes de una línea.
 * @param {{ cantidad?: any, precio_base_unitario?: any, tipo_iva?: any, descuento?: any, descuento_pct?: any }} input
 * @returns {{
 *   incremento_pct: number,
 *   precio_base_unitario: number,
 *   precio_refacturado_unitario: number,
 *   cantidad: number,
 *   tipo_iva: number,
 *   descuento: number,
 *   base_linea: number,
 *   iva_linea: number,
 *   total_linea: number,
 * }}
 */
export function recalcularLineaRefacturacion(input = {}) {
  const cantidad = Number(input.cantidad) || 0;
  const precio_base_unitario = Number(input.precio_base_unitario) || 0;
  const tipo_iva = Number(input.tipo_iva) || 0;
  const descuento = Number(input.descuento ?? input.descuento_pct) || 0;
  const incremento_pct = INCREMENTO_REFACTURACION_PCT;

  const precio_refacturado_unitario = round2(
    precio_base_unitario * (1 + incremento_pct / 100),
  );
  const base_linea = round2(
    cantidad * precio_refacturado_unitario * (1 - descuento / 100),
  );
  const iva_linea = round2((base_linea * tipo_iva) / 100);
  const total_linea = round2(base_linea + iva_linea);

  return {
    incremento_pct,
    precio_base_unitario: round2(precio_base_unitario),
    precio_refacturado_unitario,
    cantidad,
    tipo_iva,
    descuento,
    base_linea,
    iva_linea,
    total_linea,
  };
}

/**
 * Heurística: ¿el OCR parece una factura (vs ticket)?
 * Criterio: nº factura proveedor + CIF + total > 0.
 */
export function pareceFactura(datosOcr = {}) {
  const numero = String(
    datosOcr.numero_factura_proveedor
      ?? datosOcr.numero_factura
      ?? datosOcr.numero
      ?? '',
  ).trim();
  const cif = String(
    datosOcr.cif
      ?? datosOcr.emisor_cif
      ?? datosOcr.proveedor_cif
      ?? '',
  ).trim();
  const total = Number(
    datosOcr.total_factura
      ?? datosOcr.total
      ?? datosOcr.importe_total
      ?? 0,
  );
  return Boolean(numero && cif && total > 0);
}
