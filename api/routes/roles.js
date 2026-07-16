import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  listarRolesCatalogo,
  crearRol,
  actualizarRolMeta,
  eliminarRol,
  normalizarNombreRol,
  obtenerRolMeta,
} from '../lib/roles.js';

const router = express.Router();

function throwSiTablaPermisosFalta(err) {
  const msg = err?.message || String(err);
  if (
    err?.name === 'ResourceNotFoundException' ||
    msg.includes('Requested resource not found') ||
    msg.includes('ResourceNotFoundException')
  ) {
    const e = new Error('La tabla de roles/permisos no existe. Ver api/ROLES-PERMISOS.md');
    e.status = 404;
    e.code = 'TABLE_NOT_FOUND';
    throw e;
  }
  throw err;
}

/** GET /roles — catálogo de roles (lectura para formularios; gestión solo Administrador). */
router.get('/roles', requireAuth, async (req, res) => {
  try {
    const roles = await listarRolesCatalogo();
    return res.json({ roles });
  } catch (err) {
    throwSiTablaPermisosFalta(err);
  }
});

router.post('/roles', requireAuth, requireRole('Administrador'), async (req, res) => {
  const body = req.body || {};
  const norm = normalizarNombreRol(body.nombre);
  if (!norm.ok) {
    return res.status(400).json({ error: norm.error });
  }
  try {
    const rol = await crearRol({
      nombre: norm.nombre,
      descripcion: body.descripcion,
      clonarDe: body.clonarDe,
      orden: body.orden,
    });
    return res.status(201).json({ ok: true, rol });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    if (err.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({ error: 'Ya existe un rol con ese nombre' });
    }
    throwSiTablaPermisosFalta(err);
  }
});

router.put('/roles/:nombre', requireAuth, requireRole('Administrador'), async (req, res) => {
  const norm = normalizarNombreRol(req.params.nombre);
  if (!norm.ok) {
    return res.status(400).json({ error: norm.error });
  }
  try {
    const rol = await actualizarRolMeta(norm.nombre, {
      descripcion: req.body?.descripcion,
      orden: req.body?.orden,
    });
    return res.json({ ok: true, rol });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throwSiTablaPermisosFalta(err);
  }
});

router.delete('/roles/:nombre', requireAuth, requireRole('Administrador'), async (req, res) => {
  const norm = normalizarNombreRol(req.params.nombre);
  if (!norm.ok) {
    return res.status(400).json({ error: norm.error });
  }
  try {
    await eliminarRol(norm.nombre);
    return res.json({ ok: true });
  } catch (err) {
    if (err.status === 403 || err.status === 404 || err.status === 409) {
      return res.status(err.status).json({ error: err.message });
    }
    throwSiTablaPermisosFalta(err);
  }
});

router.get('/roles/:nombre', requireAuth, requireRole('Administrador'), async (req, res) => {
  const norm = normalizarNombreRol(req.params.nombre);
  if (!norm.ok) {
    return res.status(400).json({ error: norm.error });
  }
  try {
    const rol = await obtenerRolMeta(norm.nombre);
    if (!rol) return res.status(404).json({ error: 'Rol no encontrado' });
    return res.json({ rol });
  } catch (err) {
    throwSiTablaPermisosFalta(err);
  }
});

export default router;
