/**
 * Lógica de cruce planificado vs real y cálculo de coste por turno.
 *
 * Reglas:
 *  - Coste se calcula a partir de salario del último contrato disponible.
 *    1. Busca `salary_cents` (importe ANUAL en céntimos) → mensual = /12.
 *    2. Si no, `salary_amount_cents` (importe MENSUAL en céntimos).
 *    3. Si ninguno, el empleado aparece sin coste (sin_contrato=true).
 *  - Tasa horaria = mensual_cents / HORAS_MES_ESTANDAR (173,33 h ≈ 40 h/sem).
 *  - Coste empresa = bruto × 1.31 (cuota empresarial SS y otros).
 *  - Día asignado = jornada de negocio IGP del inicio del turno/fichaje
 *    (Europe/Madrid; ≤09:30 → día anterior). Ver fechaJornadaNegocioDesdeIso.
 */

import { fechaJornadaNegocioDesdeIso } from '../jornadaNegocio.js';

export { fechaJornadaNegocioDesdeIso };

const HORAS_MES_ESTANDAR = 173.33;
const COSTE_EMPRESA_FACTOR = 1.31;
const TARDE_UMBRAL_MIN = 15;
const SALIDA_ANTICIPADA_UMBRAL_MIN = 15;

const TZ_MADRID = 'Europe/Madrid';

/** Devuelve el timestamp en ms (epoch) de un ISO. Devuelve null si inválido. */
function tsMs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Diferencia en minutos entre dos ISO. Devuelve 0 si alguno falta o es inválido. */
function diffMin(startIso, endIso) {
  const a = tsMs(startIso);
  const b = tsMs(endIso);
  if (a == null || b == null || b < a) return 0;
  return Math.round((b - a) / 60000);
}

const _madridPartsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ_MADRID,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Offset (ms) de Europe/Madrid para un instante dado (maneja DST). */
function madridOffsetMs(date) {
  const map = {};
  for (const p of _madridPartsFmt.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asUTC - date.getTime();
}

/** ¿El valor es solo una hora "HH:mm" / "HH:mm:ss" (sin fecha)? */
function esHoraSola(v) {
  return typeof v === 'string' && /^\d{1,2}:\d{2}(:\d{2})?/.test(v.trim()) && !/\d{4}-\d{2}-\d{2}/.test(v);
}

/** ¿Parece un datetime ISO (con T o espacio entre fecha y hora)? */
function esIsoDateTime(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

/** Fecha de negocio del fichaje: `date` o, si falta, `reference_date` (Factorial). */
function attDateOf(s) {
  const raw = s?.date || s?.reference_date || null;
  if (raw == null || raw === '') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw).trim());
  return m ? m[1] : null;
}

