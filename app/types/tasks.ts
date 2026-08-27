/**
 * Tipos del módulo de dirección — proyectos, tareas y reuniones.
 *
 * **Fuente normativa** del contrato de datos. El backend es JavaScript sin
 * compilación, así que no puede importar de aquí: mantiene un espejo con
 * `@typedef` en `api/lib/tasks/tipos.js`. Si los dos divergen, manda
 * `docs/tasks/02-modelo-datos.md`.
 *
 * Este fichero lo toca **solo el agente integrador** (ver
 * `.cursor/rules/modulo-tasks.mdc`).
 *
 * El esquema está completo para todas las fases aunque se implemente por
 * partes: un campo declarado aquí y todavía sin escribir es correcto.
 */

// ─── Estados y enumeraciones ───

export const ESTADOS_PROYECTO = ['borrador', 'activo', 'en_pausa', 'cerrado', 'cancelado'] as const;
export type EstadoProyecto = (typeof ESTADOS_PROYECTO)[number];

export const ESTADOS_TAREA = ['pendiente', 'en_curso', 'bloqueada', 'hecha', 'cancelada'] as const;
export type EstadoTarea = (typeof ESTADOS_TAREA)[number];

/** Estados en los que la tarea deja de estar abierta y sale de la vista personal. */
export const ESTADOS_TAREA_TERMINALES = ['hecha', 'cancelada'] as const;

export const PRIORIDADES = ['baja', 'media', 'alta'] as const;
export type Prioridad = (typeof PRIORIDADES)[number];

export const ROLES_PROYECTO = ['responsable', 'miembro', 'observador'] as const;
export type RolProyecto = (typeof ROLES_PROYECTO)[number];

export const ESTADOS_LINEA_COMPRA = ['propuesta', 'aprobada', 'rechazada', 'pedida', 'recibida'] as const;
export type EstadoLineaCompra = (typeof ESTADOS_LINEA_COMPRA)[number];

/** Escalón de aprobación, en orden creciente de autoridad. */
export const NIVELES_APROBACION = ['responsable_proyecto', 'responsable_departamento', 'direccion'] as const;
export type NivelAprobacion = (typeof NIVELES_APROBACION)[number];

export const ESTADOS_REUNION = [
  'borrador',
  'convocada',
  'celebrada',
  'acta_borrador',
  'acta_validada',
  'cancelada',
] as const;
export type EstadoReunion = (typeof ESTADOS_REUNION)[number];

/**
 * Estado técnico del pipeline, **separado** del estado de negocio: una reunión
 * con acta manual llega a `acta_validada` sin pasar por aquí. El atributo es
 * disperso — solo existe mientras la reunión está en vuelo — y por eso el
 * índice del poller no contiene nada más.
 */
export const ESTADOS_PIPELINE = ['audio_pendiente', 'transcribiendo', 'transcrita', 'resumiendo', 'error'] as const;
export type EstadoPipeline = (typeof ESTADOS_PIPELINE)[number];

export const FASES_PIPELINE = ['captura', 'transcripcion', 'resumen'] as const;
export type FasePipeline = (typeof FASES_PIPELINE)[number];

export const VISIBILIDADES_REUNION = ['direccion', 'empresa', 'departamento', 'local', 'restringida'] as const;
export type VisibilidadReunion = (typeof VISIBILIDADES_REUNION)[number];

export const ORIGENES_AUDIO = ['meet', 'subida', 'grabacion_app'] as const;
export type OrigenAudio = (typeof ORIGENES_AUDIO)[number];

export const ESTADOS_AUDIO = ['ausente', 'presente', 'borrado'] as const;
export type EstadoAudio = (typeof ESTADOS_AUDIO)[number];

export const MODALIDADES_REUNION = ['presencial', 'remota', 'mixta'] as const;
export type ModalidadReunion = (typeof MODALIDADES_REUNION)[number];

