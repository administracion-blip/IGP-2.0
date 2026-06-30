import type { LineaProductoActivo } from '../types/acuerdo';

/** Compara IDs de producto tolerando ceros a la izquierda. */
export function idsProductoCoinciden(a: string, b: string): boolean {
  const ta = String(a ?? '').trim();
  const tb = String(b ?? '').trim();
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  const na = ta.replace(/^0+/, '') || '0';
  const nb = tb.replace(/^0+/, '') || '0';
  return na === nb;
}

/** Total aportación unitaria (€/ud) = Aportación + Rappel + Dto. extra del acuerdo. */
export function totalAportacionUnitaria(
  linea: Pick<LineaProductoActivo, 'Aportacion' | 'Rappel' | 'DescuentoExtra'>,
): number {
  return (Number(linea.Aportacion) || 0) + (Number(linea.Rappel) || 0) + (Number(linea.DescuentoExtra) || 0);
}

/** Normaliza a YYYY-MM-DD (ISO o dd/mm/aaaa). */
export function fechaPedidoAIso(fecha: string): string {
  const t = fecha.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    return `${m[3]}-${mo}-${d}`;
  }
  return t.slice(0, 10);
}

/** ¿La fecha del pedido cae dentro del rango del acuerdo? */
export function fechaEnRangoAcuerdo(fechaPedido: string, inicio?: string, fin?: string): boolean {
  const f = fechaPedidoAIso(fechaPedido);
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const ini = inicio ? fechaPedidoAIso(inicio) : '';
  const end = fin ? fechaPedidoAIso(fin) : '';
  if (ini && f < ini) return false;
  if (end && f > end) return false;
  return true;
}

/**
 * Busca la línea de acuerdo activa para un producto cuyo rango de fechas
 * incluye la fecha del pedido. Si hay varias, se usa la de mayor total aportación.
 */
export function buscarLineaAcuerdoProducto(
  items: LineaProductoActivo[],
  productId: string,
  fechaPedido: string,
): LineaProductoActivo | null {
  const pid = productId.trim();
  if (!pid) return null;
  const candidatas = items.filter((i) => {
    const idProd = String(i.ProductId ?? i.SK ?? '').trim();
    if (!idsProductoCoinciden(idProd, pid)) return false;
    return fechaEnRangoAcuerdo(fechaPedido, i.FechaInicioAcuerdo, i.FechaFinAcuerdo);
  });
  if (candidatas.length === 0) return null;
  candidatas.sort((a, b) => totalAportacionUnitaria(b) - totalAportacionUnitaria(a));
  return candidatas[0];
}

/** Total rappel/aportación de la línea = cantidad × total aportación unitaria del acuerdo. */
export function calcularTotalRappelLinea(
  cantidad: number,
  items: LineaProductoActivo[],
  productId: string,
  fechaPedido: string,
): number {
  const linea = buscarLineaAcuerdoProducto(items, productId, fechaPedido);
  if (!linea) return 0;
  const cant = Number.isFinite(cantidad) ? cantidad : 0;
  return cant * totalAportacionUnitaria(linea);
}
