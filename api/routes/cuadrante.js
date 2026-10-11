/**
 * Cuadrante de personal (turnos planificados vs fichajes reales).
 *
 * GET /api/personal/cuadrante?local_ids=id1,id2,...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Compat: local_id=uno solo o varios repetidos (?local_id=a&local_id=b).
 *
 * La carga vive en `api/lib/personal/cuadranteServicio.js`.
 */

import { Router } from 'express';
import { requireAnyPermission } from '../middleware/auth.js';
import { requireLocales } from '../middleware/alcance.js';
import {
  obtenerCuadrantePorLocales,
  CuadranteServicioError,
} from '../lib/personal/cuadranteServicio.js';

const router = Router();

/** id_Locales únicos desde local_ids=a,b o local_id repetido. */
function parseLocalIds(query) {
  const ids = new Set();
  const pushMany = (v) => {
    if (v == null || v === '') return;
    if (Array.isArray(v)) {
      for (const x of v) pushMany(x);
      return;
    }
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((id) => ids.add(id));
  };
  pushMany(query.local_ids);
  pushMany(query.local_id);
  return [...ids];
}

// Incluye costes salariales por turno. La intersección con el alcance va aquí y no en
// obtenerCuadrantePorLocales, que también usa ratiosDiaLocal sin petición de usuario.
const localesPedidos = requireLocales((req) => parseLocalIds(req.query), { tipo: 'idLocal' });
router.get('/personal/cuadrante', requireAnyPermission('planning_dia.ver', 'rrhh.horas'), localesPedidos, async (req, res) => {
  try {
    const localIds = req.alcanceLocales;
    const from = req.query.from != null ? String(req.query.from) : '';
    const to = req.query.to != null ? String(req.query.to) : '';
    const payload = await obtenerCuadrantePorLocales({ localIds, from, to });
    res.json(payload);
  } catch (err) {
    if (err instanceof CuadranteServicioError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[cuadrante]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al cargar el cuadrante' });
  }
});

export default router;
