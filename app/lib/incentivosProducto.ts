import type { EstadoCampana, TipoIncentivo } from '../types/incentivosProducto';

export const ESTADOS_CAMPANA: EstadoCampana[] = ['Borrador', 'Activa', 'Finalizada', 'Archivada'];

export const FILTROS_ESTADO_CAMPANA: { key: EstadoCampana | 'todos'; label: string }[] = [
  { key: 'Activa', label: 'Activas' },
  { key: 'Borrador', label: 'Borrador' },
  { key: 'Finalizada', label: 'Finalizadas' },
  { key: 'Archivada', label: 'Archivadas' },
  { key: 'todos', label: 'Todas' },
];

export function colorEstadoCampana(estado: string): string {
  switch (estado) {
    case 'Activa': return '#16a34a';
    case 'Borrador': return '#64748b';
    case 'Finalizada': return '#0ea5e9';
    case 'Archivada': return '#94a3b8';
    default: return '#64748b';
  }
}

/** Pastel chips de filtro (mismo lenguaje visual que operaciones mayoristas). */
export const CHIP_ESTADO_CAMPANA_PASTEL: Record<
  string,
  { bg: string; bgSel: string; border: string; borderSel: string; text: string }
> = {
  todos: { bg: '#f8fafc', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  Activa: { bg: '#dcfce7', bgSel: '#bbf7d0', border: '#bbf7d0', borderSel: '#86efac', text: '#166534' },
  Borrador: { bg: '#f1f5f9', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  Finalizada: { bg: '#e0f2fe', bgSel: '#bae6fd', border: '#bae6fd', borderSel: '#7dd3fc', text: '#075985' },
  Archivada: { bg: '#f1f5f9', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#64748b' },
};

export function etiquetaTipoIncentivo(tipo: TipoIncentivo): string {
  return tipo === 'eur_por_unidad' ? '€ por unidad' : '% del margen unitario';
}

export function etiquetaDestinatario(dest: string): string {
  return dest === 'individual' ? 'Por empleado' : 'Bote por local';
}

export function diasEntre(fechaInicio: string, fechaFin: string): number {
  if (!fechaInicio || !fechaFin || fechaInicio > fechaFin) return 0;
  const d0 = new Date(fechaInicio + 'T12:00:00').getTime();
  const d1 = new Date(fechaFin + 'T12:00:00').getTime();
  return Math.round((d1 - d0) / (24 * 60 * 60 * 1000)) + 1;
}

export function avisoDuracionLarga(fechaInicio: string, fechaFin: string): boolean {
  return diasEntre(fechaInicio, fechaFin) > 56;
}

export function etiquetaWarning(w: string): string {
  if (w === 'baseline_incompleto') return 'Baseline sin datos históricos';
  if (w === 'coste_desconocido') return 'Coste de producto desconocido';
  if (w === 'iva_estimado') return 'IVA estimado al 10%';
  if (w === 'duracion_superior_8_semanas') return 'Duración superior a 8 semanas';
  if (w.startsWith('coste_desconocido:')) return `Coste desconocido (${w.split(':')[1]})`;
  return w;
}
