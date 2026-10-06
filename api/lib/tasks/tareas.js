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
 *    (`REMOVE`), no se escribe vacío. El índice personal lleva abiertas y
 *    `hecha` con fecha (`hecha#…`); `cancelada`, `hecha` sin fecha y sin
 *    responsable salen. La vista personal acota con `< hecha#` y no filtra.
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
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  ESTADOS_TAREA,
  FECHA_SIN_LIMITE,
  MAX_CHECKLIST,
  MAX_PARTICIPANTES_TAREA,
  MAX_TAREAS_LOTE,
  PERMISOS,
  PK,
  PREFIJO_VENCIMIENTO_HECHA,
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
import { emailsDeUsuarios, nombreDe, nombresDeUsuarios } from './proyectos.js';
import {
  ACCIONES,
  AUTOR_SISTEMA,
  listarActividad,
  registrarActividad,
  registrarActividadLote,
} from './actividad.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';
import { crearNotificacion } from './notificaciones.js';
import { logger } from '../logger.js';
import {
  actualizarEvento as calendarActualizar,
  borrarEvento as calendarBorrar,
  cancelarInstanciaSerie,
  crearEvento as calendarCrear,
  disponible as calendarDisponible,
  truncarSerieHasta,
} from '../google/calendarClient.js';
import {
  fechasDeRecurrencia,
  normalizarRecurrencia,
  pkSerie,
  rruleDe,
  separarMiembros,
} from './recurrencia.js';
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

/** Ids que ven la tarea en su agenda, sin repetir al responsable. */
function idsParticipantes(tarea) {
  const responsable = texto(tarea?.responsable_id);
  return listaDeTexto(tarea?.participantes_ids).filter((id) => id !== responsable);
}

function esItemVista(item) {
  return item?.es_vista === true || texto(item?.SK).startsWith('VISTA#');
}

/** El índice siempre devuelve la clave de tabla; `id_tarea` puede no venir proyectado. */
function idTareaDeItem(item) {
  const directo = texto(item?.id_tarea);
  if (directo) return directo;
  const pk = texto(item?.PK);
  return pk.startsWith('TAREA#') ? pk.slice('TAREA#'.length) : '';
}

/**
 * Fila del índice personal de un participante. No copia título ni fecha: quien
 * lista hidrata `META`, y los avisos/el feed ignoran la fila porque no tiene
 * fecha. El orden sí va, para que caiga en el mismo día que la tarea.
 */
