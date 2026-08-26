/**
 * Espejo en backend de los tipos del módulo de dirección.
 *
 * El frontend es TypeScript y este lado JavaScript sin compilación, así que no
 * se puede compartir el tipo literal. La fuente normativa es
 * `app/types/tasks.ts`; aquí viven **las constantes que el backend valida de
 * verdad** más los `@typedef` equivalentes. Si los dos ficheros divergen, manda
 * `docs/tasks/02-modelo-datos.md`.
 *
 * Este fichero lo toca **solo el agente integrador**. El resto lo consume.
 *
 * Los literales de estado se declaran aquí una sola vez: nada de `'pendiente'`
 * suelto repartido por los handlers, porque es como se acaba con dos estados
 * escritos distinto que nadie detecta hasta que un filtro devuelve vacío.
 */

// ─── Estados y enumeraciones ───

export const ESTADOS_PROYECTO = ['borrador', 'activo', 'en_pausa', 'cerrado', 'cancelado'];
export const ESTADOS_TAREA = ['pendiente', 'en_curso', 'bloqueada', 'hecha', 'cancelada'];
export const ESTADOS_TAREA_TERMINALES = ['hecha', 'cancelada'];
export const PRIORIDADES = ['baja', 'media', 'alta'];

/**
 * Los valores que se comparan dentro de una decisión de acceso van con nombre,
 * no como literal suelto: una errata en `'observador'` no da error, cambia quién
 * puede editar. Las listas se derivan del mapa para no escribirlos dos veces.
 */
export const ROL_PROYECTO = Object.freeze({
  responsable: 'responsable',
  miembro: 'miembro',
  observador: 'observador',
});
export const ROLES_PROYECTO = Object.freeze(Object.values(ROL_PROYECTO));

export const ESTADO_LINEA_COMPRA = Object.freeze({
  propuesta: 'propuesta',
  aprobada: 'aprobada',
  rechazada: 'rechazada',
  pedida: 'pedida',
  recibida: 'recibida',
});
export const ESTADOS_LINEA_COMPRA = Object.freeze(Object.values(ESTADO_LINEA_COMPRA));

/** El orden de declaración **es** la jerarquía: de menor a mayor autoridad. */
export const NIVEL_APROBACION = Object.freeze({
  responsableProyecto: 'responsable_proyecto',
  responsableDepartamento: 'responsable_departamento',
  direccion: 'direccion',
});
export const NIVELES_APROBACION = Object.freeze(Object.values(NIVEL_APROBACION));

export const ESTADOS_REUNION = [
  'borrador',
  'convocada',
  'celebrada',
  'acta_borrador',
  'acta_validada',
  'cancelada',
];
export const ESTADOS_PIPELINE = ['audio_pendiente', 'transcribiendo', 'transcrita', 'resumiendo', 'error'];
export const FASES_PIPELINE = ['captura', 'transcripcion', 'resumen'];

export const VISIBILIDAD_REUNION = Object.freeze({
  direccion: 'direccion',
  empresa: 'empresa',
  departamento: 'departamento',
  local: 'local',
  restringida: 'restringida',
});
export const VISIBILIDADES_REUNION = Object.freeze(Object.values(VISIBILIDAD_REUNION));
export const ORIGENES_AUDIO = ['meet', 'subida', 'grabacion_app'];
export const ESTADOS_AUDIO = ['ausente', 'presente', 'borrado'];
export const MODALIDADES_REUNION = ['presencial', 'remota', 'mixta'];
export const COBERTURAS_PUNTO = ['tratado', 'parcial', 'no_tratado'];
export const ORIGENES_PUNTO = ['previsto', 'emergente'];
export const ESTADOS_ACUERDO = ['abierto', 'cumplido', 'incumplido'];
export const TIPOS_PROPUESTA = ['tarea', 'acuerdo'];
export const ESTADOS_PROPUESTA = ['pendiente', 'aceptada', 'rechazada', 'editada_y_aceptada'];
export const ESTADOS_CAPTURA = ['pendiente', 'ok', 'fallida'];
export const TIPOS_NOTIFICACION = ['mencion', 'asignacion', 'vencimiento', 'compra_pendiente', 'acta_lista'];

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
];

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
};

/** Rol con cortocircuito global, igual que en el resto del ERP. */
export const ROL_ADMINISTRADOR = 'Administrador';

// ─── Límites ───

export const MAX_CHECKLIST = 50;
export const MAX_TAREAS_LOTE = 50;
/** Las tareas sin fecha límite ordenan al final, no al principio. */
export const FECHA_SIN_LIMITE = '9999-12-31';

