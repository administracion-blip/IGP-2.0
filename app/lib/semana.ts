/**
 * Utilidades de semana natural (lunes → domingo) para filtros de rango de fechas.
 *
 * Trabajan siempre en ISO `yyyy-mm-dd`. La "semana actual" se ancla a la fecha
 * que se le pase (normalmente `fechaJornadaNegocioIso()`, corte 09:30), no a
 * `new Date()` directo, para respetar la jornada de negocio.
 */

export type PresetSemana = 'esta' | 'anterior' | 'proxima' | 'custom';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Suma `n` días (puede ser negativo) a una fecha ISO. */
export function sumarDias(fechaIso: string, n: number): string {
  if (!ISO_RE.test(fechaIso)) return fechaIso;
  const d = new Date(fechaIso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Lunes (inicio) de la semana natural que contiene `fechaIso`. */
export function lunesDeSemana(fechaIso: string): string {
  if (!ISO_RE.test(fechaIso)) return fechaIso;
  const d = new Date(fechaIso + 'T12:00:00');
  const js = d.getDay(); // 0 = domingo … 6 = sábado
  const offsetLunes = js === 0 ? 6 : js - 1; // días transcurridos desde el lunes
  return sumarDias(fechaIso, -offsetLunes);
}

/**
 * Rango lunes→domingo relativo a `hoyIso`.
 * `offsetSemanas`: 0 = esta semana, -1 = semana anterior, +1 = semana próxima.
 */
export function rangoSemana(hoyIso: string, offsetSemanas: number): { from: string; to: string } {
  const lunesEsta = lunesDeSemana(hoyIso);
  const lunes = sumarDias(lunesEsta, offsetSemanas * 7);
  return { from: lunes, to: sumarDias(lunes, 6) };
}

/** Detecta a qué preset de semana corresponde un rango (o 'custom' si no coincide). */
export function detectarPresetSemana(hoyIso: string, from: string, to: string): PresetSemana {
  const candidatos: { preset: Exclude<PresetSemana, 'custom'>; offset: number }[] = [
    { preset: 'esta', offset: 0 },
    { preset: 'anterior', offset: -1 },
    { preset: 'proxima', offset: 1 },
  ];
  for (const c of candidatos) {
    const r = rangoSemana(hoyIso, c.offset);
    if (r.from === from && r.to === to) return c.preset;
  }
  return 'custom';
}
