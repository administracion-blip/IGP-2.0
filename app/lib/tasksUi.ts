/**
 * Etiquetas, tonos y agrupaciones del módulo de dirección para la interfaz.
 *
 * Aquí no hay reglas de negocio nuevas: solo la traducción a español y a color
 * de lo que ya declara `app/types/tasks.ts`. Las transiciones de estado son un
 * espejo de las del backend y sirven únicamente para no ofrecer botones que el
 * servidor rechazaría con `422`; quien decide sigue siendo el servidor.
 */
import type { ComponentProps } from 'react';
import { MaterialIcons } from '@expo/vector-icons';
import { formatFecha } from '../utils/formatFecha';
import {
  FECHA_SIN_LIMITE,
  type EstadoAcuerdo,
  type EstadoAudio,
  type EstadoPipeline,
  type EstadoProyecto,
  type EstadoReunion,
  type EstadoTarea,
  type EstadoPropuesta,
  type ModalidadReunion,
  type OrigenAudio,
  type Prioridad,
  type RolProyecto,
  type TipoPropuesta,
  type TipoVinculo,
  type VisibilidadReunion,
} from '../types/tasks';

export type NombreIcono = ComponentProps<typeof MaterialIcons>['name'];

/** Par fondo / texto de una etiqueta de estado. Solo colores del ERP. */
export type Tono = { bg: string; fg: string };

// ─── Proyectos ───

export const ETIQUETA_ESTADO_PROYECTO: Record<EstadoProyecto, string> = {
  borrador: 'Borrador',
  activo: 'Activo',
  en_pausa: 'En pausa',
  cerrado: 'Cerrado',
  cancelado: 'Cancelado',
};

export const TONO_ESTADO_PROYECTO: Record<EstadoProyecto, Tono> = {
  borrador: { bg: '#e2e8f0', fg: '#64748b' },
  activo: { bg: '#dcfce7', fg: '#16a34a' },
  en_pausa: { bg: '#fef3c7', fg: '#d97706' },
  cerrado: { bg: '#e0f2fe', fg: '#0369a1' },
  cancelado: { bg: '#f1f5f9', fg: '#94a3b8' },
};

export const ETIQUETA_ROL_PROYECTO: Record<RolProyecto, string> = {
  responsable: 'Responsable',
  miembro: 'Miembro',
  observador: 'Observador',
};

export const ICONO_ROL_PROYECTO: Record<RolProyecto, NombreIcono> = {
  responsable: 'stars',
  miembro: 'person',
  observador: 'visibility',
};

// ─── Tareas ───

export const ETIQUETA_ESTADO_TAREA: Record<EstadoTarea, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  bloqueada: 'Bloqueada',
  hecha: 'Hecha',
  cancelada: 'Cancelada',
};

export const TONO_ESTADO_TAREA: Record<EstadoTarea, Tono> = {
  pendiente: { bg: '#e2e8f0', fg: '#475569' },
  en_curso: { bg: '#e0f2fe', fg: '#0369a1' },
  bloqueada: { bg: '#fef3c7', fg: '#b45309' },
  hecha: { bg: '#dcfce7', fg: '#16a34a' },
  cancelada: { bg: '#f1f5f9', fg: '#94a3b8' },
};

export const ETIQUETA_PRIORIDAD: Record<Prioridad, string> = {
  baja: 'Baja',
  media: 'Media',
  alta: 'Alta',
};

export const TONO_PRIORIDAD: Record<Prioridad, Tono> = {
  baja: { bg: '#f1f5f9', fg: '#64748b' },
  media: { bg: '#e0f2fe', fg: '#0369a1' },
  alta: { bg: '#fee2e2', fg: '#b91c1c' },
};

/**
 * Espejo de `TRANSICIONES_TAREA` (`api/lib/tasks/tipos.js`). Reabrir una tarea
 * cerrada está permitido a propósito: se cierran cosas por error.
 */
export const TRANSICIONES_TAREA: Record<EstadoTarea, EstadoTarea[]> = {
  pendiente: ['en_curso', 'bloqueada', 'hecha', 'cancelada'],
  en_curso: ['pendiente', 'bloqueada', 'hecha', 'cancelada'],
  bloqueada: ['pendiente', 'en_curso', 'cancelada'],
  hecha: ['pendiente'],
  cancelada: ['pendiente'],
};