export const COBERTURAS_PUNTO = ['tratado', 'parcial', 'no_tratado'] as const;
export type CoberturaPunto = (typeof COBERTURAS_PUNTO)[number];

export const ORIGENES_PUNTO = ['previsto', 'emergente'] as const;
export type OrigenPunto = (typeof ORIGENES_PUNTO)[number];

export const ESTADOS_ACUERDO = ['abierto', 'cumplido', 'incumplido'] as const;
export type EstadoAcuerdo = (typeof ESTADOS_ACUERDO)[number];

export const TIPOS_PROPUESTA = ['tarea', 'acuerdo'] as const;
export type TipoPropuesta = (typeof TIPOS_PROPUESTA)[number];

export const ESTADOS_PROPUESTA = ['pendiente', 'aceptada', 'rechazada', 'editada_y_aceptada'] as const;
export type EstadoPropuesta = (typeof ESTADOS_PROPUESTA)[number];

export const ESTADOS_CAPTURA = ['pendiente', 'ok', 'fallida'] as const;
export type EstadoCaptura = (typeof ESTADOS_CAPTURA)[number];

export const TIPOS_NOTIFICACION = [
  'mencion',
  'asignacion',
  'vencimiento',
  'compra_pendiente',
  'acta_lista',
] as const;
export type TipoNotificacion = (typeof TIPOS_NOTIFICACION)[number];

// ─── Vínculo polimórfico ───

export const TIPOS_VINCULO = [
  'local',
  'proveedor',
  'articulo',
  'actuacion',
  'cuenta_bancaria',
  'factura',
  'incidencia',
  'empresa',
  'proyecto',
  'tarea',
  'reunion',
] as const;
export type TipoVinculo = (typeof TIPOS_VINCULO)[number];

/**
 * Referencia a una entidad de negocio de IGP. `etiqueta` es el nombre **en el
 * momento de vincular**, para poder pintar la tarjeta sin resolver la entidad
 * en cada lectura.
 */
export type Vinculo = {
  tipo: TipoVinculo;
  id: string;
  etiqueta?: string;
};

// ─── Permisos ───

export const PERMISOS = {
  proyectosVer: 'proyectos.ver',
  proyectosCrear: 'proyectos.crear',
  proyectosEditar: 'proyectos.editar',
  proyectosBorrar: 'proyectos.borrar',
  tareasVerTodas: 'tareas.ver_todas',
  tareasEditarTodas: 'tareas.editar_todas',
  reunionesVer: 'reuniones.ver',
  reunionesGestionar: 'reuniones.gestionar',
  reunionesVerDireccion: 'reuniones.ver_direccion',
  reunionesBorrarAudio: 'reuniones.borrar_audio',
  presupuestoVer: 'proyectos.presupuesto_ver',
  comprasAprobar: 'proyectos.compras_aprobar',
  plantillas: 'proyectos.plantillas',
  cuadroMando: 'proyectos.cuadro_mando',
  // Maestro de departamentos: la lectura solo pide sesión, solo la escritura tiene código.
  departamentosEditar: 'departamentos.editar',
} as const;

export type CodigoPermisoTasks = (typeof PERMISOS)[keyof typeof PERMISOS];

// ─── Permisos de fila ───

/*
 * Qué puede hacer con **esa** fila quien la ha pedido. Lo resuelve el servidor
 * con las mismas funciones que después autorizan la escritura
 * (`api/lib/tasks/acceso.js`), y es lo único que la interfaz debe mirar para
 * habilitar acciones de fila: no se reimplementan las reglas en el cliente.
 *
 * Viaja en listados, fichas y respuestas de escritura. Si faltara, la interfaz
 * deniega: el valor por defecto de todo el módulo es no poder.
 */

/** En proyecto, `borrar` autoriza también la cascada de sus tareas. */
export type PermisosFilaProyecto = {
  editar: boolean;
  borrar: boolean;
};

