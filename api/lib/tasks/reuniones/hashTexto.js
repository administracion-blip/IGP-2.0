/**
 * Hash canónico de la transcripción (idempotencia del resumen).
 * Usado por el tick STT y por la importación de texto: no diverger el algoritmo.
 */

import { createHash } from 'node:crypto';

/** SHA-256 hex del texto en UTF-8. */
export function hashTexto(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}
