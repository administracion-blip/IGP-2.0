import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('[SEGURIDAD] JWT_SECRET no definido o menor de 32 caracteres. Abortando arranque.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

export function signToken(payload) {
  // [SEC S-07]
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });
}

/** Prefijo de `sub` reservado a tokens de sistema; ningún `id_usuario` real lo usa. */
export const PREFIJO_SUB_SISTEMA = 'sistema-';

/**
 * Token para llamadas del propio API a sí mismo (informe diario) en nombre de
 * un proceso, no de un usuario: `requireAuth` no lo contrasta con `igp_usuarios`.
 * Vida corta porque no se puede revocar.
 */
export function signSystemToken(nombre) {
  return jwt.sign(
    { sub: `${PREFIJO_SUB_SISTEMA}${nombre}`, email: `sistema@${nombre}`, rol: 'Administrador', sys: true },
    JWT_SECRET,
    { expiresIn: '10m', algorithm: 'HS256' },
  );
}

export function verifyToken(token) {
  // [SEC S-07]
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}
