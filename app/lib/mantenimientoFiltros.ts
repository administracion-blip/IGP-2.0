/** Filtros compartidos para listados de incidencias de mantenimiento. */

import { isoDesdeDate, rangoSemana } from './semana';

export type CampoFechaMantenimiento = 'fecha_creacion' | 'fecha_programada' | 'fecha_completada';

export type ChipPeriodoMantenimiento =
  | 'todos'
  | 'semana_pasada'
  | 'proxima_semana'
  | 'mes_curso'
  | 'anio_curso'
  | null;

export const ESTADOS_MANTENIMIENTO = ['Nuevo', 'Programado', 'Reparacion', 'CANCELADA'] as const;

export type EstadoMantenimiento = (typeof ESTADOS_MANTENIMIENTO)[number];

export type IncidenciaFiltro = Record<string, string | number | string[] | undefined>;

export type FiltrosMantenimiento = {
  fechaDesde: string;
  fechaHasta: string;
  chipPeriodo: ChipPeriodoMantenimiento;
  localIds: string[];
  estados: string[];
};

/** Campo de fecha usado por el filtro de rango (siempre fecha de creación). */
const CAMPO_FECHA_FILTRO: CampoFechaMantenimiento = 'fecha_creacion';

export function isoLocal(d: Date): string {
  return isoDesdeDate(d);
}

export function rangoMesCurso(): { desde: string; hasta: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  return {
    desde: isoLocal(new Date(y, m, 1)),
    hasta: isoLocal(new Date(y, m + 1, 0)),
  };
}

export function rangoAnioCurso(): { desde: string; hasta: string } {
  const y = new Date().getFullYear();
  return { desde: `${y}-01-01`, hasta: `${y}-12-31` };
}

export function rangoChipPeriodo(chip: Exclude<ChipPeriodoMantenimiento, null>): { desde: string; hasta: string } {
  if (chip === 'todos') return { desde: '', hasta: '' };
  const hoyIso = isoLocal(new Date());
  if (chip === 'semana_pasada') {
    const r = rangoSemana(hoyIso, -1);
    return { desde: r.from, hasta: r.to };
  }
  if (chip === 'proxima_semana') {
    const r = rangoSemana(hoyIso, 1);
    return { desde: r.from, hasta: r.to };
  }
  if (chip === 'mes_curso') return rangoMesCurso();
  return rangoAnioCurso();
}

export function filtrosPorDefecto(
  chipDefault: Exclude<ChipPeriodoMantenimiento, null> = 'todos',
): FiltrosMantenimiento {
  const { desde, hasta } = rangoChipPeriodo(chipDefault);
  return {
    fechaDesde: desde,
    fechaHasta: hasta,
    chipPeriodo: chipDefault,
    localIds: [],
    estados: [],
  };
}

/** Extrae yyyy-mm-dd de un campo de incidencia (ISO datetime o date). */
export function extraerFechaIsoIncidencia(
  inc: IncidenciaFiltro,
  campo: CampoFechaMantenimiento,
): string | null {
  const raw = inc[campo];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function cumpleRangoFechaIncidencia(
  inc: IncidenciaFiltro,
  campo: CampoFechaMantenimiento,
  desdeIso: string,
  hastaIso: string,
): boolean {
  if (!desdeIso.trim() && !hastaIso.trim()) return true;
  const iso = extraerFechaIsoIncidencia(inc, campo);
  if (!iso) return false;
  if (desdeIso.trim() && iso < desdeIso.trim()) return false;
  if (hastaIso.trim() && iso > hastaIso.trim()) return false;
  return true;
}

export function normalizarEstadoIncidencia(inc: IncidenciaFiltro): string {
  return (inc.estado ?? '').toString().trim();
}

export function filtrarIncidenciasMantenimiento(
  list: IncidenciaFiltro[],
  filtros: FiltrosMantenimiento,
): IncidenciaFiltro[] {
  let out = list;

  if (filtros.localIds.length > 0) {
    const permitidos = new Set(filtros.localIds);
    out = out.filter((i) => permitidos.has((i.local_id ?? '').toString().trim()));
  }

  if (filtros.estados.length > 0) {
    const estadosSet = new Set(filtros.estados.map((e) => e.toUpperCase()));
    out = out.filter((i) => estadosSet.has(normalizarEstadoIncidencia(i).toUpperCase()));
  }

  out = out.filter((i) =>
    cumpleRangoFechaIncidencia(i, CAMPO_FECHA_FILTRO, filtros.fechaDesde, filtros.fechaHasta),
  );

  return out;
}

export function isDateInPast(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return true;
  const d = new Date(iso + 'T12:00:00');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime() < hoy.getTime();
}

export function detectarChipPeriodo(desde: string, hasta: string): ChipPeriodoMantenimiento {
  if (!desde.trim() && !hasta.trim()) return 'todos';
  const chips: Exclude<ChipPeriodoMantenimiento, null>[] = [
    'semana_pasada',
    'proxima_semana',
    'mes_curso',
    'anio_curso',
  ];
  for (const chip of chips) {
    const r = rangoChipPeriodo(chip);
    if (r.desde === desde && r.hasta === hasta) return chip;
  }
  return null;
}

const CHIPS_PERIODO_LIST: Exclude<ChipPeriodoMantenimiento, null>[] = [
  'todos',
  'semana_pasada',
  'proxima_semana',
  'mes_curso',
  'anio_curso',
];

export type ContadoresMantenimientoFiltros = {
  porPeriodo: Record<Exclude<ChipPeriodoMantenimiento, null>, number>;
  porEstado: Record<EstadoMantenimiento, number>;
  todosEstados: number;
};

/** Contadores por chip respetando el resto de filtros activos (sin el eje que varía). */
export function calcularContadoresMantenimiento(
  list: IncidenciaFiltro[],
  filtros: FiltrosMantenimiento,
): ContadoresMantenimientoFiltros {
  const porPeriodo = {} as Record<Exclude<ChipPeriodoMantenimiento, null>, number>;
  for (const chip of CHIPS_PERIODO_LIST) {
    const r = rangoChipPeriodo(chip);
    porPeriodo[chip] = filtrarIncidenciasMantenimiento(list, {
      ...filtros,
      fechaDesde: r.desde,
      fechaHasta: r.hasta,
      chipPeriodo: chip,
    }).length;
  }

  const baseSinEstado = { ...filtros, estados: [] as string[] };
  const todosEstados = filtrarIncidenciasMantenimiento(list, baseSinEstado).length;

  const porEstado = {} as Record<EstadoMantenimiento, number>;
  for (const estado of ESTADOS_MANTENIMIENTO) {
    porEstado[estado] = filtrarIncidenciasMantenimiento(list, {
      ...baseSinEstado,
      estados: [estado],
    }).length;
  }

  return { porPeriodo, porEstado, todosEstados };
}
