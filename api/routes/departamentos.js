/**
 * Maestro de departamentos — `docs/tasks/03-contrato-api.md`.
 *
 * La ruta es `/api/departamentos` (no `/api/tasks/…`) por coherencia con
 * `/api/locales` y `/api/empresas`. La lógica vive en
 * `api/lib/tasks/departamentos.js`; aquí solo se traduce a HTTP.
 */

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import {
  listarDepartamentos,
  crearDepartamento,
  actualizarDepartamento,
  desactivarDepartamento,
} from '../lib/tasks/departamentos.js';

const router = Router();

/**
 * Un único permiso para las tres escrituras: el maestro son cinco filas y tres
 * permisos para eso es burocracia. La lectura no pide permiso —solo la sesión
 * del `requireAuth` global—: alimenta los desplegables de todo el módulo y de la
 * ficha de usuario, y exigirlo solo conseguiría formularios con listas vacías.
 */
const PERMISO_EDITAR = 'departamentos.editar';

const CAMPOS_EDITABLES = ['nombre', 'responsable_id', 'orden', 'activo'];

function responder(res, resultado) {
  if (!resultado.ok) return res.status(resultado.status).json({ error: resultado.error });
  return res.json({ ok: true, departamento: resultado.departamento });
}

router.get('/departamentos', async (req, res) => {
  const soloActivos = ['1', 'true', 'si'].includes(String(req.query?.soloActivos ?? '').toLowerCase());
  const departamentos = await listarDepartamentos({ soloActivos });
  return res.json({ departamentos });
});

router.post('/departamentos', requirePermission(PERMISO_EDITAR), async (req, res) => {
  const body = req.body || {};
  return responder(
    res,
    await crearDepartamento({
      nombre: body.nombre,
      responsable_id: body.responsable_id,
      orden: body.orden,
    }),
  );
});

router.patch('/departamentos/:id', requirePermission(PERMISO_EDITAR), async (req, res) => {
  const body = req.body || {};
  const cambios = {};
  for (const campo of CAMPOS_EDITABLES) {
    if (body[campo] !== undefined) cambios[campo] = body[campo];
  }
  if (Object.keys(cambios).length === 0) {
    return res.status(400).json({ error: 'No hay nada que actualizar' });
  }
  return responder(res, await actualizarDepartamento(req.params.id, cambios));
});

// Baja lógica siempre: hay `departamento_id` guardado en tareas, proyectos y
// fichas de usuario sin integridad referencial, y no puede quedarse huérfano.
router.delete('/departamentos/:id', requirePermission(PERMISO_EDITAR), async (req, res) => {
  return responder(res, await desactivarDepartamento(req.params.id));
});

export default router;
