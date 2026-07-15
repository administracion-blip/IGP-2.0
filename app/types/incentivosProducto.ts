export type EstadoCampana = 'Borrador' | 'Activa' | 'Finalizada' | 'Archivada';
export type TipoIncentivo = 'eur_por_unidad' | 'pct_margen';
export type DestinatarioCampana = 'individual' | 'equipo';

export type ProductoCampana = {
  productId: string;
  productName: string;
  margenUnitario?: number;
};

export type Campana = {
  campanaId: string;
  nombre: string;
  estado: EstadoCampana;
  locales: string[];
  productos: ProductoCampana[];
  fechaInicio: string;
  fechaFin: string;
  tipoIncentivo: TipoIncentivo;
  valorIncentivo: number;
  destinatario: DestinatarioCampana;
  baselineInicio: string;
  baselineFin: string;
  notas?: string;
  creadoPor?: string;
  creadoEn?: string;
  actualizadoEn?: string;
};

export type ResultadoProducto = {
  productId: string;
  productName: string;
  udsBaselinePorDia: number;
  udsCampanaPorDia: number;
  udsCampanaTotal: number;
  udsIncrementales: number;
  margenUnitario: number;
  margenIncremental: number;
  costeIncentivo: number;
  resultadoNeto: number;
  veredicto: 'RENTABLE' | 'REVISAR';
  baselineIncompleto?: boolean;
};

export type ResultadoEmpleado = {
  agoraUserId: string;
  userName: string;
  localId: string;
  unidades: number;
  importe: number;
  incentivoDevengado: number;
};

export type ResultadoLocal = {
  localId: string;
  unidades: number;
  incentivoDevengado: number;
};

export type ResultadosCampana = {
  ok?: boolean;
  campanaId?: string;
  porProducto: ResultadoProducto[];
  porEmpleado: ResultadoEmpleado[];
  porLocal: ResultadoLocal[];
  totales: {
    margenIncremental: number;
    costeIncentivo: number;
    resultadoNeto: number;
  };
  serieDiaria: { fecha: string; unidades: number }[];
  warnings?: string[];
};

export type CampanaFormValues = {
  nombre: string;
  locales: string[];
  productos: ProductoCampana[];
  fechaInicio: string;
  fechaFin: string;
  baselineInicio: string;
  baselineFin: string;
  tipoIncentivo: TipoIncentivo;
  valorIncentivo: string;
  destinatario: DestinatarioCampana;
  notas: string;
  estado?: EstadoCampana;
};
