// [SEC S-10]
/**
 * Helpers de contraseña: bcrypt + verificación legacy (plaintext) con
 * comparación timing-safe. Migración gradual on-login; no se corta plaintext
 * por fecha.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';

export const BCRYPT_ROUNDS = 10;
export const MIN_PASSWORD_LENGTH = 8;

/** Prefijo típico de hash bcrypt ($2a$ / $2b$ / $2y$). */
export function isBcryptHash(str) {
  return typeof str === 'string' && /^\$2[aby]\$\d{2}\$/.test(str);
}

export async function hashPassword(plain) {
  return bcrypt.hash(String(plain ?? ''), BCRYPT_ROUNDS);
}

/**
 * Verifica contraseña contra valor almacenado (bcrypt o plaintext legacy).
 * Nunca lanza por inputs vacíos/raros: devuelve `{ ok: false, legacy: false }`.
 *
 * @returns {{ ok: boolean, legacy: boolean }}
 */
export async function verifyPassword(plain, stored) {
  try {
    if (typeof plain !== 'string' || typeof stored !== 'string') {
      return { ok: false, legacy: false };
    }
    if (!plain || !stored) {
      return { ok: false, legacy: false };
    }

    if (isBcryptHash(stored)) {
      const ok = await bcrypt.compare(plain, stored);
      return { ok: Boolean(ok), legacy: false };
    }

    // Legacy plaintext: timing-safe; longitudes distintas → no match.
    if (stored.length !== plain.length) {
      return { ok: false, legacy: true };
    }
    const match = crypto.timingSafeEqual(
      Buffer.from(stored),
      Buffer.from(plain)
    );
    return { ok: Boolean(match), legacy: true };
  } catch {
    return { ok: false, legacy: false };
  }
}
