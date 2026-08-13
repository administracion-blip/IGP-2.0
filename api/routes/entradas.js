/**
 * Entradas (Coupons Ágora).
 *
 * Permisos:
 *  - entradas.ver
 *  - entradas.crear
 *  - entradas.enviar_whatsapp
 *  - entradas.reintentar_agora
 *  - entradas.configurar
 *  - entradas.anular
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { formatId6, usuarioPuedeAccederLocal } from '../lib/usuarioLocales.js';
import { validateAgoraBaseUrl } from '../lib/agora/couponsImport.js';
import { createEntradaAndSync, reintentarSync } from '../lib/entradas/entradasSync.js';
import {
  WHATSAPP_STATUS,
  configToPublic,
  deleteTipo,
  entradaToPublic,
  getConfig,
  getEntrada,
  getTipo,
  listEntradas,
  listEventos,
  listTipos,
  nowIso,
  pkLocal,
  putConfig,
  putEvento,
  putTipo,
  skTipo,
  tipoToPublic,
  updateEntradaFields,
} from '../lib/entradas/entradasStore.js';

const router = Router();

async function assertLocal(req, res, localId) {
  const raw = localId != null ? String(localId).trim() : '';
  if (!raw) {
    res.status(400).json({ error: 'localId es obligatorio' });
    return null;
  }
  const id = formatId6(raw);
  if (!(await usuarioPuedeAccederLocal(req.user, id))) {
    res.status(403).json({ error: 'No tienes acceso a este local' });
    return null;
  }
  return id;
}

function usuarioLabel(user) {
  return String(user?.email || user?.sub || '').trim() || null;
}

/** Normaliza teléfono a dígitos (con + opcional) para wa.me */
function telefonoParaWa(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const digits = s.replace(/[^\d+]/g, '');
  const only = digits.startsWith('+') ? digits.slice(1).replace(/\D/g, '') : digits.replace(/\D/g, '');
  return only;
}

// ─── Config ─────────────────────────────────────────────────────────────────

router.get('/entradas/config/:localId', requirePermission('entradas.configurar'), async (req, res) => {
  const localId = await assertLocal(req, res, req.params.localId);
  if (!localId) return;

  const cfg = await getConfig(localId);
  return res.json(configToPublic(cfg ? { ...cfg, localId } : { localId }));
});

router.put('/entradas/config/:localId', requirePermission('entradas.configurar'), async (req, res) => {
  const localId = await assertLocal(req, res, req.params.localId);
  if (!localId) return;

  const body = req.body || {};
  if (body.agoraBaseUrl != null && String(body.agoraBaseUrl).trim()) {
    try {
      body.agoraBaseUrl = validateAgoraBaseUrl(body.agoraBaseUrl);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  const saved = await putConfig(localId, {
    agoraBaseUrl: body.agoraBaseUrl,
    agoraApiToken: body.agoraApiToken,
    enabled: body.enabled,
  }, req.user);

  return res.json(configToPublic(saved));
});

// ─── Tipos ───────────────────────────────────────────────────────────────────

router.get(
  '/entradas/tipos',
  requireAnyPermission('entradas.ver', 'entradas.configurar'),
  async (req, res) => {
  const localId = await assertLocal(req, res, req.query.localId);
  if (!localId) return;

  const items = await listTipos(localId);
  return res.json({ items: items.map(tipoToPublic) });
});

router.post('/entradas/tipos', requirePermission('entradas.configurar'), async (req, res) => {
  const body = req.body || {};
  const localId = await assertLocal(req, res, body.localId || req.query.localId);
  if (!localId) return;

  const nombre = String(body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });

  const agoraSettingsId = Number(body.agoraSettingsId);
  if (!Number.isFinite(agoraSettingsId) || agoraSettingsId <= 0) {
    return res.status(400).json({ error: 'agoraSettingsId debe ser un número positivo' });
  }

  const tipoId = String(body.tipoId || randomUUID()).trim();
  const now = nowIso();
  const item = {
    PK: pkLocal(localId),
    SK: skTipo(tipoId),
    tipoId,
    localId,
    nombre,
    agoraSettingsId,
    activo: body.activo !== false,
    whatsappPlantilla:
      body.whatsappPlantilla != null && String(body.whatsappPlantilla).trim()
        ? String(body.whatsappPlantilla).trim()
        : null,
    creadoEn: now,
    actualizadoEn: now,
  };

  await putTipo(item);
  return res.status(201).json(tipoToPublic(item));
});

router.patch('/entradas/tipos/:localId/:tipoId', requirePermission('entradas.configurar'), async (req, res) => {
  const localId = await assertLocal(req, res, req.params.localId);
  if (!localId) return;

  const tipoId = String(req.params.tipoId || '').trim();
  const existing = await getTipo(localId, tipoId);
  if (!existing) return res.status(404).json({ error: 'Tipo no encontrado' });

  const body = req.body || {};
  if (body.nombre !== undefined) {
    const nombre = String(body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'nombre no puede estar vacío' });
    existing.nombre = nombre;
  }
  if (body.agoraSettingsId !== undefined) {
    const n = Number(body.agoraSettingsId);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: 'agoraSettingsId debe ser un número positivo' });
    }
    existing.agoraSettingsId = n;
  }
  if (body.activo !== undefined) existing.activo = body.activo === true;
  if (body.whatsappPlantilla !== undefined) {
    const t = String(body.whatsappPlantilla || '').trim();
    existing.whatsappPlantilla = t || null;
  }
  existing.actualizadoEn = nowIso();

  await putTipo(existing);
  return res.json(tipoToPublic(existing));
});

