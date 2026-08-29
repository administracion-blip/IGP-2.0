/**
 * Tareas del módulo de dirección: escritura, listados y claves derivadas.
 *
 * Vive aparte del router porque `api/routes/tareas.js` solo traduce a HTTP, igual
 * que en el maestro de departamentos. Las decisiones de acceso no se toman aquí:
 * se delegan en `api/lib/tasks/acceso.js` pasándole el proyecto de la tarea, que
 * es el dato sin el cual esa capa deniega.
 *
 * Tres cosas que conviene tener presentes al leer el fichero:
 *
 * 1. **Las dos claves derivadas se mantienen en cada escritura.**
 *    `vencimiento_orden` y `sk_proyecto` salen de `vencimientoOrdenDe` y
 *    `skProyectoDe`, y cuando devuelven `null` el atributo se **borra**
 *    (`REMOVE`), no se escribe vacío. De eso depende que
 *    `Responsable-Vencimiento-index` contenga solo tareas abiertas y que la vista
 *    personal no tenga que filtrar nada. Una tarea cerrada que se queda en el
 *    índice es el error más fácil de cometer aquí.
 * 2. **Ni un `Scan`.** Todo por clave primaria o por índice, y paginado. Por eso
 *    el listado general exige filtrar por proyecto o por persona: no hay índice
 *    que devuelva «todas las tareas» (ver `docs/tasks/02-modelo-datos.md`).
 * 3. **Filtrar un listado no lee una partición por tarea.** Se resuelven los
 *    proyectos de la página con una sola llamada a `leerProyectosParaAcceso` y se
 *    decide con `puedeVerTarea` sobre ese dato. Ese mismo mapa alimenta después
 *    `proyecto_nombre` y `permisos_fila`, así que no se vuelve a leer.
 * 4. **Toda tarea sale con `responsable_nombre` y `permisos_fila`.** Los nombres
 *    se resuelven en lote y los permisos los calcula `acceso.js`: la interfaz no
 *    cruza ids contra `/api/usuarios` ni lleva su propia copia de las reglas de
 *    acceso, que es lo que acaba escondiendo botones a quien sí puede pulsarlos.
 *
 * La jornada de negocio (corte de 09:30) **no aplica** a este módulo: las tareas
 * van por fecha natural.
 */

import crypto from 'crypto';
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  ESTADOS_TAREA,
  MAX_CHECKLIST,
  MAX_TAREAS_LOTE,
  PERMISOS,
  PK,
  PRIORIDADES,
  SK,
  enLista,
  esEstadoTareaTerminal,
  skProyectoDe,
  transicionTareaPermitida,
  vencimientoOrdenDe,
} from './tipos.js';
import {
  filtrarVisibles,
  puedeEditarProyecto,
  puedeEditarTarea,
  puedeReasignarTarea,
  puedeVerProyecto,
  puedeVerTarea,
  tienePermiso,
} from './acceso.js';
import { leerProyectoConMiembros, leerProyectosParaAcceso } from './proyectoLectura.js';
import { nombreDe, nombresDeUsuarios } from './proyectos.js';
import {
  ACCIONES,
  listarActividad,
  registrarActividad,
  registrarActividadLote,
} from './actividad.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';
import { crearNotificacion } from './notificaciones.js';
import { logger } from '../logger.js';
// Las salidas a S3 se importan de donde ya viven, para que borrar una tarea use
// el mismo camino que borrar un enlace o un adjunto sueltos. La dependencia es
// circular —los dos ficheros importan el acceso de aquí— pero solo se resuelve al
// llamar, nunca al cargar el módulo.
import { almacenAdjuntos } from './adjuntos.js';
import { transporteEnlaces } from './enlaces.js';

export const IDX_RESPONSABLE = 'Responsable-Vencimiento-index';
export const IDX_PROYECTO = 'Proyecto-index';
export const IDX_PADRE = 'Padre-index';
export const IDX_REUNION = 'Reunion-index';

/** Estado con el que nace una tarea si no se indica otro. */
const ESTADO_INICIAL = 'pendiente';
const PRIORIDAD_POR_DEFECTO = 'media';

/** Límites de `BatchWriteItem`. */
const MAX_LOTE_ESCRITURA = 25;
const MAX_INTENTOS_LOTE = 3;

/**
 * Resultado uniforme de todas las operaciones, para que el router solo traduzca a
 * HTTP y no decida nada.
 *
 * @typedef {{ ok: false, status: number, error: string, fallos?: object[] }} Fallo
 */

// ─── Normalización ───

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function vacio(valor) {
  if (valor == null) return true;
  if (typeof valor === 'string') return valor.trim() === '';
  if (Array.isArray(valor)) return valor.length === 0;
  return false;
}

function listaDeTexto(valor) {
  const bruto = Array.isArray(valor) ? valor : [valor];
  const vistos = new Set();
  for (const v of bruto) {
    const t = texto(v);
    if (t) vistos.add(t);
  }
  return [...vistos];
}

function aOrden(valor, porDefecto = 0) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
}

/**
 * `hecho` llega por HTTP y puede venir como texto. La cadena vacía cuenta como
 * falso: es el campo sin rellenar de un formulario, y darla por buena marcaría
 * un elemento que nadie ha marcado.
 */
function aBooleano(valor) {
  if (typeof valor === 'boolean') return valor;
  if (valor == null) return false;
  const t = String(valor).trim().toLowerCase();
  return !(t === '' || t === 'false' || t === '0');
}

function ahora() {
  return new Date().toISOString();
}

const PARTES_DIA_MADRID = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Día natural en Madrid (`YYYY-MM-DD`). Es la fecha con la que se decide si una
 * tarea está vencida: en este módulo **no** se aplica la jornada de negocio, así
 * que una tarea que vence hoy no está vencida hasta mañana.
 */
export function fechaHoyMadrid() {
  const partes = {};
  for (const p of PARTES_DIA_MADRID.formatToParts(new Date())) {
    if (p.type !== 'literal') partes[p.type] = p.value;
  }
  return `${partes.year}-${partes.month}-${partes.day}`;
}