function itemVista(tarea, idUsuario) {
  const orden = vencimientoOrdenDe(tarea);
  const item = {
    PK: PK.tarea(tarea.id_tarea),
    SK: SK.vista(idUsuario),
    es_vista: true,
    id_tarea: texto(tarea.id_tarea),
    responsable_id: idUsuario,
  };
  if (orden) item.vencimiento_orden = orden;
  return item;
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

/** Hora `HH:mm` o cadena vacía. Criterio copiado de reuniones (`aHora`). */
function aHora(valor) {
  const bruto = texto(valor);
  if (!bruto) return '';
  if (!/^\d{2}:\d{2}$/.test(bruto)) return null;
  const [h, m] = bruto.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return bruto;
}

/**
 * Par `hora_inicio` / `hora_fin`: ambas o ninguna; fin estrictamente posterior.
 *
 * @returns {{ ok: true, hora_inicio: string, hora_fin: string } | { ok: false, error: string }}
 */
export function validarHorasPareja({ hora_inicio, hora_fin } = {}) {
  const hi = aHora(hora_inicio);
  if (hi === null) return { ok: false, error: 'La hora de inicio debe ser HH:mm' };
  const hf = aHora(hora_fin);
  if (hf === null) return { ok: false, error: 'La hora de fin debe ser HH:mm' };
  if ((hi && !hf) || (!hi && hf)) {
    return { ok: false, error: 'Indica hora de inicio y de fin, o ninguna' };
  }
  if (hi && hf) {
    const [h1, m1] = hi.split(':').map(Number);
    const [h2, m2] = hf.split(':').map(Number);
    if (h2 * 60 + m2 <= h1 * 60 + m1) {
      return { ok: false, error: 'La hora de fin tiene que ser posterior a la de inicio' };
    }
  }
  return { ok: true, hora_inicio: hi, hora_fin: hf };
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
    participantes_ids: Array.isArray(resto.participantes_ids) ? resto.participantes_ids : [],
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

/** Avisa a quien verá la tarea en su agenda sin ser el responsable. */
async function notificarParticipantes({ tarea, actorId }) {
  const actor = texto(actorId);
  const tituloTarea = texto(tarea?.titulo) || 'Tarea';
  for (const dest of idsParticipantes(tarea)) {
    if (!dest || dest === actor) continue;
    try {
      await crearNotificacion({
        usuarioId: dest,
        tipo: 'asignacion',
        titulo: `También te aparece: ${tituloTarea}`,
        cuerpo: `La añadió ${texto(tarea?.asignada_por_nombre) || 'un compañero'} a tu agenda`,
        entidad_ref: { tipo: 'tarea', id: texto(tarea?.id_tarea), etiqueta: tituloTarea },
      });
    } catch (err) {
      logger.warn({ err, destinatarioId: dest }, '[tareas] No se pudo avisar a un participante');
    }
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
async function escribirMeta(idTarea, cambios, extra = {}) {
  const nombres = { '#pk': 'PK', ...(extra.nombres || {}) };
  const valores = { ...(extra.valores || {}) };
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
        ConditionExpression: extra.condicion
          ? `attribute_exists(#pk) AND (${extra.condicion})`
          : 'attribute_exists(#pk)',
        ...(Object.keys(valores).length > 0 && { ExpressionAttributeValues: valores }),
        ReturnValues: 'ALL_NEW',
      }),
    );
    const attrs = res.Attributes || null;
    const tocaVistas = ['estado', 'fecha_limite', 'responsable_id', 'participantes_ids'].some((campo) =>
      Object.prototype.hasOwnProperty.call(cambios, campo),
    );
    if (attrs && tocaVistas) await guardarVistas(attrs);
    return attrs;
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
  // vista personal de nadie y se queda sin hacer. El resto de personas van en
  // `participantes_ids`: ven la misma tarea, no una copia.
  const responsableId = texto(bruto.responsable_id);
  if (!responsableId) return { ok: false, error: 'La tarea necesita una persona responsable' };
  const participantes = listaDeTexto(bruto.participantes_ids).filter((id) => id !== responsableId);
  if (participantes.length > MAX_PARTICIPANTES_TAREA) {
    return {
      ok: false,
      error: `Una tarea admite como máximo ${MAX_PARTICIPANTES_TAREA} personas además del responsable`,
    };
  }

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

  const horas = validarHorasPareja({
    hora_inicio: bruto.hora_inicio,
    hora_fin: bruto.hora_fin,
  });
  if (!horas.ok) return horas;

  const checklist = normalizarChecklistEntrante(bruto.checklist);
  if (!checklist.ok) return checklist;

  return {
    ok: true,
    datos: {
      titulo,
      descripcion: texto(bruto.descripcion),
      estado,
      responsable_id: responsableId,
      participantes_ids: participantes,
      departamento_id: texto(bruto.departamento_id),
      fecha_limite: fechaLimite,
      hora_inicio: horas.hora_inicio,
      hora_fin: horas.hora_fin,
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

// ─── Google Calendar (D-21: no tumba la tarea) ───

const CAMPOS_SYNC_CALENDARIO = ['titulo', 'descripcion', 'fecha_limite', 'hora_inicio', 'hora_fin'];

function syncCalendarDe(resultado) {
  return {
    calendario_sincronizado: !!(resultado && resultado.ok && resultado.eventId),
    calendar_event_id: resultado?.eventId || null,
    calendar_id: resultado?.calendarId || null,
    calendario_error: resultado?.ok ? null : texto(resultado?.error) || null,
  };
}

function syncDesdeMeta(meta) {
  const eventId = texto(meta?.calendar_event_id) || null;
  return {
    calendario_sincronizado: Boolean(eventId),
    calendar_event_id: eventId,
    calendar_id: texto(meta?.calendar_id) || null,
    calendario_error: null,
  };
}

async function emailDeResponsable(responsableId) {
  const id = texto(responsableId);
  if (!id) return '';
  const mapa = await emailsDeUsuarios([id]);
  return mapa.get(id) || '';
}

async function emailsDeParticipantes(tarea) {
  const ids = idsParticipantes(tarea);
  if (ids.length === 0) return [];
  const mapa = await emailsDeUsuarios(ids);
  const organizador = (await emailDeResponsable(tarea?.responsable_id)).toLowerCase();
  const emails = [];
  const vistos = new Set();
  for (const id of ids) {
    const email = texto(mapa.get(id)).toLowerCase();
    if (!email || email === organizador || vistos.has(email)) continue;
    vistos.add(email);
    emails.push(email);
  }
  return emails;
}

function datosEventoTarea(tarea, organizadorEmail, { alta = false, asistentesEmails = [] } = {}) {
  const serie = Boolean(texto(tarea?.recurrencia_id));
  const rrule = texto(tarea?.recurrencia_rrule);
  return {
    titulo: texto(tarea?.titulo),
    descripcion: texto(tarea?.descripcion),
    fecha: texto(tarea?.ocurrencia_fecha) || texto(tarea?.fecha_limite),
    horaInicio: texto(tarea?.hora_inicio),
    horaFin: texto(tarea?.hora_fin),
    organizadorEmail: texto(organizadorEmail),
    conMeet: false,
    asistentesEmails,
    ...(alta && rrule ? { recurrence: [rrule] } : {}),
    // Editar una fecha de la serie no reescribe el inicio del evento recurrente.
    conservarHorario: serie && !alta,
  };
}

/**
 * Alta en Calendar del responsable. Fallo o ausencia → sync con error; no lanza.
 */
async function sincronizarAltaCalendar(tarea) {
  if (!calendarDisponible()) {
    return syncCalendarDe({ ok: false, error: 'Google Calendar no está configurado' });
  }
  const email = await emailDeResponsable(tarea?.responsable_id);
  if (!email) {
    return syncCalendarDe({ ok: false, error: 'El responsable no tiene email' });
  }
  if (!texto(tarea?.fecha_limite)) {
    return syncCalendarDe({ ok: false, error: 'La tarea no tiene fecha límite para el calendario' });
  }
  try {
    const asistentesEmails = await emailsDeParticipantes(tarea);
    const cal = await calendarCrear(datosEventoTarea(tarea, email, { alta: true, asistentesEmails }));
    return syncCalendarDe(cal);
  } catch (err) {
    return syncCalendarDe({ ok: false, error: err?.message || 'Error al sincronizar con Calendar' });
  }
}

/**
 * Actualiza o crea el evento tras un PATCH de campos de calendario.
 * Persiste `calendar_event_id` / `calendar_id` si el alta tiene éxito.
 */
async function sincronizarEdicionCalendar(tarea) {
  const eventId = texto(tarea?.calendar_event_id);
  if (!calendarDisponible()) {
    return {
      ...syncDesdeMeta(tarea),
      calendario_sincronizado: false,
      calendario_error: 'Google Calendar no está configurado',
    };
  }
  const email = await emailDeResponsable(tarea?.responsable_id);
  if (!email) {
    return {
      ...syncDesdeMeta(tarea),
      calendario_sincronizado: false,
      calendario_error: 'El responsable no tiene email',
    };
  }
  const asistentesEmails = await emailsDeParticipantes(tarea);

  if (eventId) {
    try {
      const cal = await calendarActualizar(eventId, datosEventoTarea(tarea, email, { asistentesEmails }));
      if (!cal.ok) {
        return {
          calendario_sincronizado: false,
          calendar_event_id: eventId,
          calendar_id: texto(tarea?.calendar_id) || null,
          calendario_error: texto(cal.error) || 'No se pudo actualizar el evento de Calendar',
        };
      }
      return syncCalendarDe({ ...cal, eventId: cal.eventId || eventId });
    } catch (err) {
      return {
        calendario_sincronizado: false,
        calendar_event_id: eventId,
        calendar_id: texto(tarea?.calendar_id) || null,
        calendario_error: err?.message || 'Error al sincronizar con Calendar',
      };
    }
  }

  if (!texto(tarea?.fecha_limite)) {
    return { ...syncDesdeMeta(tarea), calendario_sincronizado: false, calendario_error: null };
  }

  const sync = await sincronizarAltaCalendar(tarea);
  if (sync.calendario_sincronizado && sync.calendar_event_id) {
    const guardado = await escribirMeta(tarea.id_tarea, {
      calendar_event_id: sync.calendar_event_id,
      calendar_id: sync.calendar_id || '',
    });
    if (guardado) {
      return { sync, meta: guardado };
    }
  }
  return { sync };
}

/** Intenta borrar el evento; nunca lanza. */
async function intentarBorrarEventoCalendar(meta) {
  const eventId = texto(meta?.calendar_event_id);
  if (!eventId) return { ok: true };
  try {
    const email = await emailDeResponsable(meta?.responsable_id);
    const cal = await calendarBorrar(eventId, { organizadorEmail: email || undefined });
    if (!cal.ok) {
      logger.warn(
        { eventId, error: cal.error },
        '[tareas] No se pudo borrar el evento de Calendar',
      );
    }
    return cal;
  } catch (err) {
    logger.warn({ err, eventId }, '[tareas] Error al borrar el evento de Calendar');
    return { ok: false, error: err?.message || 'Error al borrar el evento de Calendar' };
  }
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
  // El lote y las plantillas pueden nacer sin plazo; el alta individual, no.
  if (!validado.datos.fecha_limite) {
    return { ok: false, status: 400, error: 'La fecha límite es obligatoria' };
  }

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

  const rec = normalizarRecurrencia(datos.recurrencia);
  if (!rec.ok) return { ok: false, status: 400, error: rec.error };
  if (rec.regla) {
    if (idPadre) return { ok: false, status: 400, error: 'Una subtarea no se puede repetir' };
    return crearSerieTareas({ ctx, acceso, plantilla: tarea, regla: rec.regla });
  }

  await docClient.send(new PutCommand({ TableName: tables.tareas, Item: itemTarea(tarea) }));
  await guardarVistas(tarea);

  // D-21: Calendar no tumba la tarea.
  let sync = await sincronizarAltaCalendar(tarea);
  let metaGuardada = itemTarea(tarea);
  if (sync.calendario_sincronizado && sync.calendar_event_id) {
    const conCal = await escribirMeta(tarea.id_tarea, {
      calendar_event_id: sync.calendar_event_id,
      calendar_id: sync.calendar_id || '',
    });
    if (conCal) metaGuardada = conCal;
  }

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
      calendario_sincronizado: sync.calendario_sincronizado,
    },
  });

  await notificarAsignacion({
    destinatarioId: tarea.responsable_id,
    actorId: ctx?.idUsuario,
    tarea: { ...tarea, asignada_por_nombre: texto(ctx?.nombre) },
  });
  await notificarParticipantes({
    tarea: { ...tarea, asignada_por_nombre: texto(ctx?.nombre) },
    actorId: ctx?.idUsuario,
  });

  const nombres = await nombresDeUsuarios([tarea.responsable_id]);
  return {
    ok: true,
    tarea: salidaConExtras(metaGuardada, ctx, { aux: acceso.aux, nombres }),
    ...sync,
  };
}

function copiarChecklist(lista) {
  return (Array.isArray(lista) ? lista : []).map((e) => ({
    id: crypto.randomUUID(),
    texto: e.texto,
    hecho: false,
    orden: e.orden,
  }));
}

/**
 * Materializa la serie en fichas y deja un solo evento recurrente en Google.
 * Calendar no tumba el alta (D-21): si falla, las fichas quedan igual.
 */
async function crearSerieTareas({ ctx, acceso, plantilla, regla }) {
  const fechas = fechasDeRecurrencia(plantilla.fecha_limite, regla);
  if (fechas.length === 0) {
    return { ok: false, status: 400, error: 'Esa repetición no genera ninguna fecha' };
  }
  const recId = crypto.randomUUID();
  const rrule = rruleDe(regla, fechas[0]);
  const tareas = fechas.map((fecha, i) => {
    const base = i === 0 ? plantilla : { ...plantilla, id_tarea: crypto.randomUUID() };
    return {
      ...base,
      fecha_limite: fecha,
      ocurrencia_fecha: fecha,
      recurrencia_id: recId,
      recurrencia_frecuencia: regla.frecuencia,
      ...(regla.dias_semana?.length ? { recurrencia_dias_semana: regla.dias_semana } : {}),
      ...(regla.dias_mes?.length ? { recurrencia_dias_mes: regla.dias_mes } : {}),
      recurrencia_rrule: rrule,
      checklist: i === 0 ? plantilla.checklist : copiarChecklist(plantilla.checklist),
    };
  });

  const ancla = { ...tareas[0] };
  let sync = await sincronizarAltaCalendar(ancla);
  const eventId = sync.calendario_sincronizado ? texto(sync.calendar_event_id) : '';
  const calendarId = texto(sync.calendar_id);
  if (eventId) {
    for (const t of tareas) {
      t.calendar_event_id = eventId;
      if (calendarId) t.calendar_id = calendarId;
    }
  }

  const items = tareas.flatMap((t) => [
    itemTarea(t),
    ...idsParticipantes(t).map((idUsuario) => itemVista(t, idUsuario)),
  ]);
  items.push({
    PK: pkSerie(recId),
    SK: SK.meta,
    recurrencia_id: recId,
    tipo: 'tarea',
    frecuencia: regla.frecuencia,
    ...(regla.dias_semana?.length ? { dias_semana: regla.dias_semana } : {}),
    ...(regla.dias_mes?.length ? { dias_mes: regla.dias_mes } : {}),
    rrule,
    ...(eventId ? { calendar_event_id: eventId } : {}),
    ...(calendarId ? { calendar_id: calendarId } : {}),
    miembros: tareas.map((t) => ({ id: t.id_tarea, fecha: t.ocurrencia_fecha })),
  });
  const noEscritos = await escribirEnLotes(items);
  if (noEscritos.length > 0) {
    return { ok: false, status: 500, error: 'No se pudo guardar toda la serie' };
  }

  await registrarActividad({
    tipo: 'tarea',
    entidadId: ancla.id_tarea,
    accion: ACCIONES.creada,
    usuario: autorDe(ctx),
    detalle: {
      titulo: ancla.titulo,
      responsable_id: ancla.responsable_id,
      proyecto_id: ancla.proyecto_id || null,
      fecha_limite: ancla.fecha_limite || null,
      recurrencia_id: recId,
      ocurrencias: tareas.length,
      calendario_sincronizado: sync.calendario_sincronizado,
    },
  });
  await notificarAsignacion({
    destinatarioId: ancla.responsable_id,
    actorId: ctx?.idUsuario,
    tarea: { ...ancla, asignada_por_nombre: texto(ctx?.nombre) },
  });
  await notificarParticipantes({
    tarea: { ...ancla, asignada_por_nombre: texto(ctx?.nombre) },
    actorId: ctx?.idUsuario,
  });

  const nombres = await nombresDeUsuarios([ancla.responsable_id]);
  return {
    ok: true,
    tarea: salidaConExtras(itemTarea(tareas[0]), ctx, { aux: acceso.aux, nombres }),
    ...sync,
  };
}

async function leerSerieTarea(recId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.tareas,
      Key: { PK: pkSerie(recId), SK: SK.meta },
    }),
  );
  return r.Item || null;
}

