export type FormatoEtiqueta = 'completa' | 'reducida' | 'minima';
export type GranularidadActivo = 'unidad' | 'lote';

export type EstadoActivo =
  | 'en_almacen'
  | 'asignado'
  | 'en_reparacion'
  | 'en_lavanderia'
  | 'prestado'
  | 'baja'
  | 'perdido';

export type CategoriaActivo = {
  categoria_id: string;
  nombre: string;
  prefijo_etiqueta: string;
  digitos_correlativo?: number;
  formato_etiqueta: FormatoEtiqueta;
  es_serializable_default?: boolean;
  requiere_firma?: boolean;
  plantilla_documento_id?: string | null;
  activo?: boolean;
};

export type PlantillaEntregaActivo = {
  plantilla_id: string;
  nombre: string;
  cuerpo: string;
  categoria_ids?: string[];
  categorias?: { categoria_id: string; nombre: string; prefijo_etiqueta?: string }[];
  preview?: string;
  activo?: boolean;
};

export type AtributoSchemaActivo = {
  clave: string;
  etiqueta?: string;
  opciones?: string[];
};

export type ModeloActivo = {
  modelo_id: string;
  categoria_id: string;
  marca: string;
  nombre: string;
  es_serializable?: boolean;
  requiere_firma?: boolean;
  atributos_schema?: AtributoSchemaActivo[];
  activo?: boolean;
  foto_url?: string | null;
  /** Unidades en almacén, sin entregar. Solo llega si se pide `conStock=1`. */
  disponible?: number;
  /** Desglose de disponible por talla. Vacío si el modelo no usa tallas. */
  tallas?: { talla: string; cantidad: number }[];
};

export type FotoActivo = {
  foto_id: string;
  tipo: 'general' | 'placa_serie' | 'otra';
  creado_en?: string;
  url?: string | null;
};

export type EventoActivo = {
  evento_id: string;
  tipo: string;
  usuario_nombre?: string;
  creado_en: string;
  notas?: string | null;
  antes?: Record<string, unknown> | null;
  despues?: Record<string, unknown> | null;
};

export type ActivoListado = {
  asset_id: string;
  etiqueta_legible: string;
  marca?: string;
  nombre_modelo?: string;
  numero_serie?: string | null;
  estado: EstadoActivo;
  id_local: string;
  local_nombre?: string;
  categoria_id?: string;
  modelo_id?: string;
  granularidad?: GranularidadActivo;
  cantidad?: number;
  etiqueta_verificada?: boolean;
  atributos?: Record<string, string | number | boolean>;
  foto_url?: string | null;
  custodio_id?: string | null;
  custodio_nombre?: string | null;
  asignado_en?: string | null;
  /** Local al que se imputa/factura la prenda entregada (puede diferir del almacén). */
  local_imputado_id?: string | null;
  local_imputado_nombre?: string | null;
};

export type CustodiaEmpleado = {
  employee_id: string;
  employee_nombre: string;
  cantidad: number;
  activos: ActivoListado[];
};

/** Acta firmada de prendas que siguen en poder del trabajador. */
export type ActaCustodia = {
  entrega_id: string;
  fecha?: string;
  url?: string;
};

/** Custodio de un artículo en la vista agrupada por modelo. */
export type CustodioArticulo = {
  employee_id: string;
  employee_nombre: string;
  cantidad: number;
  talla?: string | null;
  id_local?: string | null;
  local_nombre?: string | null;
  local_imputado_id?: string | null;
  local_imputado_nombre?: string | null;
};

export type ArticuloCustodia = {
  modelo_id: string;
  marca?: string;
  nombre_modelo?: string;
  categoria_id?: string;
  foto_url?: string | null;
  cantidad: number;
  custodios: CustodioArticulo[];
};

/** Línea de stock en almacén de un modelo (`GET /api/activos/modelos/:id/stock`). */
export type LineaStockModelo = {
  asset_id: string;
  etiqueta_legible: string;
  id_local: string;
  local_nombre?: string;
  granularidad: GranularidadActivo;
  talla?: string | null;
  numero_serie?: string | null;
  disponibles: number;
};

export type StockModelo = {
  modelo_id: string;
  total: number;
  lineas: LineaStockModelo[];
};

export type ActivoFicha = ActivoListado & {
  notas?: string | null;
  coste_adquisicion?: number | null;
  fecha_compra?: string | null;
  fotos?: FotoActivo[];
  etiqueta_impresa?: boolean;
};

export type PreviewEtiquetaActivo = {
  asset_id: string;
  etiqueta_legible: string;
  marca?: string;
  nombre_modelo?: string;
  numero_serie?: string | null;
  formato_etiqueta: FormatoEtiqueta;
  ya_impresa?: boolean;
  qr_url: string;
};
