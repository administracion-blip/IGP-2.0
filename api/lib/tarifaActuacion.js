/**
 * Determina franja horaria y tipo de día para tarifas de actuaciones.
 * Franjas: mañana | tarde | noche (ajustables por umbrales).
 */

/** @param {string} horaHHmm "HH:mm" o "H:mm" */
export function parseHoraMinutos(horaHHmm) {
  if (!horaHHmm || typeof horaHHmm !== 'string') return { h: 12, m: 0 };
  const m = horaHHmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 12, m: 0 };
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return { h: 12, m: 0 };
  return { h, m: min };
}

/**
 * @param {string} hora_inicio "HH:mm"
 * @returns {'mañana'|'tarde'|'noche'}
 */
export function franjaDesdeHora(hora_inicio) {
  const { h, m } = parseHoraMinutos(hora_inicio);
  const dec = h + m / 60;
  if (dec >= 6 && dec < 15) return 'mañana';
  if (dec >= 15 && dec < 22) return 'tarde';
  return 'noche';
}

/**
 * @param {string} fechaIso yyyy-mm-dd
 * @param {boolean} esFestivo si la fecha está marcada como festivo en calendario
 */
export function tipoDiaDesdeFecha(fechaIso, esFestivo) {
  if (!fechaIso || typeof fechaIso !== 'string') return 'laborable';
  if (esFestivo) return 'festivo';
  const d = new Date(`${fechaIso}T12:00:00Z`);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return 'fin_semana';
  return 'laborable';
}

/**
 * Busca importe en lista de tarifas del artista.
 * @param {Array<{ tipo_dia?: string, franja?: string, codigo?: string, importe?: number }>} tarifas
 * @param {string} tipoDia laborable | fin_semana | festivo
 * @param {string} franja mañana | tarde | noche
 * @returns {number|null}
 */
export function importeDesdeTarifas(tarifas, tipoDia, franja) {
  if (!Array.isArray(tarifas) || tarifas.length === 0) return null;
  const t = String(tipoDia);
  const f = String(franja);
  const match = tarifas.find(
    (x) =>
      x &&
      String(x.tipo_dia || '').toLowerCase() === t.toLowerCase() &&
      String(x.franja || '').toLowerCase() === f.toLowerCase()
  );
  if (match && typeof match.importe === 'number' && !Number.isNaN(match.importe)) return match.importe;
  const imp = match?.importe != null ? Number(match.importe) : NaN;
  return Number.isFinite(imp) ? imp : null;
}

/**
 * Respuesta completa para el endpoint calcular-importe.
 * @param {string} fechaIso yyyy-mm-dd
 * @param {string} hora_inicio HH:mm
 * @param {Array} tarifas
 * @param {boolean} esFestivo
 */
export function calcularPropuestaImporte(fechaIso, hora_inicio, tarifas, esFestivo) {
  const franja = franjaDesdeHora(hora_inicio);
  const tipo_dia = tipoDiaDesdeFecha(fechaIso, !!esFestivo);
  const importe_previsto = importeDesdeTarifas(tarifas, tipo_dia, franja);
  return {
    franja,
    tipo_dia,
    importe_previsto,
  };
}
