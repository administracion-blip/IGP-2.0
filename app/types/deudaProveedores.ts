/**
 * Deuda con proveedores: facturas de gasto registradas frente a pagadas.
 * Contrato de `GET /api/facturacion/deuda-proveedores` y `/deuda-proveedores/facturas`.
 */
import type { FacturaListado } from './factura';

export type EstadoDeudaProveedor = 'cuadrado' | 'pendiente' | 'vencido';

export type TramoAntiguedad = 'no_vencido' | 'd0_30' | 'd31_60' | 'd61_90' | 'd90mas';

export type AntiguedadDeuda = {
  noVencido: number;
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90mas: number;
};

export type AntiguedadResumen = AntiguedadDeuda & {
  numSinVencimiento: number;
};

export type SociedadDeuda = {
  id: string;
  nombre: string;
  cif?: string;
};

export type KpisDeudaProveedores = {
  facturado: number;
  pagado: number;
  pendiente: number;
  vencido: number;
  numFacturas: number;
  numProveedores: number;
  pendienteAnterior: number;
  vencidoAnterior: number;
};

export type IntragrupoProveedor = {
  sociedadId: string | null;
  leDebemos: number;
  nosDebe: number;
  neto: number;
  /** Sin acceso a todas las facturas de esa sociedad: «nos debe» puede quedarse corto. */
  nosDebeParcial?: boolean;
};

export type ProveedorDeuda = {
  clave: string;
  nombre: string;
  cif?: string;
  empresaId?: string;
  facturado: number;
  pagado: number;
  pendiente: number;
  diferencia: number;
  vencido: number;
  pctPagado: number;
  estado: EstadoDeudaProveedor;
  saldoAFavor?: boolean;
  numFacturas: number;
  numPendientes: number;
  numVencidas: number;
  vencimientoMasAntiguo?: string | null;
  anterior?: { pendiente: number; vencido: number; numFacturas: number } | null;
  antiguedad?: AntiguedadDeuda | null;
  intragrupo: IntragrupoProveedor | null;
};

/** El contrato habla de `{ id, nombre? }`; los listados de facturas usan `remesaId`. Se aceptan ambos. */
export type RemesaActivaDeuda = {
  id?: string;
  remesaId?: string;
  nombre?: string;
  estado?: string;
};

export type FacturaDeuda = Omit<FacturaListado, 'remesaActiva'> & {
  remesaActiva: RemesaActivaDeuda | null;
  vencida: boolean;
  diasVencida: number | null;
  /** null si la factura no tiene saldo pendiente. */
  tramo: TramoAntiguedad | null;
  anteriorAlPeriodo: boolean;
  /** Opcionales: si el backend los incluye se usan para mostrar el icono de documento. */
  documento_file_key?: string;
  adjuntos?: unknown[];
};

export type DeudaProveedoresResp = {
  rango: { desde: string; hasta: string };
  hoy: string;
  tolerancia: number;
  sociedades: SociedadDeuda[];
  kpis: KpisDeudaProveedores;
  antiguedad: AntiguedadResumen;
  proveedores: ProveedorDeuda[];
  /** Solo con `incluirFacturas=1`. */
  facturas?: FacturaDeuda[];
};

export type DetalleProveedorResp = {
  rango: { desde: string; hasta: string };
  proveedor: ProveedorDeuda;
  facturas: FacturaDeuda[];
  intragrupo: null | { leDebemos: FacturaDeuda[]; nosDebe: FacturaDeuda[] };
};

export type ParamsDeudaProveedores = {
  fechaDesde: string;
  fechaHasta: string;
  emisorId?: string;
  proveedor?: string;
  incluirFacturas?: boolean;
};

export type ChipDeuda = 'todos' | 'con_deuda' | 'vencidos' | 'cuadrados';
