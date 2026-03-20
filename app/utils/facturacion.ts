export const TIPOS_IVA = [
  { value: 21, label: 'General 21%' },
  { value: 10, label: 'Reducido 10%' },
  { value: 4, label: 'Superreducido 4%' },
  { value: 0, label: 'Exento 0%' },
] as const;

export const TIPOS_RETENCION = [
  { value: 0, label: 'Sin retención' },
  { value: 1, label: '1%' },
  { value: 2, label: '2%' },
  { value: 7, label: '7%' },
  { value: 15, label: '15%' },
  { value: 19, label: '19%' },
] as const;

export const FORMAS_PAGO = [
  'transferencia',
  'efectivo',
  'tarjeta',
  'bizum',
  'remesa',
  'domiciliacion',
  'otro',
] as const;

export const METODOS_PAGO = FORMAS_PAGO;

export const CONDICIONES_PAGO = [
  'contado',
  '15 días',
  '30 días',
  '60 días',
  '90 días',
] as const;

export const ESTADOS_OUT = [
  'borrador',
  'emitida',
  'parcialmente_cobrada',
  'cobrada',
  'vencida',
  'anulada',
] as const;

export const ESTADOS_IN = [
  'borrador',
  'pendiente_revision',
  'pendiente_pago',
  'parcialmente_pagada',
  'pagada',
  'anulada',
] as const;

export type EstadoOut = (typeof ESTADOS_OUT)[number];
export type EstadoIn = (typeof ESTADOS_IN)[number];

/** Metadatos de adjunto en DynamoDB; `url` solo viene en GET /facturacion/facturas/:id/adjuntos */
export type AdjuntoFactura = {
  id?: string;
  fileKey?: string;
  nombre?: string;
  tipo?: string;
  size?: number;
  subido_en?: string;
  subido_por?: string;
  url?: string;
};

export type LineaFactura = {
  id_linea?: string;
  producto_id?: string;
  producto_ref?: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  descuento_pct: number;
  tipo_iva: number;
  iva_nombre?: string;
  retencion_pct: number;
  base_linea?: number;
  iva_linea?: number;
  retencion_linea?: number;
  total_linea?: number;
};

export type Factura = {
  id_factura: string;
  tipo: 'OUT' | 'IN';
  serie: string;
  numero: number;
  estado: string;
  /** Sociedad del grupo (p. ej. GRUPO PARIPE) en facturas IN; coincide con el selector «Empresa» en OCR */
  emisor_id?: string;
  emisor_nombre?: string;
  emisor_cif?: string;
  empresa_id: string;
  empresa_nombre: string;
  empresa_cif: string;
  empresa_direccion: string;
  empresa_cp: string;
  empresa_municipio: string;
  empresa_provincia: string;
  empresa_email: string;
  fecha_emision: string;
  fecha_operacion: string;
  fecha_vencimiento: string;
  condiciones_pago: string;
  forma_pago: string;
  base_imponible: number;
  total_iva: number;
  total_retencion: number;
  total_factura: number;
  total_cobrado: number;
  saldo_pendiente: number;
  observaciones: string;
  /** Clave S3 del documento principal (misma referencia que adjuntos[0] tras OCR) */
  documento_file_key?: string;
  documento_nombre?: string;
  adjuntos: AdjuntoFactura[];
  local_id: string;
  es_rectificativa: boolean;
  factura_rectificada_id: string;
  motivo_rectificacion: string;
  numero_factura_proveedor: string;
  fecha_contabilizacion: string;
  creado_por: string;
  creado_en: string;
  modificado_por: string;
  modificado_en: string;
  version: number;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calcularLinea(l: LineaFactura) {
  const base = round2(l.cantidad * l.precio_unitario * (1 - l.descuento_pct / 100));
  const iva = round2(base * l.tipo_iva / 100);
  const retencion = round2(base * l.retencion_pct / 100);
  const total = round2(base + iva - retencion);
  return { base_linea: base, iva_linea: iva, retencion_linea: retencion, total_linea: total };
}

export function calcularTotales(lineas: LineaFactura[]) {
  let base_imponible = 0;
  let total_iva = 0;
  let total_retencion = 0;

  const desglose: Record<number, { base: number; iva: number }> = {};

  for (const l of lineas) {
    const calc = calcularLinea(l);
    base_imponible += calc.base_linea;
    total_iva += calc.iva_linea;
    total_retencion += calc.retencion_linea;
    if (!desglose[l.tipo_iva]) desglose[l.tipo_iva] = { base: 0, iva: 0 };
    desglose[l.tipo_iva].base += calc.base_linea;
    desglose[l.tipo_iva].iva += calc.iva_linea;
  }

  return {
    base_imponible: round2(base_imponible),
    total_iva: round2(total_iva),
    total_retencion: round2(total_retencion),
    total_factura: round2(base_imponible + total_iva - total_retencion),
    desglose_iva: Object.entries(desglose).map(([tipo, vals]) => ({
      tipo_iva: Number(tipo),
      base: round2(vals.base),
      iva: round2(vals.iva),
    })),
  };
}

export function formatMoneda(n: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function labelEstado(estado: string): string {
  const map: Record<string, string> = {
    borrador: 'Borrador',
    emitida: 'Emitida',
    parcialmente_cobrada: 'Parcial cobrada',
    cobrada: 'Cobrada',
    vencida: 'Vencida',
    anulada: 'Anulada',
    pendiente_revision: 'Pte. revisión',
    pendiente_pago: 'Pte. pago',
    parcialmente_pagada: 'Parcial pagada',
    pagada: 'Pagada',
  };
  return map[estado] || estado;
}

export function colorEstado(estado: string): { bg: string; text: string } {
  const map: Record<string, { bg: string; text: string }> = {
    borrador: { bg: '#f1f5f9', text: '#64748b' },
    emitida: { bg: '#dbeafe', text: '#1e40af' },
    parcialmente_cobrada: { bg: '#fef3c7', text: '#b45309' },
    cobrada: { bg: '#d1fae5', text: '#047857' },
    vencida: { bg: '#fee2e2', text: '#b91c1c' },
    anulada: { bg: '#f1f5f9', text: '#94a3b8' },
    pendiente_revision: { bg: '#fef3c7', text: '#b45309' },
    pendiente_pago: { bg: '#dbeafe', text: '#1e40af' },
    parcialmente_pagada: { bg: '#fef3c7', text: '#b45309' },
    pagada: { bg: '#d1fae5', text: '#047857' },
  };
  return map[estado] || { bg: '#f1f5f9', text: '#64748b' };
}

export function labelFormaPago(fp: string): string {
  const map: Record<string, string> = {
    transferencia: 'Transferencia',
    efectivo: 'Efectivo',
    tarjeta: 'Tarjeta',
    bizum: 'Bizum',
    remesa: 'Remesa',
    domiciliacion: 'Domiciliación',
    otro: 'Otro',
  };
  return map[fp] || fp;
}
