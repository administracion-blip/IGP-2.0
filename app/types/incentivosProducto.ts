export type EstadoCampana = 'Borrador' | 'Activa' | 'Finalizada' | 'Bonificada' | 'Archivada';

// pct_coste: % sobre precio de compra (modelo actual). pct_margen: campañas antiguas.

export type TipoIncentivo = 'eur_por_unidad' | 'pct_coste' | 'pct_margen';

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

  /** Legacy — ya no se usa en campañas nuevas */

  baselineInicio?: string;

  baselineFin?: string;

  notas?: string;

  creadoPor?: string;

  creadoEn?: string;

  actualizadoEn?: string;

  /** Archivada manualmente */
  archivadaManual?: boolean;
  archivadaEn?: string;
  /** Revisión y cierre confirmado por RRHH */
  bonificadaEn?: string;
  bonificadaPor?: string;
  bonificacionNotas?: string;
};



export type ResultadoProducto = {

  productId: string;

  productName: string;

  udsCampanaPorDia: number;

  udsCampanaTotal: number;
  costeIncentivo: number;
  /** Incentivo unitario calculado según tipo de campaña y coste/margen del producto */
  bonificacionUnitaria?: number;
  precioCoste?: number;
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

    unidadesCampana: number;

    costeIncentivo: number;

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

  tipoIncentivo: TipoIncentivo;

  valorIncentivo: string;

  destinatario: DestinatarioCampana;

  notas: string;

  estado?: EstadoCampana;

};

