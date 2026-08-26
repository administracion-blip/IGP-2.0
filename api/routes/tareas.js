/**
 * Tareas del módulo de dirección — `docs/tasks/03-contrato-api.md`, Fase 1A.
 *
 * Aquí solo hay HTTP: la lógica vive en `api/lib/tasks/tareas.js` y las
 * decisiones de acceso de fila en `api/lib/tasks/acceso.js`. El permiso global lo
 * pone `requirePermission` en la ruta; la ACL de fila la resuelve la capa de
 * acceso dentro de cada operación, que devuelve el `status` que toca.
 *
 * Sobre los códigos: `403` sin permiso, `404` cuando la tarea no existe **o no es
 * visible** (un `403` ya confirmaría que existe), `409` conflicto de estado y
 * `422` transición de estado no permitida.
 *
 * Los enlaces con captura y los adjuntos viven en `api/lib/tasks/enlaces.js` y
 * `api/lib/tasks/adjuntos.js`. Las reglas de la descarga en servidor —la parte
 * con protección contra SSRF— están documentadas en el primero: **no se tocan
 * sin leerlas**.
 */

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { cargarContextoAcceso } from '../lib/tasks/acceso.js';
import { PERMISOS } from '../lib/tasks/tipos.js';
import {
  actualizarElementoChecklist,
  actualizarTarea,
  anadirElementoChecklist,
  borrarElementoChecklist,
  borrarTarea,
  cambiarEstadoTarea,
  crearComentario,
  crearTarea,
  crearTareasEnLote,
  listarActividadTarea,
  listarComentarios,
  listarMisTareas,
  listarSubtareas,
  listarTareas,
  obtenerTareaDetalle,
  reasignarTarea,
} from '../lib/tasks/tareas.js';
import { anadirEnlace, borrarEnlace, recapturarEnlace, urlDeImagenEnlace } from '../lib/tasks/enlaces.js';
import {
  borrarAdjunto,
  confirmarAdjunto,
  presignarAdjunto,
  urlDeAdjunto,
} from '../lib/tasks/adjuntos.js';

const router = Router();

/** Campos que acepta el `PATCH`. El estado y el responsable tienen su propia ruta. */
const CAMPOS_PATCH = ['titulo', 'descripcion', 'fecha_limite', 'prioridad', 'departamento_id', 'menciones'];

/**
 * Traduce el fallo uniforme de la capa de lógica a HTTP. Devuelve `true` si ya ha
 * respondido, para que el handler solo tenga que salir.
 */
function fallo(res, resultado) {
  if (resultado.ok) return false;
  const cuerpo = { error: resultado.error };
  if (resultado.fallos) cuerpo.fallos = resultado.fallos;
  res.status(resultado.status).json(cuerpo);
  return true;
}

/** Contexto de acceso del usuario del token: una carga por petición, cacheada. */
function contexto(req) {
  return cargarContextoAcceso(req.user);
}

// ─── Vista personal ───

