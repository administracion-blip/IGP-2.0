export type EstadoRemesa = 'Borrador' | 'Generada' | 'Ejecutada' | 'Anulada';

/** Remesa Borrador/Generada en la que está incluida una factura IN (campo `remesaActiva`). */
export type RemesaActivaFactura = {
  remesaId: string;
  nombre: string;
  estado: 'Borrador' | 'Generada';
};

export type LineaRemesa = {
  id_factura: string;
  numero_factura?: string;
  numero_factura_proveedor?: string;
  proveedorNombre: string;
  proveedorCif?: string;
  ibanBeneficiario: string;
  importe: number;
  importeMaximo?: number;
  totalFactura?: number;
  totalPagado?: number;
  saldoPendiente?: number;
  concepto: string;
};

export type FacturaExcluidaRemesa = {
  id_factura: string;
  numero_factura?: string;
  proveedorNombre?: string;
  motivo: string;
};

export type Remesa = {
  remesaId: string;
  nombre: string;
  banco: string;
  estado: EstadoRemesa;
  sociedadId: string;
  sociedadNombre: string;
  sociedadCif: string;
  cuentaOrdenante: string;
  sufijoOrdenante?: string;
  fechaEjecucion?: string;
  lineas: LineaRemesa[];
  excluidas?: FacturaExcluidaRemesa[];
  importeTotal: number;
  generadaEn?: string | null;
  ejecutadaEn?: string | null;
  creadoPor?: string;
  creadoEn?: string;
  actualizadoEn?: string;
};

export type CrearRemesaBody = {
  nombre: string;
  sociedadId: string;
  facturaIds: string[];
  fechaEjecucion?: string;
  cuentaOrdenante?: string;
  sufijoOrdenante?: string;
};