/** `borrar` puede ser `true` y acabar en `409` si la tarea tiene subtareas abiertas. */
export type PermisosFilaTarea = {
  editar: boolean;
  reasignar: boolean;
  borrar: boolean;
  /**
   * Colgar una subtarea decide sobre el **proyecto**, no sobre la tarea madre, así
   * que no coincide con `editar`: se es responsable de una tarea dentro de un
   * proyecto del que no se es miembro, y entonces se puede cerrar esa tarea pero no
   * añadir trabajo al proyecto.
   */
  crear_subtarea: boolean;
};

/**
 * Qué se puede hacer con **esa** reunión. Si el backend aún no lo manda, la UI
 * oculta escrituras con `reuniones.gestionar` (ver pantallas de reuniones).
 */
export type PermisosFilaReunion = {
  editar: boolean;
  borrar: boolean;
};

// ─── Límites ───

/** Por encima de esto, son subtareas y no elementos de lista. */
export const MAX_CHECKLIST = 50;
/** Tope de tareas por llamada a la creación en lote. */
export const MAX_TAREAS_LOTE = 50;
/** Orden de las tareas sin fecha límite: al final, no al principio. */
export const FECHA_SIN_LIMITE = '9999-12-31';

// ─── Proyectos ───

export type Proyecto = {
  id_proyecto: string;
  nombre: string;
  descripcion?: string;
  estado: EstadoProyecto;
  departamento_id?: string;
  responsable_id?: string;
  fecha_inicio?: string;
  fecha_fin_prevista?: string;
  fecha_cierre?: string;
  empresa_id?: string;
  prioridad?: Prioridad;
  /** Solo visible con `proyectos.presupuesto_ver`. */
  presupuesto_asignado?: number;
  plantilla_origen_id?: string;
  creado_por?: string;
  creado_en?: string;
  actualizado_en?: string;
  /**
   * Nombre visible del responsable, resuelto por el servidor. `null` si no hay
   * responsable o si el usuario ya no existe. La interfaz **nunca** pinta
   * `responsable_id`: sin este campo tendría que cruzarlo contra
   * `/api/usuarios`, que exige un permiso distinto al de abrir la pantalla.
   */
  responsable_nombre?: string | null;
  permisos_fila?: PermisosFilaProyecto;
};

/** Proyecto con lo que cuelga de su partición, tal como lo devuelve el detalle. */
export type ProyectoDetalle = Proyecto & {
  miembros: ProyectoMiembro[];
  compras: LineaCompra[];
  vinculos: Vinculo[];
  /** Calculados al leer sumando las líneas: nunca persistidos. */
  gasto_comprometido: number;
  gasto_real: number;
};

export type ProyectoMiembro = {
  usuario_id: string;
  rol_proyecto: RolProyecto;
  añadido_por?: string;
  añadido_en?: string;
  /** Igual que `responsable_nombre`, sobre `usuario_id`. */
  usuario_nombre?: string | null;
};

export type LineaCompra = {
  id_linea: string;
  concepto: string;
  cantidad: number;
  enlace_url?: string;
  proveedor_ref?: Vinculo;
  precio_unitario_estimado?: number;
  precio_total_estimado?: number;
  precio_real?: number;
  solicitante_id: string;
  compra_estado: EstadoLineaCompra;
  fecha_necesaria?: string;
  /** Se fija al crear la línea y no se recalcula si cambian los umbrales. */
  nivel_aprobacion_requerido: NivelAprobacion;
  aprobado_por?: string;
  aprobado_en?: string;
  rechazo_motivo?: string;
  /** Reservado para el enganche futuro con conciliación bancaria. */
  movimiento_bancario_id?: string;
  notas?: string;
};

// ─── Tareas ───

export type ChecklistItem = {
  id: string;
  texto: string;
  hecho: boolean;
  hecho_por?: string;
  hecho_en?: string;
  orden: number;
};

/**
 * Enlace externo con captura. Los datos capturados son una **foto del momento y
 * no se refrescan**: si el destino cambia de precio o desaparece, debe seguir
 * constando qué se pidió y por cuánto.
 */
