/**
 * Fechas en pantallas Marketing: el usuario ve siempre dd/mm/yyyy.
 * Las APIs siguen usando ISO YYYY-MM-DD en query/body.
 */

/** Convierte YYYY-MM-DD (o prefijo de ISO datetime) a DD/MM/YYYY. */
export function isoToDmy(iso: string | undefined | null): string {
  if (iso == null || iso === '') return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

/** Parsea DD/MM/YYYY o YYYY-MM-DD a ISO fecha YYYY-MM-DD. */
export function dmyToIso(valor: string | undefined | null): string | null {
  if (valor == null || String(valor).trim() === '') return null;
  const s = String(valor).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  if (!Number.isFinite(d) || !Number.isFinite(mo) || !Number.isFinite(y)) return null;
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Primera línea de fecha para mostrar metadata tipo `creado_en` ISO. */
export function isoDateTimeToDmyFecha(iso: string | undefined | null): string {
  if (iso == null || iso === '') return '—';
  const dmy = isoToDmy(iso);
  return dmy || String(iso).slice(0, 10);
}

export function inicioMesActualDmy(): string {
  const d = new Date();
  return isoToDmy(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`) || '';
}

export function finMesActualDmy(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return (
    isoToDmy(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    ) || ''
  );
}

/** Fin del mes siguiente (útil como rango amplio por defecto en carteles). */
export function finMesSiguienteDmy(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  return (
    isoToDmy(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    ) || ''
  );
}
