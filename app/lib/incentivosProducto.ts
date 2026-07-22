import type { EstadoCampana, TipoIncentivo } from '../types/incentivosProducto';

export const ESTADOS_CAMPANA: EstadoCampana[] = ['Borrador', 'Activa', 'Finalizada', 'Bonificada', 'Archivada'];

export const FILTROS_ESTADO_CAMPANA: { key: EstadoCampana | 'todos'; label: string }[] = [
  { key: 'Activa', label: 'Activas' },
  { key: 'Finalizada', label: 'Pend. RRHH' },
  { key: 'Bonificada', label: 'Cerradas RRHH' },
  { key: 'Borrador', label: 'Borrador' },
  { key: 'Archivada', label: 'Archivadas' },
  { key: 'todos', label: 'Todas' },
];

export function colorEstadoCampana(estado: string): string {
  switch (estado) {
    case 'Activa': return '#16a34a';
    case 'Borrador': return '#64748b';
    case 'Finalizada': return '#d97706';
    case 'Bonificada': return '#0ea5e9';
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
  Finalizada: { bg: '#fffbeb', bgSel: '#fef3c7', border: '#fde68a', borderSel: '#fbbf24', text: '#92400e' },
  Bonificada: { bg: '#e0f2fe', bgSel: '#bae6fd', border: '#bae6fd', borderSel: '#7dd3fc', text: '#075985' },
  Archivada: { bg: '#f1f5f9', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#64748b' },
};

export function etiquetaTipoIncentivo(tipo: TipoIncentivo): string {
  if (tipo === 'eur_por_unidad') return '€ por unidad';
  if (tipo === 'pct_coste') return '% del precio de compra';
  return '% del margen unitario';
}

/** Parsea texto del input (admite coma decimal). */
export function parseValorIncentivoInput(raw: string): number {
  return parseFloat(String(raw).replace(',', '.').trim()) || 0;
}

/**
 * Normaliza el valor antes de guardar.
 * Si el usuario escribe 10 para 10 %, convierte a 0.10 (fracción interna).
 */
export function normalizarValorIncentivo(tipo: TipoIncentivo, valor: number): number {
  if (!(valor > 0)) return 0;
  if (tipo === 'pct_coste' || tipo === 'pct_margen') {
    if (valor > 1) return Math.round((valor / 100) * 10000) / 10000;
  }
  return valor;
}

/** Muestra en formulario: 0.10 almacenado → "10" para editar como porcentaje. */
export function valorIncentivoParaFormulario(tipo: TipoIncentivo, valor: number | string): string {
  const n = typeof valor === 'number' ? valor : parseValorIncentivoInput(valor);
  if (!(n > 0)) return '';
  if (tipo === 'pct_coste' || tipo === 'pct_margen') {
    const frac = n > 1 ? n / 100 : n;
    const pct = Math.round(frac * 1000) / 10;
    return String(pct).replace('.', ',');
  }
  return String(n).replace('.', ',');
}

/** Etiqueta legible en listados y cabeceras: "10 %" o "0,80 €/ud". */
export function formatValorIncentivoDisplay(tipo: TipoIncentivo, valor: number): string {
  if (tipo === 'eur_por_unidad') {
    return `${valor.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €/ud`;
  }
  if (tipo === 'pct_coste' || tipo === 'pct_margen') {
    const frac = valor > 1 ? valor / 100 : valor;
    const pct = Math.round(frac * 1000) / 10;
    return `${pct} %`;
  }
  return String(valor);
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
  if (w === 'coste_desconocido') return 'Coste de producto desconocido';
  if (w === 'iva_estimado') return 'IVA estimado al 10%';
  if (w === 'duracion_superior_8_semanas') return 'Duración superior a 8 semanas';
  if (w.startsWith('coste_desconocido:')) return `Coste desconocido (${w.split(':')[1]})`;
  return w;
}
