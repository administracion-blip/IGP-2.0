/**
 * Reuniones del módulo de dirección — `docs/tasks/03-contrato-api.md`.
 *
 * Fase 1B: CRUD, asistentes, acuerdos, aviso de grabación, sugerencia de orden.
 * Fase 2A: `POST …/audio/presign` y `POST …/procesar` (subida a S3 + marca
 * `audio_pendiente`; sin STT ni poller).
 * Fase 2B: `POST /reuniones/pipeline/tick` (poller interno; stub STT).
 * Importación de texto: `POST …/transcripcion/importar` (salta STT → `transcrita`).
 * Fase 2F: cola de propuestas (`…/propuestas/pendientes`, `…/:id/propuestas`,
 * `…/:id/propuestas/resolver`).
 *
 * Solo HTTP: la lógica vive en `api/lib/tasks/reuniones.js` (+ `reuniones/audio.js`,
 * `reuniones/pipeline.js`, `reuniones/pipelineTick.js`, `reuniones/importarTranscripcion.js`,
 * `reuniones/propuestas.js`)
 * y la ACL de fila en `acceso.js`. Auth global; permiso de ruta + visibilidad
 * en el handler.
 *
 * No monta Meet ni PDF.
 */

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { cargarContextoAcceso } from '../lib/tasks/acceso.js';
import { PERMISOS } from '../lib/tasks/tipos.js';
import {
  CAMPOS_EDITABLES,
  actualizarAcuerdo,
  actualizarReunion,
  anadirAsistentes,
  borrarReunion,
  crearAcuerdo,
  crearReunion,
  crearTareasDesdeAcuerdos,
  listarActividadReunion,
  listarReunionesVisibles,
  listarTareasDeReunion,
  obtenerFichaReunion,
  registrarAvisoGrabacion,
  sugerenciaOrdenDelDia,
} from '../lib/tasks/reuniones.js';
import { presignarAudioReunion } from '../lib/tasks/reuniones/audio.js';
import { procesarAudioReunion } from '../lib/tasks/reuniones/pipeline.js';
import { ejecutarTickPipeline } from '../lib/tasks/reuniones/pipelineTick.js';
import { importarTranscripcionReunion } from '../lib/tasks/reuniones/importarTranscripcion.js';
import {
  listarPropuestasDeReunion,
  listarPropuestasPendientes,
  resolverPropuestas,
} from '../lib/tasks/reuniones/propuestas.js';

const router = Router();

function fallo(res, resultado) {
  if (resultado.ok) return false;
  const cuerpo = { error: resultado.error };
  if (resultado.fallos) cuerpo.fallos = resultado.fallos;
  res.status(resultado.status).json(cuerpo);
  return true;
}

function contexto(req) {
  return cargarContextoAcceso(req.user);
}

// ─── Listado y alta ───

router.get('/reuniones', requirePermission(PERMISOS.reunionesVer), async (req, res) => {
  const r = await listarReunionesVisibles(await contexto(req), {
    limite: req.query?.limite,
    cursor: req.query?.cursor,
    desde: req.query?.desde,
    hasta: req.query?.hasta,
    proyecto: req.query?.proyecto,
    estado: req.query?.estado,
  });
  if (fallo(res, r)) return;
  return res.json({ reuniones: r.reuniones, cursor: r.cursor });
});

router.post('/reuniones', requirePermission(PERMISOS.reunionesGestionar), async (req, res) => {
  const r = await crearReunion(await contexto(req), req.body || {});
  if (fallo(res, r)) return;
  return res.json({
    ok: true,
    reunion: r.reunion,
    calendario_sincronizado: r.calendario_sincronizado,
    calendar_event_id: r.calendar_event_id,
    calendar_id: r.calendar_id,
    modalidad: r.modalidad,
    sala_recurso_email: r.sala_recurso_email,
    meet_code: r.meet_code,
    calendario_error: r.calendario_error,
    calendar_disponible: r.calendar_disponible,
  });
});

/**
 * Poller interno (Fase 2B). Alta en INTERNAL_SYNC_POST_PATHS.
 * Antes de `/:id` para que «pipeline» no se tome por id.
 */
router.post(
  '/reuniones/pipeline/tick',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const origen = req.isInternal ? 'programado' : 'manual';
    const r = await ejecutarTickPipeline({ origen });
    return res.json(r);
  },
);

/**
 * Cola global de propuestas pendientes (Fase 2F).
 * Antes de `/:id` para que «propuestas» no se tome por id.
 */
router.get(
  '/reuniones/propuestas/pendientes',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await listarPropuestasPendientes(await contexto(req), {
      limite: req.query?.limite,
      cursor: req.query?.cursor,
    });
    if (fallo(res, r)) return;
    return res.json({ propuestas: r.propuestas, cursor: r.cursor });
  },
);

// ─── Subrutas de :id (antes del GET genérico donde haga falta el mismo patrón) ───

router.post(
  '/reuniones/:id/asistentes',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await anadirAsistentes(await contexto(req), req.params.id, req.body || {});
    if (fallo(res, r)) return;
    return res.json({
      ok: true,
      asistentes: r.asistentes,
      ...(r.calendario_sincronizado !== undefined && {
        calendario_sincronizado: r.calendario_sincronizado,
        calendario_error: r.calendario_error ?? null,
      }),
    });
  },
);

router.post(
  '/reuniones/:id/aviso-grabacion',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await registrarAvisoGrabacion(await contexto(req), req.params.id, req.body || {});
    if (fallo(res, r)) return;
    return res.json({ ok: true, aviso_grabacion: r.aviso_grabacion });
  },
);