export type EnlaceTarea = {
  id_enlace: string;
  url: string;
  url_host?: string;
  captura_estado: EstadoCaptura;
  titulo?: string;
  precio?: number;
  moneda?: string;
  /** La imagen se descarga y se guarda en S3, no se enlaza la del destino. */
  imagen_s3_key?: string;
  capturado_en?: string;
  captura_error?: string;
  añadido_por?: string;
  añadido_en?: string;
};

export type ComentarioTarea = {
  id_comentario: string;
  texto: string;
  autor_id: string;
  autor_nombre?: string;
  menciones?: string[];
  creado_en: string;
};

export type AdjuntoTarea = {
  id_adjunto: string;
  nombre: string;
  s3_key: string;
  content_type?: string;
  tamano?: number;
  subido_por?: string;
  subido_en?: string;
};

export type Tarea = {
  id_tarea: string;
  titulo: string;
  descripcion?: string;
  estado: EstadoTarea;
  /** **Uno solo.** No existe lista de responsables. */
  responsable_id?: string;
  proyecto_id?: string;
  departamento_id?: string;
  fecha_limite?: string;
  prioridad?: Prioridad;
  checklist?: ChecklistItem[];
  tarea_padre_id?: string;
  menciones?: string[];
  bloqueo_motivo?: string;
  reunion_origen_id?: string;
  propuesta_origen_id?: string;
  /** Cita literal que justificó la tarea. Se conserva aunque se edite. */
  cita_origen?: string;
  cerrada_en?: string;
  creado_por?: string;
  creado_en?: string;
  actualizado_en?: string;
  /** Igual que en proyecto: nombre ya resuelto, `null` si el usuario no existe. */
  responsable_nombre?: string | null;
  /**
   * Nombre del proyecto de la tarea. Viene **ausente** —no a `null`— cuando la
   * tarea no tiene proyecto, igual que `proyecto_id`; vale `null` si ese
   * proyecto ya no se puede leer.
   */
  proyecto_nombre?: string | null;
  permisos_fila?: PermisosFilaTarea;
};

export type TareaDetalle = Tarea & {
  enlaces: EnlaceTarea[];
  adjuntos: AdjuntoTarea[];
  vinculos: Vinculo[];
};

/** Cuerpo de `POST /api/tareas/lote`, el único camino de creación masiva. */
export type TareaLoteEntrada = {
  titulo: string;
  descripcion?: string;
  responsable_id: string;
  fecha_limite?: string;
  prioridad?: Prioridad;
  checklist?: Pick<ChecklistItem, 'texto' | 'orden'>[];
  propuesta_origen_id?: string;
  cita_origen?: string;
};

// ─── Reuniones ───

export type Reunion = {
  id_reunion: string;
  titulo: string;
  fecha: string;
  hora_inicio?: string;
  hora_fin?: string;
  estado: EstadoReunion;
  visibilidad: VisibilidadReunion;
  usuarios_autorizados?: string[];
  departamento_id?: string;
  local_id?: string;
  /** Nombre del local, guardado al convocar: `Locales` del usuario son nombres. */
  local_nombre?: string;
  empresa_id?: string;
  proyecto_id?: string;
  serie_id?: string;
  convocada_por?: string;
  orden_del_dia?: string;
  /** Copia al arrancar la grabación. La cobertura se mide contra esta, no contra la editable. */
  orden_del_dia_congelado?: string;
  orden_del_dia_congelado_en?: string;
  calendar_id?: string;
  calendar_event_id?: string;
  sala_recurso_email?: string;
  modalidad?: ModalidadReunion;
  meet_code?: string;
  conference_record_id?: string;
  drive_file_id?: string;
  origen_audio?: OrigenAudio;
  audio_estado?: EstadoAudio;
  audio_s3_key?: string;
  audio_borrado_en?: string;
  duracion_seg?: number;
  aviso_grabacion?: AvisoGrabacion;
  pipeline_estado?: EstadoPipeline;
  pipeline_desde?: string;
  pipeline_error?: string;
  pipeline_error_fase?: FasePipeline;
  intentos?: number;
  transcripcion_proveedor?: string;
  transcripcion_job_id?: string;
  /** La transcripción vive en S3, no en el ítem. */
  transcripcion_s3_key?: string;
  transcripcion_hash?: string;
  resumen?: string;
  vocabulario_esperado?: string[];
  acta_pdf_s3_key?: string;
  coste_ia?: CosteIa;
  creado_en?: string;
  actualizado_en?: string;
  permisos_fila?: PermisosFilaReunion;
};