router.delete('/entradas/tipos/:localId/:tipoId', requirePermission('entradas.configurar'), async (req, res) => {
  const localId = await assertLocal(req, res, req.params.localId);
  if (!localId) return;

  const tipoId = String(req.params.tipoId || '').trim();
  const existing = await getTipo(localId, tipoId);
  if (!existing) return res.status(404).json({ error: 'Tipo no encontrado' });

  await deleteTipo(localId, tipoId);
  return res.json({ ok: true });
});

// ─── Entradas ────────────────────────────────────────────────────────────────

router.get('/entradas', requirePermission('entradas.ver'), async (req, res) => {
  const localId = await assertLocal(req, res, req.query.localId);
  if (!localId) return;

  const agoraSyncStatus = req.query.agoraSyncStatus
    ? String(req.query.agoraSyncStatus).trim().toUpperCase()
    : '';

  const items = await listEntradas(localId, { agoraSyncStatus: agoraSyncStatus || undefined });
  return res.json({ items: items.map(entradaToPublic) });
});

router.post('/entradas', requirePermission('entradas.crear'), async (req, res) => {
  const body = req.body || {};
  const localId = await assertLocal(req, res, body.localId);
  if (!localId) return;

  try {
    const entrada = await createEntradaAndSync({ ...body, localId }, req.user);
    return res.status(201).json(entradaToPublic(entrada));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

router.post(
  '/entradas/:localId/:entradaId/reintentar-agora',
  requirePermission('entradas.reintentar_agora'),
  async (req, res) => {
    const localId = await assertLocal(req, res, req.params.localId);
    if (!localId) return;

    try {
      const entrada = await reintentarSync(localId, req.params.entradaId, req.user);
      return res.json(entradaToPublic(entrada));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  },
);

router.post(
  '/entradas/:localId/:entradaId/enviar-whatsapp',
  requirePermission('entradas.enviar_whatsapp'),
  async (req, res) => {
    const localId = await assertLocal(req, res, req.params.localId);
    if (!localId) return;

    const entrada = await getEntrada(localId, req.params.entradaId);
    if (!entrada) return res.status(404).json({ error: 'Entrada no encontrada' });
    if (entrada.anulado) return res.status(409).json({ error: 'La entrada está anulada' });

    const phone = telefonoParaWa(entrada.telefono);
    let waUrl = null;
    if (phone) {
      const tipo = await getTipo(localId, entrada.tipoId);
      const plantilla = String(tipo?.whatsappPlantilla || '')
        .replace(/\{\{code\}\}/gi, entrada.code)
        .replace(/\{\{nombre\}\}/gi, entrada.clienteNombre || '')
        .trim();
      const text = plantilla || `Tu entrada: ${entrada.code}`;
      waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    }

    const updated = await updateEntradaFields(entrada, {
      whatsappStatus: WHATSAPP_STATUS.STUB_LINK,
      whatsappEnviadoEn: nowIso(),
    });
    await putEvento({
      entradaId: entrada.entradaId,
      tipo: 'whatsapp_stub',
      detalle: waUrl ? 'Stub link wa.me generado' : 'Sin teléfono; marcado stub sin URL',
      usuario: usuarioLabel(req.user),
    });

    return res.json({
      ...entradaToPublic(updated),
      waUrl,
    });
  },
);

router.post(
  '/entradas/:localId/:entradaId/anular',
  requirePermission('entradas.anular'),
  async (req, res) => {
    const localId = await assertLocal(req, res, req.params.localId);
    if (!localId) return;

    const entrada = await getEntrada(localId, req.params.entradaId);
    if (!entrada) return res.status(404).json({ error: 'Entrada no encontrada' });
    if (entrada.anulado) return res.status(409).json({ error: 'La entrada ya está anulada' });

    const updated = await updateEntradaFields(entrada, {
      anulado: true,
      anuladoEn: nowIso(),
      anuladoPor: usuarioLabel(req.user),
    });
    await putEvento({
      entradaId: entrada.entradaId,
      tipo: 'anulada',
      detalle: 'Entrada anulada (soft)',
      usuario: usuarioLabel(req.user),
    });

    return res.json(entradaToPublic(updated));
  },
);

router.get(
  '/entradas/:localId/:entradaId/eventos',
  requirePermission('entradas.ver'),
  async (req, res) => {
    const localId = await assertLocal(req, res, req.params.localId);
    if (!localId) return;

    const entrada = await getEntrada(localId, req.params.entradaId);
    if (!entrada) return res.status(404).json({ error: 'Entrada no encontrada' });

    const eventos = await listEventos(entrada.entradaId);
    return res.json({
      items: eventos.map(({ PK, SK, ...rest }) => rest),
    });
  },
);

export default router;