async function guardarSerieTarea(serie, miembros) {
  const item = { ...serie, miembros, SK: SK.meta, PK: serie.PK || pkSerie(serie.recurrencia_id) };
  if (!miembros.length) {
    await docClient.send(new DeleteCommand({ TableName: tables.tareas, Key: { PK: item.PK, SK: SK.meta } }));
    return;
  }
  await docClient.send(new PutCommand({ TableName: tables.tareas, Item: item }));
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

async function borrarClavesTarea(claves) {
  for (let i = 0; i < claves.length; i += MAX_LOTE_ESCRITURA) {
    let pendientes = claves
      .slice(i, i + MAX_LOTE_ESCRITURA)
      .map((Key) => ({ DeleteRequest: { Key } }));
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tables.tareas]: pendientes } }),
      );
      pendientes = res?.UnprocessedItems?.[tables.tareas] || [];
    }
    if (pendientes.length > 0) {
      throw new Error('No se pudo actualizar la agenda de los participantes');
    }
  }
}

/**
 * Reescribe las filas `VISTA#` para que el índice personal de cada participante
 * siga el mismo día y el mismo estado que la ficha. Si el orden desaparece
 * (cancelada, hecha sin fecha), la fila se queda fuera del índice.
 */
async function guardarVistas(tarea) {
  const id = texto(tarea?.id_tarea);
  if (!id) return;
  const ids = idsParticipantes(tarea);
  const existentes = await consultarTodo({
    TableName: tables.tareas,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK.tarea(id), ':sk': 'VISTA#' },
    ProjectionExpression: 'PK, SK',
  });
  const quieren = new Set(ids.map((idUsuario) => SK.vista(idUsuario)));
  const sobran = existentes
    .filter((it) => !quieren.has(texto(it.SK)))
    .map((it) => ({ PK: it.PK, SK: it.SK }));
  if (sobran.length > 0) await borrarClavesTarea(sobran);
  if (ids.length > 0) {
    const noEscritos = await escribirEnLotes(
      ids.map((idUsuario) => itemVista({ ...tarea, id_tarea: id }, idUsuario)),
    );
    if (noEscritos.length > 0) {
      throw new Error('No se pudo actualizar la agenda de los participantes');
    }
  }
}