/** Fecha sola (`YYYY-MM-DD`) que además existe en el calendario. */
function esFechaIso(valor) {
  const t = texto(valor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(`${t}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}

/**
 * Forma pública de una tarea. Las claves de DynamoDB y los dos atributos de orden
 * de los índices no salen: son mecánica interna y `app/types/tasks.ts` no los
 * declara.
 */
function salida(item) {
  if (!item) return null;
  const {
    PK: _pk,
    SK: _sk,
    vencimiento_orden: _vencimiento,
    sk_proyecto: _skProyecto,
    ...resto
  } = item;
  return {
    ...resto,
    checklist: Array.isArray(resto.checklist) ? resto.checklist : [],
    menciones: Array.isArray(resto.menciones) ? resto.menciones : [],
  };
}

/**
 * Forma pública de una fila hija (enlace, adjunto, comentario, vínculo). La
 * usan también `enlaces.js` y `adjuntos.js`, para que un enlace tenga la misma
 * forma salga del detalle de la tarea o de su propio endpoint.
 */
export function salidaFilaHija(item) {
  if (!item) return null;
  const { PK: _pk, SK: _sk, vinculo_clave: _clave, ...resto } = item;
  return resto;
}

// ─── Nombres y permisos de fila ───

/**
 * Qué puede hacer quien pregunta con **esta** tarea.
 *
 * Sale de `acceso.js` sin reimplementar ni una regla, y por eso existe: dos
 * copias de la misma decisión —una aquí y otra en la interfaz— divergen, y el
 * síntoma es un botón escondido a quien sí puede pulsarlo.
 *
 * `borrar` refleja el permiso global y la visibilidad, que es exactamente lo que
 * comprueba `borrarTarea`. **No** dice si el borrado acabará en `409` por tener
 * subtareas abiertas: eso exige contarlas y no merece una lectura por fila.
 *
 * @param {import('./acceso.js').ContextoTarea} [aux]
 */
function permisosFilaTarea(ctx, tarea, aux = {}) {
  return {
    editar: puedeEditarTarea(ctx, tarea, aux),
    reasignar: puedeReasignarTarea(ctx, tarea, aux),
    borrar: tienePermiso(ctx, PERMISOS.proyectosBorrar) && puedeVerTarea(ctx, tarea, aux),
    crear_subtarea: puedeCrearSubtarea(ctx, tarea, aux),
  };
}

/**
 * ¿Puede colgar una subtarea de esta? Crear decide sobre el **proyecto**, no sobre
 * la tarea madre, así que `editar` no sirve de respuesta: se es responsable de una
 * tarea dentro de un proyecto del que no se es miembro, y entonces se puede cerrar
 * esa tarea pero no añadir trabajo al proyecto.
 *
 * Va aquí, y no deducido en la pantalla, porque es la misma condición que aplica
 * `proyectoParaCrear` al autorizar `POST /api/tareas`. Cuando la interfaz la
 * calculaba por su cuenta ofrecía un botón que el servidor rechazaba con un 403.
 */
function puedeCrearSubtarea(ctx, tarea, aux = {}) {
  if (!texto(tarea?.proyecto_id)) return tienePermiso(ctx, PERMISOS.proyectosEditar);
  if (!aux?.proyecto) return false;
  return (
    puedeEditarProyecto(ctx, aux.proyecto, aux.miembros) ||
    tienePermiso(ctx, PERMISOS.tareasEditarTodas)
  );
}

/**
 * Forma pública de una tarea con lo que hace falta para pintarla sin cruzar
 * nada: el nombre de la persona responsable, el del proyecto y lo que quien
 * pregunta puede hacer con la fila.
 *
 * `proyecto_nombre` solo viaja si la tarea tiene proyecto, igual que
 * `proyecto_id`; vale `null` si ese proyecto ya no se puede leer **o si quien
 * pregunta no lo alcanza**. Esa segunda condición no es cosmética: `aux.proyecto`
 * se lee para decidir el acceso a la *tarea*, y una tarea se ve por ser su
 * responsable o por estar mencionado sin ver el proyecto. Publicar el nombre sin
 * preguntar filtraba «Despido de J. P.» en la vista personal y en el correo
 * diario de quien, al pulsar, recibe un 404 correcto.
 *
 * `nombres` es el mapa que devuelve `nombresDeUsuarios`, resuelto una vez para
 * toda la página.
 *
 * @param {{ aux?: object, nombres?: Map<string, string|null> }} [opciones]
 */
function salidaConExtras(item, ctx, { aux = {}, nombres } = {}) {
  const conProyecto = texto(item?.proyecto_id) !== '';
  const proyectoVisible =
    Boolean(aux?.proyecto) && puedeVerProyecto(ctx, aux.proyecto, aux.miembros);
  return {
    ...salida(item),
    responsable_nombre: nombreDe(nombres, item?.responsable_id),
    ...(conProyecto && {
      proyecto_nombre: proyectoVisible ? texto(aux.proyecto.nombre) || null : null,
    }),
    permisos_fila: permisosFilaTarea(ctx, item, aux),
  };
}

/** Contexto de acceso de una tarea a partir de un mapa de proyectos ya leído. */
function auxDeMapa(proyectos, tarea) {
  const id = texto(tarea?.proyecto_id);
  return id ? proyectos.get(id) || {} : {};
}

// ─── Menciones ───

const RE_MENCION = /@([A-Za-z0-9._-]{2,})/g;

/**
 * Menciones de un texto, en `id_usuario`.
 *
 * Del texto solo se aceptan los tokens que **son un id** (`@000007`, el formato
 * que pinta `formatId6`); `@Nombre` es prosa. Estar mencionado da lectura de la
 * tarea, así que resolver nombres a ojo abriría la tarea a quien acertara la
 * búsqueda. Los ids que manda la interfaz en `menciones` sí se aceptan tal cual:
 * mencionar a alguien es un acto deliberado de quien ya puede editar la tarea.
 *
 * En Fase 1A **solo se guardan**: no se avisa a nadie (los avisos son Fase 3).
 */
export function extraerMenciones(textoLibre, explicitas) {
  const ids = new Set(listaDeTexto(explicitas));
  for (const [, token] of String(textoLibre || '').matchAll(RE_MENCION)) {
    if (/^\d{4,}$/.test(token)) ids.add(token);
  }
  return [...ids];
}

// ─── Lecturas de apoyo ───

/** Recorre todas las páginas de una Query. Las particiones del módulo son pequeñas. */
async function consultarTodo(entrada) {
  const items = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({ ...entrada, ...(desde && { ExclusiveStartKey: desde }) }),
    );
    items.push(...(res.Items || []));
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  return items;
}

async function leerMeta(idTarea) {
  const id = texto(idTarea);
  if (!id) return null;
  const res = await docClient.send(
    new GetCommand({ TableName: tables.tareas, Key: { PK: PK.tarea(id), SK: SK.meta } }),
  );
  return res.Item || null;
}

/**
 * Contexto que `acceso.js` necesita para decidir sobre una tarea: su proyecto y
 * los miembros de ese proyecto. Sin él, una tarea con `proyecto_id` se deniega.
 */
async function auxDeTarea(tarea) {
  const idProyecto = texto(tarea?.proyecto_id);
  if (!idProyecto) return {};
  return (await leerProyectoConMiembros(idProyecto)) || {};
}

/**
 * Autor de una escritura, con su nombre visible, para que el historial y los
 * comentarios no muestren ids crudos a quien no tenga `usuarios.ver`.
 *
 * Sale del contexto de acceso, que ya ha leído la ficha del usuario para resolver
 * rol y permisos. Resolverlo aquí con un `GetItem` propio sería una lectura de más
 * en cada escritura, y la caché del contexto la absorbe.
 */
function autorDe(ctx) {
  return { id_usuario: texto(ctx?.idUsuario), Nombre: texto(ctx?.nombre) };
}

/**
 * Aviso de asignación al nuevo responsable (si no es quien actúa).
 * Los fallos de notificación no tumban la operación de la tarea.
 */
async function notificarAsignacion({ destinatarioId, actorId, tarea }) {
  const dest = texto(destinatarioId);
  const actor = texto(actorId);
  if (!dest || dest === actor) return;
  const tituloTarea = texto(tarea?.titulo) || 'Tarea';
  try {
    await crearNotificacion({
      usuarioId: dest,
      tipo: 'asignacion',
      titulo: `Te han asignado: ${tituloTarea}`,
      cuerpo: actor ? `Asignada por ${texto(tarea?.asignada_por_nombre) || 'un compañero'}` : '',
      entidad_ref: {
        tipo: 'tarea',
        id: texto(tarea?.id_tarea),
        etiqueta: tituloTarea,
      },
    });
  } catch (err) {
    logger.warn({ err, destinatarioId: dest }, '[tareas] No se pudo crear la notificación de asignación');
  }
}

/**
 * Avisos de mención en un comentario (cada mencionado salvo el autor).
 */
async function notificarMenciones({ mencionados, autorId, autorNombre, tarea }) {
  const autor = texto(autorId);
  const tituloTarea = texto(tarea?.titulo) || 'Tarea';
  const idTarea = texto(tarea?.id_tarea);
  for (const raw of mencionados || []) {
    const dest = texto(raw);
    if (!dest || dest === autor) continue;
    try {
      await crearNotificacion({
        usuarioId: dest,
        tipo: 'mencion',
        titulo: `${texto(autorNombre) || 'Alguien'} te ha mencionado`,
        cuerpo: tituloTarea,
        entidad_ref: {
          tipo: 'tarea',
          id: idTarea,
          etiqueta: tituloTarea,
        },
      });
    } catch (err) {
      logger.warn({ err, destinatarioId: dest }, '[tareas] No se pudo crear la notificación de mención');
    }
  }
}

/**
 * Una tarea visible, o el fallo que le corresponde. Nunca `403` al leer: `404`.
 *
 * Se exporta para que los enlaces y los adjuntos —que viven en la misma
 * partición pero en su propio fichero— decidan el acceso exactamente igual que
 * el resto de operaciones de la tarea, en lugar de reescribir la comprobación.
 */
export async function cargarParaVer(ctx, idTarea) {
  const meta = await leerMeta(idTarea);
  if (!meta) return { ok: false, status: 404, error: 'La tarea no existe' };
  const aux = await auxDeTarea(meta);
  // Un 403 aquí confirmaría que la tarea existe, y eso ya es información.
  if (!puedeVerTarea(ctx, meta, aux)) return { ok: false, status: 404, error: 'La tarea no existe' };
  return { ok: true, meta, aux };
}

/**
 * Una tarea sobre la que se puede escribir. `comprobacion` distingue editar de
 * reasignar, que es más estrecho: la reasigna quien manda en el proyecto, no
 * quien la tiene asignada.
 */
export async function cargarParaEscribir(ctx, idTarea, comprobacion = puedeEditarTarea, mensaje = 'No puedes editar esta tarea') {
  const r = await cargarParaVer(ctx, idTarea);
  if (!r.ok) return r;
  if (!comprobacion(ctx, r.meta, r.aux)) return { ok: false, status: 403, error: mensaje };
  return r;
}

/**
 * Proyecto en el que se va a crear una tarea, comprobando que quien la crea puede
 * añadirle contenido.
 *
 * `tareas.editar_todas` sirve también aquí: alcanza a las tareas de proyectos
 * ajenos, que es lo que dice su nombre. Lo que **no** hace es dejar editar el
 * proyecto ni gestionar sus miembros (D-13).
 *
 * **Sin proyecto no hay ACL de fila que decida**, así que la tarea suelta se
 * apoya en el permiso global. Es la comprobación que antes ponía
 * `requirePermission` en la ruta y que se quedaría sin nadie al quitarlo de ahí:
 * una tarea sin proyecto no la ve nadie más que su responsable y quien la crea,
 * pero crearla asigna trabajo a otra persona.
 */
async function proyectoParaCrear(ctx, idProyecto) {
  const id = texto(idProyecto);
  if (!id) {
    return tienePermiso(ctx, PERMISOS.proyectosEditar)
      ? { ok: true, aux: {} }
      : { ok: false, status: 403, error: 'No puedes crear tareas sin proyecto' };
  }
  const leido = await leerProyectoConMiembros(id);
  if (!leido || !puedeVerProyecto(ctx, leido.proyecto, leido.miembros)) {
    return { ok: false, status: 404, error: 'El proyecto no existe' };
  }
  if (
    !puedeEditarProyecto(ctx, leido.proyecto, leido.miembros) &&
    !tienePermiso(ctx, PERMISOS.tareasEditarTodas)
  ) {
    return { ok: false, status: 403, error: 'No puedes crear tareas en este proyecto' };
  }
  return { ok: true, aux: leido };
}

// ─── Escritura del ítem META ───

/**
 * Ítem `META` a partir de los campos de negocio. Los atributos vacíos **no se
 * escriben**: `proyecto_id`, `tarea_padre_id` y `reunion_origen_id` son claves de
 * partición de sus índices, y una cadena vacía ahí no es «sin valor», es un error
 * de validación de DynamoDB.
 */
function itemTarea(tarea) {
  const item = { PK: PK.tarea(tarea.id_tarea), SK: SK.meta };
  for (const [campo, valor] of Object.entries(tarea)) {
    if (!vacio(valor)) item[campo] = valor;
  }
  const vencimiento = vencimientoOrdenDe(tarea);
  if (vencimiento) item.vencimiento_orden = vencimiento;
  const skProyecto = skProyectoDe(tarea);
  if (skProyecto) item.sk_proyecto = skProyecto;
  return item;
}

/**
 * Aplica cambios sobre `META`. Un valor nulo o vacío se traduce en `REMOVE`, que
 * es lo que saca la tarea de un índice disperso; escribir cadena vacía la dejaría
 * dentro.
 *
 * Todos los nombres de atributo van con alias: `estado`, `orden` y compañía están
 * en la lista de palabras reservadas de DynamoDB según el caso, y comprobarlo una
 * a una es una fuente de sorpresas.
 *
 * Devuelve `null` si la tarea ya no está —la borraron entre la comprobación de
 * acceso y la escritura—, igual que `escribirEnlace`: quien llama lo traduce a
 * `404`, que es lo que la interfaz sabe tratar, y no a un `500`.
 */
async function escribirMeta(idTarea, cambios) {
  const nombres = { '#pk': 'PK' };
  const valores = {};
  const sets = [];
  const removes = [];
  let i = 0;
  for (const [campo, valor] of Object.entries(cambios)) {
    const alias = `#c${i}`;
    nombres[alias] = campo;
    if (vacio(valor)) {
      removes.push(alias);
    } else {
      sets.push(`${alias} = :v${i}`);
      valores[`:v${i}`] = valor;
    }
    i += 1;
  }
  const partes = [];
  if (sets.length) partes.push(`SET ${sets.join(', ')}`);
  if (removes.length) partes.push(`REMOVE ${removes.join(', ')}`);
  if (partes.length === 0) return null;

  try {
    const res = await docClient.send(
      new UpdateCommand({
        TableName: tables.tareas,
        Key: { PK: PK.tarea(idTarea), SK: SK.meta },
        UpdateExpression: partes.join(' '),
        ExpressionAttributeNames: nombres,
        // Si otra persona la ha borrado entre la lectura y la escritura, no se
        // resucita a medias.
        ConditionExpression: 'attribute_exists(#pk)',
        ...(Object.keys(valores).length > 0 && { ExpressionAttributeValues: valores }),
        ReturnValues: 'ALL_NEW',
      }),
    );
    return res.Attributes || null;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/** La tarea desapareció a mitad de la escritura: mismo `404` que al leerla. */
function tareaDesaparecida() {
  return { ok: false, status: 404, error: 'La tarea no existe' };
}

/**
 * Cambios de las dos claves derivadas para una tarea ya modificada. Se calculan
 * sobre el estado final, no sobre el que llegó por HTTP.
 */
function clavesDerivadas(tarea) {
  return {
    vencimiento_orden: vencimientoOrdenDe(tarea),
    sk_proyecto: skProyectoDe(tarea),
  };
}

// ─── Validación ───

/**
 * Valida y normaliza los campos de una tarea nueva. Es pura: no lee nada, para
 * que la creación en lote pueda validar las cincuenta antes de escribir ninguna.
 *
 * @returns {{ ok: true, datos: object } | { ok: false, error: string }}
 */
export function validarDatosTarea(bruto = {}) {
  const titulo = texto(bruto.titulo);
  if (!titulo) return { ok: false, error: 'El título de la tarea es obligatorio' };

  // Un solo responsable, y obligatorio: una tarea sin dueño no aparece en la
  // vista personal de nadie y se queda sin hacer.
  const responsableId = texto(bruto.responsable_id);
  if (!responsableId) return { ok: false, error: 'La tarea necesita una persona responsable' };

  const estado = texto(bruto.estado) || ESTADO_INICIAL;
  if (!enLista(ESTADOS_TAREA, estado)) return { ok: false, error: `Estado no válido: «${estado}»` };
  const bloqueoMotivo = texto(bruto.bloqueo_motivo);
  if (estado === 'bloqueada' && !bloqueoMotivo) {
    return { ok: false, error: 'Una tarea bloqueada necesita el motivo del bloqueo' };
  }

  const prioridad = texto(bruto.prioridad) || PRIORIDAD_POR_DEFECTO;
  if (!enLista(PRIORIDADES, prioridad)) {
    return { ok: false, error: `Prioridad no válida: «${prioridad}»` };
  }

  const fechaLimite = texto(bruto.fecha_limite);
  if (fechaLimite && !esFechaIso(fechaLimite)) {
    return { ok: false, error: 'La fecha límite debe ser una fecha en formato AAAA-MM-DD' };
  }

  const checklist = normalizarChecklistEntrante(bruto.checklist);
  if (!checklist.ok) return checklist;

  return {
    ok: true,
    datos: {
      titulo,
      descripcion: texto(bruto.descripcion),
      estado,
      responsable_id: responsableId,
      departamento_id: texto(bruto.departamento_id),
      fecha_limite: fechaLimite,
      prioridad,
      checklist: checklist.checklist,
      menciones: extraerMenciones(bruto.descripcion, bruto.menciones),
      bloqueo_motivo: bloqueoMotivo,
      propuesta_origen_id: texto(bruto.propuesta_origen_id),
      cita_origen: texto(bruto.cita_origen),
    },
  };
}

/** Lista de comprobación tal como llega al crear: acepta textos o objetos. */
function normalizarChecklistEntrante(bruto) {
  if (bruto == null) return { ok: true, checklist: [] };
  if (!Array.isArray(bruto)) {
    return { ok: false, error: 'La lista de comprobación debe ser una lista de elementos' };
  }
  if (bruto.length > MAX_CHECKLIST) {
    return {
      ok: false,
      error: `La lista de comprobación no admite más de ${MAX_CHECKLIST} elementos; por encima de eso son subtareas`,
    };
  }
  const checklist = [];
  for (const [i, entrada] of bruto.entries()) {
    const textoElemento = texto(typeof entrada === 'string' ? entrada : entrada?.texto);
    if (!textoElemento) {
      return { ok: false, error: 'Hay un elemento de la lista de comprobación sin texto' };
    }
    checklist.push({
      id: crypto.randomUUID(),
      texto: textoElemento,
      hecho: false,
      orden: aOrden(typeof entrada === 'string' ? i : entrada?.orden, i),
    });
  }
  return { ok: true, checklist };
}

// ─── Creación ───

/**
 * Crea una tarea.
 *
 * `departamento_id` se hereda del proyecto si no llega, y después es editable: es
 * etiqueta organizativa, no candado. Una subtarea hereda además el proyecto de su
 * madre, para que no puedan acabar en proyectos distintos.
 *
 * @param {{ ctx: object, usuario: object, datos: object }} opciones
 * @returns {Promise<{ ok: true, tarea: object } | Fallo>}
 */
export async function crearTarea({ ctx, datos = {} } = {}) {
  const validado = validarDatosTarea(datos);
  if (!validado.ok) return { ok: false, status: 400, error: validado.error };

  let idProyecto = texto(datos.proyecto_id);
  let departamentoHeredado = '';

  const idPadre = texto(datos.tarea_padre_id);
  if (idPadre) {
    const padre = await leerMeta(idPadre);
    if (!padre) return { ok: false, status: 400, error: 'La tarea madre no existe' };
    const proyectoDelPadre = texto(padre.proyecto_id);
    if (idProyecto && proyectoDelPadre && idProyecto !== proyectoDelPadre) {
      return { ok: false, status: 400, error: 'Una subtarea no puede estar en otro proyecto que su tarea madre' };
    }
    if (!idProyecto) idProyecto = proyectoDelPadre;
    departamentoHeredado = texto(padre.departamento_id);
  }

  const acceso = await proyectoParaCrear(ctx, idProyecto);
  if (!acceso.ok) return acceso;
  if (acceso.aux?.proyecto) {
    departamentoHeredado = texto(acceso.aux.proyecto.departamento_id) || departamentoHeredado;
  }

  const instante = ahora();
  const tarea = {
    ...validado.datos,
    id_tarea: crypto.randomUUID(),
    proyecto_id: idProyecto,
    departamento_id: validado.datos.departamento_id || departamentoHeredado,
    tarea_padre_id: idPadre,
    reunion_origen_id: texto(datos.reunion_origen_id),
    cerrada_en: esEstadoTareaTerminal(validado.datos.estado) ? instante : '',
    creado_por: texto(ctx?.idUsuario),
    creado_en: instante,
    actualizado_en: instante,
  };

  await docClient.send(new PutCommand({ TableName: tables.tareas, Item: itemTarea(tarea) }));

  await registrarActividad({
    tipo: 'tarea',
    entidadId: tarea.id_tarea,
    accion: ACCIONES.creada,
    usuario: autorDe(ctx),
    detalle: {
      titulo: tarea.titulo,
      responsable_id: tarea.responsable_id,
      proyecto_id: tarea.proyecto_id || null,
      fecha_limite: tarea.fecha_limite || null,
    },
  });

  await notificarAsignacion({
    destinatarioId: tarea.responsable_id,
    actorId: ctx?.idUsuario,
    tarea: { ...tarea, asignada_por_nombre: texto(ctx?.nombre) },
  });

  const nombres = await nombresDeUsuarios([tarea.responsable_id]);
  return {
    ok: true,
    tarea: salidaConExtras(itemTarea(tarea), ctx, { aux: acceso.aux, nombres }),
  };
}

/**
 * Tareas ya creadas desde una propuesta, indexadas por `propuesta_origen_id`.
 *
 * No hay índice por `propuesta_origen_id`, así que la idempotencia se resuelve
 * mirando el conjunto al que pertenecería la tarea: el proyecto o la reunión de
 * origen del lote. Son una o dos Query por llamada, no una por tarea.
 */
async function tareasPorPropuesta({ proyectoId, reunionId }) {
  const mapa = new Map();
  const consultas = [];
  if (reunionId) {
    consultas.push({
      IndexName: IDX_REUNION,
      KeyConditionExpression: 'reunion_origen_id = :h',
      ExpressionAttributeValues: { ':h': reunionId },
    });
  }
  if (proyectoId) {
    consultas.push({
      IndexName: IDX_PROYECTO,
      KeyConditionExpression: 'proyecto_id = :h',
      ExpressionAttributeValues: { ':h': proyectoId },
    });
  }
  for (const consulta of consultas) {
    const items = await consultarTodo({
      TableName: tables.tareas,
      ...consulta,
      FilterExpression: 'attribute_exists(propuesta_origen_id)',
    });
    for (const item of items) {
      const clave = texto(item.propuesta_origen_id);
      if (clave && !mapa.has(clave)) mapa.set(clave, salida(item));
    }
  }
  return mapa;
}

/**
 * Escribe ítems en lotes de 25, reintentando lo que DynamoDB devuelva sin
 * procesar. Devuelve los que no se pudieron escribir tras los reintentos: antes
 * que girar sin fin ante throttling, se responde con lo que sí quedó grabado.
 */
async function escribirEnLotes(items) {
  const noEscritos = [];
  for (let i = 0; i < items.length; i += MAX_LOTE_ESCRITURA) {
    let pendientes = items
      .slice(i, i + MAX_LOTE_ESCRITURA)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tables.tareas]: pendientes } }),
      );
      pendientes = res?.UnprocessedItems?.[tables.tareas] || [];
    }
    if (pendientes.length > 0) {
      console.error('[tasks/tareas] quedaron tareas sin escribir tras los reintentos', pendientes.length);
      noEscritos.push(...pendientes.map((p) => p.PutRequest.Item));
    }
  }
  return noEscritos;
}

