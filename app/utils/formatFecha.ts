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
