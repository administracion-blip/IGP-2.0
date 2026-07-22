export type LineaVentaCampana = {
  fecha: string;
  productId: string;
  productName: string;
  unidades: number;
  importe: number;
  incentivo: number;
};

export type UsuarioVentaCampana = {
  agoraUserId: string;
  userName: string | null;
  lineas: LineaVentaCampana[];
  totalUnidades: number;
  totalImporte: number;
  totalIncentivo: number;
};

export type LocalVentaCampana = {
  localId: string;
  porUsuario: UsuarioVentaCampana[];
  totalUnidades: number;
  totalIncentivo: number;
};

export type DetalleVentasCampana = {
  ok?: boolean;
  campanaId?: string;
  tipoIncentivo?: string;
  valorIncentivo?: number;
  porLocal: LocalVentaCampana[];
};

export type FiltroVentasCampana = {
  productId?: string;
  localId?: string;
  agoraUserId?: string;
  fecha?: string;
};