async function leerMetasPorId(ids) {
  const unicos = [...new Set(ids.map(texto).filter(Boolean))];
  const out = [];
  for (let i = 0; i < unicos.length; i += 100) {
    let Keys = unicos.slice(i, i + 100).map((idTarea) => ({ PK: PK.tarea(idTarea), SK: SK.meta }));
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && Keys.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchGetCommand({ RequestItems: { [tables.tareas]: { Keys } } }),
      );
      out.push(...(res.Responses?.[tables.tareas] || []));
      Keys = res.UnprocessedKeys?.[tables.tareas]?.Keys || [];
    }
  }
  return out;
}

/**
 * La query del índice mezcla fichas (`META`) y punteros (`VISTA#`). Los punteros
 * se sustituyen por la ficha, que es la que tiene título, estado y checklist.
 */
/**
 * En la agenda propia, si todas las fichas son de quien pregunta, su nombre ya
 * viene en el contexto y no hace falta leer usuarios. Si hay tareas de otras
 * personas (participa sin ser responsable), sí se resuelven en un lote.
 */
async function nombresDeFichas(ctx, fichas) {
  const yo = texto(ctx?.idUsuario);
  const ids = [...new Set(fichas.map((t) => texto(t.responsable_id)).filter(Boolean))];
  if (ids.every((id) => id === yo)) {
    return new Map(yo ? [[yo, texto(ctx?.nombre) || null]] : []);
  }
  return nombresDeUsuarios(ids);
}

