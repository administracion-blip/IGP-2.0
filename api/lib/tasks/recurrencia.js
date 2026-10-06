/**
 * Repetición de tareas y reuniones.
 *
 * Una serie es un solo evento de Google (RRULE) y una ficha por fecha en la
 * agenda, hasta 400 días y como máximo 400 ocurrencias. `ocurrencia_fecha` es
 * el hueco original; la fecha que se ve puede moverse (arrastre) sin tocar a
 * las demás.
 */

export const HORIZONTE_DIAS = 400;
export const MAX_OCURRENCIAS = 400;

const FRECUENCIAS = new Set(['diaria', 'semanal', 'mensual', 'ultimo_dia']);
const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

export function esFechaIso(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(texto(valor));
}

export function sumarDias(iso, dias) {
  const [y, m, d] = iso.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d));
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

/** 1 = lunes … 7 = domingo, en fecha civil (no en zona). */
export function diaSemanaIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

function ultimoDiaMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function isoDe(anio, mes, dia) {
  return `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function enterosUnicos(valor, min, max) {
  const lista = Array.isArray(valor) ? valor : valor == null || valor === '' ? [] : [valor];
  const vistos = new Set();
  const out = [];
  for (const n of lista) {
    const dia = Number(n);
    if (!Number.isInteger(dia) || dia < min || dia > max) return null;
    if (vistos.has(dia)) continue;
    vistos.add(dia);
    out.push(dia);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Acepta `dias_semana` o el `dia_semana` de una sola elección. */
export function diasSemanaDe(regla) {
  if (Array.isArray(regla?.dias_semana) && regla.dias_semana.length) {
    return [...regla.dias_semana].sort((a, b) => a - b);
  }
  if (regla?.dia_semana) return [Number(regla.dia_semana)];
  return [];
}

/** Sin lista, el día es el de la fecha de inicio. */
export function diasMesDe(regla, desde) {
  if (Array.isArray(regla?.dias_mes) && regla.dias_mes.length) {
    return [...regla.dias_mes].sort((a, b) => a - b);
  }
  return [Number(String(desde).slice(8, 10))];
}

/**
 * @param {unknown} bruto
 * @returns {{ ok: true, regla: { frecuencia: string, dias_semana: number[]|null, dias_mes: number[]|null }|null } | { ok: false, error: string }}
 */
export function normalizarRecurrencia(bruto) {
  if (bruto == null || bruto === false || bruto === '') return { ok: true, regla: null };
  let entrada = bruto;
  if (typeof entrada === 'string') {
    if (entrada === 'ninguna') return { ok: true, regla: null };
    entrada = { frecuencia: entrada };
  }
  if (typeof entrada !== 'object') return { ok: false, error: 'La repetición no es válida' };
  const frecuencia = texto(entrada.frecuencia);
  if (!frecuencia || frecuencia === 'ninguna') return { ok: true, regla: null };
  if (!FRECUENCIAS.has(frecuencia)) return { ok: false, error: 'Elige una repetición válida' };

  let diasSemana = null;
  let diasMes = null;
  if (frecuencia === 'semanal') {
    const crudo = entrada.dias_semana != null ? entrada.dias_semana : entrada.dia_semana;
    diasSemana = enterosUnicos(crudo, 1, 7);
    if (!diasSemana || diasSemana.length === 0) {
      return { ok: false, error: 'Elige al menos un día de la semana' };
    }
  }
  if (frecuencia === 'mensual' && entrada.dias_mes != null) {
    diasMes = enterosUnicos(entrada.dias_mes, 1, 31);
    if (!diasMes || diasMes.length === 0) {
      return { ok: false, error: 'Elige al menos un día del mes' };
    }
  }
  return { ok: true, regla: { frecuencia, dias_semana: diasSemana, dias_mes: diasMes } };
}

/**
 * Fechas inclusive desde `desde`, dentro del horizonte.
 * Semanal y mensual admiten varios días. Si el mes no tiene ese día, esa fecha no sale.
 */
export function fechasDeRecurrencia(desde, regla, { horizonteDias = HORIZONTE_DIAS, max = MAX_OCURRENCIAS } = {}) {
  if (!esFechaIso(desde) || !regla) return [];
  const limite = sumarDias(desde, horizonteDias);
  const out = [];

  if (regla.frecuencia === 'diaria') {
    let dia = desde;
    while (dia <= limite && out.length < max) {
      out.push(dia);
      dia = sumarDias(dia, 1);
    }
    return out;
  }

  if (regla.frecuencia === 'semanal') {
    const elegidos = new Set(diasSemanaDe(regla));
    if (elegidos.size === 0) return [];
    let dia = desde;
    while (dia <= limite && out.length < max) {
      if (elegidos.has(diaSemanaIso(dia))) out.push(dia);
      dia = sumarDias(dia, 1);
    }
    return out;
  }

  if (regla.frecuencia === 'mensual') {
    const dias = diasMesDe(regla, desde);
    let anio = Number(desde.slice(0, 4));
    let mes = Number(desde.slice(5, 7));
    while (out.length < max) {
      const ultimo = ultimoDiaMes(anio, mes);
      let fuera = false;
      for (const diaMes of dias) {
        if (diaMes > ultimo) continue;
        const iso = isoDe(anio, mes, diaMes);
        if (iso > limite) {
          fuera = true;
          break;
        }
        if (iso >= desde) out.push(iso);
        if (out.length >= max) break;
      }
      if (fuera || out.length >= max) break;
      mes += 1;
      if (mes > 12) {
        mes = 1;
        anio += 1;
      }
      if (isoDe(anio, mes, 1) > limite) break;
    }
    return out;
  }

  let anio = Number(desde.slice(0, 4));
  let mes = Number(desde.slice(5, 7));
  while (out.length < max) {
    const iso = isoDe(anio, mes, ultimoDiaMes(anio, mes));
    if (iso > limite) break;
    if (iso >= desde) out.push(iso);
    mes += 1;
    if (mes > 12) {
      mes = 1;
      anio += 1;
    }
  }
  return out;
}

export function rruleDe(regla, desde) {
  if (!regla) return '';
  if (regla.frecuencia === 'diaria') return 'RRULE:FREQ=DAILY';
  if (regla.frecuencia === 'semanal') {
    const dias = diasSemanaDe(regla);
    return `RRULE:FREQ=WEEKLY;BYDAY=${dias.map((d) => BYDAY[d - 1]).join(',')}`;
  }
  if (regla.frecuencia === 'mensual') {
    return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${diasMesDe(regla, desde).join(',')}`;
  }
  return 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1';
}

