/**
 * Misma lógica que en Objetivos: FechaComparacion para TotalFacturadoComparativa (Agora).
 * - Si hay festivo con FechaComparativa válida, se usa esa fecha.
 * - Si no, mismo día del año anterior.
 */

export type FestivoGestionRow = {
  PK?: string;
  FechaComparativa?: string;
  Festivo?: boolean;
  NombreFestivo?: string;
};

export function fechaComparacionAnioAnterior(fechaIso: string): string {
  const d = new Date(fechaIso + 'T12:00:00');
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Fecha en la que se lee la facturación comparativa en Agora para el día `fechaIso` (actuación). */
export function fechaComparacionParaObjetivo(
  fechaIso: string,
  festivosByFecha: Record<string, FestivoGestionRow>,
): string {
  const festivo = festivosByFecha[fechaIso];
  const fc = festivo?.FechaComparativa;
  if (fc && /^\d{4}-\d{2}-\d{2}$/.test(String(fc).slice(0, 10))) {
    return String(fc).slice(0, 10);
  }
  return fechaComparacionAnioAnterior(fechaIso);
}
