/**
 * Proyectos del módulo de dirección — `docs/tasks/03-contrato-api.md`.
 *
 * Aquí solo se traduce HTTP: la lógica y las escrituras viven en
 * `api/lib/tasks/proyectos.js` y toda decisión de fila la toma
 * `api/lib/tasks/acceso.js`.
 *
 * El orden de comprobación es siempre el mismo: primero el **permiso global**
 * con `requirePermission`, y después la **ACL de fila** dentro del handler, con
 * el proyecto ya leído. La autenticación la pone el `requireAuth` global, así
 * que no se repite.
 *
 * Las rutas que **escriben** son la excepción: no llevan `requirePermission` y
 * la decisión entera la toma `puedeEditarProyecto`. Es lo que dice
 * `docs/tasks/04-permisos-y-acceso.md`: el responsable de un proyecto lo edita
 * sin `proyectos.editar`. Exigirlo además en la ruta devolvía `403` a quien la
 * ficha acababa de decirle que sí (`permisos_fila.editar: true`), y dejaba a
 * quien crea un proyecto con `proyectos.crear` sin poder tocarlo. Mismo criterio
 * que las rutas de escritura del router de tareas.
 *
 * Las líneas `COMPRA#` solo se leen para sumar los dos totales de gasto de la
 * ficha (endpoints de compras: otra entrega de Fase 4). Las plantillas y el
 * cuadro de mando sí están montados aquí, **antes** de `/:id`.
 */

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { cargarContextoAcceso } from '../lib/tasks/acceso.js';
import { PERMISOS } from '../lib/tasks/tipos.js';
import {
  CAMPOS_EDITABLES,
  actualizarProyecto,
  anadirMiembro,
  anadirVinculo,
  borrarProyecto,
  crearProyecto,
  listarActividadProyecto,
  listarProyectosDelUsuario,
  listarProyectosVisibles,
  obtenerFichaProyecto,
  quitarMiembro,
  quitarVinculo,
} from '../lib/tasks/proyectos.js';
import {
  actualizarPlantilla,
  borrarPlantilla,
  crearPlantilla,
  instanciarPlantilla,
  listarPlantillas,
} from '../lib/tasks/plantillas.js';
import { obtenerCuadroMando } from '../lib/tasks/cuadroMando.js';

const router = Router();

function fallo(res, resultado) {
  const cuerpo = { error: resultado.error };
  if (resultado.fallos) cuerpo.fallos = resultado.fallos;
  return res.status(resultado.status).json(cuerpo);
}

// Listar. Los filtros se resuelven en memoria sobre la página del `Listado-index`
// (ver 02-modelo-datos), y la visibilidad se aplica siempre en el servidor.
router.get('/proyectos', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await listarProyectosVisibles(ctx, {
    limite: req.query?.limite,
    cursor: req.query?.cursor,
    estado: req.query?.estado,
    departamento: req.query?.departamento,
    responsable: req.query?.responsable,
  });
  if (!r.ok) return fallo(res, r);
  return res.json({ proyectos: r.proyectos, cursor: r.cursor });
});

// Antes de `/proyectos/:id`: si no, «mios» / «plantillas» entrarían como id.
router.get('/proyectos/mios', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await listarProyectosDelUsuario(ctx);
  if (!r.ok) return fallo(res, r);
  // Sin paginar —son los proyectos de una persona—, pero con la misma envoltura
  // que el resto de listados para que el cliente no tenga dos formas.
  return res.json({ proyectos: r.proyectos, cursor: null });
});

// ─── Cuadro de mando (Fase 4) — antes de `/:id` ───
// Permiso propio: `proyectos.ver` no basta.
router.get('/proyectos/cuadro-mando', requirePermission(PERMISOS.cuadroMando), async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await obtenerCuadroMando(ctx);
  if (!r.ok) return fallo(res, r);
  const { ok: _ok, ...cuerpo } = r;
  return res.json(cuerpo);
});

// ─── Plantillas (Fase 4) — antes de `/:id` ───

router.get('/proyectos/plantillas', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const r = await listarPlantillas({
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (!r.ok) return fallo(res, r);
  return res.json({ plantillas: r.plantillas, cursor: r.cursor });
});

router.post('/proyectos/plantillas', requirePermission(PERMISOS.plantillas), async (req, res) => {
  const r = await crearPlantilla(req.body || {});
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true, plantilla: r.plantilla });
});

