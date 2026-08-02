import type { Campana, EstadoCampana } from '../types/incentivosProducto';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const DIAS_AUTO_ARCHIVAR = 60;

export function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function diasDesde(fechaIso: string, hoy: string): number {
  if (!RE_FECHA.test(fechaIso) || !RE_FECHA.test(hoy)) return 0;
  const d0 = new Date(`${fechaIso}T12:00:00`).getTime();
  const d1 = new Date(`${hoy}T12:00:00`).getTime();
  return Math.round((d1 - d0) / (24 * 60 * 60 * 1000));
}

/** Misma lógica que api/lib/campanas/campanaEstado.js */
export function estadoEfectivoCampana(campana: Campana, hoy = hoyIso()): EstadoCampana {
  if (campana.archivadaManual === true) return 'Archivada';
  if (campana.estado === 'Archivada' && campana.archivadaManual !== false) {
    return 'Archivada';
  }

  const fechaInicio = String(campana.fechaInicio || '').trim();
  const fechaFin = String(campana.fechaFin || '').trim();
  if (!RE_FECHA.test(fechaInicio) || !RE_FECHA.test(fechaFin)) return 'Borrador';

  if (hoy > fechaFin) {
    if (campana.bonificadaEn) {
      if (campana.archivadaManual === true) return 'Archivada';
      const fechaBonif = String(campana.bonificadaEn).slice(0, 10);
      if (diasDesde(fechaBonif, hoy) >= DIAS_AUTO_ARCHIVAR) return 'Archivada';
      return 'Bonificada';
    }
    return 'Finalizada';
  }
  if (hoy >= fechaInicio) return 'Activa';
  return 'Borrador';
}

/** Estados en los que se permite borrar (no Bonificada: archivar antes). */
export function campanaSePuedeBorrar(campana: Campana, hoy = hoyIso()): boolean {
  const estado = estadoEfectivoCampana(campana, hoy);
  return estado === 'Borrador' || estado === 'Activa' || estado === 'Finalizada' || estado === 'Archivada';
}

export function campanaPendienteRevisionRrhh(campana: Campana, hoy = hoyIso()): boolean {
  return estadoEfectivoCampana(campana, hoy) === 'Finalizada';
}

export function etiquetaEstadoAutomatico(estado: EstadoCampana): string {
  if (estado === 'Borrador') return 'Programada — aún no ha empezado el periodo';
  if (estado === 'Activa') return 'En curso — dentro del periodo de la campaña';
  if (estado === 'Finalizada') return 'Periodo finalizado — pendiente de revisión RRHH';
  if (estado === 'Bonificada') return 'Revisada por RRHH — pendiente de archivar';
  return 'Archivada';
}