export function transicionesDesde(estado?: EstadoTarea | null): EstadoTarea[] {
  if (!estado) return [];
  return TRANSICIONES_TAREA[estado] ?? [];
}

/** Cómo se presenta cada destino de estado como acción pulsable. */
export const ACCION_ESTADO_TAREA: Record<
  EstadoTarea,
  { etiqueta: string; icono: NombreIcono; tono: Tono }
> = {
  pendiente: { etiqueta: 'Reabrir', icono: 'undo', tono: { bg: '#f1f5f9', fg: '#475569' } },
  en_curso: { etiqueta: 'Empezar', icono: 'play-arrow', tono: { bg: '#e0f2fe', fg: '#0369a1' } },
  bloqueada: { etiqueta: 'Bloquear', icono: 'block', tono: { bg: '#fef3c7', fg: '#b45309' } },
  hecha: { etiqueta: 'Hecha', icono: 'check', tono: { bg: '#dcfce7', fg: '#15803d' } },
  cancelada: { etiqueta: 'Cancelar', icono: 'close', tono: { bg: '#f1f5f9', fg: '#94a3b8' } },
};

/** Acciones rápidas de la vista personal: cerrar, arrancar y bloquear. */
export const ACCIONES_RAPIDAS_TAREA: EstadoTarea[] = ['hecha', 'en_curso', 'bloqueada'];

// ─── Reuniones ───

export const ETIQUETA_ESTADO_REUNION: Record<EstadoReunion, string> = {
  borrador: 'Borrador',
  convocada: 'Convocada',
  celebrada: 'Celebrada',
  acta_borrador: 'Acta en borrador',
  acta_validada: 'Acta validada',
  cancelada: 'Cancelada',
};

export const TONO_ESTADO_REUNION: Record<EstadoReunion, Tono> = {
  borrador: { bg: '#e2e8f0', fg: '#64748b' },
  convocada: { bg: '#e0f2fe', fg: '#0369a1' },
  celebrada: { bg: '#dcfce7', fg: '#16a34a' },
  acta_borrador: { bg: '#fef3c7', fg: '#d97706' },
  acta_validada: { bg: '#dcfce7', fg: '#15803d' },
  cancelada: { bg: '#f1f5f9', fg: '#94a3b8' },
};

export const ETIQUETA_VISIBILIDAD_REUNION: Record<VisibilidadReunion, string> = {
  direccion: 'Dirección',
  empresa: 'Empresa',
  departamento: 'Departamento',
  local: 'Local',
  restringida: 'Restringida',
};

export const ETIQUETA_MODALIDAD_REUNION: Record<ModalidadReunion, string> = {
  presencial: 'Presencial',
  remota: 'Remota',
  mixta: 'Mixta',
};

/**
 * URL de Google Meet a partir del código guardado (`igt-tgse-rrz`).
 * Devuelve null si el código está vacío o no es usable.
 */
