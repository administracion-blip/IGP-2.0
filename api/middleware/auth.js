import { verifyToken, PREFIJO_SUB_SISTEMA } from '../lib/jwt.js';
import { cargarContextoAcceso, normalizarTokenVersion } from '../lib/tasks/acceso.js';
import { safeEqual } from '../lib/seguridad/safeEqual.js';
import {
  INTERNAL_SYNC_POST_PATHS,
  SYSTEM_TOKEN_GET_PATHS,
  normalizeApiPathname,
} from '../lib/internalSync.js';
import { codigosPermisoEfectivos } from '../lib/permisoAliases.js';
import { permisosRolCacheados, tienePermisoRol } from '../lib/permisos/cachePermisos.js';

export function requireAuth(req, res, next) {
  // Bypass interno (scheduler/scripts) vía x-internal-secret.
  // El secreto debe ser largo y rotatorio. INTERNAL_SYNC_IP_ALLOWLIST es opcional:
  // vacía/ausente = solo secret (localhost OK); definida = IP debe estar en la lista.
  const internalSecret = process.env.INTERNAL_SYNC_SECRET;
  if (internalSecret && req.method === 'POST') {
    const pathname = normalizeApiPathname(req);
    if (
      INTERNAL_SYNC_POST_PATHS.has(pathname) &&
      safeEqual(req.headers['x-internal-secret'], internalSecret)
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
  let decoded;
  try {
    decoded = verifyToken(header.slice(7));
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  if (esTokenDeSistema(decoded)) {
    if (req.method !== 'GET' || !SYSTEM_TOKEN_GET_PATHS.has(normalizeApiPathname(req))) {
      return res.status(403).json({ error: 'Token de sistema no autorizado para esta ruta' });
    }
    req.user = decoded;
    return next();
  }

  return sesionVigente(decoded).then(
    (vigente) => {
      if (!vigente) return res.status(401).json({ error: SESION_CADUCADA });
      req.user = decoded;
      return next();
    },
    (err) => {
      console.error('[requireAuth] Error verificando la sesión', err?.message || err);
      return res.status(500).json({ error: 'Error verificando la sesión' });
    },
  );
}

export const SESION_CADUCADA = 'Sesión caducada, vuelve a iniciar sesión';

function esTokenDeSistema(decoded) {
  return decoded?.sys === true
    && typeof decoded.sub === 'string'
    && decoded.sub.startsWith(PREFIJO_SUB_SISTEMA);
}

/**
 * El token sigue valiendo si el usuario existe, su `tv` coincide con
 * `tokenVersion` y su rol con el de la ficha. Usa el contexto cacheado (60 s):
 * un cambio hecho en otra instancia tarda como mucho eso en surtir efecto aquí.
 */
async function sesionVigente(decoded) {
  const tv = normalizarTokenVersion(decoded.tv);
  const rol = String(decoded.rol ?? '').trim();
  let ctx = await cargarContextoAcceso(decoded);
  if (!ctx.idUsuario) return false;
  // Un tv menor que el cacheado es un token revocado: se rechaza sin leer. Uno
  // mayor (o un rol distinto) puede venir de un login posterior a una revocación
  // hecha en otro proceso: la caché es la que está vieja, se relee una vez.
  if (tv < ctx.tokenVersion) return false;
  if (tv > ctx.tokenVersion || rol !== ctx.rol) {
    ctx = await cargarContextoAcceso(decoded, { forzar: true });
    if (!ctx.idUsuario) return false;
  }
  return tv === ctx.tokenVersion && rol === ctx.rol;
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
  return tienePermisoRol(user.rol, permiso);
}

export async function hasAnyPermission(user, ...permisos) {
  if (!user || permisos.length === 0) return false;
  if (user.rol === 'Administrador') return true;
  const codigos = await permisosRolCacheados(user.rol);
  return permisos.some((permiso) => codigosPermisoEfectivos(permiso).some((c) => codigos.has(c)));
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
