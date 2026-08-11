/**
 * Jornada de negocio IGP (Europe/Madrid).
 * Misma regla que cajas / app/lib/jornadaNegocio.ts / jornadaNegocioHoyIso:
 * hora local del instante ≤ 09:30 → día calendario Madrid − 1;
 * ≥ 09:31 → día calendario Madrid.
 * Se aplica a todos los starts (turnos planificados y fichajes), igual que en cajas.
 */

const TZ_MADRID = 'Europe/Madrid';
const CUTOFF_MIN = 9 * 60 + 30; // 09:30 inclusive

const _madridPartsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ_MADRID,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Resta un día a YYYY-MM-DD (calendario, sin TZ). */
function restarUnDia(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return dateStr;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Jornada de negocio (YYYY-MM-DD) para un instante ISO arbitrario.
 * Parsea partes en Europe/Madrid; si minutesOfDay ≤ 09:30 resta un día.
 *
 * @param {string|null|undefined} iso
 * @returns {string|null} YYYY-MM-DD o null si inválido
 */
export function fechaJornadaNegocioDesdeIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const map = {};
  for (const p of _madridPartsFmt.formatToParts(d)) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const hour = map.hour === 24 ? 0 : map.hour;
  const minutesOfDay = hour * 60 + (map.minute || 0);
  const yyyy = String(map.year);
  const mm = String(map.month).padStart(2, '0');
  const dd = String(map.day).padStart(2, '0');
  const fechaMadrid = `${yyyy}-${mm}-${dd}`;

  if (minutesOfDay <= CUTOFF_MIN) return restarUnDia(fechaMadrid);
  return fechaMadrid;
}
