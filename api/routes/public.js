/**
 * Endpoints PÚBLICOS (sin requireAuth).
 * Solo deben exponer datos estrictamente necesarios antes del login.
 */
import express from 'express';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

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

export default router;
