import express from 'express';
import bcrypt from 'bcrypt';
import { ScanCommand, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { signToken } from '../lib/jwt.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const BCRYPT_ROUNDS = 10;

function isBcryptHash(str) {
  return typeof str === 'string' && /^\$2[aby]\$\d{2}\$/.test(str);
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan email o password' });
  }

  const emailNorm = email.trim().toLowerCase();

  try {
    const cmd = new ScanCommand({
      TableName: tables.usuarios,
      FilterExpression: '#Email = :email',
      ExpressionAttributeNames: { '#Email': 'Email' },
      ExpressionAttributeValues: { ':email': emailNorm },
    });

    const result = await docClient.send(cmd);
    const items = result.Items || [];

    if (items.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = items[0];
    const storedPassword = user.Password ?? '';
    let passwordValid = false;

    if (isBcryptHash(storedPassword)) {
      passwordValid = await bcrypt.compare(password, storedPassword);
    } else {
      passwordValid = storedPassword === password;
      if (passwordValid && storedPassword) {
        try {
          const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
          const getCmd = new GetCommand({
            TableName: tables.usuarios,
            Key: { id_usuario: user.id_usuario },
          });
          const full = await docClient.send(getCmd);
          const fullItem = full.Item || user;
          await docClient.send(new PutCommand({
            TableName: tables.usuarios,
            Item: { ...fullItem, Password: hashed },
          }));
        } catch (migrationErr) {
          console.error('[auth] Error migrando password a bcrypt:', migrationErr.message);
        }
      }
    }

    if (!passwordValid) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const rawLocal = user.Local;
    const locales = Array.isArray(rawLocal)
      ? rawLocal.filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim())
      : (rawLocal != null && String(rawLocal).trim() !== '' ? [String(rawLocal).trim()] : []);

    const userPayload = {
      id_usuario: user.id_usuario ?? user.Email ?? '',
      email: user.Email ?? '',
      Nombre: user.Nombre ?? user.Email ?? user.email ?? '',
      Rol: user.Rol ?? '',
      Locales: locales,
    };

    const token = signToken({
      sub: userPayload.id_usuario,
      email: userPayload.email,
      rol: userPayload.Rol,
    });

    res.json({ user: userPayload, token });
  } catch (err) {
    console.error('DynamoDB error:', err);
    const message = err.message || 'Error al verificar credenciales';
    res.status(500).json({ error: message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { sub, rol } = req.user;
    const got = await docClient.send(new GetCommand({
      TableName: tables.usuarios,
      Key: { id_usuario: sub },
    }));
    if (!got.Item) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const u = got.Item;
    const rawLocal = u.Local;
    const locales = Array.isArray(rawLocal)
      ? rawLocal.filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim())
      : (rawLocal != null && String(rawLocal).trim() !== '' ? [String(rawLocal).trim()] : []);

    const userPayload = {
      id_usuario: u.id_usuario ?? '',
      email: u.Email ?? '',
      Nombre: u.Nombre ?? u.Email ?? '',
      Rol: u.Rol ?? '',
      Locales: locales,
    };

    let permisos = [];
    const userRol = u.Rol || rol || '';
    if (userRol) {
      const qCmd = new QueryCommand({
        TableName: tables.rolesPermisos,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `ROL#${userRol}`, ':sk': 'PERMISO#' },
      });
      const qResult = await docClient.send(qCmd);
      permisos = (qResult.Items || []).map((i) => (i.SK || '').replace(/^PERMISO#/, '')).filter(Boolean);
    }

    res.json({ user: userPayload, permisos });
  } catch (err) {
    console.error('[/me] error:', err.message);
    res.status(500).json({ error: 'Error al obtener sesión' });
  }
});

export default router;
