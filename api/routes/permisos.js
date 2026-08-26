import express from 'express';
import { QueryCommand, ScanCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { invalidarContextoAcceso } from '../lib/tasks/acceso.js';

const router = express.Router();

/**
 * Si el error indica que la tabla rolesPermisos no existe en DynamoDB, lanza
 * un Error con status 404 y mensaje custom para que el operador sepa cómo
 * crearla. Para el resto de errores, los re-lanza (gestiona el middleware).
 */
function throwSiTablaPermisosFalta(err, hint = 'Créala en DynamoDB con PK (String) y SK (String). Ver api/ROLES-PERMISOS.md') {
  const msg = err?.message || String(err);
  if (
    err?.name === 'ResourceNotFoundException' ||
    msg.includes('Requested resource not found') ||
    msg.includes('ResourceNotFoundException')
  ) {
    const e = new Error(`La tabla ${tables.rolesPermisos} no existe. ${hint}`);
    e.status = 404;
    e.code = 'TABLE_NOT_FOUND';
    throw e;
  }
  throw err;
}

// GET /permisos?rol= — protegido (AuthContext usa /api/me ahora)
router.get('/permisos', requireAuth, async (req, res) => {
  const rol = (req.query.rol ?? '').toString().trim();
  if (!rol) {
    return res.json({ permisos: [] });
  }
  const pk = `ROL#${rol}`;
  let items = [];
  let lastKey = null;
  try {
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
  } catch (err) {
    throwSiTablaPermisosFalta(err);
  }
  const permisos = items.map((i) => (i.SK || '').replace(/^PERMISO#/, '')).filter(Boolean);
  return res.json({ permisos });
});

router.get('/permisos/todos', requireAuth, requireRole('Administrador'), async (req, res) => {
  let items = [];
  let lastKey = null;
  try {
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
  } catch (err) {
    throwSiTablaPermisosFalta(err, 'Ver api/ROLES-PERMISOS.md');
  }
  const list = items.map((i) => ({
    rol: (i.PK || '').replace(/^ROL#/, ''),
    permiso: (i.SK || '').replace(/^PERMISO#/, ''),
  })).filter((x) => x.rol && x.permiso);
  list.sort((a, b) => (a.rol + a.permiso).localeCompare(b.rol + b.permiso));
  return res.json({ items: list });
});

router.post('/permisos', requireAuth, requireRole('Administrador'), async (req, res) => {
  const rol = (req.body?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  await docClient.send(
    new PutCommand({
      TableName: tables.rolesPermisos,
      Item: { PK: pk, SK: sk },
    })
  );
  // El contexto de acceso cachea los permisos por usuario y no hay invalidación
  // por rol: conceder un permiso obliga a vaciar la caché entera.
  invalidarContextoAcceso();
  return res.json({ ok: true });
});

router.delete('/permisos', requireAuth, requireRole('Administrador'), async (req, res) => {
  const rol = (req.body?.rol ?? req.query?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? req.query?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  await docClient.send(
    new DeleteCommand({
      TableName: tables.rolesPermisos,
      Key: { PK: pk, SK: sk },
    })
  );
  // Retirar un permiso tiene que surtir efecto ya, no cuando caduque la caché.
  invalidarContextoAcceso();
  return res.json({ ok: true });
});

export default router;
