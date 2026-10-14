/**
 * Plazo de vencimiento de las facturas: «días desde la fecha de factura».
 *
 * El plazo de cada proveedor vive en el maestro de empresas (`igp_Empresas`,
 * atributo `Vencimiento`, Number; 0 = contado) y el de cada factura en
 * `condiciones_pago` como texto ('contado', '30 días'…). Los registros antiguos
 * traen el plazo en formatos variados ('30_dias', '30d', '30 días fecha
 * factura'), así que todo pasa por `parseDiasPlazo`.
 *
 * Gramática de `parseDiasPlazo` (la misma en el front; la tabla de casos de
 * `tests/plazoVencimiento.test.mjs` es la referencia común):
 *   - Number entero.
 *   - Texto, sin distinguir mayúsculas ni tildes y sin espacios en los extremos;
 *     entre palabras, uno o más espacios:
 *       'contado' | 'al contado'                 → 0
 *       '<n>' | '<n>d' | '<n>_dias'              → n
 *       '<n> dia' | '<n> dias'                   → n
 *       '<n> dias fecha factura' | '… f.f.' | '… ff' → n
 *   - <n> son 1 a 3 cifras y el resultado tiene que estar en 0..365.
 *   - Cualquier otra cosa ('fin de mes', listas '30, 60 días', '30 d',
 *     decimales, negativos…) → null.
 *
 * Funciones puras: sin lecturas de DynamoDB.
 */

import { fechaEmisionFacturaAIso } from './idDocumento.js';
import { fechaIndiceIso } from './clavesIndice.js';

export const DIAS_PLAZO_MAX = 365;

function enRango(n) {
  return Number.isInteger(n) && n >= 0 && n <= DIAS_PLAZO_MAX ? n : null;
}

/**
 * Días de plazo de un valor de maestro o de `condiciones_pago`.
 * @param {unknown} valor
 * @returns {number|null} entero 0..365, o null si está vacío, no se reconoce o se sale de rango
 */
export function parseDiasPlazo(valor) {
  if (valor == null) return null;
  if (typeof valor === 'number') return enRango(valor);
  if (typeof valor !== 'string') return null;
  const s = valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (/^(?:al\s+)?contado$/.test(s)) return 0;
  const m = /^(\d{1,3})(?:d|_dias|\s+dias?(?:\s+(?:fecha\s+factura|f\.f\.|ff))?)?$/.exec(s);
  if (!m) return null;
  return enRango(Number(m[1]));
}

/** Claves de `condiciones_pago` con las que la emisión de ventas (OUT) pone vencimiento. */
const DIAS_CONDICIONES_VENTA = Object.freeze({ contado: 0, '15_dias': 15, '30_dias': 30, '60_dias': 60, '90_dias': 90 });

/**
 * Vencimiento de una venta al emitir. Solo entiende las claves exactas de
 * `DIAS_CONDICIONES_VENTA`: un texto como '30 días' deja la venta sin
 * vencimiento (si no, entraría en check-vencimientos y en los recordatorios a
 * clientes).
 * @param {unknown} condiciones
 * @param {unknown} fechaBase emisión o, si no hay, hoy
 * @returns {string} '' si no hay clave o la fecha no vale
 */
export function vencimientoVentaPorCondiciones(condiciones, fechaBase) {
  if (typeof condiciones !== 'string' || !Object.hasOwn(DIAS_CONDICIONES_VENTA, condiciones)) return '';
  return calcularFechaVencimiento(fechaBase, DIAS_CONDICIONES_VENTA[condiciones]);
}

/** Texto de `condiciones_pago` para un plazo en días. */
export function condicionesDesdeDias(n) {
  return n === 0 ? 'contado' : `${n} días`;
}

/**
 * Fecha de vencimiento = emisión + días, en `YYYY-MM-DD`.
 * Aritmética en UTC: sumar días con la hora local salta un día al cruzar el
 * cambio de horario.
 * @param {unknown} fechaEmision ISO (`YYYY-MM-DD…`) o `dd/mm/aaaa`
 * @param {unknown} dias
 * @returns {string} '' si la fecha o los días no valen
 */
export function calcularFechaVencimiento(fechaEmision, dias) {
  const n = typeof dias === 'number' ? enRango(dias) : null;
  if (n == null) return '';
  const iso = fechaIndiceIso(fechaEmisionFacturaAIso(fechaEmision) || '');
  if (!iso) return '';
  const [anio, mes, dia] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(anio, mes - 1, dia + n));
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}