async function fichasDeIndice(items) {
  const idsVista = [];
  for (const it of items) {
    if (esItemVista(it)) {
      const id = idTareaDeItem(it);
      if (id) idsVista.push(id);
    }
  }
  const leidas = idsVista.length > 0 ? await leerMetasPorId(idsVista) : [];
  const porId = new Map();
  for (const t of leidas) {
    const id = texto(t.id_tarea);
    if (id) porId.set(id, t);
  }
  const orden = [];
  const vistos = new Set();
  for (const it of items) {
    const id = idTareaDeItem(it);
    if (!id || vistos.has(id)) continue;
    const ficha = esItemVista(it) ? porId.get(id) : it;
    if (!ficha || esItemVista(ficha)) continue;
    orden.push(ficha);
    vistos.add(id);
  }
  return orden;
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
    for (const idUsuario of idsParticipantes(tarea)) items.push(itemVista(tarea, idUsuario));
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
      await notificarParticipantes({
        tarea: { ...tarea, asignada_por_nombre: nombreActor },
        actorId: creadoPor,
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
 * El índice también guarda `hecha` con prefijo `hecha#` (D-34). Aquí no se
 * filtra por estado: la KeyCondition `vencimiento_orden < hecha#` deja fuera
 * ese prefijo. Tampoco hace falta filtrar por visibilidad: ser la persona
 * responsable siempre da acceso.
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
      KeyConditionExpression: 'responsable_id = :r AND vencimiento_orden < :tope',
      ExpressionAttributeValues: { ':r': idUsuario, ':tope': PREFIJO_VENCIMIENTO_HECHA },
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  const fichas = await fichasDeIndice(res.Items || []);
  // Los proyectos de la página en una sola lectura. Aquí no se necesitan para
  // decidir visibilidad —ser la responsable o participante ya la da—, sino para
  // el nombre del proyecto y los permisos de fila.
  const proyectos = await proyectosDeLaPagina(ctx, fichas);
  const nombres = await nombresDeFichas(ctx, fichas);

  return {
    ok: true,
    tareas: fichas.map((t) => salidaConExtras(t, ctx, { aux: auxDeMapa(proyectos, t), nombres })),
    vencidas: await contarVencidas(idUsuario),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

/**
 * Hechas de quien pregunta cuyo sort key cae en el rango de fechas (calendario).
 *
 * Exige `desde` y `hasta` ISO (`YYYY-MM-DD`). No mezcla abiertas: BETWEEN sobre
 * `hecha#<desde>#` … `hecha#<hasta>#\uffff`. Sin recuento de vencidas.
 *
 * @returns {Promise<{ ok: true, tareas: object[], cursor: string|null } | Fallo>}
 */
export async function listarMisTareasHechas({ ctx, desde: fechaDesde, hasta: fechaHasta, limite, cursor } = {}) {
  const idUsuario = texto(ctx?.idUsuario);
  if (!idUsuario) return { ok: false, status: 403, error: 'No hay sesión' };
  if (!esFechaIso(fechaDesde) || !esFechaIso(fechaHasta)) {
    return {
      ok: false,
      status: 400,
      error: 'Para consultar las tareas hechas hay que indicar desde y hasta en formato AAAA-MM-DD',
    };
  }

  const inicioCursor = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      IndexName: IDX_RESPONSABLE,
      KeyConditionExpression: 'responsable_id = :r AND vencimiento_orden BETWEEN :desde AND :hasta',
      ExpressionAttributeValues: {
        ':r': idUsuario,
        ':desde': `${PREFIJO_VENCIMIENTO_HECHA}${fechaDesde}#`,
        ':hasta': `${PREFIJO_VENCIMIENTO_HECHA}${fechaHasta}#\uffff`,
      },
      Limit: limiteValido(limite),
      ...(inicioCursor && { ExclusiveStartKey: inicioCursor }),
    }),
  );

  const fichas = await fichasDeIndice(res.Items || []);
  const proyectos = await proyectosDeLaPagina(ctx, fichas);
  const nombres = await nombresDeFichas(ctx, fichas);

  return {
    ok: true,
    tareas: fichas.map((t) => salidaConExtras(t, ctx, { aux: auxDeMapa(proyectos, t), nombres })),
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
    // El histórico por persona sigue cerrado (D-34): las hechas del índice
    // personal solo se ven por `/tareas/mias?incluir_hechas=1`.
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
        KeyConditionExpression: 'responsable_id = :h AND vencimiento_orden < :tope',
        ...filtroDeIgualdades(
          { estado, departamento_id: departamento },
          { ':h': responsable, ':tope': PREFIJO_VENCIMIENTO_HECHA },
        ),
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

  // `VISTA#` no es una tarea de la que esa persona sea responsable.
  const { visibles, proyectos } = await visiblesConProyectos(
    ctx,
    (res.Items || []).filter((it) => !esItemVista(it)),
  );
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
const CAMPOS_EDITABLES = [
  'titulo',
  'descripcion',
  'fecha_limite',
  'hora_inicio',
  'hora_fin',
  'prioridad',
  'departamento_id',
  'menciones',
];

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
    if (!fecha) {
      return { ok: false, status: 400, error: 'La fecha límite es obligatoria' };
    }
    if (!esFechaIso(fecha)) {
      return { ok: false, status: 400, error: 'La fecha límite debe ser una fecha en formato AAAA-MM-DD' };
    }
    nuevos.fecha_limite = fecha;
  }
  if (cambios.hora_inicio !== undefined || cambios.hora_fin !== undefined) {
    const horas = validarHorasPareja({
      hora_inicio: cambios.hora_inicio !== undefined ? cambios.hora_inicio : meta.hora_inicio,
      hora_fin: cambios.hora_fin !== undefined ? cambios.hora_fin : meta.hora_fin,
    });
    if (!horas.ok) return { ok: false, status: 400, error: horas.error };
    nuevos.hora_inicio = horas.hora_inicio;
    nuevos.hora_fin = horas.hora_fin;
  }
  if (cambios.prioridad !== undefined) {
    const prioridad = texto(cambios.prioridad);
    if (!enLista(PRIORIDADES, prioridad)) {
      return { ok: false, status: 400, error: `Prioridad no válida: «${prioridad}»` };
    }
    nuevos.prioridad = prioridad;
  }
  if (cambios.departamento_id !== undefined) nuevos.departamento_id = texto(cambios.departamento_id);
  let participantesNuevos = [];
  if (cambios.participantes_ids !== undefined) {
    const participantes = listaDeTexto(cambios.participantes_ids).filter(
      (id) => id !== texto(meta.responsable_id),
    );
    if (participantes.length > MAX_PARTICIPANTES_TAREA) {
      return {
        ok: false,
        status: 400,
        error: `Una tarea admite como máximo ${MAX_PARTICIPANTES_TAREA} personas además del responsable`,
      };
    }
    const antesIds = idsParticipantes(meta).slice().sort().join('\0');
    const ahoraIds = participantes.slice().sort().join('\0');
    if (antesIds !== ahoraIds) {
      nuevos.participantes_ids = participantes;
      participantesNuevos = participantes.filter((id) => !idsParticipantes(meta).includes(id));
    }
  }
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

  if (participantesNuevos.length > 0) {
    await notificarParticipantes({
      tarea: {
        ...guardado,
        participantes_ids: participantesNuevos,
        asignada_por_nombre: texto(ctx?.nombre),
      },
      actorId: ctx?.idUsuario,
    });
  }

  let metaFinal = guardado;
  let sync = null;
  const tocaCalendar =
    CAMPOS_SYNC_CALENDARIO.some((c) => nuevos[c] !== undefined) ||
    nuevos.participantes_ids !== undefined;
  if (tocaCalendar) {
    const r = await sincronizarEdicionCalendar({
      ...guardado,
      id_tarea: texto(idTarea),
    });
    if (r.meta) metaFinal = r.meta;
    sync = r.sync || r;
  }

  const nombres = await nombresDeUsuarios([metaFinal?.responsable_id]);
  return {
    ok: true,
    tarea: salidaConExtras(metaFinal, ctx, { aux: acceso.aux, nombres }),
    ...(sync || {}),
  };
}

/**
 * Pasa el vencimiento de una tarea abierta a `hoy` y sincroniza Google Calendar
 * igual que un cambio de fecha hecho a mano.
 *
 * La condición de la escritura mira el ítem que hay ahora: si entre la lectura y
 * el update alguien la cerró o ya le puso la fecha de hoy, no se pisa. La hora
 * no se toca. Un fallo de Calendar no deshace la fecha.
 *
 * @param {string} idTarea
 * @param {string} hoy `YYYY-MM-DD` en Madrid
 * @returns {Promise<{ ok: true, arrastrada: boolean, calendario_error: string|null } | { ok: false, error: string }>}
 */
export async function arrastrarFechaLimiteAHoy(idTarea, hoy) {
  const id = texto(idTarea);
  const dia = texto(hoy);
  if (!id || !esFechaIso(dia)) return { ok: false, error: 'Falta la tarea o el día' };

  const meta = await leerMeta(id);
  if (!meta) return { ok: true, arrastrada: false, calendario_error: null };
  if (esEstadoTareaTerminal(meta.estado)) return { ok: true, arrastrada: false, calendario_error: null };

  const fecha = texto(meta.fecha_limite);
  if (!esFechaIso(fecha) || fecha === FECHA_SIN_LIMITE || fecha >= dia) {
    // Una vista atrasada vuelve a entrar en el arrastre aunque la ficha ya esté al día.
    if (idsParticipantes(meta).length > 0) await guardarVistas(meta);
    return { ok: true, arrastrada: false, calendario_error: null };
  }

  const guardado = await escribirMeta(
    id,
    {
      fecha_limite: dia,
      actualizado_en: ahora(),
      ...clavesDerivadas({ ...meta, fecha_limite: dia }),
    },
    {
      condicion: '#est <> :hecha AND #est <> :cancelada AND #fl < :hoy',
      nombres: { '#est': 'estado', '#fl': 'fecha_limite' },
      valores: { ':hecha': 'hecha', ':cancelada': 'cancelada', ':hoy': dia },
    },
  );
  if (!guardado) return { ok: true, arrastrada: false, calendario_error: null };

  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.editada,
    usuario: { id_usuario: AUTOR_SISTEMA, nombre: 'Sistema' },
    detalle: {
      motivo: 'arrastre_vencimiento',
      antes: { fecha_limite: fecha },
      despues: { fecha_limite: dia },
    },
  });

  // Una serie es un solo evento en Google. Mover esta fecha no desplaza las demás.
  if (texto(guardado.recurrencia_id)) {
    return { ok: true, arrastrada: true, calendario_error: null };
  }

  const r = await sincronizarEdicionCalendar({ ...guardado, id_tarea: id });
  const sync = r.sync || r;
  return {
    ok: true,
    arrastrada: true,
    calendario_error: texto(sync?.calendario_error) || null,
  };
}