/** Sin aceptación registrada no se emite URL de subida de audio. */
export type AvisoGrabacion = {
  informados: string[];
  aceptado_por?: string;
  aceptado_en?: string;
};

export type CosteIa = {
  transcripcion_usd?: number;
  resumen_usd?: number;
  tokens_entrada?: number;
  tokens_salida?: number;
};

export type AsistenteReunion = {
  usuario_id?: string;
  nombre: string;
  asistio?: boolean;
  es_externo?: boolean;
  email?: string;
  rol_en_reunion?: string;
};

export type PuntoOrdenDia = {
  orden: number;
  texto_punto: string;
  origen: OrigenPunto;
  cobertura: CoberturaPunto;
  cita?: string;
  aplazado?: boolean;
  candidato_siguiente?: boolean;
};

export type AcuerdoReunion = {
  id_acuerdo: string;
  texto: string;
  cita?: string;
  responsable_id?: string;
  fecha_limite?: string;
  estado: EstadoAcuerdo;
  tarea_id?: string;
  validado_por?: string;
  validado_en?: string;
};

/**
 * Propuesta de la IA pendiente de validación humana. **La cita es obligatoria**:
 * sin fragmento que la respalde, no se muestra.
 */
export type PropuestaReunion = {
  id_propuesta: string;
  tipo: TipoPropuesta;
  titulo: string;
  descripcion?: string;
  cita: string;
  responsable_sugerido_id?: string;
  fecha_limite_sugerida?: string;
  confianza?: number;
  propuesta_estado: EstadoPropuesta;
  resuelta_por?: string;
  resuelta_en?: string;
  tarea_id?: string;
  creado_en?: string;
};

export type ReunionDetalle = Reunion & {
  asistentes: AsistenteReunion[];
  acuerdos: AcuerdoReunion[];
  puntos: PuntoOrdenDia[];
  vinculos: Vinculo[];
};

// ─── Actividad y avisos ───

export type EntradaActividad = {
  accion: string;
  usuario_id: string;
  usuario_nombre?: string;
  /** JSON serializado con el antes y el después. */
  detalle?: string;
  /** Obligatorio en acciones de compra. */
  importe?: number;
  creado_en: string;
};

export type Notificacion = {
  id_notificacion: string;
  tipo: TipoNotificacion;
  titulo: string;
  cuerpo?: string;
  entidad_ref?: Vinculo;
  leida: boolean;
  leida_en?: string;
  creado_en: string;
};

// ─── Configuración ───

export type Departamento = {
  id: string;
  nombre: string;
  responsable_id?: string;
  /**
   * Nombre del responsable, resuelto por el backend al listar. Es `null` si el
   * usuario ya no existe. Se devuelve para que la pantalla no dependa de
   * `usuarios.ver` solo para no pintar un ID crudo en la tabla.
   */
  responsable_nombre?: string | null;
  activo: boolean;
  orden?: number;
};

/** Viven en configuración, nunca en el código. */
export type UmbralesCompra = {
  umbral_responsable: number;
  umbral_departamento: number;
  moneda: string;
};

// ─── Respuestas paginadas ───

export type PaginaApi<T> = {
  items: T[];
  /** `null` cuando no hay más páginas. Opaco: nunca un número de página. */
  cursor: string | null;
};