/** Minutos del día de una hora "HH:mm" / "HH:mm:ss". null si no parsea. */
function horaAMin(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Suma un día a una fecha YYYY-MM-DD. */
function sumarUnDia(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return dateStr;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/** Convierte fecha YYYY-MM-DD + hora HH:mm[/ss] (hora local Madrid) a ISO UTC. null si inválido. */
function madridWallClockToIso(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(timeStr || '').trim());
  if (!dm || !tm) return null;
  const sec = tm[3] != null ? Number(tm[3]) : 0;
  const guess = Date.UTC(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
    sec,
  );
  const offset = madridOffsetMs(new Date(guess));
  return new Date(guess - offset).toISOString();
}

/**
 * Convierte un valor de reloj Factorial a ISO UTC.
 * Acepta ISO datetime completo, o HH:mm[/ss] + fecha de referencia (Madrid).
 */
function clockValorAIso(clockVal, dateStr) {
  if (clockVal == null || clockVal === '') return null;
  if (esIsoDateTime(clockVal)) return new Date(String(clockVal).trim()).toISOString();
  if (dateStr && esHoraSola(clockVal)) return madridWallClockToIso(dateStr, clockVal);
  // Último recurso: Date() sobre el string (p. ej. ISO sin T estricto).
  if (typeof clockVal === 'string' && /\d{4}-\d{2}-\d{2}/.test(clockVal)) {
    const d = new Date(clockVal.trim());
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/**
 * Lista de fechas YYYY-MM-DD entre `from` y `to` inclusive (ambos en YYYY-MM-DD).
 * Trabaja en UTC sobre la parte de fecha; no se ve afectado por la zona horaria local.
 */
function rangoFechas(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  while (cur.getTime() <= end.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Para cada empleado, devuelve la versión de contrato más reciente.
 * Heurística: usa `effective_on` o `starts_on` como fecha de referencia, y se queda con la mayor.
 * Como fallback, usa `updated_at`. Si nada de lo anterior, usa el `id` (mayor = más reciente).
 *
 * @param {Array<Record<string, unknown>>} contracts versiones tal y como vienen de Factorial.
 * @returns {Map<string, Record<string, unknown>>} keyed por employee_id (string).
 */
export function ultimoContratoPorEmpleado(contracts) {
  const m = new Map();
  for (const c of contracts || []) {
    const empId = c.employee_id != null ? String(c.employee_id) : null;
    if (!empId) continue;
    const prev = m.get(empId);
    if (!prev || compararContratos(c, prev) > 0) m.set(empId, c);
  }
  return m;
}

function compararContratos(a, b) {
  const fa = a.effective_on || a.starts_on || a.updated_at || '';
  const fb = b.effective_on || b.starts_on || b.updated_at || '';
  if (fa && fb && fa !== fb) return fa < fb ? -1 : 1;
  const ia = Number(a.id) || 0;
  const ib = Number(b.id) || 0;
  return ia - ib;
}

/**
 * Calcula la tasa horaria en céntimos a partir de un contrato.
 * Devuelve null si no hay datos de salario suficientes.
 */
export function tasaHorariaCents(contract) {
  if (!contract) return null;
  // 1. salary_cents (anual)
  if (typeof contract.salary_cents === 'number' && contract.salary_cents > 0) {
    const mensual = contract.salary_cents / 12;
    return mensual / HORAS_MES_ESTANDAR;
  }
  // 2. salary_amount_cents (mensual)
  if (typeof contract.salary_amount_cents === 'number' && contract.salary_amount_cents > 0) {
    return contract.salary_amount_cents / HORAS_MES_ESTANDAR;
  }
  return null;
}

/** Calcula coste bruto y empresa (en céntimos enteros) para X minutos a una tasa horaria. */
function costeMinutos(minutos, tasaCentsPorHora) {
  if (!minutos || tasaCentsPorHora == null) return { bruto_cents: 0, empresa_cents: 0 };
  const horas = minutos / 60;
  const bruto = tasaCentsPorHora * horas;
  return {
    bruto_cents: Math.round(bruto),
    empresa_cents: Math.round(bruto * COSTE_EMPRESA_FACTOR),
  };
}

/**
 * Ubicación Factorial numérica asociada al fichaje, si el payload la incluye.
 * Nombres de campo según versiones del API de Factorial.
 */
export function attendanceShiftLocationId(shift) {
  if (!shift || typeof shift !== 'object') return null;
  const candidates = [
    shift.location_id,
    shift.reference_contract_location_id,
    shift.workplace_id,
    shift.clock_in_location_id,
    shift.clock_location_id,
  ];
  for (const v of candidates) {
    if (v == null || v === '') continue;
    const n = typeof v === 'number' && Number.isFinite(v) ? v : Number.parseInt(String(v).trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Lectores de campos: tolerantes a varios nombres por compatibilidad entre versiones de Factorial. */
function planStartOf(s) { return s?.start_at || s?.starts_at || s?.start_on || null; }
function planEndOf(s) { return s?.end_at || s?.ends_at || s?.end_on || null; }

/**
 * Inicio del fichaje como ISO.
 * Factorial suele devolver `date`/`reference_date` + `clock_in` ("HH:mm", "HH:mm:ss" o ISO).
 * Turno abierto (sin clock_out) sigue indexándose si hay inicio.
 */
function attClockInRaw(s) {
  return s?.clock_in ?? s?.clock_in_at ?? s?.start_at ?? s?.starts_at ?? null;
}

function attClockOutRaw(s) {
  return s?.clock_out ?? s?.clock_out_at ?? s?.end_at ?? s?.ends_at ?? null;
}

function attStartOf(s) {
  const dateStr = attDateOf(s);
  const iso = clockValorAIso(attClockInRaw(s), dateStr);
  if (iso) return iso;
  // Si solo hay fecha + minutes (sin hora), no inventamos instante; sin start no se indexa.
  return null;
}

/**
 * Fin del fichaje como ISO. Maneja turnos que cruzan medianoche: si la hora de salida es
 * anterior a la de entrada, la salida pertenece al día siguiente.
 * Ausencia de clock_out (turno abierto) → null; no invalida el fichaje.
 */
function attEndOf(s) {
  const dateStr = attDateOf(s);
  const clockOut = attClockOutRaw(s);
  if (clockOut == null || clockOut === '') return null;

  if (dateStr && esHoraSola(clockOut)) {
    let endDate = dateStr;
    const inMin = horaAMin(attClockInRaw(s));
    const outMin = horaAMin(clockOut);
    if (inMin != null && outMin != null && outMin < inMin) endDate = sumarUnDia(dateStr);
    return madridWallClockToIso(endDate, clockOut);
  }
  return clockValorAIso(clockOut, dateStr);
}

/**
 * Minutos reales del fichaje: usa `minutes` de Factorial si está (también con turno abierto);
 * si no, calcula por diferencia cuando hay fin.
 */
function attMinutesOf(s, startIso, endIso) {
  if (typeof s?.minutes === 'number' && Number.isFinite(s.minutes) && s.minutes >= 0) return s.minutes;
  if (!endIso) return 0;
  return diffMin(startIso, endIso);
}

/** Construye un Map<employee_id_string + '__' + dia, Array<shift>> agrupado por jornada de negocio. */
function indexarPorEmpleadoYDia(items, getStart) {
  const out = new Map();
  for (const it of items || []) {
    const empId = it.employee_id != null ? String(it.employee_id) : null;
    if (!empId) continue;
    const startIso = getStart(it);
    const dia = fechaJornadaNegocioDesdeIso(startIso);
    if (!dia) continue;
    const key = `${empId}__${dia}`;
    const arr = out.get(key) || [];
    arr.push(it);
    out.set(key, arr);
  }
  return out;
}

/**
 * Construye el cuadrante completo agrupado por día.
 *
 * @param {{ planned: Array, attendance: Array, contratoPorEmp: Map, empleadoNombre: Map, from: string, to: string }} args
 * @returns {{ from: string, to: string, dias: Array, totales: object }}
 */
export function construirCuadrante({ planned, attendance, contratoPorEmp, empleadoNombre, from, to }) {
  const plannedIdx = indexarPorEmpleadoYDia(planned, planStartOf);
  const attendIdx = indexarPorEmpleadoYDia(attendance, attStartOf);

  const dias = rangoFechas(from, to);

  const empleadosVistos = new Set();
  for (const k of plannedIdx.keys()) empleadosVistos.add(k.split('__')[0]);
  for (const k of attendIdx.keys()) empleadosVistos.add(k.split('__')[0]);

  const tasaPorEmp = new Map();
  for (const empId of empleadosVistos) {
    const c = contratoPorEmp.get(empId);
    tasaPorEmp.set(empId, tasaHorariaCents(c));
  }

  const totalesGlob = {
    coste_bruto_cents: 0,
    coste_empresa_cents: 0,
    minutos_planificados: 0,
    minutos_reales: 0,
  };

  const diasOut = dias.map((fecha) => {
    const empleadosDelDia = new Set();
    for (const empId of empleadosVistos) {
      if (plannedIdx.has(`${empId}__${fecha}`) || attendIdx.has(`${empId}__${fecha}`)) {
        empleadosDelDia.add(empId);
      }
    }

    const filas = [];
    const totDia = {
      coste_bruto_cents: 0,
      coste_empresa_cents: 0,
      minutos_planificados: 0,
      minutos_reales: 0,
    };

    for (const empId of empleadosDelDia) {
      const plans = (plannedIdx.get(`${empId}__${fecha}`) || []).slice()
        .sort((a, b) => (tsMs(planStartOf(a)) ?? 0) - (tsMs(planStartOf(b)) ?? 0));
      const atts = (attendIdx.get(`${empId}__${fecha}`) || []).slice()
        .sort((a, b) => (tsMs(attStartOf(a)) ?? 0) - (tsMs(attStartOf(b)) ?? 0));
      const tasa = tasaPorEmp.get(empId);
      const sinContrato = tasa == null;
      const nombre = empleadoNombre.get(empId) || `Empleado ${empId}`;

      // Emparejamos plan↔att por orden cronológico. Filas adicionales si descuadran (anomalías).
      const nFilas = Math.max(plans.length, atts.length, 1);
      for (let i = 0; i < nFilas; i++) {
        const plan = plans[i] || null;
        const att = atts[i] || null;
        if (!plan && !att) continue; // empleado vacío en este día

        const planStart = plan ? planStartOf(plan) : null;
        const planEnd = plan ? planEndOf(plan) : null;
        const realStart = att ? attStartOf(att) : null;
        const realEnd = att ? attEndOf(att) : null;

        const minPlan = plan ? diffMin(planStart, planEnd) : 0;
        const minReal = att ? attMinutesOf(att, realStart, realEnd) : 0;

        // Coste sobre el MAYOR de los dos (cubre horas extra). Si no hay contrato, queda 0.
        const minCoste = Math.max(minPlan, minReal);
        const { bruto_cents, empresa_cents } = costeMinutos(minCoste, tasa);

        const flags = [];
        if (!plan) flags.push('sin_planificado');
        if (!att) flags.push('sin_real');
        if (plan && att && planStart && realStart) {
          const dMin = Math.round((tsMs(realStart) - tsMs(planStart)) / 60000);
          if (dMin > TARDE_UMBRAL_MIN) flags.push('tarde');
        }
        if (plan && att && planEnd && realEnd) {
          const dMin = Math.round((tsMs(planEnd) - tsMs(realEnd)) / 60000);
          if (dMin > SALIDA_ANTICIPADA_UMBRAL_MIN) flags.push('salida_anticipada');
        }

        filas.push({
          employee_id: empId,
          nombre,
          planificado: plan ? { inicio: planStart, fin: planEnd, minutos: minPlan } : null,
          real: att ? { inicio: realStart, fin: realEnd, minutos: minReal } : null,
          desviacion_min: minReal - minPlan,
          flags,
          coste_bruto_cents: bruto_cents,
          coste_empresa_cents: empresa_cents,
          sin_contrato: sinContrato,
        });

        totDia.coste_bruto_cents += bruto_cents;
        totDia.coste_empresa_cents += empresa_cents;
        totDia.minutos_planificados += minPlan;
        totDia.minutos_reales += minReal;
      }
    }

    filas.sort((a, b) => {
      const cmp = a.nombre.localeCompare(b.nombre, 'es');
      if (cmp !== 0) return cmp;
      return (tsMs(a.planificado?.inicio || a.real?.inicio) ?? 0) - (tsMs(b.planificado?.inicio || b.real?.inicio) ?? 0);
    });

    totalesGlob.coste_bruto_cents += totDia.coste_bruto_cents;
    totalesGlob.coste_empresa_cents += totDia.coste_empresa_cents;
    totalesGlob.minutos_planificados += totDia.minutos_planificados;
    totalesGlob.minutos_reales += totDia.minutos_reales;

    return { fecha, totales: totDia, filas };
  });

  return {
    from,
    to,
    totales: totalesGlob,
    dias: diasOut,
  };
}

/**
 * ¿Incluir este fichaje en el cuadrante del local?
 * - Si hay plan del mismo empleado en este local en la **misma jornada** del fichaje → sí
 *   (aunque location_id del fichaje no coincida; evita doble conteo entre locales).
 * - Si no: ubicación del fichaje = local, o sede del empleado = local.
 */
function fichajePerteneceAlLocal(a, plannedL, factorialLocStr, empleadoLocationPorEmp) {
  if (a.employee_id == null) return false;
  const empStr = String(a.employee_id);
  const attDia = fechaJornadaNegocioDesdeIso(attStartOf(a));

  if (attDia) {
    const tienePlanEsaJornada = (plannedL || []).some((p) => {
      if (p.employee_id == null || String(p.employee_id) !== empStr) return false;
      const planDia = fechaJornadaNegocioDesdeIso(planStartOf(p));
      return planDia === attDia;
    });
    if (tienePlanEsaJornada) return true;
  }

  const locNum = Number.parseInt(String(factorialLocStr || '').trim(), 10);
  const locOk = Number.isFinite(locNum);
  if (!locOk) return false;

  const attLoc = attendanceShiftLocationId(a);
  if (Number.isFinite(attLoc)) return attLoc === locNum;
  const home = empleadoLocationPorEmp.get(empStr);
  return Number.isFinite(home) && home === locNum;
}

/**
 * Un cuadrante por local IGP: turnos deben llevar `__igp_local_id` (string).
 * Fichajes: plan misma jornada en el local (sin exigir location del fichaje);
 * además fichajes sin plan si ubicación del fichaje o sede del empleado coincide.
 *
 * @param {{ plannedTagged: Array, attendance: Array, contratoPorEmp: Map, empleadoNombre: Map, empleadoLocationPorEmp?: Map<string, number|null>, from: string, to: string, localesOrden: Array<{ local_id: string, nombre: string, factorial_location_id: string }> }} args
 * @returns {{ totales: object, por_local: Array<{ local_id, nombre, factorial_location_id, totales, dias }> }}
 */
export function construirCuadrantePorLocales({
  plannedTagged,
  attendance,
  contratoPorEmp,
  empleadoNombre,
  empleadoLocationPorEmp = new Map(),
  from,
  to,
  localesOrden,
}) {
  const totalesGlobal = {
    coste_bruto_cents: 0,
    coste_empresa_cents: 0,
    minutos_planificados: 0,
    minutos_reales: 0,
  };
  const porLocal = [];

  for (const loc of localesOrden || []) {
    const lid = String(loc.local_id);
    const plannedL = (plannedTagged || []).filter((s) => String(s.__igp_local_id) === lid);
    const attendanceL = (attendance || []).filter((a) =>
      fichajePerteneceAlLocal(a, plannedL, loc.factorial_location_id, empleadoLocationPorEmp),
    );

    const cu = construirCuadrante({
      planned: plannedL,
      attendance: attendanceL,
      contratoPorEmp,
      empleadoNombre,
      from,
      to,
    });

    totalesGlobal.coste_bruto_cents += cu.totales.coste_bruto_cents;
    totalesGlobal.coste_empresa_cents += cu.totales.coste_empresa_cents;
    totalesGlobal.minutos_planificados += cu.totales.minutos_planificados;
    totalesGlobal.minutos_reales += cu.totales.minutos_reales;

    porLocal.push({
      local_id: lid,
      nombre: loc.nombre || lid,
      factorial_location_id: String(loc.factorial_location_id || ''),
      totales: cu.totales,
      dias: cu.dias,
    });
  }

  return { totales: totalesGlobal, por_local: porLocal };
}
