import { fechaEmisionFacturaAIso } from '../utils/formatFecha';

/** Días de margen futuro permitidos para fecha_emision al crear facturas. */
export const DIAS_MARGEN_FUTURO_FECHA_EMISION = 7;

/** Mismo texto que el rechazo del backend. */
export const MSG_FECHA_EMISION_FUTURA =
  'La fecha de la factura no puede ser más de 7 días posterior a hoy';

/** Hoy en yyyy-mm-dd (UTC). */
export function hoyIsoUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Suma (o resta) días a una fecha ISO yyyy-mm-dd sin desfases de zona. */
export function addDaysIso(iso: string, days: number): string {
  const m = String(iso).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** Máximo ISO permitido para fecha_emision al crear: hoy + margen. */
export function fechaEmisionMaximaPermitidaIso(hoy?: string): string {
  return addDaysIso(hoy ?? hoyIsoUtc(), DIAS_MARGEN_FUTURO_FECHA_EMISION);
}

/**
 * Si la fecha de emisión supera hoy+7, devuelve el mensaje de error; si no, null.
 * Fechas vacías o no parseables → null (otras validaciones las cubren).
 */
export function errorFechaEmisionDemasiadoFutura(
  fechaEmision: string | null | undefined,
  hoy?: string,
): string | null {
  const iso = fechaEmisionFacturaAIso(fechaEmision);
  if (!iso) return null;
  const hoyRef = hoy ?? hoyIsoUtc();
  const max = fechaEmisionMaximaPermitidaIso(hoyRef);
  return iso > max ? MSG_FECHA_EMISION_FUTURA : null;
}