/**
 * Creación en lote: el **único** camino de creación múltiple, y el punto de unión
 * con el módulo de reuniones y con las plantillas.
 *
 * - Se validan **todas** antes de escribir ninguna: un `400` con el índice y el
 *   motivo de cada fallo, y ni una tarea creada.
 * - Idempotencia por `propuesta_origen_id`: una doble pulsación de «validar» no
 *   crea dos tareas, devuelve la que ya existía.
 *
 * @param {{ ctx: object, usuario: object, datos: object }} opciones
 * @returns {Promise<{ ok: true, creadas: object[], omitidas: object[] } | Fallo>}
 */
export async function crearTareasEnLote({ ctx, datos = {} } = {}) {
  const entradas = Array.isArray(datos.tareas) ? datos.tareas : null;
  if (!entradas || entradas.length === 0) {
    return { ok: false, status: 400, error: 'Envía al menos una tarea' };
  }
  if (entradas.length > MAX_TAREAS_LOTE) {
    return {
      ok: false,
      status: 400,
      error: `No se pueden crear más de ${MAX_TAREAS_LOTE} tareas en una sola llamada`,
    };
  }

  const proyectoId = texto(datos.proyecto_id);
  const reunionId = texto(datos.reunion_origen_id);
  const acceso = await proyectoParaCrear(ctx, proyectoId);
  if (!acceso.ok) return acceso;
  const departamentoHeredado = texto(acceso.aux?.proyecto?.departamento_id);

  const fallos = [];
  const validas = [];
  for (const [indice, entrada] of entradas.entries()) {
    const validado = validarDatosTarea(entrada);
    if (!validado.ok) fallos.push({ indice, error: validado.error });
    else validas.push({ indice, datos: validado.datos });
  }
  if (fallos.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `No se ha creado ninguna tarea: ${fallos.length} de ${entradas.length} tienen datos inválidos`,
      fallos,
    };
  }

  const conPropuesta = validas.filter((v) => v.datos.propuesta_origen_id);
  if (conPropuesta.length > 0 && !proyectoId && !reunionId) {
    // Sin proyecto ni reunión no hay índice por el que comprobar si la propuesta
    // ya se convirtió, y resolverlo con un Scan no es una opción.
    return {
      ok: false,
      status: 400,
      error: 'Para crear tareas desde propuestas hace falta indicar el proyecto o la reunión de origen',
    };
  }
  const yaCreadas = conPropuesta.length > 0 ? await tareasPorPropuesta({ proyectoId, reunionId }) : new Map();

  const instante = ahora();
  const creadoPor = texto(ctx?.idUsuario);
  const items = [];
  const creadas = [];
  const omitidas = [];

  for (const { indice, datos: campos } of validas) {
    const propuesta = campos.propuesta_origen_id;
    if (propuesta && yaCreadas.has(propuesta)) {
      omitidas.push({ indice, propuesta_origen_id: propuesta, tarea: yaCreadas.get(propuesta) });
      continue;
    }
    const tarea = {
      ...campos,
      id_tarea: crypto.randomUUID(),
      proyecto_id: proyectoId,
      departamento_id: campos.departamento_id || departamentoHeredado,
      reunion_origen_id: reunionId,
      cerrada_en: esEstadoTareaTerminal(campos.estado) ? instante : '',
      creado_por: creadoPor,
      creado_en: instante,
      actualizado_en: instante,
    };
    const item = itemTarea(tarea);
    items.push(item);
    creadas.push(salida(item));
    // Dos entradas del mismo lote con la misma propuesta tampoco se duplican.
    if (propuesta) yaCreadas.set(propuesta, salida(item));
  }

  if (items.length > 0) {
    const noEscritos = new Set((await escribirEnLotes(items)).map((it) => it.id_tarea));
    const escritas = creadas.filter((t) => !noEscritos.has(t.id_tarea));
    await registrarActividadLote(
      escritas.map((tarea) => ({
        tipo: 'tarea',
        entidadId: tarea.id_tarea,
        accion: ACCIONES.creada,
        // Con el nombre, como en el resto de las escrituras (D-19): en Fase 2
        // este es el camino normal —toda tarea nacida de una reunión entra por el
        // lote— y un historial firmado con el id crudo no dice quién fue.
        usuario: autorDe(ctx),
        detalle: {
          titulo: tarea.titulo,
          responsable_id: tarea.responsable_id,
          proyecto_id: tarea.proyecto_id || null,
          propuesta_origen_id: tarea.propuesta_origen_id || null,
          origen: 'lote',
        },
      })),
    );
    const nombreActor = texto(ctx?.nombre);
    for (const tarea of escritas) {
      await notificarAsignacion({
        destinatarioId: tarea.responsable_id,
        actorId: creadoPor,
        tarea: { ...tarea, asignada_por_nombre: nombreActor },
      });
    }
    // Todas las del lote comparten proyecto, así que el contexto de acceso es el
    // mismo y los nombres salen de un solo `BatchGet`. Las de `omitidas` van tal
    // cual: son el eco de idempotencia de tareas que ya existían, y su ficha
    // completa está en `GET /api/tareas/:id`.
    const nombres = await nombresDeUsuarios(escritas.map((t) => t.responsable_id));
    return {
      ok: true,
      creadas: escritas.map((t) => salidaConExtras(t, ctx, { aux: acceso.aux, nombres })),
      omitidas,
    };
  }

  return { ok: true, creadas, omitidas };
}

