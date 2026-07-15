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
