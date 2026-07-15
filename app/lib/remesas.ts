import type { EstadoRemesa } from '../types/remesas';

export const FILTROS_ESTADO_REMESA: { id: EstadoRemesa | 'todos'; label: string }[] = [
  { id: 'todos', label: 'Todas' },
  { id: 'Borrador', label: 'Borrador' },
  { id: 'Generada', label: 'Generada' },
  { id: 'Ejecutada', label: 'Ejecutada' },
  { id: 'Anulada', label: 'Anulada' },
];

export function colorEstadoRemesa(estado: EstadoRemesa): { bg: string; text: string } {
  const map: Record<EstadoRemesa, { bg: string; text: string }> = {
    Borrador: { bg: '#f1f5f9', text: '#475569' },
    Generada: { bg: '#dbeafe', text: '#1e40af' },
    Ejecutada: { bg: '#d1fae5', text: '#047857' },
    Anulada: { bg: '#fee2e2', text: '#b91c1c' },
  };
  return map[estado] || { bg: '#f1f5f9', text: '#64748b' };
}

export function labelEstadoRemesa(estado: EstadoRemesa): string {
  return FILTROS_ESTADO_REMESA.find((f) => f.id === estado)?.label || estado;
}

/** Estados de factura IN seleccionables en modo multiselección del listado */
export const ESTADOS_FACTURA_SELECCION = new Set([
  'pendiente_revision',
  'pendiente_pago',
  'parcialmente_pagada',
  'vencida',
]);

export function esFacturaSeleccionableEnListado(estado: string | undefined | null): boolean {
  return ESTADOS_FACTURA_SELECCION.has(String(estado || ''));
}

/** Estados de factura IN que permiten incluir en remesa */
export const ESTADOS_FACTURA_REMESABLES = new Set([
  'pendiente_pago',
  'parcialmente_pagada',
  'vencida',
]);
