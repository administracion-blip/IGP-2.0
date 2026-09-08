import { statusColors } from '../constants/theme';
import type { ActivoListado, EstadoActivo, FormatoEtiqueta, FotoActivo, ModeloActivo } from '../types/activos';

export const TALLAS_INDUMENTARIA = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'Única'] as const;

export const SCHEMA_TALLA = {
  clave: 'talla',
  etiqueta: 'Talla',
  opciones: [...TALLAS_INDUMENTARIA],
} as const;

export function modeloPideTalla(modelo?: Pick<ModeloActivo, 'atributos_schema' | 'es_serializable'> | null): boolean {
  if (!modelo || modelo.es_serializable === true) return false;
  return (modelo.atributos_schema || []).some((s) => s.clave === 'talla');
}

export function opcionesTallaDeModelo(modelo?: Pick<ModeloActivo, 'atributos_schema'> | null): string[] {
  const schema = (modelo?.atributos_schema || []).find((s) => s.clave === 'talla');
  const ops = (schema?.opciones || []).map((o) => String(o).trim()).filter(Boolean);
  return ops.length ? ops : [...TALLAS_INDUMENTARIA];
}

export function ordenarStockTallas(
  tallas?: { talla: string; cantidad: number }[] | null,
): { talla: string; cantidad: number }[] {
  if (!tallas?.length) return [];
  return [...tallas]
    .filter((t) => t.cantidad > 0 && String(t.talla || '').trim())
    .sort((a, b) => {
      const ia = TALLAS_INDUMENTARIA.indexOf(a.talla as (typeof TALLAS_INDUMENTARIA)[number]);
      const ib = TALLAS_INDUMENTARIA.indexOf(b.talla as (typeof TALLAS_INDUMENTARIA)[number]);
      if (ia === -1 && ib === -1) return a.talla.localeCompare(b.talla, 'es');
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
}

export function unidadesDeActivo(item?: Pick<ActivoListado, 'granularidad' | 'cantidad'> | null): number {
  if (!item) return 0;
  if (item.granularidad === 'lote') {
    const n = Number(item.cantidad);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }
  return 1;
}

export function tallaDeActivo(item?: Pick<ActivoListado, 'atributos'> | null): string {
  const v = item?.atributos?.talla;
  return v == null || v === '' ? '' : String(v);
}

export function fotoGeneralUrl(item?: {
  foto_url?: string | null;
  fotos?: { tipo?: string; url?: string | null }[];
} | null): string | null {
  if (item?.foto_url) return item.foto_url;
  const fotos = item?.fotos || [];
  const general = fotos.find((f) => f.tipo === 'general' && f.url) || fotos.find((f) => f.url);
  return general?.url || null;
}

export const ESTADOS_ACTIVO: { id: EstadoActivo; label: string }[] = [
  { id: 'en_almacen', label: 'En almacén' },
  { id: 'asignado', label: 'Asignado' },
  { id: 'en_reparacion', label: 'En reparación' },
  { id: 'en_lavanderia', label: 'En lavandería' },
  { id: 'prestado', label: 'Prestado' },
  { id: 'perdido', label: 'Perdido' },
  { id: 'baja', label: 'Baja' },
];

const ESTADO_SEMANTICO: Record<EstadoActivo, keyof typeof statusColors> = {
  en_almacen: 'info',
  asignado: 'success',
  en_reparacion: 'warning',
  en_lavanderia: 'info',
  prestado: 'warning',
  perdido: 'danger',
  baja: 'neutral',
};

export function labelEstadoActivo(estado: string): string {
  return ESTADOS_ACTIVO.find((e) => e.id === estado)?.label || estado;
}

export function colorEstadoActivo(estado: string): { bg: string; text: string } {
  const key = ESTADO_SEMANTICO[estado as EstadoActivo] ?? 'neutral';
  return statusColors[key];
}

export const FORMATOS_ETIQUETA: { id: FormatoEtiqueta; label: string }[] = [
  { id: 'completa', label: 'Completa (QR + datos)' },
  { id: 'reducida', label: 'Reducida (QR + etiqueta)' },
  { id: 'minima', label: 'Mínima' },
];

const EVENTO_LABEL: Record<string, string> = {
  alta: 'Alta',
  etiqueta_impresa: 'Etiqueta impresa',
  etiqueta_verificada: 'Etiqueta verificada',
  foto_añadida: 'Foto añadida',
  edicion: 'Edición',
  traslado: 'Traslado',
  entrega: 'Entrega',
  devolucion: 'Devolución',
  cambio_estado: 'Cambio de estado',
  sustitucion_unidad: 'Sustitución de unidad',
  baja: 'Baja',
};

export function labelEventoActivo(tipo: string): string {
  return EVENTO_LABEL[tipo] || tipo;
}

export function labelFormatoEtiqueta(formato: string): string {
  return FORMATOS_ETIQUETA.find((f) => f.id === formato)?.label || formato;
}

/** Destinos permitidos desde cada estado. `baja` no sale. */
export const TRANSICIONES_ACTIVO: Record<EstadoActivo, EstadoActivo[]> = {
  en_almacen: ['asignado', 'prestado', 'en_reparacion', 'en_lavanderia', 'perdido', 'baja'],
  asignado: ['en_almacen', 'en_reparacion', 'prestado', 'perdido', 'baja'],
  prestado: ['en_almacen', 'asignado', 'perdido', 'baja'],
  en_reparacion: ['en_almacen', 'perdido', 'baja'],
  en_lavanderia: ['en_almacen', 'perdido', 'baja'],
  perdido: ['en_almacen', 'baja'],
  baja: [],
};

export const TIPOS_FOTO_ACTIVO: { id: FotoActivo['tipo']; label: string }[] = [
  { id: 'general', label: 'Foto general' },
  { id: 'placa_serie', label: 'Placa de serie' },
  { id: 'otra', label: 'Otra' },
];

export function labelTipoFotoActivo(tipo: string): string {
  return TIPOS_FOTO_ACTIVO.find((t) => t.id === tipo)?.label || tipo;
}
