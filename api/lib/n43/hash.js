/**
 * Huellas del fichero y de cada movimiento, para que la ingesta posterior sea
 * idempotente.
 */

import { createHash } from 'node:crypto';

const SEPARADOR = '|';

/**
 * SHA-256 (hex) del fichero en bruto: identifica un fichero ya procesado.
 * @param {Buffer|Uint8Array} buffer
 * @returns {string}
 */
export function hashFichero(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * SHA-256 (hex) de un movimiento: su identidad a efectos de no duplicarlo.
 *
 * La receta usa **solo datos que traen todos los formatos de extracto** (Norma
 * 43, Excel y CSV del banco). El N43 trae además la fecha de valor y dos
 * referencias internas, y sería tentador meterlas para afinar la huella; no se
 * hace a propósito: el mismo apunte descargado en Excel no las lleva, saldría
 * otra huella y el movimiento acabaría guardado dos veces.
 *
 * El `ordinal` parece redundante, pero es imprescindible: dos movimientos
 * idénticos el mismo día son perfectamente legítimos —dos consumos del mismo
 * importe— y sin él colapsarían en una única huella, de modo que la ingesta
 * idempotente descartaría el segundo y perderíamos un apunte real.
 *
 * El importe va en céntimos enteros para no depender de cómo redondee los
 * decimales cada formato.
 *
 * @param {object} mov
 * @param {string} mov.cuenta IBAN de la cuenta; el CCC como respaldo si no se pudo construir el IBAN.
 * @param {string} mov.fechaOperacion Fecha de la operación en ISO (YYYY-MM-DD).
 * @param {number} mov.importeCentimos Importe en céntimos, con el signo ya aplicado.
 * @param {number} mov.ordinal Orden del movimiento dentro de su cuenta y su fecha de operación (desde 1).
 * @returns {string}
 */
export function hashMovimiento({ cuenta, fechaOperacion, importeCentimos, ordinal }) {
  const partes = [
    String(cuenta ?? ''),
    String(fechaOperacion ?? ''),
    String(Math.trunc(Number(importeCentimos) || 0)),
    String(ordinal ?? ''),
  ];
  return createHash('sha256').update(partes.join(SEPARADOR), 'utf8').digest('hex');
}