// ─── Listados ───

/**
 * Cuántas tareas abiertas de una persona han pasado ya de su fecha límite.
 *
 * Se cuenta con una Query acotada por la clave de orden del índice, no filtrando
 * en memoria la página que se devuelve: el recuento tiene que ser del total, y la
 * vista personal está paginada.
 */
async function contarVencidas(idUsuario) {
  const corte = `${fechaHoyMadrid()}#`;
  const items = await consultarTodo({
    TableName: tables.tareas,
    IndexName: IDX_RESPONSABLE,
    KeyConditionExpression: 'responsable_id = :r AND vencimiento_orden < :corte',
    ExpressionAttributeValues: { ':r': idUsuario, ':corte': corte },
    ProjectionExpression: 'PK',
  });
  return items.length;
}

/**
 * **Vista personal.** Tareas abiertas de quien pregunta, ya ordenadas por
 * vencimiento, más el recuento de vencidas.
 *
 * El índice solo contiene tareas abiertas —el escritor borra `vencimiento_orden`
 * al cerrarlas—, así que aquí no se filtra por estado. Tampoco hace falta filtrar
 * por visibilidad: ser la persona responsable siempre da acceso.
 *
 * @returns {Promise<{ ok: true, tareas: object[], vencidas: number, cursor: string|null } | Fallo>}
 */
