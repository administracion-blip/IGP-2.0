/** Días por defecto al cargar listados / resumen / conciliación de compras a proveedor. */
export const DIAS_CARGA_COMPRAS = 90;

/** Más histórico para «última compra» y variación de precio (necesita compra anterior). */
export const DIAS_CARGA_ULTIMO = 365;

export function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function rangoComprasDefault(dias: number): { dateFrom: string; dateTo: string } {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - dias * 24 * 60 * 60 * 1000);
  return { dateFrom: isoLocal(desde), dateTo: isoLocal(hoy) };
}

export function buildPurchasesQuery(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
  all?: boolean;
  refresh?: boolean;
}): string {
  const q = new URLSearchParams();
  if (params.refresh) q.set('refresh', '1');
  if (params.all) {
    q.set('all', '1');
  } else {
    if (params.dateFrom) q.set('dateFrom', params.dateFrom);
    if (params.dateTo) q.set('dateTo', params.dateTo);
  }
  const s = q.toString();
  return s ? `/api/agora/purchases?${s}` : '/api/agora/purchases';
}
