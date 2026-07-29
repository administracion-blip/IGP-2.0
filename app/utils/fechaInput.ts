/**
 * Utilidades compartidas para campos de fecha editables (InputFecha / FechaInputDmy).
 * Visible: dd/mm/aaaa. En código/API: yyyy-mm-dd (ISO).
 */
import { formatFecha, fechaToIso } from './formatFecha';

export type FechaInputFormat = 'iso' | 'dmy';

/**
 * Formatea tecleo o pegado numérico a dd/mm/aaaa insertando barras.
 * Ej.: "26102026" → "26/10/2026", "2610" → "26/10".
 */
export function formatearEntradaDmy(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** Parsea dd/mm/aaaa (o variantes) a ISO válido, o null si incompleto/inválido. */
export function isoValidoDesdeDmy(val: string): string | null {
  const s = val.trim();
  const dmy =
    s.includes('/') || /^\d+$/.test(s) ? formatearEntradaDmy(s) : s;
  const iso = fechaToIso(dmy);
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
