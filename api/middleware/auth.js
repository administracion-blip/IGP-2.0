import { verifyToken } from '../lib/jwt.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { INTERNAL_SYNC_POST_PATHS, normalizeApiPathname } from '../lib/internalSync.js';
import { codigosPermisoEfectivos } from '../lib/permisoAliases.js';

export function requireAuth(req, res, next) {
  // Bypass interno (scheduler/scripts) vía x-internal-secret.
  // El secreto debe ser largo y rotatorio. INTERNAL_SYNC_IP_ALLOWLIST es opcional:
  // vacía/ausente = solo secret (localhost OK); definida = IP debe estar en la lista.
  const internalSecret = process.env.INTERNAL_SYNC_SECRET;
  if (internalSecret && req.method === 'POST') {
    const pathname = normalizeApiPathname(req);
    if (
      INTERNAL_SYNC_POST_PATHS.has(pathname) &&
      req.headers['x-internal-secret'] === internalSecret
    ) {
      // [SEC S-13] Allowlist IP opcional para el bypass x-internal-secret
      const allowlistRaw = (process.env.INTERNAL_SYNC_IP_ALLOWLIST || '').trim();
      if (allowlistRaw) {
        const allowlist = allowlistRaw.split(',').map((ip) => ip.trim()).filter(Boolean);
        const rawIp = req.ip || req.socket?.remoteAddress || '';
        const clientIp = String(rawIp).replace(/^::ffff:/i, '');
        if (!allowlist.includes(clientIp)) {
          return res.status(401).json({ error: 'IP no autorizada para sync interno' });
        }
      }
      // Llamada de confianza (scheduler/scripts): salta auth y permisos.
      req.isInternal = true;
      return next();
    }
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  try {
    const decoded = verifyToken(header.slice(7));
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (req.user.rol === 'Administrador') return next();
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'Rol insuficiente para este recurso' });
    }
    next();
  };
}

/**
 * Comprueba si un usuario (req.user) tiene un permiso concreto.
 * Administrador siempre lo tiene. Devuelve boolean; útil cuando el permiso
 * depende de datos que solo se conocen dentro del handler (p. ej. el estado
 * de un pedido), donde no se puede usar `requirePermission` como middleware.
 */
export async function hasPermission(user, permiso) {
  if (!user) return false;
  if (user.rol === 'Administrador') return true;
  const codigos = codigosPermisoEfectivos(permiso);
  for (const cod of codigos) {
    const result = await docClient.send(new GetCommand({
      TableName: tables.rolesPermisos,
      Key: { PK: `ROL#${user.rol}`, SK: `PERMISO#${cod}` },
    }));
    if (result.Item) return true;
  }
  return false;
}

export async function hasAnyPermission(user, ...permisos) {
  for (const permiso of permisos) {
    if (await hasPermission(user, permiso)) return true;
  }
  return false;
}

export function requirePermission(permiso) {
  return async (req, res, next) => {
    if (req.isInternal) return next();
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (req.user.rol === 'Administrador') return next();
    try {
      if (await hasPermission(req.user, permiso)) return next();
      return res.status(403).json({ error: 'Permiso insuficiente' });
    } catch (err) {
      console.error('[requirePermission]', err.message);
      return res.status(500).json({ error: 'Error verificando permisos' });
    }
  };
}

export function requireAnyPermission(...permisos) {
  return async (req, res, next) => {
    if (req.isInternal) return next();
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (req.user.rol === 'Administrador') return next();
    try {
      if (await hasAnyPermission(req.user, ...permisos)) return next();
      return res.status(403).json({ error: 'Permiso insuficiente' });
    } catch (err) {
      console.error('[requireAnyPermission]', err.message);
      return res.status(500).json({ error: 'Error verificando permisos' });
    }
  };
}
