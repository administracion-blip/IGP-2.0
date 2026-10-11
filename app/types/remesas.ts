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
  /** `id_factura` de las líneas que quedaron sin pagar al ejecutar (remesa `Ejecutada`). */
  lineasPendientesPago?: string[];
  creadoPor?: string;
  creadoEn?: string;
  actualizadoEn?: string;
};

/** Línea que no se pudo pagar en `POST /remesas/:id/ejecutar` (409 `REMESA_EJECUCION_PARCIAL`). */
export type FallidaEjecucionRemesa = {
  id_factura: string;
  error: string;
  code?: string;
};

export type CrearRemesaBody = {
  nombre: string;
  sociedadId: string;
  facturaIds: string[];
  fechaEjecucion?: string;
  cuentaOrdenante?: string;
  sufijoOrdenante?: string;
};