export function urlMeetDesdeCodigo(code?: string | null): string | null {
  const raw = String(code ?? '').trim();
  if (!raw) return null;
  // Código Meet típico: segmentos alfanuméricos separados por guiones
  const limpio = raw.replace(/^https?:\/\/meet\.google\.com\//i, '').trim();
  if (!limpio || /\s/.test(limpio) || /[/?#]/.test(limpio)) return null;
  return `https://meet.google.com/${limpio}`;
}

export const ETIQUETA_ESTADO_ACUERDO: Record<EstadoAcuerdo, string> = {
  abierto: 'Abierto',
  cumplido: 'Cumplido',
  incumplido: 'Incumplido',
};

export const TONO_ESTADO_ACUERDO: Record<EstadoAcuerdo, Tono> = {
  abierto: { bg: '#e0f2fe', fg: '#0369a1' },
  cumplido: { bg: '#dcfce7', fg: '#16a34a' },
  incumplido: { bg: '#fee2e2', fg: '#b91c1c' },
};

export const ETIQUETA_ESTADO_AUDIO: Record<EstadoAudio, string> = {
  ausente: 'Sin audio',
  presente: 'Audio presente',
  borrado: 'Audio borrado',
};

export const ETIQUETA_ORIGEN_AUDIO: Record<OrigenAudio, string> = {
  meet: 'Google Meet',
  subida: 'Subida manual',
  grabacion_app: 'Grabación en app',
  transcripcion_importada: 'Transcripción importada',
};

/**
 * Espejo de `pipelineYaIniciado` del backend: no re-subir audio ni re-importar
 * si ya hay captura, job STT, transcripción en S3 o pipeline en vuelo.
 */
export function capturaYaIniciada(reunion: {
  transcripcion_job_id?: string | null;
  transcripcion_s3_key?: string | null;
  audio_estado?: string | null;
  pipeline_estado?: string | null;
  origen_audio?: string | null;
}): boolean {
  if ((reunion.transcripcion_job_id ?? '').trim()) return true;
  if ((reunion.transcripcion_s3_key ?? '').trim()) return true;
  if (reunion.origen_audio === 'transcripcion_importada') return true;
  if (reunion.audio_estado === 'presente') return true;
  const estado = reunion.pipeline_estado;
  return !!estado && (ESTADOS_PIPELINE_EN_VUELO as readonly string[]).includes(estado);
}

export const ETIQUETA_ESTADO_PIPELINE: Record<EstadoPipeline, string> = {
  audio_pendiente: 'Audio pendiente de transcripción',
  transcribiendo: 'Transcribiendo',
  transcrita: 'Transcripción lista',
  resumiendo: 'Generando resumen',
  error: 'Error en el procesado',
};

/** Estados en los que el pipeline sigue trabajando (sin %; UI indeterminada). */
export const ESTADOS_PIPELINE_EN_VUELO: readonly EstadoPipeline[] = [
  'audio_pendiente',
  'transcribiendo',
  'transcrita',
  'resumiendo',
] as const;

export function pipelineEnVuelo(estado?: EstadoPipeline | null): boolean {
  return !!estado && (ESTADOS_PIPELINE_EN_VUELO as readonly string[]).includes(estado);
}

/**
 * Duración legible entre dos horas `HH:MM` / `HH:MM:SS`.
 * Devuelve p. ej. `45 min`, `1 h`, `1 h 30 min`, o `null` si no se puede calcular.
 */
export function duracionEntreHoras(
  horaInicio?: string | null,
  horaFin?: string | null,
): string | null {
  const aMin = minutosDeHora(horaInicio);
  const bMin = minutosDeHora(horaFin);
  if (aMin == null || bMin == null) return null;
  let diff = bMin - aMin;
  if (diff < 0) diff += 24 * 60;
  if (diff === 0) return null;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function minutosDeHora(hora?: string | null): number | null {
  const t = (hora ?? '').trim();
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

export const ETIQUETA_TIPO_PROPUESTA: Record<TipoPropuesta, string> = {
  tarea: 'Tarea',
  acuerdo: 'Acuerdo',
};

export const ETIQUETA_ESTADO_PROPUESTA: Record<EstadoPropuesta, string> = {
  pendiente: 'Pendiente',
  aceptada: 'Aceptada',
  rechazada: 'Rechazada',
  editada_y_aceptada: 'Editada y aceptada',
};

export const TONO_ESTADO_PROPUESTA: Record<EstadoPropuesta, Tono> = {
  pendiente: { bg: '#fef3c7', fg: '#d97706' },
  aceptada: { bg: '#dcfce7', fg: '#16a34a' },
  rechazada: { bg: '#f1f5f9', fg: '#94a3b8' },
  editada_y_aceptada: { bg: '#dcfce7', fg: '#15803d' },
};

export const TONO_TIPO_PROPUESTA: Record<TipoPropuesta, Tono> = {
  tarea: { bg: '#e0f2fe', fg: '#0369a1' },
  acuerdo: { bg: '#ecfdf5', fg: '#047857' },
};

/**
 * D-20: el orden del día deja de editarse en `celebrada` o superior, salvo
 * `cancelada`. El servidor responde `409` si se intenta igual.
 */
export function ordenDelDiaEditable(estado?: EstadoReunion | null): boolean {
  if (!estado || estado === 'cancelada') return true;
  return estado === 'borrador' || estado === 'convocada';
}

const PREFIJO_PUNTO_ORDEN = /^\d+[.)]\s+/;
const PREFIJO_VIÑETA_ORDEN = /^[-•*]\s+/;
const LINEA_NUMERADA_ORDEN = /^\s*(\d+)[.)]\s/;

/**
 * Convierte texto libre del orden del día en lista `1. 2. 3. …`.
 * Omite líneas vacías y quita prefijos previos de número o viñeta.
 */
export function numerarOrdenDelDia(texto: string): string {
  const normalizado = String(texto ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lineas = normalizado
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(PREFIJO_PUNTO_ORDEN, '').replace(PREFIJO_VIÑETA_ORDEN, '').trim())
    .filter((l) => l.length > 0);
  if (lineas.length === 0) return '';
  return lineas.map((l, i) => `${i + 1}. ${l}`).join('\n');
}

/**
 * Si el cambio es insertar un solo salto de línea tras una línea `N.` / `N)`,
 * añade `(N+1). ` en la nueva línea. No reescribe pegados masivos.
 */
export function autoNumerarOrdenDelDiaAlEnter(previo: string, nuevo: string): string {
  const ant = String(previo ?? '');
  const act = String(nuevo ?? '');
  const delta = act.length - ant.length;
  if (delta < 1 || delta > 2) return act;

  let i = 0;
  const limite = Math.min(ant.length, act.length);
  while (i < limite && ant[i] === act[i]) i++;

  let salto = '';
  if (delta === 1 && act[i] === '\n' && act.slice(i + 1) === ant.slice(i)) {
    salto = '\n';
  } else if (
    delta === 2 &&
    act.slice(i, i + 2) === '\r\n' &&
    act.slice(i + 2) === ant.slice(i)
  ) {
    salto = '\r\n';
  } else {
    return act;
  }

  const antes = ant.slice(0, i);
  const ultimaLinea = antes.slice(antes.lastIndexOf('\n') + 1);
  const m = ultimaLinea.match(LINEA_NUMERADA_ORDEN);
  if (!m) return act;

  const siguiente = Number(m[1]) + 1;
  if (!Number.isFinite(siguiente) || siguiente < 1) return act;
  return act.slice(0, i + salto.length) + `${siguiente}. ` + act.slice(i + salto.length);
}

// ─── Vínculos ───

export const ETIQUETA_TIPO_VINCULO: Record<TipoVinculo, string> = {
  local: 'Local',
  proveedor: 'Proveedor',
  articulo: 'Artículo',
  actuacion: 'Actuación',
  cuenta_bancaria: 'Cuenta bancaria',
  factura: 'Factura',
  incidencia: 'Incidencia',
  empresa: 'Empresa',
  proyecto: 'Proyecto',
  tarea: 'Tarea',
  reunion: 'Reunión',
};

// ─── Actividad ───

const ETIQUETA_ACCION_ACTIVIDAD: Record<string, string> = {
  creada: 'Creación',
  editada: 'Edición',
  borrada: 'Borrado',
  estado_cambiado: 'Cambio de estado',
  reasignada: 'Reasignación',
  miembro_anadido: 'Miembro añadido',
  miembro_quitado: 'Miembro retirado',
  vinculo_anadido: 'Vínculo añadido',
  vinculo_quitado: 'Vínculo retirado',
  comentario: 'Comentario',
  checklist_cambiada: 'Lista de comprobación',
};

export function etiquetaAccionActividad(accion: string): string {
  return ETIQUETA_ACCION_ACTIVIDAD[accion] ?? accion.replace(/_/g, ' ');
}

/** Nombres de campo tal como se enseñan en el historial. */
const ETIQUETA_CAMPO: Record<string, string> = {
  titulo: 'Título',
  nombre: 'Nombre',
  descripcion: 'Descripción',
  estado: 'Estado',
  prioridad: 'Prioridad',
  responsable_id: 'Responsable',
  proyecto_id: 'Proyecto',
  departamento_id: 'Departamento',
  fecha_limite: 'Fecha límite',
  fecha_inicio: 'Fecha de inicio',
  fecha_fin_prevista: 'Fin previsto',
  fecha_cierre: 'Fecha de cierre',
  presupuesto_asignado: 'Presupuesto',
  bloqueo_motivo: 'Motivo del bloqueo',
  rol_proyecto: 'Rol',
  usuario_id: 'Usuario',
  antes: 'Antes',
  despues: 'Después',
  texto: 'Texto',
  hecho: 'Marcado',
  tipo: 'Tipo',
  etiqueta: 'Etiqueta',
};

function etiquetaCampo(clave: string): string {
  return ETIQUETA_CAMPO[clave] ?? clave.replace(/_/g, ' ');
}

/** Valor de un detalle de actividad legible: nunca un objeto crudo. */
function valorLegible(valor: unknown): string {
  if (valor == null || valor === '') return '—';
  if (typeof valor === 'boolean') return valor ? 'sí' : 'no';
  if (typeof valor === 'number') return String(valor);
  if (typeof valor === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return formatFecha(valor);
    return valor;
  }
  if (Array.isArray(valor)) return valor.length === 0 ? '—' : String(valor.length);
  return '…';
}

/**
 * Resume el `detalle` (JSON serializado) del historial en líneas legibles.
 *
 * Los identificadores en bruto se descartan: el historial no es sitio para
 * enseñar un UUID. Devuelve lista vacía si no hay nada que contar.
 */
export function resumirDetalleActividad(detalle?: string): string[] {
  const bruto = (detalle ?? '').trim();
  if (!bruto) return [];
  let dato: unknown;
  try {
    dato = JSON.parse(bruto);
  } catch {
    return [bruto.slice(0, 200)];
  }
  if (dato == null || typeof dato !== 'object') return [valorLegible(dato)];

  const objeto = dato as Record<string, unknown>;
  const antes = objeto.antes as Record<string, unknown> | undefined;
  const despues = objeto.despues as Record<string, unknown> | undefined;

  if (antes && despues && typeof antes === 'object' && typeof despues === 'object') {
    const claves = [...new Set([...Object.keys(antes), ...Object.keys(despues)])];
    return claves
      .filter((c) => !c.endsWith('_id') && valorLegible(antes[c]) !== valorLegible(despues[c]))
      .map((c) => `${etiquetaCampo(c)}: ${valorLegible(antes[c])} → ${valorLegible(despues[c])}`);
  }

  return Object.entries(objeto)
    .filter(([clave, valor]) => !clave.endsWith('_id') && valor != null && valor !== '')
    .map(([clave, valor]) => `${etiquetaCampo(clave)}: ${valorLegible(valor)}`);
}

// ─── Vencimientos ───

export type GrupoVencimiento = 'vencidas' | 'hoy' | 'semana' | 'adelante' | 'sin_fecha';

/** Orden de presentación: lo urgente arriba, lo indefinido al final. */
export const ORDEN_GRUPOS_VENCIMIENTO: GrupoVencimiento[] = [
  'vencidas',
  'hoy',
  'semana',
  'adelante',
  'sin_fecha',
];

export const ETIQUETA_GRUPO_VENCIMIENTO: Record<GrupoVencimiento, string> = {
  vencidas: 'Vencidas',
  hoy: 'Para hoy',
  semana: 'Esta semana',
  adelante: 'Más adelante',
  sin_fecha: 'Sin fecha',
};

export const ICONO_GRUPO_VENCIMIENTO: Record<GrupoVencimiento, NombreIcono> = {
  vencidas: 'warning',
  hoy: 'today',
  semana: 'date-range',
  adelante: 'event',
  sin_fecha: 'event-busy',
};

export const TONO_GRUPO_VENCIMIENTO: Record<GrupoVencimiento, Tono> = {
  vencidas: { bg: '#fee2e2', fg: '#b91c1c' },
  hoy: { bg: '#fef3c7', fg: '#b45309' },
  semana: { bg: '#e0f2fe', fg: '#0369a1' },
  adelante: { bg: '#f1f5f9', fg: '#475569' },
  sin_fecha: { bg: '#f1f5f9', fg: '#94a3b8' },
};

/** Hoy natural en ISO. Las fechas límite no dependen de la jornada de negocio. */
export function hoyIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dia}`;
}

function esFechaIso(valor: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(valor);
}

/** Diferencia en días naturales entre dos fechas ISO (`hasta − desde`). */
export function diasEntreIso(desde: string, hasta: string): number {
  const a = new Date(`${desde}T12:00:00`);
  const b = new Date(`${hasta}T12:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function grupoVencimiento(fechaLimite?: string, hoy: string = hoyIso()): GrupoVencimiento {
  const iso = (fechaLimite ?? '').trim();
  if (!iso || iso === FECHA_SIN_LIMITE || !esFechaIso(iso)) return 'sin_fecha';
  if (iso < hoy) return 'vencidas';
  if (iso === hoy) return 'hoy';
  return diasEntreIso(hoy, iso) <= 7 ? 'semana' : 'adelante';
}

/**
 * Reparte las tareas en los grupos de vencimiento **sin reordenar**: el backend
 * ya las devuelve ordenadas por vencimiento y el orden relativo se conserva
 * dentro de cada grupo.
 */
export function agruparPorVencimiento<T extends { fecha_limite?: string }>(
  tareas: T[],
  hoy: string = hoyIso(),
): { grupo: GrupoVencimiento; tareas: T[] }[] {
  const mapa = new Map<GrupoVencimiento, T[]>();
  for (const tarea of tareas) {
    const grupo = grupoVencimiento(tarea.fecha_limite, hoy);
    const lista = mapa.get(grupo);
    if (lista) lista.push(tarea);
    else mapa.set(grupo, [tarea]);
  }
  return ORDEN_GRUPOS_VENCIMIENTO.filter((g) => (mapa.get(g)?.length ?? 0) > 0).map((g) => ({
    grupo: g,
    tareas: mapa.get(g) as T[],
  }));
}

/** Texto corto del vencimiento: «Vencida hace 3 días», «Hoy», «15/06/2026». */
export function textoVencimiento(fechaLimite?: string, hoy: string = hoyIso()): string {
  const iso = (fechaLimite ?? '').trim();
  if (!iso || iso === FECHA_SIN_LIMITE || !esFechaIso(iso)) return 'Sin fecha límite';
  const dias = diasEntreIso(hoy, iso);
  if (dias === 0) return 'Hoy';
  if (dias === 1) return 'Mañana';
  if (dias === -1) return 'Venció ayer';
  if (dias < -1) return `Venció hace ${Math.abs(dias)} días`;
  if (dias <= 7) return `En ${dias} días · ${formatFecha(iso)}`;
  return formatFecha(iso);
}

// ─── Nombres resueltos por el servidor ───

/**
 * Texto de una persona a partir del nombre que ya resolvió el servidor.
 *
 * Con el id puesto y el nombre a `null`, esa persona ya no existe. El
 * identificador no se muestra en ningún caso.
 */
export function nombreUsuario(id?: string | null, nombre?: string | null): string {
  const limpio = (nombre ?? '').trim();
  if (limpio) return limpio;
  return (id ?? '').trim() ? 'Usuario eliminado' : '—';
}

/**
 * Texto del proyecto de una tarea, o `null` si la tarea no tiene proyecto:
 * `proyecto_nombre` llega **ausente** en ese caso, no a `null`.
 */
export function nombreProyectoDeTarea(tarea: {
  proyecto_id?: string;
  proyecto_nombre?: string | null;
}): string | null {
  if (!(tarea.proyecto_id ?? '').trim()) return null;
  return (tarea.proyecto_nombre ?? '').trim() || 'Proyecto no disponible';
}

/**
 * Si se puede ofrecer la ficha del proyecto de una tarea. Con `proyecto_nombre`
 * a `null` ese proyecto no lo alcanza quien mira —ve la tarea por ser su
 * responsable— y su ficha respondería `404`.
 */
export function proyectoDeTareaAlcanzable(tarea: {
  proyecto_id?: string;
  proyecto_nombre?: string | null;
}): boolean {
  return Boolean((tarea.proyecto_id ?? '').trim()) && Boolean((tarea.proyecto_nombre ?? '').trim());
}

/** Importe en euros con formato español. */
export function formatEuros(valor?: number | null): string {
  if (valor == null || !Number.isFinite(valor)) return '—';
  return `${valor.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