export async function listarMisTareas({ ctx, limite, cursor } = {}) {
  const idUsuario = texto(ctx?.idUsuario);
  if (!idUsuario) return { ok: false, status: 403, error: 'No hay sesión' };

  const desde = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      IndexName: IDX_RESPONSABLE,
      KeyConditionExpression: 'responsable_id = :r',
      ExpressionAttributeValues: { ':r': idUsuario },
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  const items = res.Items || [];
  // Los proyectos de la página en una sola lectura. Aquí no se necesitan para
  // decidir visibilidad —ser la responsable ya la da—, sino para el nombre del
  // proyecto y los permisos de fila; a cambio, la pantalla deja de traerse el
  // listado de proyectos solo para cruzar ese nombre.
  const proyectos = await proyectosDeLaPagina(ctx, items);
  // La responsable es siempre quien pregunta, y su nombre visible ya viene en el
  // contexto de acceso: ni una lectura para resolverlo.
  const nombres = new Map([[idUsuario, texto(ctx?.nombre) || null]]);

  return {
    ok: true,
    tareas: items.map((t) => salidaConExtras(t, ctx, { aux: auxDeMapa(proyectos, t), nombres })),
    vencidas: await contarVencidas(idUsuario),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

/**
 * Los proyectos de una página de tareas, en **una** lectura: veinte tareas de
 * veinte proyectos son un `BatchGet`, no veinte Query.
 */
async function proyectosDeLaPagina(ctx, items) {
  const idsProyecto = [...new Set(items.map((t) => texto(t.proyecto_id)).filter(Boolean))];
  return idsProyecto.length
    ? leerProyectosParaAcceso(idsProyecto, ctx?.idUsuario)
    : new Map();
}

/**
 * Deja en la lista solo lo que quien pregunta puede ver, y devuelve el mapa de
 * proyectos con el que se decidió.
 *
 * La decisión la toma `puedeVerTarea` con el proyecto real, nunca una
 * comprobación escrita a mano aquí. Y el mapa se devuelve porque es el mismo dato
 * que después resuelve `proyecto_nombre` y `permisos_fila`: leerlo dos veces
 * sería leer de más.
 */
async function visiblesConProyectos(ctx, items) {
  const proyectos = await proyectosDeLaPagina(ctx, items);
  const visibles = filtrarVisibles(ctx, 'tarea', items, (t) => auxDeMapa(proyectos, t));
  return { visibles, proyectos };
}

/**
 * Página de tareas ya visibles, en su forma pública y con los nombres de sus
 * responsables resueltos en un solo `BatchGet`.
 */
async function paginaDeTareas(ctx, visibles, proyectos) {
  const nombres = await nombresDeUsuarios(visibles.map((t) => t.responsable_id));
  return visibles.map((t) =>
    salidaConExtras(t, ctx, { aux: auxDeMapa(proyectos, t), nombres }),
  );
}

/** Construye el `FilterExpression` de los filtros que no son clave del índice. */
function filtroDeIgualdades(igualdades, valoresBase) {
  const nombres = {};
  const valores = { ...valoresBase };
  const partes = [];
  let i = 0;
  for (const [campo, valor] of Object.entries(igualdades)) {
    if (!valor) continue;
    nombres[`#f${i}`] = campo;
    valores[`:f${i}`] = valor;
    partes.push(`#f${i} = :f${i}`);
    i += 1;
  }
  return {
    ...(partes.length > 0 && {
      FilterExpression: partes.join(' AND '),
      ExpressionAttributeNames: nombres,
    }),
    ExpressionAttributeValues: valores,
  };
}

/**
 * Listado de tareas con filtros.
 *
 * Exige `proyecto` o `responsable` porque son las dos particiones que existen
 * (`Proyecto-index` y `Responsable-Vencimiento-index`): no hay índice de «todas
 * las tareas» y resolverlo con un `Scan` no es una opción. `estado` y
 * `departamento` se aplican como filtro sobre esas consultas.
 *
 * Ver las tareas de otra persona exige `tareas.ver_todas` o ser miembro del
 * proyecto; eso no se comprueba aquí a mano, lo aplica el filtro de visibilidad.
 *
 * @returns {Promise<{ ok: true, tareas: object[], cursor: string|null } | Fallo>}
 */
export async function listarTareas({ ctx, filtros = {}, limite, cursor } = {}) {
  const proyecto = texto(filtros.proyecto);
  const responsable = texto(filtros.responsable);
  const estado = texto(filtros.estado);
  const departamento = texto(filtros.departamento);

  if (estado && !enLista(ESTADOS_TAREA, estado)) {
    return { ok: false, status: 400, error: `Estado no válido: «${estado}»` };
  }
  if (!proyecto && !responsable) {
    return {
      ok: false,
      status: 400,
      error: 'Indica el proyecto o la persona responsable: no existe un listado de todas las tareas',
    };
  }
  if (!proyecto && esEstadoTareaTerminal(estado)) {
    // El índice por responsable solo tiene tareas abiertas, así que la respuesta
    // sería una lista vacía indistinguible de «no hay ninguna».
    return {
      ok: false,
      status: 400,
      error: 'El histórico de tareas cerradas se consulta por proyecto, no por persona',
    };
  }

  const porProyecto = Boolean(proyecto);
  const consulta = porProyecto
    ? {
        IndexName: IDX_PROYECTO,
        KeyConditionExpression: 'proyecto_id = :h',
        ...filtroDeIgualdades(
          { estado, departamento_id: departamento, responsable_id: responsable },
          { ':h': proyecto },
        ),
      }
    : {
        IndexName: IDX_RESPONSABLE,
        KeyConditionExpression: 'responsable_id = :h',
        ...filtroDeIgualdades({ estado, departamento_id: departamento }, { ':h': responsable }),
      };

  const desde = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      ...consulta,
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  const { visibles, proyectos } = await visiblesConProyectos(ctx, res.Items || []);
  return {
    ok: true,
    tareas: await paginaDeTareas(ctx, visibles, proyectos),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

/**
 * Ficha de una tarea en **una sola Query**: `META` con su lista de comprobación,
 * vínculos, enlaces y adjuntos comparten partición justamente para esto. Los
 * comentarios se descartan aquí porque tienen su propio endpoint paginado.
 *
 * @returns {Promise<{ ok: true, tarea: object } | Fallo>}
 */
export async function obtenerTareaDetalle({ ctx, idTarea } = {}) {
  const id = texto(idTarea);
  if (!id) return { ok: false, status: 404, error: 'La tarea no existe' };

  const items = await consultarTodo({
    TableName: tables.tareas,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': PK.tarea(id) },
  });

  const meta = items.find((it) => texto(it.SK) === SK.meta);
  if (!meta) return { ok: false, status: 404, error: 'La tarea no existe' };
  const aux = await auxDeTarea(meta);
  if (!puedeVerTarea(ctx, meta, aux)) return { ok: false, status: 404, error: 'La tarea no existe' };

  const porPrefijo = (prefijo) =>
    items.filter((it) => texto(it.SK).startsWith(prefijo)).map(salidaFilaHija);

  const nombres = await nombresDeUsuarios([meta.responsable_id]);
  return {
    ok: true,
    tarea: {
      ...salidaConExtras(meta, ctx, { aux, nombres }),
      enlaces: porPrefijo('ENLACE#'),
      adjuntos: porPrefijo('ADJUNTO#'),
      vinculos: porPrefijo('VINC#'),
    },
  };
}

/**
 * Subtareas de una tarea, vía `Padre-index`.
 *
 * @returns {Promise<{ ok: true, tareas: object[], cursor: string|null } | Fallo>}
 */
export async function listarSubtareas({ ctx, idTarea, limite, cursor } = {}) {
  const acceso = await cargarParaVer(ctx, idTarea);
  if (!acceso.ok) return acceso;

  const desde = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      IndexName: IDX_PADRE,
      KeyConditionExpression: 'tarea_padre_id = :p',
      ExpressionAttributeValues: { ':p': texto(idTarea) },
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  const { visibles, proyectos } = await visiblesConProyectos(ctx, res.Items || []);
  return {
    ok: true,
    tareas: await paginaDeTareas(ctx, visibles, proyectos),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

/**
 * Historial de una tarea. Hereda la visibilidad de la tarea: quien no la ve
 * tampoco ve lo que se hizo con ella.
 *
 * @returns {Promise<{ ok: true, actividad: object[], cursor: string|null } | Fallo>}
 */
export async function listarActividadTarea({ ctx, idTarea, limite, cursor } = {}) {
  const acceso = await cargarParaVer(ctx, idTarea);
  if (!acceso.ok) return acceso;
  const { actividad, cursor: siguiente } = await listarActividad({
    tipo: 'tarea',
    entidadId: texto(idTarea),
    limite,
    cursor,
  });
  return { ok: true, actividad, cursor: siguiente };
}

// ─── Edición ───

/** Campos que se editan con `PATCH`. El estado y el responsable tienen su endpoint. */
const CAMPOS_EDITABLES = ['titulo', 'descripcion', 'fecha_limite', 'prioridad', 'departamento_id', 'menciones'];

/**
 * Edita los campos de una tarea, manteniendo las claves derivadas: cambiar la
 * fecha límite cambia el orden de la vista personal y del listado del proyecto.
 *
 * @returns {Promise<{ ok: true, tarea: object } | Fallo>}
 */
export async function actualizarTarea({ ctx, idTarea, cambios = {} } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea);
  if (!acceso.ok) return acceso;
  const { meta } = acceso;

  const nuevos = {};
  if (cambios.titulo !== undefined) {
    const titulo = texto(cambios.titulo);
    if (!titulo) return { ok: false, status: 400, error: 'El título de la tarea es obligatorio' };
    nuevos.titulo = titulo;
  }
  if (cambios.descripcion !== undefined) nuevos.descripcion = texto(cambios.descripcion);
  if (cambios.fecha_limite !== undefined) {
    const fecha = texto(cambios.fecha_limite);
    if (fecha && !esFechaIso(fecha)) {
      return { ok: false, status: 400, error: 'La fecha límite debe ser una fecha en formato AAAA-MM-DD' };
    }
    nuevos.fecha_limite = fecha;
  }
  if (cambios.prioridad !== undefined) {
    const prioridad = texto(cambios.prioridad);
    if (!enLista(PRIORIDADES, prioridad)) {
      return { ok: false, status: 400, error: `Prioridad no válida: «${prioridad}»` };
    }
    nuevos.prioridad = prioridad;
  }
  if (cambios.departamento_id !== undefined) nuevos.departamento_id = texto(cambios.departamento_id);
  if (cambios.menciones !== undefined) {
    // Lista explícita: manda quien edita, y se le añaden las del texto.
    nuevos.menciones = extraerMenciones(cambios.descripcion, cambios.menciones);
  } else if (cambios.descripcion !== undefined) {
    // Escribir `@000007` en la descripción menciona, igual que al crear la tarea
    // y que en un comentario. Se parte de las que ya tenía en lugar de rehacer la
    // lista: estar mencionado da lectura, y editar la descripción no puede
    // echar a quien fue mencionado en un comentario.
    nuevos.menciones = extraerMenciones(cambios.descripcion, meta.menciones);
  }

  if (Object.keys(nuevos).length === 0) {
    return { ok: false, status: 400, error: 'No hay nada que actualizar' };
  }

  const antes = {};
  for (const campo of Object.keys(nuevos)) antes[campo] = meta[campo] ?? null;

  const actualizado = { ...salida(meta), ...nuevos };
  const guardado = await escribirMeta(idTarea, {
    ...nuevos,
    ...clavesDerivadas(actualizado),
    actualizado_en: ahora(),
  });
  if (!guardado) return tareaDesaparecida();

  await registrarActividad({
    tipo: 'tarea',
    entidadId: texto(idTarea),
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: { antes, despues: nuevos },
  });

  const nombres = await nombresDeUsuarios([guardado?.responsable_id]);
  return { ok: true, tarea: salidaConExtras(guardado, ctx, { aux: acceso.aux, nombres }) };
}

/**
 * Cambia el estado de una tarea.
 *
 * Las transiciones las decide `transicionTareaPermitida`, y una no permitida es
 * `422`, no `400`: la petición está bien formada, es el estado el que no la
 * admite. Cerrar la tarea la saca de `Responsable-Vencimiento-index` y reabrirla
 * la devuelve, que es lo que hace que la vista personal no tenga que filtrar.
 *
 * @returns {Promise<{ ok: true, tarea: object } | Fallo>}
 */
export async function cambiarEstadoTarea({ ctx, idTarea, estado, bloqueoMotivo } = {}) {
  const destino = texto(estado);
  if (!enLista(ESTADOS_TAREA, destino)) {
    return { ok: false, status: 400, error: `Estado no válido: «${destino}»` };
  }

  const acceso = await cargarParaEscribir(ctx, idTarea);
  if (!acceso.ok) return acceso;
  const { meta } = acceso;
  const origen = texto(meta.estado);

  if (!transicionTareaPermitida(origen, destino)) {
    return {
      ok: false,
      status: 422,
      error: `Una tarea «${origen}» no puede pasar a «${destino}»`,
    };
  }

  const motivo = texto(bloqueoMotivo);
  if (destino === 'bloqueada' && !motivo) {
    return { ok: false, status: 400, error: 'Para bloquear una tarea hace falta indicar el motivo' };
  }

  const instante = ahora();
  const terminal = esEstadoTareaTerminal(destino);
  const actualizado = { ...salida(meta), estado: destino };
  const guardado = await escribirMeta(idTarea, {
    estado: destino,
    // El motivo se conserva mientras siga bloqueada y se borra al desbloquearla.
    bloqueo_motivo: destino === 'bloqueada' ? motivo : '',
    // Reabrir una tarea tiene que dejarla como abierta de verdad, sin fecha de cierre.
    cerrada_en: terminal ? (texto(meta.cerrada_en) || instante) : '',
    ...clavesDerivadas(actualizado),
    actualizado_en: instante,
  });
  if (!guardado) return tareaDesaparecida();

  await registrarActividad({
    tipo: 'tarea',
    entidadId: texto(idTarea),
    accion: ACCIONES.estadoCambiado,
    usuario: autorDe(ctx),
    detalle: { antes: { estado: origen }, despues: { estado: destino, bloqueo_motivo: motivo || null } },
  });

  const nombres = await nombresDeUsuarios([guardado?.responsable_id]);
  return { ok: true, tarea: salidaConExtras(guardado, ctx, { aux: acceso.aux, nombres }) };
}

/**
 * Cambia la persona responsable. **Una sola**: no hay lista de responsables.
 *
 * La reasigna quien manda en el proyecto, no quien la tiene asignada, para que
 * nadie se quite el marrón de encima solo.
 *
 * @returns {Promise<{ ok: true, tarea: object } | Fallo>}
 */
export async function reasignarTarea({ ctx, idTarea, responsableId } = {}) {
  const nuevo = texto(responsableId);
  if (!nuevo) return { ok: false, status: 400, error: 'Indica la nueva persona responsable' };

  const acceso = await cargarParaEscribir(
    ctx,
    idTarea,
    puedeReasignarTarea,
    'No puedes reasignar esta tarea',
  );
  if (!acceso.ok) return acceso;
  const { meta } = acceso;
  const anterior = texto(meta.responsable_id);
  if (anterior === nuevo) {
    return { ok: false, status: 409, error: 'La tarea ya está asignada a esa persona' };
  }

  const actualizado = { ...salida(meta), responsable_id: nuevo };
  const guardado = await escribirMeta(idTarea, {
    responsable_id: nuevo,
    ...clavesDerivadas(actualizado),
    actualizado_en: ahora(),
  });
  if (!guardado) return tareaDesaparecida();

  await registrarActividad({
    tipo: 'tarea',
    entidadId: texto(idTarea),
    accion: ACCIONES.reasignada,
    usuario: autorDe(ctx),
    detalle: { antes: { responsable_id: anterior || null }, despues: { responsable_id: nuevo } },
  });

  await notificarAsignacion({
    destinatarioId: nuevo,
    actorId: ctx?.idUsuario,
    tarea: {
      id_tarea: texto(idTarea),
      titulo: texto(guardado?.titulo) || texto(meta.titulo),
      asignada_por_nombre: texto(ctx?.nombre),
    },
  });

  const nombres = await nombresDeUsuarios([nuevo]);
  return { ok: true, tarea: salidaConExtras(guardado, ctx, { aux: acceso.aux, nombres }) };
}

/**
 * Borra los objetos de S3 a los que apunta la partición de una tarea: el fichero
 * de cada adjunto y la imagen capturada de cada enlace.
 *
 * Borrar solo la partición de DynamoDB dejaba esos objetos huérfanos en el
 * bucket: pagándose para siempre y, peor, sobreviviendo a un borrado que quien lo
 * pidió da por hecho que se llevó también el contenido.
 *
 * Un fallo **no impide** el borrado en DynamoDB: se registra y se sigue, igual
 * que hacen `borrarEnlace` y `borrarAdjunto` con el suyo. Al revés, un objeto
 * inaccesible dejaría una tarea que nadie puede borrar nunca.
 */
async function borrarObjetosDeS3(filas) {
  for (const fila of filas) {
    const sk = texto(fila?.SK);
    try {
      if (sk.startsWith('ADJUNTO#') && texto(fila.s3_key)) {
        await almacenAdjuntos.borrar({ key: fila.s3_key });
      } else if (sk.startsWith('ENLACE#') && texto(fila.imagen_s3_key)) {
        await transporteEnlaces.borrarImagen({ key: fila.imagen_s3_key });
      }
    } catch (err) {
      console.error('[tasks/tareas] no se pudo borrar el objeto de S3 de', sk, err?.message || err);
    }
  }
}

/**
 * Borra una tarea, sus filas hijas y los objetos de S3 a los que apuntaban.
 *
 * `409` si tiene subtareas abiertas: borrar la madre dejaría trabajo vivo sin
 * sitio donde aparecer. El historial **no** se borra: `Igp_Actividad` es
 * append-only.
 *
 * @returns {Promise<{ ok: true } | Fallo>}
 */
export async function borrarTarea({ ctx, idTarea } = {}) {
  const acceso = await cargarParaVer(ctx, idTarea);
  if (!acceso.ok) return acceso;
  const id = texto(idTarea);

  const subtareas = await consultarTodo({
    TableName: tables.tareas,
    IndexName: IDX_PADRE,
    KeyConditionExpression: 'tarea_padre_id = :p',
    ExpressionAttributeValues: { ':p': id },
  });
  const abiertas = subtareas.filter((s) => !esEstadoTareaTerminal(texto(s.estado)));
  if (abiertas.length > 0) {
    return {
      ok: false,
      status: 409,
      error: `La tarea tiene ${abiertas.length} subtarea(s) sin cerrar`,
    };
  }

  await borrarParticionTarea({
    ctx,
    idTarea: id,
    titulo: texto(acceso.meta.titulo),
    proyectoId: texto(acceso.meta.proyecto_id) || null,
  });
  return { ok: true };
}

/**
 * Partición de la tarea + objetos de S3, sin el `409` de subtareas abiertas.
 * Lo usa el borrado suelto (tras ese chequeo) y la cascada al borrar un proyecto.
 */
async function borrarParticionTarea({ ctx, idTarea, titulo, proyectoId, origen }) {
  const id = texto(idTarea);
  const filas = await consultarTodo({
    TableName: tables.tareas,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': PK.tarea(id) },
    ProjectionExpression: 'PK, SK, s3_key, imagen_s3_key',
  });
  if (filas.length === 0) return false;

  await borrarObjetosDeS3(filas);

  for (let i = 0; i < filas.length; i += MAX_LOTE_ESCRITURA) {
    let pendientes = filas
      .slice(i, i + MAX_LOTE_ESCRITURA)
      .map((f) => ({ DeleteRequest: { Key: { PK: f.PK, SK: f.SK } } }));
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tables.tareas]: pendientes } }),
      );
      pendientes = res?.UnprocessedItems?.[tables.tareas] || [];
    }
    if (pendientes.length > 0) {
      throw new Error('DynamoDB no aceptó parte del lote de borrado de tareas');
    }
  }

  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.borrada,
    usuario: autorDe(ctx),
    detalle: {
      titulo: texto(titulo),
      proyecto_id: texto(proyectoId) || null,
      ...(origen ? { origen } : {}),
    },
  });
  return true;
}

