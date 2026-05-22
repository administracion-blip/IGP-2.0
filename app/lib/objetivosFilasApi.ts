/**
 * Misma lógica que la comparativa diaria en Cajas → Objetivos (Agora + festivos).
 * Centralizada para reutilizar en Actuaciones (previsión = TotalFacturadoComparativa).
 */
import { apiFetch } from '../utils/api';

export type FestivoReg = {
  PK?: string;
  FechaComparativa?: string;
  Festivo?: boolean;
  NombreFestivo?: string;
};

export type FilaObjetivo = {
  Fecha: string;
  FechaComparacion: string;
  Festivo: boolean;
  NombreFestivo: string;
  TotalFacturadoReal: number;
  TotalFacturadoComparativa: number;
  Desvio: number;
  DesvioPct: number | null;
};

export function fechaComparacion(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00');
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export async function obtenerFilasObjetivos(
  _apiBaseUrl: string,
  workplaceId: string,
  fechaInicio: string,
  fechaFin: string,
): Promise<FilaObjetivo[]> {
  const [totalsRealRes, festivosRes] = await Promise.all([
    apiFetch(
      `/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${fechaInicio}&dateTo=${fechaFin}`,
    ),
    apiFetch('/api/gestion-festivos'),
  ]);
  const totalsRealData = await totalsRealRes.json();
  const festivosData = await festivosRes.json();
  const totalsReal: Record<string, number> = totalsRealData.totals ?? {};
  const festivosList: FestivoReg[] = Array.isArray(festivosData.registros) ? festivosData.registros : [];
  const festivosByFecha = Object.fromEntries(
    festivosList
      .filter((f) => f.PK || f.FechaComparativa)
      .map((f) => [String(f.PK ?? f.FechaComparativa ?? '').slice(0, 10), f]),
  );

  let minComp = '';
  let maxComp = '';
  const d = new Date(fechaInicio + 'T12:00:00');
  const end = new Date(fechaFin + 'T12:00:00');
  const fechaToComp: Record<string, string> = {};
  while (d <= end) {
    const fecha = d.toISOString().slice(0, 10);
    const festivo = festivosByFecha[fecha];
    const fechaComp =
      festivo?.FechaComparativa && /^\d{4}-\d{2}-\d{2}$/.test(String(festivo.FechaComparativa).slice(0, 10))
        ? String(festivo.FechaComparativa).slice(0, 10)
        : fechaComparacion(fecha);
    fechaToComp[fecha] = fechaComp;
    if (!minComp || fechaComp < minComp) minComp = fechaComp;
    if (!maxComp || fechaComp > maxComp) maxComp = fechaComp;
    d.setDate(d.getDate() + 1);
  }

  const totalsCompRes = await apiFetch(
    `/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${minComp}&dateTo=${maxComp}`,
  );
  const totalsCompData = await totalsCompRes.json();
  const totalsComp: Record<string, number> = totalsCompData.totals ?? {};

  const filas: FilaObjetivo[] = [];
  const d2 = new Date(fechaInicio + 'T12:00:00');
  const end2 = new Date(fechaFin + 'T12:00:00');
  while (d2 <= end2) {
    const fecha = d2.toISOString().slice(0, 10);
    const fechaComp = fechaToComp[fecha];
    const real = totalsReal[fecha] ?? 0;
    const comp = totalsComp[fechaComp] ?? 0;
    const festivo = festivosByFecha[fecha];
    const esFestivo = String(festivo?.Festivo).toLowerCase() === 'true';
    const nombreFestivo = String(festivo?.NombreFestivo ?? '').trim();
    const desvio = real - comp;
    const desvioPct = comp === 0 ? null : real / comp - 1;
    filas.push({
      Fecha: fecha,
      FechaComparacion: fechaComp,
      Festivo: esFestivo,
      NombreFestivo: nombreFestivo,
      TotalFacturadoReal: real,
      TotalFacturadoComparativa: comp,
      Desvio: desvio,
      DesvioPct: desvioPct,
    });
    d2.setDate(d2.getDate() + 1);
  }
  return filas;
}

const DIAS_SEMANA_LUN_PRIMERO = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'] as const;

/** 0 = lunes … 6 = domingo (orden semanal ES) */
function diaSemanaIndexLunesPrimero(fechaIso: string): number {
  const d = new Date(fechaIso + 'T12:00:00');
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

export type MediasDiaSemanaFila = {
  label: (typeof DIAS_SEMANA_LUN_PRIMERO)[number];
  nReal: number;
  mediaReal: number;
  nComp: number;
  mediaComp: number;
};

/**
 * Fecha tope para medias “operativas”: el anterior entre fin de periodo y ayer (YYYY-MM-DD).
 * Excluye días futuros del mes aún sin cerrar.
 */
export function fechaCorteMediaRealObjetivos(fechaFinPeriodo: string, ayerIso: string): string {
  const finOk = fechaFinPeriodo && /^\d{4}-\d{2}-\d{2}$/.test(fechaFinPeriodo);
  const ayerOk = ayerIso && /^\d{4}-\d{2}-\d{2}$/.test(ayerIso);
  if (!finOk && !ayerOk) return fechaFinPeriodo || ayerIso || '';
  if (!finOk) return ayerIso;
  if (!ayerOk) return fechaFinPeriodo;
  return fechaFinPeriodo <= ayerIso ? fechaFinPeriodo : ayerIso;
}

/**
 * Media real por día de semana de Fecha; comparativa por día de semana de FechaComparacion.
 * Si `opts.fechaMaxRealInclusive` es una fecha ISO válida, la media real solo usa filas con Fecha <= ese tope (p. ej. min(fin periodo, ayer)).
 * La media comparativa usa siempre todas las filas del periodo.
 */
export function mediasPorDiaSemanaDesdeFilas(
  filas: FilaObjetivo[],
  opts?: { fechaMaxRealInclusive?: string },
): MediasDiaSemanaFila[] {
  const max = opts?.fechaMaxRealInclusive?.trim();
  const rowsReal =
    max && /^\d{4}-\d{2}-\d{2}$/.test(max) ? filas.filter((r) => r.Fecha <= max) : filas;

  const bucketsReal = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
  const bucketsComp = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));

  for (const r of rowsReal) {
    const iReal = diaSemanaIndexLunesPrimero(r.Fecha);
    bucketsReal[iReal].sum += r.TotalFacturadoReal;
    bucketsReal[iReal].n += 1;
  }

  for (const r of filas) {
    const iComp = diaSemanaIndexLunesPrimero(r.FechaComparacion);
    bucketsComp[iComp].sum += r.TotalFacturadoComparativa;
    bucketsComp[iComp].n += 1;
  }

  return DIAS_SEMANA_LUN_PRIMERO.map((label, i) => {
    const br = bucketsReal[i];
    const bc = bucketsComp[i];
    return {
      label,
      nReal: br.n,
      mediaReal: br.n > 0 ? br.sum / br.n : 0,
      nComp: bc.n,
      mediaComp: bc.n > 0 ? bc.sum / bc.n : 0,
    };
  });
}