/**
 * Copia título, fecha y hora desde Google sin volver a escribir el evento.
 * Así un cambio hecho en Calendar no rebota y no se pisan en bucle.
 * Un evento borrado en Google no borra la tarea.
 *
 * @param {string} idTarea
 * @param {{ titulo?: string, fecha?: string, horaInicio?: string, horaFin?: string }} remoto
 */
export async function aplicarEventoCalendarEnTarea(idTarea, remoto = {}) {
  const id = texto(idTarea);
  const meta = await leerMeta(id);
  if (!meta || esEstadoTareaTerminal(meta.estado)) return { ok: true, aplicada: false };

  const cambios = {};
  const titulo = texto(remoto.titulo);
  if (titulo && titulo !== texto(meta.titulo)) cambios.titulo = titulo;
  const fecha = texto(remoto.fecha);
  const ancla = texto(meta.ocurrencia_fecha);
  const mostrada = texto(meta.fecha_limite);
  // Si el arrastre ya movió esta fecha, Google sigue en el hueco original y no la pisa.
  const desplazada = Boolean(ancla) && Boolean(mostrada) && ancla !== mostrada;
  if (!desplazada && esFechaIso(fecha) && fecha !== mostrada) {
    cambios.fecha_limite = fecha;
    if (ancla) cambios.ocurrencia_fecha = fecha;
  }

  const hi = texto(remoto.horaInicio);
  const hf = texto(remoto.horaFin);
  const parValido = (hi && hf) || (!hi && !hf);
  if (parValido && (hi !== texto(meta.hora_inicio) || hf !== texto(meta.hora_fin))) {
    cambios.hora_inicio = hi;
    cambios.hora_fin = hf;
  }
  if (Object.keys(cambios).length === 0) return { ok: true, aplicada: false };

  const guardado = await escribirMeta(id, {
    ...cambios,
    actualizado_en: ahora(),
    ...clavesDerivadas({ ...meta, ...cambios }),
  });
  if (!guardado) return { ok: true, aplicada: false };

  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.editada,
    usuario: { id_usuario: AUTOR_SISTEMA, nombre: 'Sistema' },
    detalle: { motivo: 'calendar_entrante', campos: Object.keys(cambios) },
  });
  return { ok: true, aplicada: true };
}