router.patch('/proyectos/plantillas/:id', requirePermission(PERMISOS.plantillas), async (req, res) => {
  const r = await actualizarPlantilla(req.params.id, req.body || {});
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true, plantilla: r.plantilla });
});

router.delete('/proyectos/plantillas/:id', requirePermission(PERMISOS.plantillas), async (req, res) => {
  const r = await borrarPlantilla(req.params.id);
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true });
});

router.post(
  '/proyectos/plantillas/:id/instanciar',
  requirePermission(PERMISOS.proyectosCrear),
  async (req, res) => {
    const ctx = await cargarContextoAcceso(req.user);
    const r = await instanciarPlantilla(ctx, req.params.id, req.body || {});
    if (!r.ok) return fallo(res, r);
    return res.json({
      ok: true,
      proyecto: r.proyecto,
      creadas: r.creadas,
      omitidas: r.omitidas,
    });
  },
);

router.post('/proyectos', requirePermission(PERMISOS.proyectosCrear), async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  // `plantilla_origen_id` no se acepta por este camino público (solo instanciar).
  const r = await crearProyecto(ctx, req.body || {});
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true, proyecto: r.proyecto });
});

router.get('/proyectos/:id', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await obtenerFichaProyecto(ctx, req.params.id);
  if (!r.ok) return fallo(res, r);
  return res.json({ proyecto: r.proyecto, miembros: r.miembros, vinculos: r.vinculos });
});

// Sin permiso de ruta: edita el proyecto quien lo dirige, o quien es miembro y
// tiene `proyectos.editar`. Lo decide `puedeEditarProyecto` con el proyecto y sus
// miembros delante, y responde 404 si no lo ve y 403 si lo ve y no lo puede tocar.
router.patch('/proyectos/:id', async (req, res) => {
  const body = req.body || {};
  const cambios = {};
  for (const campo of CAMPOS_EDITABLES) {
    if (body[campo] !== undefined) cambios[campo] = body[campo];
  }
  const ctx = await cargarContextoAcceso(req.user);
  const r = await actualizarProyecto(ctx, req.params.id, cambios);
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true, proyecto: r.proyecto });
});

// Borrado físico del proyecto y de las tareas que cuelgan de él. Cancelar
// sin borrar es `PATCH { estado: 'cancelado' }`.
router.delete('/proyectos/:id', requirePermission(PERMISOS.proyectosBorrar), async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await borrarProyecto(ctx, req.params.id);
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true, tareas_borradas: r.tareas_borradas ?? 0 });
});

// Gestionar miembros es editar el proyecto: misma decisión, mismo sitio.
router.post('/proyectos/:id/miembros', async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await anadirMiembro(ctx, req.params.id, req.body || {});
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true, miembro: r.miembro });
});

router.delete(
  '/proyectos/:id/miembros/:usuarioId',
  async (req, res) => {
    const ctx = await cargarContextoAcceso(req.user);
    const r = await quitarMiembro(ctx, req.params.id, req.params.usuarioId);
    if (!r.ok) return fallo(res, r);
    return res.json({ ok: true });
  },
);

router.get('/proyectos/:id/actividad', requirePermission(PERMISOS.proyectosVer), async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await listarActividadProyecto(ctx, req.params.id, {
    limite: req.query?.limite,
    cursor: req.query?.cursor,
  });
  if (!r.ok) return fallo(res, r);
  return res.json({ actividad: r.actividad, cursor: r.cursor });
});

router.post('/proyectos/:id/vinculos', async (req, res) => {
  const ctx = await cargarContextoAcceso(req.user);
  const r = await anadirVinculo(ctx, req.params.id, req.body || {});
  if (!r.ok) return fallo(res, r);
  return res.json({ ok: true, vinculo: r.vinculo });
});

router.delete(
  '/proyectos/:id/vinculos/:tipo/:entidadId',
  async (req, res) => {
    const ctx = await cargarContextoAcceso(req.user);
    const r = await quitarVinculo(ctx, req.params.id, req.params.tipo, req.params.entidadId);
    if (!r.ok) return fallo(res, r);
    return res.json({ ok: true });
  },
);

export default router;
