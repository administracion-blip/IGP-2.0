/**
 * Tarifas de artistas: matriz fija { tarde|noche } × { laborable|fin_semana|festivo }.
 * Compatibilidad: lectura de listas antiguas [{ tipo_dia, franja, importe }].
 */

/** @param {string} horaHHmm "HH:mm" o "H:mm" */
export function parseHoraMinutos(horaHHmm) {
  if (!horaHHmm || typeof horaHHmm !== 'string') return { h: 12, m: 0 };
  const m = horaHHmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 12, m: 0 };
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return { h: 12, m: 0 };
  return { h, m: min };
}

/**
 * Franjas (sin "mañana"):
 * - TARDE: 12:00–22:59
 * - NOCHE: 23:00–23:59 y 00:00–09:30
 * - Tramo 09:31–11:59: se trata como tarde (precio tarde; antes no encaja en noche ni en tarde estricta).
 * @param {string} hora_inicio "HH:mm"
 * @returns {'tarde'|'noche'}
 */
export function franjaDesdeHora(hora_inicio) {
  const { h, m } = parseHoraMinutos(hora_inicio);
  const mins = h * 60 + m;
  if (mins >= 23 * 60 || mins <= 9 * 60 + 30) return 'noche';
  if (mins >= 12 * 60 && mins <= 22 * 60 + 59) return 'tarde';
  if (mins >= 9 * 60 + 31 && mins <= 11 * 60 + 59) return 'tarde';
  return 'tarde';
}

/**
 * @param {string} fechaIso yyyy-mm-dd
 * @param {boolean} esFestivo
 * @returns {'laborable'|'fin_semana'|'festivo'}
 */
export function tipoDiaDesdeFecha(fechaIso, esFestivo) {
  if (!fechaIso || typeof fechaIso !== 'string') return 'laborable';
  if (esFestivo) return 'festivo';
  const d = new Date(`${fechaIso}T12:00:00Z`);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return 'fin_semana';
  return 'laborable';
}

function normalizeTipoDiaKey(tipoDia) {
  const t = String(tipoDia || '').toLowerCase();
  if (t === 'festivo') return 'festivo';
  if (t === 'fin_semana' || t === 'fin semana') return 'fin_semana';
  return 'laborable';
}

/** Matriz vacía (importes 0). */
export function tarifasMatrizVacia() {
  return {
    tarde: { laborable: 0, fin_semana: 0, festivo: 0 },
    noche: { laborable: 0, fin_semana: 0, festivo: 0 },
  };
}

function sanitizeMatrizObj(obj) {
  const out = tarifasMatrizVacia();
  for (const fr of ['tarde', 'noche']) {
    const row = obj?.[fr];
    if (!row || typeof row !== 'object') continue;
    for (const td of ['laborable', 'fin_semana', 'festivo']) {
      const raw = Number(row[td]);
      out[fr][td] = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
    }
  }
  return out;
}

/**
 * Convierte listado antiguo [{ tipo_dia, franja, importe }] → matriz (solo tarde/noche; "mañana" → tarde).
 * @param {unknown[]} arr
 */
export function arrayTarifasToMatriz(arr) {
  const out = tarifasMatrizVacia();
  if (!Array.isArray(arr)) return out;
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    let fr = String(t.franja || '').toLowerCase();
    if (fr === 'mañana' || fr === 'manana' || fr === 'morning') fr = 'tarde';
    if (fr !== 'tarde' && fr !== 'noche') continue;
    const tipo = normalizeTipoDiaKey(t.tipo_dia);
    const raw = Number(t.importe);
    if (!Number.isFinite(raw)) continue;
    out[fr][tipo] = Math.round(raw * 100) / 100;
  }
  return out;
}

/**
 * Normaliza entrada API: matriz nueva o array legacy → siempre matriz.
 * @param {unknown} input
 */
export function sanitizeTarifas(input) {
  if (Array.isArray(input)) return arrayTarifasToMatriz(input);
  if (input && typeof input === 'object') return sanitizeMatrizObj(input);
  return tarifasMatrizVacia();
}

/**
 * Importe desde matriz o lista legacy.
 * @param {unknown} tarifas
 * @param {string} tipoDia laborable | fin_semana | festivo
 * @param {string} franja tarde | noche
 * @returns {number|null}
 */
export function importeDesdeTarifas(tarifas, tipoDia, franja) {
  const t = normalizeTipoDiaKey(tipoDia);
  let f = String(franja || '').toLowerCase();
  if (f === 'mañana' || f === 'manana') f = 'tarde';
  if (f !== 'tarde' && f !== 'noche') f = 'tarde';

  if (Array.isArray(tarifas)) {
    const match = tarifas.find(
      (x) =>
        x &&
        normalizeTipoDiaKey(x.tipo_dia) === t &&
        String(x.franja || '').toLowerCase() === f
    );
    if (match) {
      const imp = Number(match.importe);
      if (Number.isFinite(imp)) return Math.round(imp * 100) / 100;
    }
    if (f === 'tarde') {
      for (const alt of ['mañana', 'manana']) {
        const m2 = tarifas.find(
          (x) =>
            x &&
            normalizeTipoDiaKey(x.tipo_dia) === t &&
            String(x.franja || '').toLowerCase() === alt
        );
        if (m2) {
          const imp = Number(m2.importe);
          if (Number.isFinite(imp)) return Math.round(imp * 100) / 100;
        }
      }
    }
    return null;
  }

  if (tarifas && typeof tarifas === 'object' && !Array.isArray(tarifas)) {
    const row = tarifas[f];
    if (!row || typeof row !== 'object') return null;
    const v = row[t];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @param {string} fechaIso yyyy-mm-dd
 * @param {string} hora_inicio HH:mm
 * @param {unknown} tarifas matriz o array legacy
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