router.post(
  '/reuniones/:id/audio/presign',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const body = req.body || {};
    const r = await presignarAudioReunion({
      ctx: await contexto(req),
      idReunion: req.params.id,
      nombre: body.nombre,
      contentType: body.contentType ?? body.content_type,
      tamano: body.tamano ?? body.size,
    });
    if (fallo(res, r)) return;
    return res.json({ ok: true, audio: r.audio });
  },
);

router.post(
  '/reuniones/:id/procesar',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const body = req.body || {};
    const r = await procesarAudioReunion({
      ctx: await contexto(req),
      idReunion: req.params.id,
      s3Key: body.s3_key ?? body.s3Key,
      duracionSeg: body.duracion_seg ?? body.duracionSeg,
    });
    if (fallo(res, r)) return;
    return res.json({ ok: true, ya_iniciado: r.ya_iniciado, reunion: r.reunion });
  },
);

router.post(
  '/reuniones/:id/transcripcion/importar',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const body = req.body || {};
    const r = await importarTranscripcionReunion({
      ctx: await contexto(req),
      idReunion: req.params.id,
      texto: body.texto ?? body.transcript,
    });
    if (fallo(res, r)) return;
    return res.json({ ok: true, ya_iniciado: r.ya_iniciado, reunion: r.reunion });
  },
);

router.get(
  '/reuniones/:id/sugerencia-orden-del-dia',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await sugerenciaOrdenDelDia(await contexto(req), req.params.id);
    if (fallo(res, r)) return;
    return res.json({
      texto: r.texto,
      origen_reunion_id: r.origen_reunion_id,
      acuerdos_abiertos: r.acuerdos_abiertos,
      puntos_aplazados: r.puntos_aplazados,
      mensaje: r.mensaje,
    });
  },
);

router.post(
  '/reuniones/:id/acuerdos',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await crearAcuerdo(await contexto(req), req.params.id, req.body || {});
    if (fallo(res, r)) return;
    return res.json({ ok: true, acuerdo: r.acuerdo });
  },
);

// D-23: convertir acuerdos → tareas en un solo camino de servidor.
// Antes de `/:acuerdoId` para que «crear-tareas» no se tome por id.
router.post(
  '/reuniones/:id/acuerdos/crear-tareas',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await crearTareasDesdeAcuerdos(await contexto(req), req.params.id, req.body || {});
    if (fallo(res, r)) return;
    return res.json({
      ok: true,
      creadas: r.creadas,
      omitidas: r.omitidas,
      enlazados: r.enlazados,
    });
  },
);

router.patch(
  '/reuniones/:id/acuerdos/:acuerdoId',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await actualizarAcuerdo(
      await contexto(req),
      req.params.id,
      req.params.acuerdoId,
      req.body || {},
    );
    if (fallo(res, r)) return;
    return res.json({ ok: true, acuerdo: r.acuerdo });
  },
);

router.get(
  '/reuniones/:id/propuestas',
  requirePermission(PERMISOS.reunionesVer),
  async (req, res) => {
    const r = await listarPropuestasDeReunion(await contexto(req), req.params.id, {
      estado: req.query?.estado,
    });
    if (fallo(res, r)) return;
    return res.json({ propuestas: r.propuestas });
  },
);

router.post(
  '/reuniones/:id/propuestas/resolver',
  requirePermission(PERMISOS.reunionesGestionar),
  async (req, res) => {
    const r = await resolverPropuestas(await contexto(req), req.params.id, req.body || {});
    if (fallo(res, r)) return;
    return res.json({ ok: true, resueltas: r.resueltas });
  },
);

router.get('/reuniones/:id/tareas', requirePermission(PERMISOS.reunionesVer), async (req, res) => {
  const r = await listarTareasDeReunion(await contexto(req), req.params.id, {
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (fallo(res, r)) return;
  return res.json({ tareas: r.tareas, cursor: r.cursor });
});

router.get('/reuniones/:id/actividad', requirePermission(PERMISOS.reunionesVer), async (req, res) => {
  const r = await listarActividadReunion(await contexto(req), req.params.id, {
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (fallo(res, r)) return;
  return res.json({ actividad: r.actividad, cursor: r.cursor });
});

// ─── Ficha / PATCH / DELETE ───

router.get('/reuniones/:id', requirePermission(PERMISOS.reunionesVer), async (req, res) => {
  const r = await obtenerFichaReunion(await contexto(req), req.params.id);
  if (fallo(res, r)) return;
  return res.json({
    reunion: r.reunion,
    asistentes: r.asistentes,
    acuerdos: r.acuerdos,
    puntos: r.puntos,
    vinculos: r.vinculos,
  });
});

router.patch('/reuniones/:id', requirePermission(PERMISOS.reunionesGestionar), async (req, res) => {
  const body = req.body || {};
  const cambios = {};
  for (const campo of CAMPOS_EDITABLES) {
    if (body[campo] !== undefined) cambios[campo] = body[campo];
  }
  const r = await actualizarReunion(await contexto(req), req.params.id, cambios);
  if (fallo(res, r)) return;
  return res.json({
    ok: true,
    reunion: r.reunion,
    calendario_sincronizado: r.calendario_sincronizado,
    calendar_event_id: r.calendar_event_id,
    calendar_id: r.calendar_id,
    modalidad: r.modalidad,
    sala_recurso_email: r.sala_recurso_email,
    meet_code: r.meet_code,
    calendario_error: r.calendario_error,
    calendar_disponible: r.calendar_disponible,
  });
});

router.delete('/reuniones/:id', requirePermission(PERMISOS.reunionesGestionar), async (req, res) => {
  const r = await borrarReunion(await contexto(req), req.params.id);
  if (fallo(res, r)) return;
  return res.json({
    ok: true,
    calendario_sincronizado: r.calendario_sincronizado,
    calendario_error: r.calendario_error,
    calendar_disponible: r.calendar_disponible,
  });
});

export default router;
