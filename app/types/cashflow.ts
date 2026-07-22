export type CashflowTipo = 'pago' | 'cobro';
export type CashflowEstado = 'Pendiente_firma' | 'Firmado' | 'Pendiente_validacion' | 'Anulado';
export type CashflowCategoria = 'actuacion' | 'proveedor' | 'evento' | 'staff' | 'otros';
export type CashflowDestinoCobro = 'banco' | 'reparto_socios';

export type CashflowLinea = {
  descripcion: string;
  importe: number;
};

export type CashflowContraparte = {
  nombre: string;
  nif?: string;
  telefono?: string;
};

export type CashflowContraparteRef = {
  tipo: 'empresa' | 'artista' | 'empleado';
  id: string;
};

export type CashflowMovimiento = {
  movimientoId: string;
  tipo: CashflowTipo;
  importe: number;
  fecha: string;
  localId: string;
  localNombre?: string;
  empresaId?: string;
  empresaNombre?: string;
  empresaCif?: string;
  categoria: CashflowCategoria;
  concepto: string;
  lineas?: CashflowLinea[];
  contraparte: CashflowContraparte;
  contraparteRef?: CashflowContraparteRef | null;
  destinoCobro?: CashflowDestinoCobro | null;
  actuacionId?: string | null;
  estado: CashflowEstado;
  numeroRecibo?: string;
  emailsCopia?: string[];
  creadoPor?: string;
  creadoPorNombre?: string;
  creadoEn?: string;
  firmadoPorId?: string | null;
  firmadoPorNombre?: string;
  firmadoEn?: string;
  validadoPor?: string;
  validadoEn?: string;
  anulacion?: {
    motivo: string;
    usuarioId?: string;
    usuarioEmail?: string;
    fecha?: string;
  };
};

export type CashflowResumen = {
  dateFrom: string;
  dateTo: string;
  pagos: number;
  cobrosBanco: number;
  cobrosReparto: number;
  neto: number;
};

export const ESTADO_CASHFLOW_META: Record<
  CashflowEstado,
  { label: string; color: string; bg: string; border: string }
> = {
  Pendiente_firma: { label: 'Pendiente firma', color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  Pendiente_validacion: { label: 'Pendiente validación', color: '#6d28d9', bg: '#f5f3ff', border: '#ddd6fe' },
  Firmado: { label: 'Firmado', color: '#166534', bg: '#dcfce7', border: '#86efac' },
  Anulado: { label: 'Anulado', color: '#991b1b', bg: '#fee2e2', border: '#fca5a5' },
};

/** Pastel chips de filtro (mismo lenguaje visual que operaciones mayoristas). */
export const CHIP_ESTADO_CASHFLOW_PASTEL: Record<
  string,
  { bg: string; bgSel: string; border: string; borderSel: string; text: string }
> = {
  '': { bg: '#f8fafc', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  Pendiente_firma: { bg: '#fffbeb', bgSel: '#fde68a', border: '#fde68a', borderSel: '#fcd34d', text: '#92400e' },
  Pendiente_validacion: { bg: '#f5f3ff', bgSel: '#ddd6fe', border: '#ddd6fe', borderSel: '#c4b5fd', text: '#6d28d9' },
  Firmado: { bg: '#dcfce7', bgSel: '#bbf7d0', border: '#bbf7d0', borderSel: '#86efac', text: '#166534' },
  Anulado: { bg: '#fee2e2', bgSel: '#fecaca', border: '#fecaca', borderSel: '#fca5a5', text: '#991b1b' },
};

export const CHIP_TIPO_CASHFLOW_PASTEL: Record<
  string,
  { bg: string; bgSel: string; border: string; borderSel: string; text: string }
> = {
  '': { bg: '#f8fafc', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  pago: { bg: '#fee2e2', bgSel: '#fecaca', border: '#fecaca', borderSel: '#fca5a5', text: '#991b1b' },
  cobro: { bg: '#dcfce7', bgSel: '#bbf7d0', border: '#bbf7d0', borderSel: '#86efac', text: '#166534' },
};

export const CATEGORIA_CASHFLOW_LABEL: Record<CashflowCategoria, string> = {
  actuacion: 'Actuación / músico',
  proveedor: 'Proveedor',
  evento: 'Evento',
  staff: 'Staff / empleado',
  otros: 'Otros',
};

export function lineasMovimiento(m: Pick<CashflowMovimiento, 'lineas' | 'concepto' | 'importe'>): CashflowLinea[] {
  if (Array.isArray(m.lineas) && m.lineas.length > 0) return m.lineas;
  const concepto = String(m.concepto || '').trim();
  if (concepto) return [{ descripcion: concepto, importe: Number(m.importe) || 0 }];
  return [];
}

export function importeTotalLineas(lineas: CashflowLinea[]): number {
  return Math.round(lineas.reduce((a, l) => a + (Number(l.importe) || 0), 0) * 100) / 100;
}

export function formatImporteCashflow(importe: number, tipo: CashflowTipo): string {
  const parts = Math.abs(importe).toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = tipo === 'pago' ? '-' : '+';
  return `${sign}${intPart},${parts[1]} €`;
}
