/** Utilidades compartidas de UI para cards de incidencias / reparaciones. */

import type { ComponentProps } from 'react';
import { MaterialIcons } from '@expo/vector-icons';

export type PrioridadIconName = ComponentProps<typeof MaterialIcons>['name'];

export const PRIORIDAD_ORDER: Record<string, number> = {
  urgente: 0,
  alta: 1,
  media: 2,
  baja: 3,
};

export const PRIORIDAD_COLOR: Record<string, string> = {
  urgente: '#dc2626',
  alta: '#ea580c',
  media: '#eab308',
  baja: '#16a34a',
};

/** Badge pastel + icono para prioridad en tablas y listados. */
export const PRIORIDAD_PASTEL: Record<string, { bg: string; color: string; icon: PrioridadIconName }> = {
  urgente: { bg: '#fee2e2', color: '#b91c1c', icon: 'priority-high' },
  alta: { bg: '#ffedd5', color: '#c2410c', icon: 'north' },
  media: { bg: '#fef9c3', color: '#a16207', icon: 'remove' },
  baja: { bg: '#dcfce7', color: '#15803d', icon: 'south' },
};

export function getPrioridadPastel(p: string | undefined): { bg: string; color: string; icon: PrioridadIconName } {
  const key = (p ?? '').toString().trim().toLowerCase();
  return PRIORIDAD_PASTEL[key] ?? { bg: '#f1f5f9', color: '#64748b', icon: 'help-outline' };
}

export function getPrioridadOrden(p: string | undefined): number {
  const key = (p ?? '').toString().trim().toLowerCase();
  return PRIORIDAD_ORDER[key] ?? 4;
}

export function getPrioridadColor(p: string | undefined): string {
  const key = (p ?? '').toString().trim().toLowerCase();
  return PRIORIDAD_COLOR[key] ?? '#94a3b8';
}

export function getPrioridadLabel(p: string | undefined): string {
  const key = (p ?? '').toString().trim().toLowerCase();
  if (!key) return '—';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Cuenta incidencias urgentes o de prioridad alta. */
export function contarUrgentes(items: { prioridad?: string }[]): number {
  return items.filter((i) => getPrioridadOrden(i.prioridad) <= 1).length;
}

/** True si la incidencia tiene fecha programada o estado Programado. */
export function incidenciaEstaProgramada(inc: {
  fecha_programada?: unknown;
  estado?: unknown;
}): boolean {
  const fp = (inc.fecha_programada ?? '').toString().trim();
  if (fp) return true;
  return (inc.estado ?? '').toString().trim() === 'Programado';
}

/**
 * Segundos de trabajo cronometrado: tramos ya cerrados más el tramo abierto.
 * El inicio del tramo lo marca el servidor, así que el total sigue siendo
 * correcto aunque se recargue la pantalla mucho después.
 */
export function segundosTrabajo(
  segundosAcumulados: unknown,
  enCursoDesde: unknown,
  ahoraMs: number,
): number {
  const base = Number(segundosAcumulados);
  let total = Number.isFinite(base) && base > 0 ? base : 0;
  const inicio = (enCursoDesde ?? '').toString().trim();
  if (inicio) {
    const inicioMs = new Date(inicio).getTime();
    if (Number.isFinite(inicioMs)) total += Math.max(0, Math.floor((ahoraMs - inicioMs) / 1000));
  }
  return total;
}

/**
 * Minutos facturables de un tramo: criterio único de redondeo al minuto, para
 * que el texto «Cronometrado» y las horas precargadas nunca discrepen.
 * Todo tiempo cronometrado cuenta al menos un minuto: si no, un tramo corto
 * se convertiría en cero y la mano de obra desaparecería de la valoración.
 */
export function minutosTrabajo(segundos: number): number {
  const s = Math.max(0, segundos);
  if (s <= 0) return 0;
  return Math.max(1, Math.round(s / 60));
}

/** Duración legible en horas y minutos: «1 h 38 min». */
export function formatearDuracionTrabajo(segundos: number): string {
  const minutos = minutosTrabajo(segundos);
  if (minutos < 1) return '0 min';
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** Cronómetro en marcha: «12:05» o «1:37:12». */
export function formatearCronometro(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(seg).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Segundos cronometrados a horas decimales para el campo de mano de obra.
 * El criterio de negocio son minutos exactos: se redondea a minuto (mismo
 * criterio que `formatearDuracionTrabajo`) y se conservan 4 decimales, que
 * mantienen el importe exacto al céntimo y se leen bien en el campo
 * (25 min → «0,4167»; 90 min → «1,5»).
 */
export function segundosAHorasInput(segundos: number): string {
  const minutos = minutosTrabajo(segundos);
  if (minutos <= 0) return '';
  const txt = (minutos / 60).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return txt.replace('.', ',');
}

export function formatearFechaIncidencia(iso: string | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yy} ${hh}:${min}`;
  } catch {
    return String(iso);
  }
}
