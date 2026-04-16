/**
 * Fecha de negocio (YYYY-MM-DD), misma regla que arqueo de caja / Objetivos:
 * hasta las 09:30 (inclusive) corresponde el día anterior; desde las 09:31, el día natural.
 */
export function fechaJornadaNegocioIso(): string {
  const now = new Date();
  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  const cutoff = 9 * 60 + 30;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (minutesOfDay <= cutoff) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
