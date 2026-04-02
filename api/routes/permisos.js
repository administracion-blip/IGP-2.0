import express from 'express';
import { QueryCommand, ScanCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// GET /permisos?rol= — protegido (AuthContext usa /api/me ahora)
router.get('/permisos', requireAuth, async (req, res) => {
  const rol = (req.query.rol ?? '').toString().trim();
  if (!rol) {
    return res.json({ permisos: [] });
  }
  const pk = `ROL#${rol}`;
  try {
    let items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tables.rolesPermisos,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': 'PERMISO#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const permisos = items.map((i) => (i.SK || '').replace(/^PERMISO#/, '')).filter(Boolean);
    return res.json({ permisos });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tables.rolesPermisos} no existe. Créala en DynamoDB con PK (String) y SK (String). Ver api/ROLES-PERMISOS.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al obtener permisos' });
  }
});

router.get('/permisos/todos', requireAuth, requireRole('Administrador'), async (req, res) => {
  try {
    let items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tables.rolesPermisos,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: { ':pk': 'ROL#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const list = items.map((i) => ({
      rol: (i.PK || '').replace(/^ROL#/, ''),
      permiso: (i.SK || '').replace(/^PERMISO#/, ''),
    })).filter((x) => x.rol && x.permiso);
    list.sort((a, b) => (a.rol + a.permiso).localeCompare(b.rol + b.permiso));
    return res.json({ items: list });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos/todos GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tables.rolesPermisos} no existe. Ver api/ROLES-PERMISOS.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al listar permisos' });
  }
});

router.post('/permisos', requireAuth, requireRole('Administrador'), async (req, res) => {
  const rol = (req.body?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  try {
    await docClient.send(
      new PutCommand({
        TableName: tables.rolesPermisos,
        Item: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos POST]', msg);
    return res.status(500).json({ error: msg || 'Error al añadir permiso' });
  }
});

router.delete('/permisos', requireAuth, requireRole('Administrador'), async (req, res) => {
  const rol = (req.body?.rol ?? req.query?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? req.query?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tables.rolesPermisos,
        Key: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos DELETE]', msg);
    return res.status(500).json({ error: msg || 'Error al borrar permiso' });
  }
});

export default router;
