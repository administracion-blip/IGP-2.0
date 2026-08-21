/**
 * API pública del parser Norma 43 (Cuaderno 43 AEB/CECA).
 *
 * `parsearN43(buffer)` es una función pura: no lee ficheros, no toca DynamoDB ni
 * S3. La ingesta de movimientos bancarios se construye encima de su salida.
 */

export { parsearN43 } from './parser.js';
export { construirIbanN43, construirCcc, cccAIbanEspanol, digitosControlCcc } from './ccc.js';
export { normalizarConcepto, extraerNif } from './concepto.js';
export { hashFichero, hashMovimiento } from './hash.js';
export {
  LARGO_REGISTRO,
  campo,
  centimosAEuros,
  parsearClaveSigno,
  parsearFechaAammdd,
  parsearImporteCentimos,
} from './campos.js';
