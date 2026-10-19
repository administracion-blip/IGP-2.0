/**
 * Sincronización de Igp_VentasHora para un rango de días cerrados.
 * La usan `POST /prevision-franjas/ventas-hora/sync` (manual y planificador) y
 * el script de backfill.
 */
import { maestroLocales } from '../alcance.js';
import { jornadaNegocioHoyIso } from '../usuarioLocales.js';
import { obtenerVentasHora, ventasHoraSinTabla } from './ventasHoraStore.js';
import { diasEntre, esFechaIso } from '../prevision/franjas.js';

export const MAX_DIAS_SYNC = 31;

function errorValidacion(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

/**
 * Locales con agoraCode del maestro. Con `filtro`, solo esos (los desconocidos
 * se devuelven aparte).
 */
export async function workplacesConAgora(filtro = null) {
  const maestro = await maestroLocales();
  const todos = [...maestro.porAgora.keys()];
  if (!Array.isArray(filtro) || filtro.length === 0) return { workplaces: todos, desconocidos: [] };
  const lista = [...new Set(filtro.map((w) => String(w ?? '').trim()).filter(Boolean))];
  return {
    workplaces: lista.filter((w) => maestro.porAgora.has(w)),
    desconocidos: lista.filter((w) => !maestro.porAgora.has(w)),
  };
}

/** Días del rango anteriores a la jornada de hoy (los únicos que se guardan). */
export function diasCerradosDelRango(fechaDesde, fechaHasta, hoyJornada) {
  return diasEntre(fechaDesde, fechaHasta).filter((d) => d < hoyJornada);
}

export function validarRangoSync(fechaDesde, fechaHasta, maxDias = MAX_DIAS_SYNC) {
  if (!esFechaIso(fechaDesde) || !esFechaIso(fechaHasta)) {
    throw errorValidacion('fechaDesde y fechaHasta deben ser fechas YYYY-MM-DD');
  }
  if (fechaDesde > fechaHasta) throw errorValidacion('fechaDesde no puede ser posterior a fechaHasta');
  if (diasEntre(fechaDesde, fechaHasta).length > maxDias) {
    throw errorValidacion(`El rango no puede superar ${maxDias} días por llamada`);
  }
}

/**
 * @param {{ fechaDesde: string, fechaHasta: string, workplaceIds?: string[]|null,
 *   force?: boolean, concurrencia?: number, hoyJornada?: string }} p
 */
export async function sincronizarVentasHora({
  fechaDesde,
  fechaHasta,
  workplaceIds = null,
  force = false,
  concurrencia = 4,
  hoyJornada = jornadaNegocioHoyIso(),
}) {
  const { workplaces, desconocidos } = await workplacesConAgora(workplaceIds);
  const dias = diasCerradosDelRango(fechaDesde, fechaHasta, hoyJornada);
  const pares = [];
  for (const workplaceId of workplaces) {
    for (const businessDay of dias) pares.push({ workplaceId, businessDay });
  }
  const datos = await obtenerVentasHora(pares, {
    maxFetch: Infinity,
    concurrencia,
    force,
    hoyJornada,
  });
  let traidos = 0;
  let existentes = 0;
  const errores = [];
  for (const [clave, v] of datos) {
    if (v.error) errores.push(clave);
    else if (v.origen === 'agora') traidos += 1;
    else if (v.origen === 'tabla') existentes += 1;
  }
  return {
    ok: errores.length === 0,
    ...(errores.length > 0 && { error: `${errores.length} día(s) no se pudieron traer de Ágora` }),
    fechaDesde,
    fechaHasta,
    dias: dias.length,
    locales: workplaces.length,
    desconocidos,
    traidos,
    existentes,
    errores,
    persistido: !ventasHoraSinTabla(),
  };
}
