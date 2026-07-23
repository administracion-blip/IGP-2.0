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
