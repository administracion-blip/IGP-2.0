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

/** Mes en curso (según jornada de hoy) desde el día 1 hasta el día anterior a la jornada. */
export function rangoMesHastaAyerJornada(): {
  dateFrom: string;
  dateTo: string;
  jornadaHoy: string;
  sinDatos: boolean;
} {
  const jornadaHoy = fechaJornadaNegocioIso();
  const [y, m] = jornadaHoy.split('-');
  const dateFrom = `${y}-${m}-01`;
  const d = new Date(`${jornadaHoy}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const dateTo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sinDatos = dateTo < dateFrom;
  return { dateFrom, dateTo, jornadaHoy, sinDatos };
}
