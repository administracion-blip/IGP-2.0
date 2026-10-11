import express from 'express';
import crypto from 'crypto';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { findUsuarioByEmail } from '../lib/dynamo/usuarios.js';
import { signToken } from '../lib/jwt.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizeLocalesUsuario } from '../lib/usuarioLocales.js';
import { normalizarIdsDepartamento } from '../lib/tasks/departamentos.js';
import { invalidarContextoAcceso, normalizarTokenVersion } from '../lib/tasks/acceso.js';
import { enviarEmail, smtpConfigurado } from '../lib/email.js';
import { origenesPermitidos } from '../lib/corsOrigins.js';
import { safeEqual } from '../lib/seguridad/safeEqual.js';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
} from '../lib/password.js';

const router = express.Router();
/** Validez del enlace de recuperación de contraseña. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min

/** Hash bcrypt de un valor aleatorio, para comparar cuando el email no existe. */
const HASH_FICTICIO = hashPassword(crypto.randomBytes(24).toString('hex'));

function esTextoNoVacio(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** Hash del token de recuperación (nunca guardamos el token en claro). */
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Base del enlace de recuperación. `APP_PUBLIC_URL` manda siempre; sin ella se
 * acepta el `Origin` solo si está en la lista blanca de CORS. Un `Origin`
 * cualquiera no vale: lo pone quien llama y el correo saldría con un enlace a
 * su dominio y el token dentro. `null` = no hay base fiable.
 */
function baseEnlaceReset(req) {
  const publica = String(process.env.APP_PUBLIC_URL || '').trim();
  if (publica) return publica.replace(/\/+$/, '');
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (origin && origenesPermitidos().has(origin)) return origin.replace(/\/+$/, '');
  return null;
}

function buildResetUrl(base, token, emailNorm) {
  const qs = `token=${encodeURIComponent(token)}&email=${encodeURIComponent(emailNorm)}`;
  return `${base}/reset-password?${qs}`;
}

// [SEC S-10]
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!esTextoNoVacio(email) || typeof password !== 'string' || password === '') {
    return res.status(400).json({ error: 'Faltan email o password' });
  }

  const emailNorm = email.trim().toLowerCase();

  // Resuelve el email a usuario vía GSI Email-index (con fallback transparente
  // a Scan mientras el índice se está creando — primer arranque). Ver
  // api/lib/dynamo/usuarios.js.
  const items = await findUsuarioByEmail(emailNorm);

  if (items.length === 0) {
    // Mismo coste que una contraseña mala: el tiempo de respuesta no debe
    // delatar qué emails están dados de alta.
    await verifyPassword(password, await HASH_FICTICIO);
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const user = items[0];
  const storedPassword = user.Password ?? '';
  const { ok: passwordValid, legacy } = await verifyPassword(
    String(password),
    typeof storedPassword === 'string' ? storedPassword : ''
  );

  // Migración gradual: si login legacy OK, rehash a bcrypt (solo SET Password).
  if (passwordValid && legacy) {
    try {
      const hashed = await hashPassword(password);
      await docClient.send(new UpdateCommand({
        TableName: tables.usuarios,
        Key: { id_usuario: user.id_usuario },
        UpdateExpression: 'SET #Password = :p',
        ExpressionAttributeNames: { '#Password': 'Password' },
        ExpressionAttributeValues: { ':p': hashed },
      }));
    } catch (migrationErr) {
      // Best-effort: el login sigue OK; no loguear nunca la password.
      req.log.warn(
        { err: migrationErr, id_usuario: user.id_usuario },
        '[SEC S-10] Error migrando password a bcrypt'
      );
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
    // Mismo campo que `/api/me`: este payload es el que se guarda en el
    // almacenamiento local y el que se restaura si la red falla, así que sin él
    // la sesión degradada se quedaría sin departamentos.
    Departamentos: normalizarIdsDepartamento(user.Departamentos),
  };

  const token = signToken({
    sub: userPayload.id_usuario,
    email: userPayload.email,
    rol: userPayload.Rol,
    tv: normalizarTokenVersion(user.tokenVersion),
  });
  invalidarContextoAcceso(userPayload.id_usuario);

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
    // IDs de departamento (D-12). Va aquí para que la sesión los tenga sin una
    // llamada extra; ausente en la ficha equivale a lista vacía.
    Departamentos: normalizarIdsDepartamento(u.Departamentos),
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
  if (!esTextoNoVacio(email)) {
    return res.status(400).json({ error: 'Falta el email' });
  }
  const emailNorm = email.trim().toLowerCase();

  const baseEnlace = baseEnlaceReset(req);
  if (!baseEnlace) {
    console.error('[auth] APP_PUBLIC_URL no configurada y Origin no permitido');
    return res.json(respuestaGenerica);
  }

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

      const resetUrl = buildResetUrl(baseEnlace, token, emailNorm);
      const nombre = user.Nombre || 'Hola';
      if (smtpConfigurado()) {
        // Sin `await`: esperar al SMTP solo cuando el email existe haría que el
        // tiempo de respuesta delatara qué cuentas hay.
        enviarEmail({
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
        }).catch((mailErr) => {
          req.log.error({ err: mailErr }, '[auth] Error enviando email de recuperación');
        });
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

  if (!esTextoNoVacio(email) || !esTextoNoVacio(token) || typeof password !== 'string' || password === '') {
    return res.status(400).json({ error: 'Faltan datos para restablecer la contraseña' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` });
  }

  const emailNorm = email.trim().toLowerCase();
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

  if (!safeEqual(hashResetToken(token), String(user.ResetTokenHash))) {
    return res.status(400).json(invalido);
  }

  // [SEC S-10]
  const hash = await hashPassword(password);
  await docClient.send(new UpdateCommand({
    TableName: tables.usuarios,
    Key: { id_usuario: user.id_usuario },
    UpdateExpression: 'SET #Password = :p REMOVE ResetTokenHash, ResetTokenExp ADD tokenVersion :uno',
    ExpressionAttributeNames: { '#Password': 'Password' },
    ExpressionAttributeValues: { ':p': hash, ':uno': 1 },
  }));
  invalidarContextoAcceso(user.id_usuario);

  return res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
});

export default router;
