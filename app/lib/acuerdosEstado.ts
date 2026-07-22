/** Filtros de estado operativo del acuerdo (distinto de facturación). */

export const FILTROS_ESTADO_ACUERDO = [
  { id: 'Activo', label: 'Activos' },
  { id: 'Vencido', label: 'Vencidos' },
  { id: 'Completado', label: 'Completados' },
  { id: 'Cancelado', label: 'Cancelados' },
  { id: '', label: 'Todos' },
] as const;

export type FiltroEstadoAcuerdoId = (typeof FILTROS_ESTADO_ACUERDO)[number]['id'];

/** Pastel chips de filtro (mismo lenguaje visual que operaciones mayoristas). */
export const CHIP_ESTADO_ACUERDO_PASTEL: Record<
  string,
  { bg: string; bgSel: string; border: string; borderSel: string; text: string }
> = {
  '': { bg: '#f8fafc', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  Activo: { bg: '#dcfce7', bgSel: '#bbf7d0', border: '#bbf7d0', borderSel: '#86efac', text: '#166534' },
  Vencido: { bg: '#fee2e2', bgSel: '#fecaca', border: '#fecaca', borderSel: '#fca5a5', text: '#991b1b' },
  Completado: { bg: '#e0f2fe', bgSel: '#bae6fd', border: '#bae6fd', borderSel: '#7dd3fc', text: '#075985' },
  Cancelado: { bg: '#f1f5f9', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#64748b' },
};

export function colorEstadoAcuerdo(estado: string): string {
  switch (estado) {
    case 'Activo': return '#16a34a';
    case 'Vencido': return '#dc2626';
    case 'Completado': return '#0ea5e9';
    case 'Cancelado': return '#64748b';
    default: return '#94a3b8';
  }
}
