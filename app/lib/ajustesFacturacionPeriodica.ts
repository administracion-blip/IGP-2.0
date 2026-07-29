/**
 * Piezas comunes de la configuración de una facturación mensual automática
 * (mantenimiento, ventas internas de compras…): calendario por defecto y
 * normalización de los campos que llegan de `Igp_Ajustes`.
 *
 * El backend normaliza lo mismo al leer el ajuste
 * (`api/lib/facturacion/facturacionPeriodica.js`). Si las dos capas divergieran,
 * la pantalla mostraría un día o una hora que el proceso mensual no usaría.
 */

/** Día del mes en que se lanza la generación cuando no hay ajuste guardado. */
export const DIA_GENERACION_DEFECTO = 1;
/** Hora de la generación cuando no hay ajuste guardado. */
export const HORA_DEFECTO = '06:00';

/** Texto no vacío del ajuste; vacío o ausente ⇒ valor por defecto. */
export function textoAjuste(v: unknown, defecto: string): string {
  const s = String(v ?? '').trim();
  return s === '' ? defecto : s;
}

/** Día del mes 1–31; cualquier otra cosa ⇒ valor por defecto. */
export function diaGeneracionAjuste(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= 31 ? Math.trunc(n) : DIA_GENERACION_DEFECTO;
}

/** Hora HH:MM válida; cualquier otra cosa ⇒ valor por defecto. */
export function horaGeneracionAjuste(v: unknown): string {
  const s = String(v ?? '').trim();
  return horaValida(s) ? s : HORA_DEFECTO;
}

/** Formato HH:MM con hora 0–23 y minutos 0–59. */
export function horaValida(v: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(v)) return false;
  const [hh, mm] = v.split(':').map(Number);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}
