/**
 * Utilidades compartidas para campos de fecha editables (InputFecha / FechaInputDmy).
 * Visible: dd/mm/aaaa. En código/API: yyyy-mm-dd (ISO).
 */
import { formatFecha, fechaToIso } from './formatFecha';

export type FechaInputFormat = 'iso' | 'dmy';

/** Parsea dd/mm/aaaa (o variantes) a ISO válido, o null si incompleto/inválido. */
export function isoValidoDesdeDmy(val: string): string | null {
  const iso = fechaToIso(val.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [ys, ms, ds] = iso.split('-');
  const y = parseInt(ys, 10);
  const mo = parseInt(ms, 10);
  const d = parseInt(ds, 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return iso;
}

/** ISO yyyy-mm-dd → dd/mm/aaaa para mostrar en input. */
export function isoADisplay(iso: string): string {
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatFecha(iso) : '';
}

/** Valor del padre (ISO o DMY según format) → ISO interno del input. */
export function isoDesdeValor(val: string, format: FechaInputFormat): string {
  const s = val.trim();
  if (!s) return '';
  if (format === 'iso') return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  return isoValidoDesdeDmy(s) ?? '';
}

/** ISO interno → valor que espera el padre según format. */
export function valorDesdeIso(iso: string, format: FechaInputFormat): string {
  if (!iso) return '';
  if (format === 'iso') return iso;
  return isoADisplay(iso);
}
