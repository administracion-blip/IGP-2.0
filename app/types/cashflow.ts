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
  { label: string; color: string; bg: string }
> = {
  Pendiente_firma: { label: 'Pendiente firma', color: '#b45309', bg: '#fffbeb' },
  Pendiente_validacion: { label: 'Pendiente validación', color: '#7c3aed', bg: '#f5f3ff' },
  Firmado: { label: 'Firmado', color: '#15803d', bg: '#f0fdf4' },
  Anulado: { label: 'Anulado', color: '#b91c1c', bg: '#fef2f2' },
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