/**
 * Todas las tareas del proyecto, vía `Proyecto-index` (sin `Scan`). No relee
 * visibilidad por fila: quien ya pudo borrar el proyecto se lleva su trabajo.
 *
 * @returns {Promise<{ ok: true, borradas: number }>}
 */
export async function borrarTareasDeProyecto({ ctx, idProyecto } = {}) {
  const id = texto(idProyecto);
  const metas = await consultarTodo({
    TableName: tables.tareas,
    IndexName: IDX_PROYECTO,
    KeyConditionExpression: 'proyecto_id = :p',
    ExpressionAttributeValues: { ':p': id },
    ProjectionExpression: 'id_tarea, titulo, proyecto_id',
  });
  const vistos = new Set();
  let borradas = 0;
  for (const meta of metas) {
    const idTarea = texto(meta.id_tarea);
    if (!idTarea || vistos.has(idTarea)) continue;
    vistos.add(idTarea);
    const ok = await borrarParticionTarea({
      ctx,
      idTarea,
      titulo: meta.titulo,
      proyectoId: texto(meta.proyecto_id) || id,
      origen: 'cascada_proyecto',
    });
    if (ok) borradas += 1;
  }
  return { ok: true, borradas };
}

// ─── Lista de comprobación ───

/**
 * Marcar un elemento **no** cambia el estado de la tarea, y completarlos todos
 * **no** la cierra: cerrarla es una decisión de la persona. De ahí que estas tres
 * funciones solo toquen el atributo `checklist`.
 *
 * Se lee y se reescribe la lista entera. Dos personas marcando elementos
 * distintos en el mismo segundo pueden pisarse; se acepta a cambio de no meter un
 * `409` en la operación más frecuente de la pantalla, y el elemento se vuelve a
 * marcar en un clic.
 */
