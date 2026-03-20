/** Convierte una fecha ISO (yyyy-mm-dd) a formato dd/mm/yyyy. Devuelve '—' si el valor es vacío/nulo. */
export function formatFecha(fecha: string | number | undefined | null): string {
  if (fecha == null || String(fecha).trim() === '') return '—';
  const s = String(fecha).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  return s;
}

/** Convierte un timestamp ISO (yyyy-mm-ddTHH:mm…) a dd/mm/yyyy HH:mm. */
export function formatCreadoEn(val: string | number | undefined | null): string {
  if (val == null || String(val).trim() === '') return '—';
  const s = String(val).trim();
  const dateMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    const timeMatch = s.match(/T(\d{2}):(\d{2})/);
    const time = timeMatch ? ` ${timeMatch[1]}:${timeMatch[2]}` : '';
    return `${d}/${m}/${y}${time}`;
  }
  return s;
}

/** Convierte dd/mm/yyyy (o dd/mm/yy) a formato ISO yyyy-mm-dd. Si ya es ISO lo devuelve tal cual. */
export function fechaToIso(val: string): string {
  const s = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo}-${d}`;
  }
  return s;
}

/**
 * Convierte fecha de emisión de factura (varios formatos en BD) a yyyy-mm-dd.
 * Soporta: YYYY-MM-DD, YYYY-MM-DDTHH:mm:ss…, dd/mm/yyyy, dd-mm-yyyy.
 */
export function fechaEmisionFacturaAIso(raw: string | undefined | null): string | null {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const isoHead = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoHead) return isoHead[1];
  const slash = s.match(/^(\d{1,2})[/](\d{1,2})[/](\d{4}|\d{2})$/);
  if (slash) {
    const d = slash[1].padStart(2, '0');
    const mo = slash[2].padStart(2, '0');
    let y = slash[3];
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo}-${d}`;
  }
  const dash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})$/);
  if (dash) {
    const d = dash[1].padStart(2, '0');
    const mo = dash[2].padStart(2, '0');
    let y = dash[3];
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo}-${d}`;
  }
  const fallback = fechaToIso(s);
  return /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : null;
}

/** Fecha de emisión → dd/mm/aaaa para InputFecha; si no parsea, `fallbackDmy`. */
export function fechaEmisionFacturaADmy(raw: string | undefined | null, fallbackDmy: string): string {
  const iso = fechaEmisionFacturaAIso(raw);
  if (!iso) return fallbackDmy;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Fecha de un pago (ISO u otros formatos) para mostrar en listados.
 * Si se puede normalizar a ISO y `formatFecha` da dd/mm/aaaa, úsalo; si no, valor bruto.
 */
export function formatFechaPagoRow(fecha: string | undefined | null): string {
  if (fecha == null || String(fecha).trim() === '') return '—';
  const raw = String(fecha).trim();
  const iso = fechaEmisionFacturaAIso(raw);
  if (iso) {
    const d = formatFecha(iso);
    if (d !== '—') return d;
  }
  return raw;
}
