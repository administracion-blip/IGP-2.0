/**
 * Constantes del módulo de activos. Los literales de estado y evento viven
 * aquí una sola vez: un typo en un handler no debe inventar un estado nuevo.
 */

export const ESTADOS_ACTIVO = Object.freeze([
  'en_almacen',
  'asignado',
  'en_reparacion',
  'en_lavanderia',
  'prestado',
  'baja',
  'perdido',
]);

export const ESTADO = Object.freeze(Object.fromEntries(ESTADOS_ACTIVO.map((e) => [e, e])));

/** Destinos permitidos desde cada estado. `baja` no sale. */
export const TRANSICIONES = Object.freeze({
  en_almacen: ['asignado', 'prestado', 'en_reparacion', 'en_lavanderia', 'perdido', 'baja'],
  asignado: ['en_almacen', 'en_reparacion', 'prestado', 'perdido', 'baja'],
  prestado: ['en_almacen', 'asignado', 'perdido', 'baja'],
  en_reparacion: ['en_almacen', 'perdido', 'baja'],
  en_lavanderia: ['en_almacen', 'perdido', 'baja'],
  perdido: ['en_almacen', 'baja'],
  baja: [],
});

export const TIPOS_EVENTO = Object.freeze([
  'alta',
  'etiqueta_impresa',
  'etiqueta_verificada',
  'foto_añadida',
  'edicion',
  'traslado',
  'entrega',
  'devolucion',
  'cambio_estado',
  'sustitucion_unidad',
  'baja',
]);

export const EVENTO = Object.freeze(Object.fromEntries(TIPOS_EVENTO.map((t) => [t, t])));

export const GRANULARIDAD = Object.freeze({
  unidad: 'unidad',
  lote: 'lote',
});

export const FORMATOS_ETIQUETA = Object.freeze(['completa', 'reducida', 'minima']);

export const TIPOS_FOTO = Object.freeze(['general', 'placa_serie', 'otra']);

export const GSI = Object.freeze({
  listadoCatalogo: 'Listado-index',
  categoria: 'Categoria-index',
  marca: 'Marca-index',
  centroEstado: 'CentroEstado-index',
  modelo: 'Modelo-index',
  etiqueta: 'Etiqueta-index',
  serie: 'Serie-index',
  pendienteVerificacion: 'PendienteVerificacion-index',
  listadoActivos: 'Listado-index',
});

export const GSI_LISTADO_CAT = 'CAT';
export const GSI_LISTADO_MOD = 'MOD';
export const GSI_LISTADO_PLANT = 'PLANT';
export const GSI_LISTADO_ACTIVO = 'ACTIVO';

export const SK_META = 'META';
export const SK_CONTADOR = 'CONTADOR';

export const PREFIJO_CAT = 'CAT#';
export const PREFIJO_MOD = 'MOD#';
export const PREFIJO_PLANT = 'PLANT#';
export const PREFIJO_ASSET = 'ASSET#';
export const PREFIJO_EVT = 'EVT#';

export const DIGITOS_CORRELATIVO_DEFAULT = 4;
export const LOTE_MAX_UNIDADES = 50;
export const FOTOS_MAX = 12;

export function enLista(lista, valor) {
  return lista.includes(valor);
}

export function errorHttp(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}
