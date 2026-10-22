/**
 * Lecturas y escrituras en lote contra DynamoDB, completas o con error.
 *
 * `BatchGetItem` y `BatchWriteItem` pueden devolver parte de la petición sin
 * procesar (`UnprocessedKeys` / `UnprocessedItems`) cuando hay throttling: no es
 * un error del SDK, así que un bucle que no las reintente pierde lecturas o
 * escrituras en silencio. Aquí se reintentan con backoff exponencial y, si tras
 * el máximo de intentos sigue quedando algo, se **lanza** un error: nunca se
 * devuelve un resultado parcial como si fuera completo.
 */

import { BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../db.js';

/** Límites del servicio por petición. */
export const MAX_CLAVES_BATCH_GET = 100;
export const MAX_ITEMS_BATCH_WRITE = 25;

/** Intentos totales por bloque (el primero incluido). */
export const MAX_INTENTOS_LOTE = 8;
const BASE_ESPERA_MS = 50;

let esperaPorDefecto = (ms) => new Promise((listo) => setTimeout(listo, ms));

/**
 * Sustituye la espera entre reintentos (las pruebas la anulan para no dormir de
 * verdad). Devuelve una función que restaura la anterior.
 * @param {(ms: number) => Promise<void>} fn
 */
export function fijarEsperaReintentos(fn) {
  const anterior = esperaPorDefecto;
  esperaPorDefecto = fn;
  return () => {
    esperaPorDefecto = anterior;
  };
}

/** 50 ms · 2^n con jitter (entre la mitad y el total del tramo). */
export function esperaBackoff(intento) {
  const tope = BASE_ESPERA_MS * 2 ** intento;
  return Math.round(tope / 2 + Math.random() * (tope / 2));
}

function trocear(lista, tam) {
  const bloques = [];
  for (let i = 0; i < lista.length; i += tam) bloques.push(lista.slice(i, i + tam));
  return bloques;
}

/** Firma estable de una clave, independiente del orden de sus atributos. */
function firmaClave(clave) {
  return JSON.stringify(Object.keys(clave).sort().map((k) => [k, clave[k]]));
}

/**
 * Indexa ítems por la clave que diga el llamador (BatchGet no garantiza orden).
 * @template T
 * @param {T[]} items
 * @param {(item: T) => unknown} claveDe
 * @returns {Map<unknown, T>}
 */
export function indexarPor(items, claveDe) {
  const mapa = new Map();
  for (const it of items || []) mapa.set(claveDe(it), it);
  return mapa;
}

/**
 * Lee todas las claves de `tabla` en bloques de 100.
 *
 * Las claves repetidas se piden una sola vez. Las que no existen no vuelven (como
 * en `GetItem`). Si tras `maxIntentos` quedan claves sin procesar, lanza un error
 * con `err.pendientes` (las claves no leídas).
 *
 * @param {string} tabla
 * @param {Record<string, unknown>[]} claves
 * @param {{
 *   projection?: string,
 *   expressionAttributeNames?: Record<string, string>,
 *   maxIntentos?: number,
 *   esperar?: (ms: number) => Promise<void>,
 * }} [opts]
 * @returns {Promise<Record<string, unknown>[]>} ítems sin orden garantizado.
 */
export async function batchGetTodos(tabla, claves, opts = {}) {
  const { projection, expressionAttributeNames, maxIntentos = MAX_INTENTOS_LOTE } = opts;
  const esperar = opts.esperar || esperaPorDefecto;

  const unicas = [];
  const vistas = new Set();
  for (const clave of claves || []) {
    const firma = firmaClave(clave);
    if (vistas.has(firma)) continue;
    vistas.add(firma);
    unicas.push(clave);
  }

  const items = [];
  for (const bloque of trocear(unicas, MAX_CLAVES_BATCH_GET)) {
    let pendientes = bloque;
    for (let intento = 0; pendientes.length > 0; intento += 1) {
      if (intento >= maxIntentos) {
        throw Object.assign(
          new Error(`BatchGet en ${tabla}: ${pendientes.length} claves sin leer tras ${maxIntentos} intentos`),
          { pendientes },
        );
      }
      if (intento > 0) await esperar(esperaBackoff(intento - 1));
      const r = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [tabla]: {
            Keys: pendientes,
            ...(projection && { ProjectionExpression: projection }),
            ...(expressionAttributeNames && { ExpressionAttributeNames: expressionAttributeNames }),
          },
        },
      }));
      items.push(...(r.Responses?.[tabla] || []));
      pendientes = r.UnprocessedKeys?.[tabla]?.Keys || [];
    }
  }
  return items;
}

/**
 * Escribe (solo `Put`) todos los ítems en `tabla` en bloques de 25.
 *
 * Si tras `maxIntentos` quedan ítems sin escribir, o una petición falla, lanza un
 * error con `err.pendientes`: los ítems que **no** consta que se hayan escrito
 * (los sin procesar del bloque y los de los bloques siguientes), para que el
 * llamador pueda registrarlos.
 *
 * @param {string} tabla
 * @param {Record<string, unknown>[]} items
 * @param {{ maxIntentos?: number, esperar?: (ms: number) => Promise<void> }} [opts]
 */
export async function batchWriteTodos(tabla, items, opts = {}) {
  const { maxIntentos = MAX_INTENTOS_LOTE } = opts;
  const esperar = opts.esperar || esperaPorDefecto;
  const bloques = trocear(items || [], MAX_ITEMS_BATCH_WRITE);

  for (let b = 0; b < bloques.length; b += 1) {
    let peticiones = bloques[b].map((Item) => ({ PutRequest: { Item } }));
    const restoTrasEste = () => bloques.slice(b + 1).flat();
    for (let intento = 0; peticiones.length > 0; intento += 1) {
      if (intento >= maxIntentos) {
        throw Object.assign(
          new Error(`BatchWrite en ${tabla}: ${peticiones.length} ítems sin escribir tras ${maxIntentos} intentos`),
          { pendientes: [...peticiones.map((p) => p.PutRequest.Item), ...restoTrasEste()] },
        );
      }
      if (intento > 0) await esperar(esperaBackoff(intento - 1));
      let r;
      try {
        r = await docClient.send(new BatchWriteCommand({ RequestItems: { [tabla]: peticiones } }));
      } catch (err) {
        if (err && typeof err === 'object') {
          err.pendientes = [...peticiones.map((p) => p.PutRequest.Item), ...restoTrasEste()];
        }
        throw err;
      }
      peticiones = r.UnprocessedItems?.[tabla] || [];
    }
  }
}