async function guardarChecklist({ ctx, idTarea, checklist, detalle, aux }) {
  const guardado = await escribirMeta(idTarea, { checklist, actualizado_en: ahora() });
  if (!guardado) return tareaDesaparecida();
  await registrarActividad({
    tipo: 'tarea',
    entidadId: texto(idTarea),
    accion: ACCIONES.checklistCambiada,
    usuario: autorDe(ctx),
    detalle,
  });
  const nombres = await nombresDeUsuarios([guardado?.responsable_id]);
  return { ok: true, tarea: salidaConExtras(guardado, ctx, { aux, nombres }) };
}

function checklistDe(meta) {
  return Array.isArray(meta.checklist) ? meta.checklist : [];
}

/** @returns {Promise<{ ok: true, tarea: object } | Fallo>} */
export async function anadirElementoChecklist({ ctx, idTarea, texto: textoElemento } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea);
  if (!acceso.ok) return acceso;

  const contenido = texto(textoElemento);
  if (!contenido) return { ok: false, status: 400, error: 'El elemento necesita un texto' };

  const checklist = checklistDe(acceso.meta);
  if (checklist.length >= MAX_CHECKLIST) {
    return {
      ok: false,
      status: 409,
      error: `La lista de comprobación no admite más de ${MAX_CHECKLIST} elementos; por encima de eso son subtareas`,
    };
  }

  const elemento = {
    id: crypto.randomUUID(),
    texto: contenido,
    hecho: false,
    orden: checklist.length,
  };
  return guardarChecklist({
    ctx,
    idTarea,
    checklist: [...checklist, elemento],
    detalle: { anadido: elemento },
    aux: acceso.aux,
  });
}

