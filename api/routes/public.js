/**
 * Endpoints PÚBLICOS (sin requireAuth).
 * Solo deben exponer datos estrictamente necesarios antes del login.
 *
 * Incluye el feed ICS de vencimientos (Fase 3): lo consumen clientes de
 * calendario que no saben de JWT; la autenticación es el token opaco de la URL.
 */
import express from 'express';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { feedVencimientosIcs } from '../lib/tasks/vencimientosIcs.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /public/personalizacion/app-image
 * Devuelve únicamente el campo `ImagenApp` (data URL o URL http) usado en el login.
 * No expone ningún otro atributo del ítem de ajustes.
 */
router.get('/public/personalizacion/app-image', async (_req, res) => {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.ajustes,
      Key: { PK: 'personalizacion', SK: 'app' },
    }));
    const raw = r.Item?.ImagenApp;
    const imagen = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
    return res.json({ imagen });
  } catch {
    return res.json({ imagen: null });
  }
});

/**
 * GET /api/tasks/vencimientos.ics?token=…
 * Feed de calendario (solo título + fecha_limite). Montado antes de requireAuth.
 * No se registra el token en claro en logs.
 */
router.get('/tasks/vencimientos.ics', async (req, res) => {
  const token = typeof req.query?.token === 'string' ? req.query.token : '';
  if (!token.trim()) {
    return res.status(401).type('text/plain').send('Token requerido');
  }
  try {
    const r = await feedVencimientosIcs(token);
    if (!r.ok) {
      return res.status(401).type('text/plain').send('Token no válido');
    }
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(r.ics);
  } catch (err) {
    logger.warn({ err }, '[vencimientos-ics] Error al servir el feed');
    return res.status(500).type('text/plain').send('Error al generar el calendario');
  }
});

export default router;
