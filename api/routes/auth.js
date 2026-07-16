import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { findUsuarioByEmail } from '../lib/dynamo/usuarios.js';
import { signToken } from '../lib/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizeLocalesUsuario } from '../lib/usuarioLocales.js';
import { enviarEmail, smtpConfigurado } from '../lib/email.js';

const router = express.Router();
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
/** Validez del enlace de recuperación de contraseña. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min

function isBcryptHash(str) {
  return typeof str === 'string' && /^\$2[aby]\$\d{2}\$/.test(str);
}

/** Hash del token de recuperación (nunca guardamos el token en claro). */
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * URL del enlace de recuperación que se incluye en el correo. Apunta a la web
 * de la app (web/tablet first). Prioriza `APP_PUBLIC_URL`; si no, usa el
 * `Origin` de la petición (la web llama al API desde su propio origen).
 */
function buildResetUrl(req, token, emailNorm) {
  const base = String(process.env.APP_PUBLIC_URL || req.headers.origin || '').replace(/\/+$/, '');
  const qs = `token=${encodeURIComponent(token)}&email=${encodeURIComponent(emailNorm)}`;
  return base ? `${base}/reset-password?${qs}` : `/reset-password?${qs}`;
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan email o password' });
  }

  const emailNorm = email.trim().toLowerCase();

  // Resuelve el email a usuario vía GSI Email-index (con fallback transparente
  // a Scan mientras el índice se está creando — primer arranque). Ver
  // api/lib/dynamo/usuarios.js.
  const items = await findUsuarioByEmail(emailNorm);

  if (items.length === 0) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const user = items[0];
  const storedPassword = user.Password ?? '';
  let passwordValid = false;

  if (isBcryptHash(storedPassword)) {
    passwordValid = await bcrypt.compare(password, storedPassword);
  } else {
    let match = false;
    try {
      match = crypto.timingSafeEqual(
        Buffer.from(storedPassword),
        Buffer.from(password)
      );
    } catch {
      match = false;
    }
    passwordValid = match;
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
        // Migración a bcrypt es best-effort: si falla, seguimos validando con la contraseña actual.
        req.log.warn({ err: migrationErr }, '[auth] Error migrando password a bcrypt');
      }
    }
  }

  if (!passwordValid) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const locales = normalizeLocalesUsuario(user);

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
});

router.get('/me', requireAuth, async (req, res) => {
  const { sub, rol } = req.user;
  const got = await docClient.send(new GetCommand({
    TableName: tables.usuarios,
    Key: { id_usuario: sub },
  }));
  if (!got.Item) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }
  const u = got.Item;
  const locales = normalizeLocalesUsuario(u);

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
});

/**
 * Solicita un enlace de recuperación de contraseña.
 *
 * Responde SIEMPRE con un mensaje genérico (200) exista o no el email, para no
 * permitir enumerar usuarios. Si el email existe y hay un único usuario, genera
 * un token de un solo uso, guarda su hash + caducidad y envía el correo.
 */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const respuestaGenerica = {
    ok: true,
    message: 'Si el email está registrado, recibirás un correo con instrucciones para restablecer tu contraseña.',
  };
  if (!email) {
    return res.status(400).json({ error: 'Falta el email' });
  }
  const emailNorm = String(email).trim().toLowerCase();

  try {
    const items = await findUsuarioByEmail(emailNorm);
    // Solo actuamos si hay exactamente un usuario (misma prudencia que reset-password.js).
    if (items.length === 1) {
      const user = items[0];
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(token);
      const expMs = Date.now() + RESET_TOKEN_TTL_MS;

      await docClient.send(new UpdateCommand({
        TableName: tables.usuarios,
        Key: { id_usuario: user.id_usuario },
        UpdateExpression: 'SET ResetTokenHash = :h, ResetTokenExp = :e',
        ExpressionAttributeValues: { ':h': tokenHash, ':e': expMs },
      }));

      const resetUrl = buildResetUrl(req, token, emailNorm);
      const nombre = user.Nombre || 'Hola';
      if (smtpConfigurado()) {
        try {
          await enviarEmail({
            to: user.Email,
            subject: 'Recuperación de contraseña — Grupo Paripé',
            text:
              `${nombre},\n\n` +
              `Hemos recibido una solicitud para restablecer tu contraseña.\n` +
              `Abre este enlace para elegir una nueva (caduca en 60 minutos):\n\n${resetUrl}\n\n` +
              `Si no has solicitado este cambio, puedes ignorar este correo.`,
            html:
              `<p>${nombre},</p>` +
              `<p>Hemos recibido una solicitud para restablecer tu contraseña.</p>` +
              `<p><a href="${resetUrl}">Pulsa aquí para elegir una nueva contraseña</a> (el enlace caduca en 60 minutos).</p>` +
              `<p style="color:#64748b;font-size:13px">Si no has solicitado este cambio, puedes ignorar este correo.</p>`,
          });
        } catch (mailErr) {
          req.log.error({ err: mailErr }, '[auth] Error enviando email de recuperación');
        }
      } else {
        req.log.warn('[auth] SMTP no configurado: no se pudo enviar el email de recuperación');
      }
    }
  } catch (err) {
    // No revelamos detalles al cliente; logueamos para diagnóstico.
    req.log.error({ err }, '[auth] Error en forgot-password');
  }

  return res.json(respuestaGenerica);
});

/**
 * Restablece la contraseña usando el token recibido por email.
 * Requiere `email`, `token` y `password`. El token se localiza vía el usuario
 * (por email) para evitar un Scan por hash; se valida hash + caducidad.
 */
router.post('/reset-password', async (req, res) => {
  const { email, token, password } = req.body || {};
  const invalido = {
    error: 'El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo.',
  };

  if (!email || !token || !password) {
    return res.status(400).json({ error: 'Faltan datos para restablecer la contraseña' });
  }
  if (String(password).length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` });
  }

  const emailNorm = String(email).trim().toLowerCase();
  const items = await findUsuarioByEmail(emailNorm);
  if (items.length !== 1) {
    return res.status(400).json(invalido);
  }

  const user = items[0];
  if (!user.ResetTokenHash || !user.ResetTokenExp) {
    return res.status(400).json(invalido);
  }
  if (Date.now() > Number(user.ResetTokenExp)) {
    return res.status(400).json(invalido);
  }

  // Comparación en tiempo constante del hash del token.
  const candidato = Buffer.from(hashResetToken(token));
  const almacenado = Buffer.from(String(user.ResetTokenHash));
  let tokenValido = false;
  try {
    tokenValido = candidato.length === almacenado.length && crypto.timingSafeEqual(candidato, almacenado);
  } catch {
    tokenValido = false;
  }
  if (!tokenValido) {
    return res.status(400).json(invalido);
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await docClient.send(new UpdateCommand({
    TableName: tables.usuarios,
    Key: { id_usuario: user.id_usuario },
    UpdateExpression: 'SET #Password = :p REMOVE ResetTokenHash, ResetTokenExp',
    ExpressionAttributeNames: { '#Password': 'Password' },
    ExpressionAttributeValues: { ':p': hash },
  }));

  return res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
});

export default router;
