/** Filtros de estado operativo del acuerdo (distinto de facturación). */

export const FILTROS_ESTADO_ACUERDO = [
  { id: 'Activo', label: 'Activos' },
  { id: 'Vencido', label: 'Vencidos' },
  { id: 'Completado', label: 'Completados' },
  { id: 'Cancelado', label: 'Cancelados' },
  { id: '', label: 'Todos' },
] as const;

export type FiltroEstadoAcuerdoId = (typeof FILTROS_ESTADO_ACUERDO)[number]['id'];