/** @returns {Promise<{ ok: true, tarea: object } | Fallo>} */
export async function actualizarElementoChecklist({ ctx, idTarea, itemId, cambios = {} } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea);
  if (!acceso.ok) return acceso;

  const checklist = checklistDe(acceso.meta);
  const indice = checklist.findIndex((e) => texto(e?.id) === texto(itemId));
  if (indice === -1) {
    return { ok: false, status: 404, error: 'Ese elemento de la lista de comprobación no existe' };
  }

  const anterior = checklist[indice];
  const nuevo = { ...anterior };
  if (cambios.texto !== undefined) {
    const contenido = texto(cambios.texto);
    if (!contenido) return { ok: false, status: 400, error: 'El elemento necesita un texto' };
    nuevo.texto = contenido;
  }
  if (cambios.orden !== undefined) nuevo.orden = aOrden(cambios.orden, anterior.orden ?? indice);
  if (cambios.hecho !== undefined) {
    const hecho = aBooleano(cambios.hecho);
    nuevo.hecho = hecho;
    if (hecho) {
      nuevo.hecho_por = texto(ctx?.idUsuario);
      nuevo.hecho_en = ahora();
    } else {
      delete nuevo.hecho_por;
      delete nuevo.hecho_en;
    }
  }
  if (cambios.texto === undefined && cambios.orden === undefined && cambios.hecho === undefined) {
    return { ok: false, status: 400, error: 'No hay nada que actualizar' };
  }

  const actualizada = [...checklist];
  actualizada[indice] = nuevo;
  actualizada.sort((a, b) => aOrden(a?.orden) - aOrden(b?.orden));

  return guardarChecklist({
    ctx,
    idTarea,
    checklist: actualizada,
    detalle: { antes: anterior, despues: nuevo },
    aux: acceso.aux,
  });
}

/** @returns {Promise<{ ok: true, tarea: object } | Fallo>} */
export async function borrarElementoChecklist({ ctx, idTarea, itemId } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea);
  if (!acceso.ok) return acceso;

  const checklist = checklistDe(acceso.meta);
  const elemento = checklist.find((e) => texto(e?.id) === texto(itemId));
  if (!elemento) {
    return { ok: false, status: 404, error: 'Ese elemento de la lista de comprobación no existe' };
  }

  return guardarChecklist({
    ctx,
    idTarea,
    checklist: checklist.filter((e) => e !== elemento),
    detalle: { borrado: elemento },
    aux: acceso.aux,
  });
}

// ─── Comentarios ───

/**
 * Hilo de seguimiento de la tarea, más reciente primero y paginado. No es un
 * chat.
 *
 * @returns {Promise<{ ok: true, comentarios: object[], cursor: string|null } | Fallo>}
 */
export async function listarComentarios({ ctx, idTarea, limite, cursor } = {}) {
  const acceso = await cargarParaVer(ctx, idTarea);
  if (!acceso.ok) return acceso;

  const desde = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': PK.tarea(texto(idTarea)), ':sk': 'COMENT#' },
      // El SK empieza por el instante: el orden inverso de la clave ya es el
      // cronológico inverso.
      ScanIndexForward: false,
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  return {
    ok: true,
    comentarios: (res.Items || []).map(salidaFilaHija),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

/**
 * Añade un comentario y guarda sus `@menciones`.
 *
 * Las menciones se acumulan también en `META`, porque estar mencionado da lectura
 * de la tarea: si solo vivieran en el comentario, mencionar a alguien no le
 * dejaría entrar a leerlo. Cada mención del comentario genera aviso `mencion`
 * (excepto al propio autor).
 *
 * @returns {Promise<{ ok: true, comentario: object } | Fallo>}
 */
export async function crearComentario({ ctx, idTarea, texto: textoComentario, menciones } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea, puedeEditarTarea, 'No puedes comentar en esta tarea');
  if (!acceso.ok) return acceso;

  const contenido = texto(textoComentario);
  if (!contenido) return { ok: false, status: 400, error: 'El comentario no puede estar vacío' };

  const autor = autorDe(ctx);
  const instante = ahora();
  const idComentario = crypto.randomUUID();
  const mencionados = extraerMenciones(contenido, menciones);
  const item = {
    PK: PK.tarea(texto(idTarea)),
    SK: SK.comentario(instante, idComentario),
    id_comentario: idComentario,
    texto: contenido,
    autor_id: autor.id_usuario,
    autor_nombre: autor.Nombre,
    creado_en: instante,
    ...(mencionados.length > 0 && { menciones: mencionados }),
  };
  await docClient.send(new PutCommand({ TableName: tables.tareas, Item: item }));

  const yaEnLaTarea = Array.isArray(acceso.meta.menciones) ? acceso.meta.menciones : [];
  const nuevas = mencionados.filter((m) => !yaEnLaTarea.includes(m));
  if (nuevas.length > 0) {
    await escribirMeta(idTarea, {
      menciones: [...yaEnLaTarea, ...nuevas],
      actualizado_en: instante,
    });
  }

  await registrarActividad({
    tipo: 'tarea',
    entidadId: texto(idTarea),
    accion: ACCIONES.comentario,
    usuario: autor,
    detalle: { id_comentario: idComentario, menciones: mencionados },
  });

  if (mencionados.length > 0) {
    await notificarMenciones({
      mencionados,
      autorId: autor.id_usuario,
      autorNombre: autor.Nombre,
      tarea: {
        id_tarea: texto(idTarea),
        titulo: texto(acceso.meta.titulo),
      },
    });
  }

  return { ok: true, comentario: salidaFilaHija(item) };
}