// ─── Prefijos de clave ───

export const PK = {
  proyecto: (id) => `PROY#${id}`,
  plantilla: (id) => `PLANTILLA#${id}`,
  tarea: (id) => `TAREA#${id}`,
  reunion: (id) => `REU#${id}`,
  usuario: (id) => `USER#${id}`,
};

export const SK = {
  meta: 'META',
  miembro: (idUsuario) => `MIEMBRO#${idUsuario}`,
  compra: (idLinea) => `COMPRA#${idLinea}`,
  enlace: (idEnlace) => `ENLACE#${idEnlace}`,
  adjunto: (idAdjunto) => `ADJUNTO#${idAdjunto}`,
  comentario: (iso, uuid) => `COMENT#${iso}#${uuid}`,
  asistente: (idUsuario) => `ASIST#${idUsuario}`,
  punto: (orden) => `PUNTO#${String(orden).padStart(3, '0')}`,
  acuerdo: (idAcuerdo) => `ACUERDO#${idAcuerdo}`,
  propuesta: (idPropuesta) => `PROPUESTA#${idPropuesta}`,
  vinculo: (tipo, id) => `VINC#${tipo}#${id}`,
  actividad: (iso, uuid) => `ACT#${iso}#${uuid}`,
  notificacion: (iso, uuid) => `NOTIF#${iso}#${uuid}`,
};

/** Valor constante de la partición del índice de listado (ver 02-modelo-datos). */
export const GSI_LISTADO = {
  proyecto: 'PROY',
  plantilla: 'PLANTILLA',
  reunion: 'REU',
};

// ─── Validación ───

/** `true` si el valor está en la lista de admitidos. Vacío o ausente = inválido. */
export function enLista(lista, valor) {
  return typeof valor === 'string' && lista.includes(valor);
}

/**
 * Número finito, o `null` si el valor no lo es. No usa `Number()` a pelo porque
 * convierte `null`, `''` y `[]` en `0`, y aquí un umbral ausente y un umbral a
 * cero llevan a decisiones opuestas.
 */