/**
 * Una instancia cancelada en Google cierra solo esa fecha de la serie.
 * No borra la ficha ni el resto de ocurrencias.
 */
export async function cancelarOcurrenciaDesdeCalendar(idTarea) {
  const id = texto(idTarea);
  const meta = await leerMeta(id);
  if (!meta || !texto(meta.recurrencia_id) || esEstadoTareaTerminal(meta.estado)) {
    return { ok: true, aplicada: false };
  }
  const instante = ahora();
  const guardado = await escribirMeta(id, {
    estado: 'cancelada',
    cerrada_en: instante,
    actualizado_en: instante,
    ...clavesDerivadas({ ...meta, estado: 'cancelada' }),
  });
  if (!guardado) return { ok: true, aplicada: false };
  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.estadoCambiado,
    usuario: { id_usuario: AUTOR_SISTEMA, nombre: 'Sistema' },
    detalle: { motivo: 'calendar_entrante', estado_antes: meta.estado, estado_despues: 'cancelada' },
  });
  return { ok: true, aplicada: true };
}

/**
 * Crea una tarea a partir de un evento que ya existe en Google.
 * No llama a Calendar: el evento ya está y volver a crearlo lo duplicaría.
 *
 * @param {{ responsableId: string, eventId: string, calendarId?: string, titulo: string, fecha: string, horaInicio?: string, horaFin?: string }} datos
 */
export async function crearTareaDesdeEventoCalendar(datos = {}) {
  const eventId = texto(datos.eventId);
  const fecha = texto(datos.fecha);
  if (!eventId) return { ok: false, error: 'Falta el evento de Calendar' };
  if (!esFechaIso(fecha)) return { ok: false, error: 'La fecha del evento no es válida' };

  const hi = texto(datos.horaInicio);
  const hf = texto(datos.horaFin);
  const horas = hi && hf ? { hora_inicio: hi, hora_fin: hf } : { hora_inicio: '', hora_fin: '' };

  const validado = validarDatosTarea({
    titulo: texto(datos.titulo),
    responsable_id: texto(datos.responsableId),
    fecha_limite: fecha,
    ...horas,
  });
  if (!validado.ok) return { ok: false, error: validado.error };

  const instante = ahora();
  const tarea = {
    ...validado.datos,
    id_tarea: crypto.randomUUID(),
    calendar_event_id: eventId,
    calendar_id: texto(datos.calendarId),
    creado_por: AUTOR_SISTEMA,
    creado_en: instante,
    actualizado_en: instante,
  };

  await docClient.send(new PutCommand({ TableName: tables.tareas, Item: itemTarea(tarea) }));

  await registrarActividad({
    tipo: 'tarea',
    entidadId: tarea.id_tarea,
    accion: ACCIONES.creada,
    usuario: { id_usuario: AUTOR_SISTEMA, nombre: 'Sistema' },
    detalle: {
      motivo: 'calendar_entrante',
      titulo: tarea.titulo,
      responsable_id: tarea.responsable_id,
      fecha_limite: tarea.fecha_limite,
      calendar_event_id: eventId,
    },
  });

  await notificarAsignacion({
    destinatarioId: tarea.responsable_id,
    actorId: AUTOR_SISTEMA,
    tarea,
  });

  return { ok: true, creada: true, id_tarea: tarea.id_tarea };
}

