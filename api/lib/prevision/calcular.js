/**
 * Previsión de ventas por franjas: orquesta plantilla, festivos y venta por hora.
 * La aritmética vive en `./franjas.js`.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { maestroLocales } from '../alcance.js';
import { jornadaNegocioHoyIso } from '../usuarioLocales.js';
import { loadFestivosByFecha, loadFestivosPorFechas } from '../agora/objetivoMensual.js';
import { obtenerVentasHora, claveVentasHora, ventasHoraSinTabla } from '../agora/ventasHoraStore.js';
import {
  esFechaIso,
  diasEntre,
  prepararFranjas,
  resolverFechaComparativa,
  esFestivoMarcado,
  calcularDia,
  construirKpis,
} from './franjas.js';

export const MAX_DIAS_RANGO = 62;
export const MAX_LOCALES = 100;

function errorValidacion(mensaje, status = 400) {
  return Object.assign(new Error(mensaje), { status });
}

/**
 * Valida el cuerpo de `POST /prevision-franjas/calcular` (sin los locales, que
 * vienen ya filtrados por alcance). Lanza Error con status 400.
 */
export function validarPeticionCalculo(body) {
  const fechaDesde = String(body?.fechaDesde ?? '').trim();
  const fechaHasta = String(body?.fechaHasta ?? '').trim();
  if (!esFechaIso(fechaDesde) || !esFechaIso(fechaHasta)) {
    throw errorValidacion('fechaDesde y fechaHasta deben ser fechas YYYY-MM-DD');
  }
  if (fechaDesde > fechaHasta) throw errorValidacion('fechaDesde no puede ser posterior a fechaHasta');
  const dias = diasEntre(fechaDesde, fechaHasta);
  if (dias.length > MAX_DIAS_RANGO) {
    throw errorValidacion(`El rango no puede superar ${MAX_DIAS_RANGO} días`);
  }
  const brutoExcluidos = body?.diasExcluidos ?? [];
  if (!Array.isArray(brutoExcluidos) || brutoExcluidos.length > 100) {
    throw errorValidacion('diasExcluidos debe ser una lista de hasta 100 fechas');
  }
  const excluidos = new Set();
  for (const f of brutoExcluidos) {
    if (!esFechaIso(f)) throw errorValidacion('diasExcluidos contiene fechas no válidas');
    excluidos.add(f);
  }
  const plantillaId = String(body?.plantillaId ?? '').trim();
  if (!plantillaId || plantillaId.length > 100) throw errorValidacion('plantillaId es obligatorio');
  const objetivo = Number(body?.objetivoEurEmpHora);
  if (!Number.isFinite(objetivo) || objetivo <= 0) {
    throw errorValidacion('objetivoEurEmpHora debe ser un número mayor que 0');
  }
  return {
    fechaDesde,
    fechaHasta,
    dias: dias.filter((d) => !excluidos.has(d)),
    plantillaId,
    objetivo,
  };
}

export async function cargarPlantillaFranjas(plantillaId) {
  const r = await docClient.send(new GetCommand({
    TableName: tables.franjasHorarias,
    Key: { PK: 'GLOBAL', SK: plantillaId },
  }));
  if (!r.Item) throw errorValidacion('La plantilla de franjas no existe', 404);
  const franjas = prepararFranjas(r.Item.franjas);
  if (!franjas.length) throw errorValidacion('La plantilla no tiene franjas válidas');
  return { plantillaId, nombre: String(r.Item.nombre ?? ''), franjas };
}

/**
 * @param {{ workplaceIds: string[], peticion: ReturnType<typeof validarPeticionCalculo>,
 *   maxFetch?: number, hoyJornada?: string }} p
 *   `workplaceIds` ya intersecados con el alcance del usuario.
 */
export async function calcularPrevision({ workplaceIds, peticion, maxFetch = 120, hoyJornada = jornadaNegocioHoyIso() }) {
  const plantilla = await cargarPlantillaFranjas(peticion.plantillaId);
  const avisos = [];

  const maestro = await maestroLocales();
  const locales = [];
  const desconocidos = [];
  for (const wp of workplaceIds) {
    const loc = maestro.porAgora.get(wp);
    if (loc) locales.push({ workplaceId: wp, idLocal: loc.idLocal || null, nombre: loc.nombre || wp });
    else desconocidos.push(wp);
  }
  if (desconocidos.length) avisos.push(`Locales sin correspondencia en el maestro: ${desconocidos.join(', ')}`);
  locales.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));

  const { dias } = peticion;
  const festivosDia = dias.length
    ? await loadFestivosByFecha(dias[0], dias[dias.length - 1])
    : new Map();
  const comparativas = new Map(dias.map((d) => [d, resolverFechaComparativa(d, festivosDia.get(d))]));
  const fechasComp = [...new Set([...comparativas.values()].map((c) => c.fechaComparativa))];
  const festivosComp = await loadFestivosPorFechas(fechasComp);

  // Comparativas primero: sin ellas no hay previsión; el real solo de días pasados.
  const pares = [];
  for (const l of locales) {
    for (const d of dias) {
      const c = comparativas.get(d);
      if (c.fechaComparativa < d) pares.push({ workplaceId: l.workplaceId, businessDay: c.fechaComparativa });
    }
  }
  for (const l of locales) {
    for (const d of dias) {
      if (d < hoyJornada) pares.push({ workplaceId: l.workplaceId, businessDay: d });
    }
  }
  const datos = await obtenerVentasHora(pares, { maxFetch, hoyJornada });

  let pendientes = 0;
  let erroresReal = 0;
  for (const v of datos.values()) if (v.pendiente) pendientes += 1;

  const salida = locales.map((l) => {
    const diasLocal = dias.map((fecha) => {
      const comparativa = comparativas.get(fecha);
      const regComp = festivosComp.get(comparativa.fechaComparativa);
      const datoReal = fecha < hoyJornada ? datos.get(claveVentasHora(l.workplaceId, fecha)) : undefined;
      if (datoReal?.error) erroresReal += 1;
      return calcularDia({
        fecha,
        hoyJornada,
        franjas: plantilla.franjas,
        objetivo: peticion.objetivo,
        comparativa,
        nombreFestivoComparativa: esFestivoMarcado(regComp) ? String(regComp.NombreFestivo ?? '').trim() : null,
        datoComparativa: datos.get(claveVentasHora(l.workplaceId, comparativa.fechaComparativa)),
        datoReal,
      });
    });
    return {
      workplaceId: l.workplaceId,
      idLocal: l.idLocal,
      nombre: l.nombre,
      kpis: construirKpis(diasLocal, plantilla.franjas),
      dias: diasLocal,
    };
  });

  if (pendientes > 0) {
    avisos.push(`Quedan ${pendientes} día(s) por traer de Ágora; vuelve a calcular para completarlos.`);
  }
  if (erroresReal > 0) avisos.push(`No se pudo obtener la venta real de ${erroresReal} día(s).`);
  if (ventasHoraSinTabla()) {
    avisos.push('La tabla de ventas por hora no existe: los datos se piden a Ágora en cada cálculo.');
  }

  return {
    plantilla,
    hoyJornada,
    pendientes,
    avisos,
    locales: salida,
  };
}
