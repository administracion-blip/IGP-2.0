/**
 * Normalización del concepto de un movimiento (registros 23).
 *
 * El texto normalizado se usará para conciliar contra facturas, así que la meta
 * es dejar el nombre del contrario lo más limpio posible: sin acentos, sin
 * prefijos del tipo de operación y sin espacios sobrantes.
 */

import { normalizeCif } from '../empresaCif.js';
import { limpiarTexto } from './campos.js';

/** Mismo formato de NIF/CIF que ya se usa al leer facturas por OCR. */
const RE_NIF = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/;

// Las partículas van pegadas al prefijo: si se quita "ABONO" pero se deja el
// "POR" de "ABONO POR TRANSFERENCIA", el texto normalizado empieza por una
// preposición huérfana y casa peor con el nombre del proveedor.
const RE_PREFIJO_OPERACION =
  /^(?:TRANSFERENCIAS?|TRANSF|RECIBOS?|ADEUDOS?|PAGOS?|ABONOS?|TRASPASOS?)\b\.?\s*(?:(?:DE|DEL|A|AL|POR|EN)\b\s*)*[-:.,/\s]*/;

/** La Ñ no es un acento: se aparta antes de descomponer para no volverla N. */
const MARCA_ENIE = '\u0001';

/**
 * Mayúsculas sin acentos (conservando la Ñ). La conciliación la reutiliza para
 * normalizar el otro lado de la comparación —nombres y CIF de la factura—, que
 * no pasan por `normalizarConcepto`.
 * @param {string} texto
 * @returns {string}
 */
export function aMayusculasSinAcentos(texto) {
  return String(texto ?? '')
    .normalize('NFC')
    .toUpperCase()
    .split('Ñ')
    .join(MARCA_ENIE)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(MARCA_ENIE)
    .join('Ñ');
}

function quitarPrefijosOperacion(texto) {
  let s = texto;
  // Hay emisores que apilan prefijos ("PAGO TRANSF DE ..."), de ahí el bucle.
  for (let i = 0; i < 3; i += 1) {
    const siguiente = s.replace(RE_PREFIJO_OPERACION, '');
    if (siguiente === s || !siguiente.trim()) break;
    s = siguiente;
  }
  return s;
}

/**
 * NIF/CIF español que aparezca en un texto, o cadena vacía.
 * @param {string} texto
 * @returns {string}
 */
export function extraerNif(texto) {
  const m = RE_NIF.exec(aMayusculasSinAcentos(texto));
  return m ? normalizeCif(m[1]) : '';
}

/**
 * @typedef {object} ConceptoNormalizado
 * @property {string} conceptoTexto Texto tal cual, con espacios colapsados.
 * @property {string} conceptoNormalizado Mayúsculas, sin acentos y sin prefijos de operación.
 * @property {string} nif NIF/CIF hallado en el concepto ('' si no hay).
 */

/**
 * @param {string|string[]} textos Concepto crudo o trozos de los registros 23, en orden.
 * @returns {ConceptoNormalizado}
 */
export function normalizarConcepto(textos) {
  const crudo = Array.isArray(textos) ? textos.join('') : String(textos ?? '');
  const conceptoTexto = limpiarTexto(crudo);
  const sinAcentos = aMayusculasSinAcentos(conceptoTexto);
  return {
    conceptoTexto,
    conceptoNormalizado: limpiarTexto(quitarPrefijosOperacion(sinAcentos)),
    nif: extraerNif(sinAcentos),
  };
}