export function aNumeroFinito(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim() !== '') {
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function esEstadoTareaTerminal(estado) {
  return ESTADOS_TAREA_TERMINALES.includes(estado);
}

/**
 * Transiciones admitidas del estado de una tarea.
 *
 * Reabrir una tarea cerrada está permitido (a `pendiente`), porque en la
 * práctica se cierran cosas por error y prohibirlo obliga a duplicar la tarea,
 * que es peor: se pierde el historial.
 */
export const TRANSICIONES_TAREA = {
  pendiente: ['en_curso', 'bloqueada', 'hecha', 'cancelada'],
  en_curso: ['pendiente', 'bloqueada', 'hecha', 'cancelada'],
  bloqueada: ['pendiente', 'en_curso', 'cancelada'],
  hecha: ['pendiente'],
  cancelada: ['pendiente'],
};

export function transicionTareaPermitida(desde, hasta) {
  if (!enLista(ESTADOS_TAREA, desde) || !enLista(ESTADOS_TAREA, hasta)) return false;
  if (desde === hasta) return true;
  return (TRANSICIONES_TAREA[desde] || []).includes(hasta);
}

// ─── Claves derivadas ───

/**
 * Atributo de orden del índice `Responsable-Vencimiento-index`.
 *
 * Devuelve `null` cuando la tarea **no debe estar en el índice**: sin
 * responsable, o ya cerrada. El escritor debe hacer `REMOVE` del atributo en
 * ese caso, y de ahí que el índice contenga solo tareas abiertas y la vista
 * personal no necesite filtrar nada.
 */
export function vencimientoOrdenDe(tarea) {
  if (!tarea?.responsable_id) return null;
  if (esEstadoTareaTerminal(tarea.estado)) return null;
  const fecha = tarea.fecha_limite || FECHA_SIN_LIMITE;
  return `${fecha}#${tarea.id_tarea}`;
}

/**
 * Atributo de orden del índice `Proyecto-index`: agrupa abiertas antes que
 * cerradas y, dentro de cada grupo, ordena por fecha límite.
 */
export function skProyectoDe(tarea) {
  if (!tarea?.proyecto_id) return null;
  const grupo = esEstadoTareaTerminal(tarea.estado) ? 'cerrada' : 'abierta';
  const fecha = tarea.fecha_limite || FECHA_SIN_LIMITE;
  return `${grupo}#${fecha}#${tarea.id_tarea}`;
}

/** Partición del `Vinculo-index`. */
export function claveVinculo(tipo, id) {
  return `${tipo}#${id}`;
}

/**
 * Nivel de aprobación que exige un importe, según los umbrales de
 * configuración. Se calcula **al crear la línea** y se guarda: cambiar los
 * umbrales después no debe reabrir aprobaciones ya hechas ni saltarse las
 * pendientes.
 *
 * Si los umbrales no están configurados —o vienen a medias, o el importe no es
 * un número— devuelve el nivel más alto. Es el único lado seguro: con la
 * alternativa, una línea de 40.000 € nacería aprobable por el responsable del
 * proyecto y el nivel se congela, así que configurar los umbrales después ya no
 * la arreglaría.
 */
export function nivelRequeridoParaImporte(importe, umbrales) {
  const total = aNumeroFinito(importe);
  const primero = aNumeroFinito(umbrales?.umbral_responsable);
  const segundo = aNumeroFinito(umbrales?.umbral_departamento);
  if (total == null || primero == null || segundo == null) return NIVEL_APROBACION.direccion;
  // Umbrales al revés: configuración incoherente, no se adivina la intención.
  if (primero > segundo) return NIVEL_APROBACION.direccion;
  if (total >= segundo) return NIVEL_APROBACION.direccion;
  if (total >= primero) return NIVEL_APROBACION.responsableDepartamento;
  return NIVEL_APROBACION.responsableProyecto;
}

/** Posición del nivel en la jerarquía; `-1` si no es un nivel conocido. */
export function ordenNivelAprobacion(nivel) {
  return NIVELES_APROBACION.indexOf(nivel);
}

// ─── Typedefs (espejo de app/types/tasks.ts) ───

/**
 * @typedef {'borrador'|'activo'|'en_pausa'|'cerrado'|'cancelado'} EstadoProyecto
 * @typedef {'pendiente'|'en_curso'|'bloqueada'|'hecha'|'cancelada'} EstadoTarea
 * @typedef {'baja'|'media'|'alta'} Prioridad
 * @typedef {'responsable'|'miembro'|'observador'} RolProyecto
 * @typedef {'propuesta'|'aprobada'|'rechazada'|'pedida'|'recibida'} EstadoLineaCompra
 * @typedef {'responsable_proyecto'|'responsable_departamento'|'direccion'} NivelAprobacion
 * @typedef {'direccion'|'empresa'|'departamento'|'local'|'restringida'} VisibilidadReunion
 * @typedef {'audio_pendiente'|'transcribiendo'|'transcrita'|'resumiendo'|'error'} EstadoPipeline
 */

/**
 * @typedef {object} Vinculo
 * @property {string} tipo
 * @property {string} id
 * @property {string} [etiqueta] Nombre en el momento de vincular.
 */

/**
 * @typedef {object} Proyecto
 * @property {string} id_proyecto
 * @property {string} nombre
 * @property {EstadoProyecto} estado
 * @property {string} [departamento_id]
 * @property {string} [responsable_id]
 * @property {number} [presupuesto_asignado]
 */

/**
 * @typedef {object} ProyectoMiembro
 * @property {string} usuario_id
 * @property {RolProyecto} rol_proyecto
 */

/**
 * @typedef {object} Tarea
 * @property {string} id_tarea
 * @property {string} titulo
 * @property {EstadoTarea} estado
 * @property {string} [responsable_id] Uno solo; no hay lista de responsables.
 * @property {string} [proyecto_id]
 * @property {string} [departamento_id]
 * @property {string} [fecha_limite]
 * @property {string[]} [menciones]
 * @property {string} [creado_por]
 */

/**
 * @typedef {object} Reunion
 * @property {string} id_reunion
 * @property {string} titulo
 * @property {string} fecha
 * @property {VisibilidadReunion} visibilidad
 * @property {string[]} [usuarios_autorizados]
 * @property {string} [departamento_id]
 * @property {string} [local_id]
 * @property {string} [local_nombre]
 * @property {string} [convocada_por]
 */

/**
 * @typedef {object} AsistenteReunion
 * @property {string} [usuario_id]
 * @property {string} nombre
 * @property {boolean} [asistio]
 */

/**
 * @typedef {object} LineaCompra
 * @property {string} id_linea
 * @property {string} solicitante_id
 * @property {EstadoLineaCompra} compra_estado
 * @property {NivelAprobacion} nivel_aprobacion_requerido
 */

/**
 * @typedef {object} UmbralesCompra
 * @property {number} umbral_responsable
 * @property {number} umbral_departamento
 * @property {string} [moneda]
 */