/** UNTIL inclusive el día anterior a `fechaDesde` (esa fecha ya no ocurre). */
export function untilDe(fechaDesde, { diaCompleto = false } = {}) {
  const previo = sumarDias(fechaDesde, -1).replace(/-/g, '');
  return diaCompleto ? previo : `${previo}T235959Z`;
}

export function rruleConUntil(rrule, fechaDesde, opts) {
  const base = String(rrule || 'RRULE:FREQ=DAILY')
    .replace(/^RRULE:/, '')
    .replace(/;UNTIL=[^;]*/g, '');
  return `RRULE:${base};UNTIL=${untilDe(fechaDesde, opts)}`;
}

export function pkSerie(id) {
  return `REC#${id}`;
}

/**
 * Parte los miembros de una serie. `esta` borra solo `id`.
 * `posteriores` borra ese hueco y los de fecha igual o posterior.
 */
export function separarMiembros(miembros, { id, fecha, alcance } = {}) {
  const lista = Array.isArray(miembros) ? miembros : [];
  const ids = new Set();
  const borrar = [];
  for (const m of lista) {
    const seVa = alcance === 'posteriores' ? texto(m?.fecha) >= texto(fecha) : texto(m?.id) === texto(id);
    if (!seVa || !texto(m?.id)) continue;
    borrar.push({ id: texto(m.id), fecha: texto(m.fecha) });
    ids.add(texto(m.id));
  }
  if (texto(id) && !ids.has(texto(id))) {
    borrar.push({ id: texto(id), fecha: texto(fecha) });
    ids.add(texto(id));
  }
  const quedar = lista
    .filter((m) => texto(m?.id) && !ids.has(texto(m.id)))
    .map((m) => ({ id: texto(m.id), fecha: texto(m.fecha) }));
  return { borrar, quedar };
}
