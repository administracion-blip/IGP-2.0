import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { buildTopCamarerosPlanningCard } from '../lib/planning/topCamareros.js';
import { formatId6 } from '../lib/usuarioLocales.js';

const router = Router();

/** Top 3 camareros del mes (Igp_VentasProducto) para el card de Planning del Día. */
router.get('/planning-dia/top-camareros', requirePermission('top.ver'), async (req, res) => {
  const localIdRaw = String(req.query.localId ?? '').trim();
  if (!localIdRaw) {
    return res.status(400).json({ error: 'localId obligatorio' });
  }

  try {
    const payload = await buildTopCamarerosPlanningCard(req.user, formatId6(localIdRaw));
    res.json(payload);
  } catch (err) {
    const status = err.statusCode === 403 ? 403 : 500;
    if (status === 403) {
      return res.status(403).json({ error: err.message || 'Sin acceso' });
    }
    console.error('[planning-dia/top-camareros]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al calcular top camareros' });
  }
});

export default router;