// Antes de `/tareas/:id`: si no, «mias» se tomaría por un id.
router.get('/tareas/mias', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await listarMisTareas({
    ctx: await contexto(req),
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (fallo(res, r)) return;
  return res.json({ tareas: r.tareas, vencidas: r.vencidas, cursor: r.cursor });
});

// ─── Listado y creación ───

router.get('/tareas', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await listarTareas({
    ctx: await contexto(req),
    filtros: {
      proyecto: req.query?.proyecto,
      responsable: req.query?.responsable,
      estado: req.query?.estado,
      departamento: req.query?.departamento,
    },
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (fallo(res, r)) return;
  return res.json({ tareas: r.tareas, cursor: r.cursor });
});

// Sin permiso de ruta, igual que el resto de las escrituras: crea tareas en un
// proyecto quien puede editarlo —incluido su responsable, que lo edita sin
// `proyectos.editar`— o quien tenga `tareas.editar_todas`. La tarea suelta, que
// no tiene proyecto contra el que decidir, sí exige `proyectos.editar`; las dos
// comprobaciones viven en `proyectoParaCrear`.
router.post('/tareas', async (req, res) => {
  const r = await crearTarea({ ctx: await contexto(req), datos: req.body || {} });
  if (fallo(res, r)) return;
  return res.json({ ok: true, tarea: r.tarea });
});

// El único camino de creación múltiple: lo usan la validación de propuestas de
// reunión y las plantillas de proyecto.
router.post('/tareas/lote', requirePermission(PERMISOS.proyectosEditar), async (req, res) => {
  const r = await crearTareasEnLote({
    ctx: await contexto(req),
    datos: req.body || {},
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, creadas: r.creadas, omitidas: r.omitidas });
});

// ─── Una tarea ───

router.get('/tareas/:id', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await obtenerTareaDetalle({ ctx: await contexto(req), idTarea: req.params.id });
  if (fallo(res, r)) return;
  return res.json({ tarea: r.tarea });
});

// Sin permiso de ruta: quien puede editar una tarea es su responsable, quien
// puede editar su proyecto o quien tenga `tareas.editar_todas`, y eso lo decide
// la capa de acceso con el proyecto delante.
router.patch('/tareas/:id', async (req, res) => {
  const body = req.body || {};
  const cambios = {};
  for (const campo of CAMPOS_PATCH) {
    if (body[campo] !== undefined) cambios[campo] = body[campo];
  }
  if (Object.keys(cambios).length === 0) {
    return res.status(400).json({ error: 'No hay nada que actualizar' });
  }
  const r = await actualizarTarea({
    ctx: await contexto(req),
    idTarea: req.params.id,
    cambios,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, tarea: r.tarea });
});

router.post('/tareas/:id/estado', async (req, res) => {
  const r = await cambiarEstadoTarea({
    ctx: await contexto(req),
    idTarea: req.params.id,
    estado: req.body?.estado,
    bloqueoMotivo: req.body?.bloqueo_motivo,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, tarea: r.tarea });
});

router.post('/tareas/:id/reasignar', async (req, res) => {
  const r = await reasignarTarea({
    ctx: await contexto(req),
    idTarea: req.params.id,
    responsableId: req.body?.responsable_id,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, tarea: r.tarea });
});

router.delete('/tareas/:id', requirePermission(PERMISOS.proyectosBorrar), async (req, res) => {
  const r = await borrarTarea({ ctx: await contexto(req), idTarea: req.params.id });
  if (fallo(res, r)) return;
  return res.json({ ok: true });
});

router.get('/tareas/:id/subtareas', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await listarSubtareas({
    ctx: await contexto(req),
    idTarea: req.params.id,
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (fallo(res, r)) return;
  return res.json({ tareas: r.tareas, cursor: r.cursor });
});

router.get('/tareas/:id/actividad', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await listarActividadTarea({
    ctx: await contexto(req),
    idTarea: req.params.id,
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (fallo(res, r)) return;
  return res.json({ actividad: r.actividad, cursor: r.cursor });
});

// ─── Lista de comprobación ───

// Marcar un elemento no cambia el estado de la tarea, y completarlos todos no la
// cierra: cerrarla es una decisión de la persona.
router.post('/tareas/:id/checklist', async (req, res) => {
  const r = await anadirElementoChecklist({
    ctx: await contexto(req),
    idTarea: req.params.id,
    texto: req.body?.texto,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, tarea: r.tarea });
});

router.patch('/tareas/:id/checklist/:itemId', async (req, res) => {
  const body = req.body || {};
  const cambios = {};
  for (const campo of ['texto', 'hecho', 'orden']) {
    if (body[campo] !== undefined) cambios[campo] = body[campo];
  }
  const r = await actualizarElementoChecklist({
    ctx: await contexto(req),
    idTarea: req.params.id,
    itemId: req.params.itemId,
    cambios,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, tarea: r.tarea });
});

router.delete('/tareas/:id/checklist/:itemId', async (req, res) => {
  const r = await borrarElementoChecklist({
    ctx: await contexto(req),
    idTarea: req.params.id,
    itemId: req.params.itemId,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, tarea: r.tarea });
});

// ─── Comentarios ───

router.get('/tareas/:id/comentarios', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await listarComentarios({
    ctx: await contexto(req),
    idTarea: req.params.id,
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (fallo(res, r)) return;
  return res.json({ comentarios: r.comentarios, cursor: r.cursor });
});

// Las `@menciones` se extraen y se guardan; en Fase 1A no se avisa a nadie.
router.post('/tareas/:id/comentarios', async (req, res) => {
  const r = await crearComentario({
    ctx: await contexto(req),
    idTarea: req.params.id,
    texto: req.body?.texto,
    menciones: req.body?.menciones,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, comentario: r.comentario });
});

// ─── Enlaces con captura ───

// Responde en cuanto el enlace está guardado en `pendiente`: la captura sigue
// por detrás y actualiza el ítem cuando termine. `r.captura` no se espera aquí a
// propósito; una web lenta no debe alargar esta respuesta.
router.post('/tareas/:id/enlaces', async (req, res) => {
  const r = await anadirEnlace({
    ctx: await contexto(req),
    idTarea: req.params.id,
    url: req.body?.url,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, enlace: r.enlace });
});

// La única forma de refrescar una captura: manual y explícita. No hay refresco
// automático en ningún otro punto (contrato 03, «Qué NO existe en la API»).
router.post('/tareas/:id/enlaces/:enlaceId/recapturar', async (req, res) => {
  const r = await recapturarEnlace({
    ctx: await contexto(req),
    idTarea: req.params.id,
    idEnlace: req.params.enlaceId,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, enlace: r.enlace });
});

router.delete('/tareas/:id/enlaces/:enlaceId', async (req, res) => {
  const r = await borrarEnlace({
    ctx: await contexto(req),
    idTarea: req.params.id,
    idEnlace: req.params.enlaceId,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true });
});

router.get('/tareas/:id/enlaces/:enlaceId/imagen', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await urlDeImagenEnlace({
    ctx: await contexto(req),
    idTarea: req.params.id,
    idEnlace: req.params.enlaceId,
  });
  if (fallo(res, r)) return;
  return res.json({ url: r.url, expira_en_seg: r.expira_en_seg, enlace: r.enlace });
});

// ─── Adjuntos ───

// El fichero va del navegador a S3 con esta URL; por la API solo pasan los
// metadatos. Nunca base64 dentro del ítem.
router.post('/tareas/:id/adjuntos/presign', async (req, res) => {
  const r = await presignarAdjunto({
    ctx: await contexto(req),
    idTarea: req.params.id,
    nombre: req.body?.nombre,
    contentType: req.body?.content_type,
    tamano: req.body?.tamano,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, adjunto: r.adjunto });
});

router.post('/tareas/:id/adjuntos/confirmar', async (req, res) => {
  const r = await confirmarAdjunto({
    ctx: await contexto(req),
    idTarea: req.params.id,
    s3Key: req.body?.s3_key,
    nombre: req.body?.nombre,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true, adjunto: r.adjunto });
});

router.get('/tareas/:id/adjuntos/:adjuntoId/url', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await urlDeAdjunto({
    ctx: await contexto(req),
    idTarea: req.params.id,
    idAdjunto: req.params.adjuntoId,
  });
  if (fallo(res, r)) return;
  return res.json({ url: r.url, expira_en_seg: r.expira_en_seg, adjunto: r.adjunto });
});

router.delete('/tareas/:id/adjuntos/:adjuntoId', async (req, res) => {
  const r = await borrarAdjunto({
    ctx: await contexto(req),
    idTarea: req.params.id,
    idAdjunto: req.params.adjuntoId,
  });
  if (fallo(res, r)) return;
  return res.json({ ok: true });
});

export default router;
