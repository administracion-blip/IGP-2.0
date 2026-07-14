/**
 * Tipos del módulo Activaciones de Marcas (campañas de marcas de bebidas
 * con sesiones programadas por local). Alineados con api/routes/activaciones.js.
 */

export type EstadoActivacion = 'borrador' | 'activa' | 'archivada';
export type EstadoSesion = 'programada' | 'realizada' | 'cancelada';

export type ActivacionAdjunto = {
  id: string;
  fileKey: string;
  nombre: string;
  tipo: string;
  size: number;
  subido_en?: string;
  subido_por?: string;
  url?: string;
};

export type Activacion = {
  id_activacion: string;
  codigo: string;
  marca: string;
  producto: string;
  /** IDs de productos IGP seleccionados (catálogo Agora). */
  productos_ids?: string[];
  tipo_activacion: string;
  vigencia_inicio: string; // YYYY-MM-DD
  vigencia_fin: string; // YYYY-MM-DD
  duracion_horas: number;
  ocasion: string;
  target_descripcion: string;
  mecanica: string;
  equipo_descripcion: string;
  materiales: string[];
  pago_observaciones: string;
  id_empresa: string;
  empresa_nombre: string;
  empresa_cif: string;
  promotor_nombre: string;
  promotor_telefono: string;
  estado: EstadoActivacion;
  adjuntos?: ActivacionAdjunto[];
  creado_por?: string;
  creado_en?: string;
  actualizado_en?: string;
  /** Solo en el listado: nº de sesiones en estado "programada". */
  sesiones_programadas?: number;
};

export type ActivacionSesion = {
  id_sesion: string;
  id_activacion: string;
  id_local: string;
  local_nombre?: string;
  /** Jornada de negocio (YYYY-MM-DD), no día calendario. */
  fecha: string;
  hora_inicio: string; // HH:mm
  hora_fin: string; // HH:mm (menor que hora_inicio si cruza medianoche)
  estado_sesion: EstadoSesion;
  incidencia?: string;
  creado_por?: string;
  creado_en?: string;
};

/** Sesión enriquecida con campos de la ficha (GET /activaciones/sesiones/dia). */
export type ActivacionSesionDia = ActivacionSesion & {
  codigo: string;
  marca: string;
  producto: string;
  tipo_activacion: string;
  mecanica: string;
  duracion_horas: number;
  equipo_descripcion: string;
  materiales: string[];
  pago_observaciones: string;
};

export const ESTADO_ACTIVACION_META: Record<EstadoActivacion, { label: string; bg: string; text: string }> = {
  borrador: { label: 'Borrador', bg: '#e2e8f0', text: '#475569' },
  activa: { label: 'Activa', bg: '#d1fae5', text: '#047857' },
  archivada: { label: 'Archivada', bg: '#fef3c7', text: '#b45309' },
};

export const ESTADO_SESION_META: Record<EstadoSesion, { label: string; bg: string; text: string }> = {
  programada: { label: 'Programada', bg: '#e0f2fe', text: '#0369a1' },
  realizada: { label: 'Realizada', bg: '#d1fae5', text: '#047857' },
  cancelada: { label: 'Cancelada', bg: '#e2e8f0', text: '#475569' },
};

/** ¿La sesión cruza medianoche? (fin en la madrugada de la misma jornada) */
export function sesionCruzaMedianoche(s: Pick<ActivacionSesion, 'hora_inicio' | 'hora_fin'>): boolean {
  return !!s.hora_inicio && !!s.hora_fin && s.hora_fin < s.hora_inicio;
}