/**
 * Cambia el estado de una tarea.
 *
 * Las transiciones las decide `transicionTareaPermitida`, y una no permitida es
 * `422`, no `400`: la petición está bien formada, es el estado el que no la
 * admite. `hecha` con fecha se queda en el índice con prefijo `hecha#`;
 * `cancelada` o `hecha` sin fecha hacen `REMOVE`. Reabrir restaura `fecha#id`.
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

  const participantes = listaDeTexto(meta.participantes_ids).filter((id) => id !== nuevo);
  const actualizado = { ...salida(meta), responsable_id: nuevo, participantes_ids: participantes };
  const guardado = await escribirMeta(idTarea, {
    responsable_id: nuevo,
    participantes_ids: participantes,
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

  // Una ficha de serie comparte el evento recurrente. Reasignarla no puede
  // borrar esa RRULE ni crear otra: el calendario de la serie se queda.
  if (texto(meta.recurrencia_id)) {
    const nombres = await nombresDeUsuarios([nuevo]);
    return {
      ok: true,
      tarea: salidaConExtras(guardado, ctx, { aux: acceso.aux, nombres }),
      ...syncDesdeMeta(guardado),
    };
  }

  // Reasignar: quitar el evento del calendario anterior e intentar crear en el nuevo.
  let sync = syncDesdeMeta(guardado);
  const eventIdAnterior = texto(meta.calendar_event_id);
  if (eventIdAnterior) {
    await intentarBorrarEventoCalendar(meta);
  }

  const paraAlta = {
    ...guardado,
    id_tarea: texto(idTarea),
    responsable_id: nuevo,
    calendar_event_id: '',
    calendar_id: '',
  };
  const alta = await sincronizarAltaCalendar(paraAlta);
  if (alta.calendario_sincronizado && alta.calendar_event_id) {
    const conCal = await escribirMeta(idTarea, {
      calendar_event_id: alta.calendar_event_id,
      calendar_id: alta.calendar_id || '',
    });
    sync = alta;
    if (!conCal) {
      await intentarBorrarEventoCalendar({
        calendar_event_id: alta.calendar_event_id,
        responsable_id: nuevo,
      });
    }
    if (conCal) {
      const nombres = await nombresDeUsuarios([nuevo]);
      return {
        ok: true,
        tarea: salidaConExtras(conCal, ctx, { aux: acceso.aux, nombres }),
        ...sync,
      };
    }
  } else {
    // Sin evento nuevo: limpiar ids del anterior si los había.
    if (eventIdAnterior) {
      const limpio = await escribirMeta(idTarea, {
        calendar_event_id: '',
        calendar_id: '',
      });
      sync = {
        calendario_sincronizado: false,
        calendar_event_id: null,
        calendar_id: null,
        calendario_error: alta.calendario_error || 'No se pudo crear el evento en el calendario del nuevo responsable',
      };
      if (limpio) {
        const nombres = await nombresDeUsuarios([nuevo]);
        return {
          ok: true,
          tarea: salidaConExtras(limpio, ctx, { aux: acceso.aux, nombres }),
          ...sync,
        };
      }
    } else {
      sync = {
        calendario_sincronizado: false,
        calendar_event_id: null,
        calendar_id: null,
        calendario_error: alta.calendario_error,
      };
    }
  }

  const nombres = await nombresDeUsuarios([nuevo]);
  return {
    ok: true,
    tarea: salidaConExtras(guardado, ctx, { aux: acceso.aux, nombres }),
    ...sync,
  };
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
export async function borrarTarea({ ctx, idTarea, alcance } = {}) {
  const acceso = await cargarParaVer(ctx, idTarea);
  if (!acceso.ok) return acceso;
  const id = texto(idTarea);
  if (texto(acceso.meta.recurrencia_id)) {
    return borrarOcurrenciasTarea({ ctx, meta: acceso.meta, alcance });
  }

  const bloqueo = await subtareasAbiertasDe(id);
  if (bloqueo) return bloqueo;

  // Calendar no tumba el borrado (D-21).
  await intentarBorrarEventoCalendar(acceso.meta);

  await borrarParticionTarea({
    ctx,
    idTarea: id,
    titulo: texto(acceso.meta.titulo),
    proyectoId: texto(acceso.meta.proyecto_id) || null,
  });
  return { ok: true };
}

async function subtareasAbiertasDe(idTarea) {
  const subtareas = await consultarTodo({
    TableName: tables.tareas,
    IndexName: IDX_PADRE,
    KeyConditionExpression: 'tarea_padre_id = :p',
    ExpressionAttributeValues: { ':p': texto(idTarea) },
  });
  const abiertas = subtareas.filter((s) => !esEstadoTareaTerminal(texto(s.estado)));
  if (abiertas.length === 0) return null;
  return {
    ok: false,
    status: 409,
    error: `La tarea tiene ${abiertas.length} subtarea(s) sin cerrar`,
  };
}

/**
 * `esta` borra solo esa fecha. `posteriores` borra esa y las que vienen detrás.
 * Las anteriores se quedan. Google cancela la instancia o acorta la RRULE.
 */
async function borrarOcurrenciasTarea({ ctx, meta, alcance }) {
  const id = texto(meta.id_tarea);
  const modo = alcance === 'posteriores' ? 'posteriores' : 'esta';
  const serie = await leerSerieTarea(meta.recurrencia_id);
  if (!serie) {
    const bloqueo = await subtareasAbiertasDe(id);
    if (bloqueo) return bloqueo;
    const email = await emailDeResponsable(meta.responsable_id);
    const eventId = texto(meta.calendar_event_id);
    if (eventId) {
      try {
        await cancelarInstanciaSerie({
          eventId,
          fecha: texto(meta.ocurrencia_fecha) || texto(meta.fecha_limite),
          organizadorEmail: email || undefined,
          calendarId: texto(meta.calendar_id) || undefined,
        });
      } catch (err) {
        logger.warn({ err, eventId }, '[tareas] No se pudo cancelar la fecha en Calendar');
      }
    }
    await borrarParticionTarea({
      ctx,
      idTarea: id,
      titulo: texto(meta.titulo),
      proyectoId: texto(meta.proyecto_id) || null,
    });
    return { ok: true };
  }
  const { borrar, quedar } = separarMiembros(serie?.miembros, {
    id,
    fecha: texto(meta.ocurrencia_fecha) || texto(meta.fecha_limite),
    alcance: modo,
  });

  for (const m of borrar) {
    const bloqueo = await subtareasAbiertasDe(m.id);
    if (bloqueo) return bloqueo;
  }

  const eventId = texto(meta.calendar_event_id) || texto(serie?.calendar_event_id);
  const email = await emailDeResponsable(meta.responsable_id);
  const datosCal = { organizadorEmail: email || undefined, calendarId: texto(meta.calendar_id) || undefined };
  if (eventId) {
    try {
      if (quedar.length === 0) await calendarBorrar(eventId, datosCal);
      else if (modo === 'posteriores') {
        await truncarSerieHasta({ eventId, fechaDesde: texto(meta.ocurrencia_fecha) || texto(meta.fecha_limite), ...datosCal });
      } else {
        await cancelarInstanciaSerie({
          eventId,
          fecha: texto(meta.ocurrencia_fecha) || texto(meta.fecha_limite),
          ...datosCal,
        });
      }
    } catch (err) {
      logger.warn({ err, eventId }, '[tareas] No se pudo ajustar la serie en Calendar');
    }
  }

  for (const m of borrar) {
    const fila = m.id === id ? meta : await leerMeta(m.id);
    if (!fila) continue;
    await borrarParticionTarea({
      ctx,
      idTarea: m.id,
      titulo: texto(fila.titulo) || texto(meta.titulo),
      proyectoId: texto(fila.proyecto_id) || null,
      origen: modo === 'posteriores' ? 'serie_posteriores' : 'serie_esta',
    });
  }
  if (serie) await guardarSerieTarea(serie, quedar);
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
    ProjectionExpression: 'id_tarea, titulo, proyecto_id, calendar_event_id, responsable_id',
  });
  const vistos = new Set();
  let borradas = 0;
  for (const meta of metas) {
    const idTarea = texto(meta.id_tarea);
    if (!idTarea || vistos.has(idTarea)) continue;
    vistos.add(idTarea);
    await intentarBorrarEventoCalendar(meta);
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
