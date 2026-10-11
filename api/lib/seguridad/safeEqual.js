import crypto from 'crypto';

/**
 * Igualdad de secretos sin fugas por tiempo. Solo acepta cadenas; cualquier otra
 * cosa, la cadena vacía o longitudes distintas → `false` (sin lanzar).
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
