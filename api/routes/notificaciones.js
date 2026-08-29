/**
 * Campana de notificaciones — `docs/tasks/03-contrato-api.md`, Fase 3.
 *
 * Solo sesión (JWT): cada usuario lee y marca **las suyas**. Sin permiso extra
 * y nunca se listan notificaciones de otro usuario.
 *
 * El id sale de `req.user.sub`: es lo que firma `signToken` en el login. No hay
 * `id_usuario` en el payload del JWT; leer otro campo devolvía 401 a quien
 * sí estaba autenticado y la campana, vía `apiFetch`, expulsaba la sesión.
 */

import { Router } from 'express';
import {
  contarNoLeidas,
  listarNotificaciones,
  marcarLeidas,
} from '../lib/tasks/notificaciones.js';

const router = Router();

/** Id del usuario del Bearer ya verificado. Nunca del body/query. */
export function idUsuarioDeToken(user) {
  return String(user?.sub || '').trim();
}

function idUsuario(req) {
  return idUsuarioDeToken(req.user);
}

router.get('/notificaciones', async (req, res) => {
  const usuarioId = idUsuario(req);
  if (!usuarioId) return res.status(401).json({ error: 'No autenticado' });

  const soloNoLeidas = ['1', 'true', 'si'].includes(
    String(req.query?.soloNoLeidas ?? '').toLowerCase(),
  );
  const r = await listarNotificaciones({
    usuarioId,
    limite: req.query?.limite,
    cursor: req.query?.cursor,
    soloNoLeidas,
  });
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
  return res.json({ notificaciones: r.notificaciones, cursor: r.cursor });
});

router.get('/notificaciones/no-leidas', async (req, res) => {
  const usuarioId = idUsuario(req);
  if (!usuarioId) return res.status(401).json({ error: 'No autenticado' });

  const r = await contarNoLeidas({ usuarioId });
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
  return res.json({ total: r.total });
});

router.post('/notificaciones/leer', async (req, res) => {
  const usuarioId = idUsuario(req);
  if (!usuarioId) return res.status(401).json({ error: 'No autenticado' });

  const body = req.body || {};
  const r = await marcarLeidas({
    usuarioId,
    ids: body.ids,
    todas: body.todas === true,
  });
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
  return res.json({ ok: true, marcadas: r.marcadas });
});

export default router;
