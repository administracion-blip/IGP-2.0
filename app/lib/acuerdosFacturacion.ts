/**
 * Estado de facturación / pago de un acuerdo comercial.
 * Preparado para sincronización futura con A3 (solo lectura vía API).
 */

export const ESTADOS_FACTURACION_ACUERDO = [
  'sin_factura',
  'pendiente_pago',
  'pagado_parcial',
  'pagado',
] as const;

export type EstadoFacturacionAcuerdo = (typeof ESTADOS_FACTURACION_ACUERDO)[number];

export type FacturacionOrigenAcuerdo = 'manual' | 'a3';

export const ESTADO_FACTURACION_DEFAULT: EstadoFacturacionAcuerdo = 'sin_factura';

export function normalizarEstadoFacturacion(val: string | undefined | null): EstadoFacturacionAcuerdo {
  const s = String(val ?? '').trim();
  if ((ESTADOS_FACTURACION_ACUERDO as readonly string[]).includes(s)) {
    return s as EstadoFacturacionAcuerdo;
  }
  return ESTADO_FACTURACION_DEFAULT;
}

export function etiquetaEstadoFacturacion(estado: EstadoFacturacionAcuerdo): string {
  switch (estado) {
    case 'sin_factura':
      return 'Sin factura';
    case 'pendiente_pago':
      return 'Pte. pago';
    case 'pagado_parcial':
      return 'Pte. parcial';
    case 'pagado':
      return 'Pagado';
    default:
      return 'Sin factura';
  }
}

export function estiloEstadoFacturacion(estado: EstadoFacturacionAcuerdo): { bg: string; text: string; border: string } {
  switch (estado) {
    case 'sin_factura':
      return { bg: '#f1f5f9', text: '#64748b', border: '#cbd5e1' };
    case 'pendiente_pago':
      return { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' };
    case 'pagado_parcial':
      return { bg: '#fef3c7', text: '#b45309', border: '#fcd34d' };
    case 'pagado':
      return { bg: '#dcfce7', text: '#166534', border: '#86efac' };
    default:
      return { bg: '#f1f5f9', text: '#64748b', border: '#cbd5e1' };
  }
}

export const FILTROS_FACTURACION = [
  { id: '', label: 'Todas' },
  { id: 'sin_factura', label: 'Sin factura' },
  { id: 'pendiente_pago', label: 'Pte. pago' },
  { id: 'pagado_parcial', label: 'Pte. parcial' },
  { id: 'pagado', label: 'Pagadas' },
] as const;
