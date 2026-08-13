/**
 * Bonus RRHH — desviación mensual, incentivos campaña y fondo común.
 * GET  /bonus?anio=&mes=
 * PUT  /bonus/:mes/pcts
 * POST /bonus/:mes/cerrar
 */

import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import {
  buildBonusMesPreview,
  cerrarMes,
  getSnapshotMes,
  parseMesKey,
  savePcts,
  snapshotToResponse,
} from '../lib/bonus/bonusMes.js';

const router = Router();
const RE_MES = /^\d{4}-\d{2}$/;

function parseAnioMesQuery(req) {
  const anio = Number(req.query.anio);
  const mes = Number(req.query.mes);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
    const err = new Error('anio es obligatorio (YYYY)');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    const err = new Error('mes es obligatorio (1-12)');
    err.status = 400;
    throw err;
  }
  return { anio, mes };
}

function pctsFromSnapshotLocales(locales) {
  const pctPorLocal = {};
  for (const loc of locales || []) {
    const id = String(loc.localId || String(loc.SK || '').replace(/^LOCAL#/, ''));
    if (!id) continue;
    if (Object.prototype.hasOwnProperty.call(loc, 'pctFondo')) {
      pctPorLocal[id] = loc.pctFondo;
    }
  }
  return pctPorLocal;
}

router.get('/bonus', requirePermission('rrhh.bonus.ver'), async (req, res) => {
  const { anio, mes } = parseAnioMesQuery(req);
  const mesKey = `${anio}-${String(mes).padStart(2, '0')}`;

  let snap;
  try {
    snap = await getSnapshotMes(mesKey);
  } catch (err) {
    // Tabla ausente u otro error Dynamo: seguir con preview live sin overlay
    console.warn('[bonus] getSnapshotMes:', err.message || err);
    snap = { meta: null, locales: [] };
  }

  if (snap.meta?.estado === 'cerrado') {
    return res.json(await snapshotToResponse(req.user, snap));
  }

  const preview = await buildBonusMesPreview(req.user, {
    anio,
    mes,
    pctDefaultGlobal: snap.meta?.pctDefaultGlobal ?? 0,
    pctPorLocal: pctsFromSnapshotLocales(snap.locales),
  });

  return res.json(preview);
});

router.put('/bonus/:mes/pcts', requirePermission('rrhh.bonus.editar'), async (req, res) => {
  const mesKey = String(req.params.mes || '').trim();
  if (!RE_MES.test(mesKey)) {
    return res.status(400).json({ error: 'mes debe ser YYYY-MM' });
  }
  try {
    parseMesKey(mesKey);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const body = req.body || {};
  const locales = Array.isArray(body.locales) ? body.locales : [];
  try {
    const pctsPayload = {
      locales: locales.map((l) => ({
        localId: String(l.localId || '').trim(),
        pctFondo: l.pctFondo,
      })),
    };
    // Solo incluir global si el cliente lo envía (403 si no tiene alcance global).
    if (Object.prototype.hasOwnProperty.call(body, 'pctDefaultGlobal')) {
      pctsPayload.pctDefaultGlobal = body.pctDefaultGlobal;
    }
    await savePcts(mesKey, pctsPayload, req.user);

    // Devolver preview live con % aplicados
    const rango = parseMesKey(mesKey);
    const snap = await getSnapshotMes(mesKey);
    const preview = await buildBonusMesPreview(req.user, {
      anio: rango.anio,
      mes: rango.mesNum,
      pctDefaultGlobal: snap.meta?.pctDefaultGlobal ?? 0,
      pctPorLocal: pctsFromSnapshotLocales(snap.locales),
    });
    return res.json(preview);
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    throw err;
  }
});

router.post('/bonus/:mes/cerrar', requirePermission('rrhh.bonus.editar'), async (req, res) => {
  const mesKey = String(req.params.mes || '').trim();
  if (!RE_MES.test(mesKey)) {
    return res.status(400).json({ error: 'mes debe ser YYYY-MM' });
  }
  try {
    parseMesKey(mesKey);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const body = req.body || {};
  const locales = Array.isArray(body.locales) ? body.locales : [];
  try {
    const payload = await cerrarMes(mesKey, {
      pctDefaultGlobal: body.pctDefaultGlobal,
      locales: locales.map((l) => ({
        localId: String(l.localId || '').trim(),
        pctFondo: l.pctFondo,
      })),
    }, req.user);
    return res.json(payload);
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    throw err;
  }
});

export default router;
