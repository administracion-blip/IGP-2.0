/**
 * Importes que muestra «Detalles de pedidos».
 * Con PrecioVenta, el precio y TotalLinea ya incluyen el beneficio guardado
 * al crear la línea y no se vuelve a aplicar. Sin ese campo (líneas antiguas),
 * el porcentaje vigente se aplica una sola vez al coste.
 */

function numero(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{ PrecioUnitario?: unknown, PrecioVenta?: unknown, TotalLinea?: unknown, Cantidad?: unknown }} linea
 * @param {number} porcentajeVigente
 * @returns {{ precio: number, total: number }}
 */
export function importesDetallePedido(linea, porcentajeVigente) {
  const coste = numero(linea?.PrecioUnitario) ?? 0;
  const cantidad = numero(linea?.Cantidad) ?? 0;
  const venta = numero(linea?.PrecioVenta);
  if (venta != null) {
    const totalGuardado = numero(linea?.TotalLinea);
    return {
      precio: venta,
      total: totalGuardado != null ? totalGuardado : cantidad * venta,
    };
  }
  const pct = numero(porcentajeVigente) ?? 0;
  const precio = coste * (1 + pct / 100);
  return { precio, total: cantidad * precio };
}
