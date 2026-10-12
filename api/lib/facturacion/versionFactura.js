/**
 * Control de versión optimista de las facturas.
 *
 * Todo camino que reescribe la factura entera a partir de una lectura (pagos,
 * borrado de pagos, compensación, exceso, edición) tiene que guardar con
 * `putFacturaVersionada`: si otra petición la ha escrito entretanto, el Put
 * falla en vez de pisar su `total_cobrado`. Sin esto, dos conciliaciones a la
 * vez sobre la misma factura dejaban los dos pagos en `Igp_FacturasPagos` y uno
 * solo sumado en el saldo.
 *
 * Las facturas antiguas sin `version` se aceptan con `attribute_not_exists`: la
 * primera escritura les pone una y desde ahí cuenta como las demás.
 */

import { tables } from '../db.js';
import { aplicarClavesFactura } from './clavesIndice.js';

export const MENSAJE_FACTURA_CAMBIADA = 'La factura ha cambiado, vuelve a intentarlo';
export const INTENTOS_ESCRITURA_FACTURA = 3;

/**
 * Parámetros del Put condicional de una factura. Deja en `factura.version` la
 * versión siguiente a la leída.
 *
 * @param {object} factura Ítem completo a guardar (se modifica su `version`).
 * @param {unknown} versionLeida `version` tal y como venía en la lectura.
 * @param {{ condicion?: string, valores?: Record<string, unknown> }} [extra]
 *   Condición adicional que tiene que cumplirse a la vez (se une con AND).
 */
export function putFacturaVersionada(factura, versionLeida, extra = {}) {
  // Siempre, también si el ítem ya traía gsi_* de una copia: un estado o una
  // fecha recién cambiados tienen que quedar en el índice, y una clave vacía
  // no puede viajar en el Put.
  aplicarClavesFactura(factura);
  const tieneVersion = versionLeida !== undefined && versionLeida !== null;
  factura.version = (Number(versionLeida) || 1) + 1;
  const condVersion = tieneVersion ? '#ver = :verLeida' : 'attribute_not_exists(#ver)';
  const valores = {
    ...(tieneVersion && { ':verLeida': versionLeida }),
    ...(extra.valores || {}),
  };
  return {
    TableName: tables.facturas,
    Item: factura,
    ConditionExpression: extra.condicion ? `(${condVersion}) AND (${extra.condicion})` : condVersion,
    ExpressionAttributeNames: { '#ver': 'version' },
    ...(Object.keys(valores).length > 0 && { ExpressionAttributeValues: valores }),
  };
}

/**
 * Añade a un UpdateCommand de factura la subida de `version`, para que un Put
 * versionado que leyó antes del Update falle y relea en vez de pisarlo. Sin
 * `version`, la factura cuenta como 1 (igual que en `putFacturaVersionada`) y
 * pasa a 2.
 *
 * @param {object} params Parámetros del UpdateCommand con `UpdateExpression` `SET ...`.
 */
export function updateFacturaVersionado(params) {
  const expr = String(params.UpdateExpression || '').trim();
  if (!/^SET\s/i.test(expr)) throw new Error('updateFacturaVersionado espera un UpdateExpression que empiece por SET');
  const subida = '#ver = if_not_exists(#ver, :verUno) + :verUno';
  const otraClausula = expr.search(/\s(REMOVE|ADD|DELETE)\s/i);
  const UpdateExpression = otraClausula === -1
    ? `${expr}, ${subida}`
    : `${expr.slice(0, otraClausula)}, ${subida}${expr.slice(otraClausula)}`;
  return {
    ...params,
    TableName: tables.facturas,
    UpdateExpression,
    ExpressionAttributeNames: { ...(params.ExpressionAttributeNames || {}), '#ver': 'version' },
    ExpressionAttributeValues: { ...(params.ExpressionAttributeValues || {}), ':verUno': 1 },
  };
}

const RAZONES_CONFLICTO = new Set(['ConditionalCheckFailed', 'TransactionConflict']);

/**
 * Choque con otra escritura, suelta o dentro de una transacción: condición que
 * ya no se cumple, o transacción/Put que coincide en el tiempo con otra
 * transacción sobre el mismo ítem (`TransactionConflict*`). Todos se resuelven
 * releyendo y repitiendo.
 */
export function esConflictoEscritura(err) {
  if (err?.name === 'ConditionalCheckFailedException') return true;
  if (err?.name === 'TransactionConflictException') return true;
  if (err?.name !== 'TransactionCanceledException') return false;
  const razones = Array.isArray(err?.CancellationReasons) ? err.CancellationReasons : [];
  return razones.some((r) => RAZONES_CONFLICTO.has(r?.Code));
}

export function errorFacturaCambiada() {
  return Object.assign(new Error(MENSAJE_FACTURA_CAMBIADA), { status: 409, code: 'FACTURA_CAMBIADA' });
}

export const ESPERA_REINTENTO_MIN_MS = 30;
export const ESPERA_REINTENTO_MAX_MS = 120;

/** Espera aleatoria entre intentos para que dos peticiones que chocan no vuelvan a coincidir. */
function esperarAntesDeReintentar() {
  const ms = ESPERA_REINTENTO_MIN_MS
    + Math.floor(Math.random() * (ESPERA_REINTENTO_MAX_MS - ESPERA_REINTENTO_MIN_MS + 1));
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Ejecuta `fn` (lectura + cálculo + escritura condicional) y la repite releyendo
 * si la escritura choca con otra. Agotados los intentos, 409. Las lecturas de
 * `fn` tienen que ser `ConsistentRead`: una lectura eventual puede devolver la
 * versión anterior y gastar el reintento en chocar otra vez.
 *
 * @template T
 * @param {(intento: number) => Promise<T>} fn
 * @param {number} [intentos]
 * @returns {Promise<T>}
 */
export async function conReintentoFactura(fn, intentos = INTENTOS_ESCRITURA_FACTURA) {
  for (let intento = 1; ; intento += 1) {
    try {
      return await fn(intento);
    } catch (err) {
      if (!esConflictoEscritura(err)) throw err;
      if (intento >= intentos) throw errorFacturaCambiada();
      await esperarAntesDeReintentar();
    }
  }
}
