import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('[SEGURIDAD] JWT_SECRET no definido o menor de 32 caracteres. Abortando arranque.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
