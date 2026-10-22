/**
 * Caché en memoria del listado completo de igp_Locales (Scan de todas las páginas).
 *
 * GET /locales sirve todas sus variantes (completa, `minimal`, `grupoParipe`)
 * derivándolas de esta lista, así que una sola caché vale para todas.
 *
 * Toda escritura sobre `tables.locales` debe llamar a `invalidarCacheLocales`
 * (además de `invalidarMaestroLocales` si cambia nombre, agoraCode, empresa o
 * id_empresa). En otra instancia de la API el cambio tarda como mucho
 * `CACHE_TTL_MS` en verse.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { alInvalidarMaestroLocales } from '../alcance.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {{ items: object[], expira: number } | null} */
let cache = null;
/** @type {Promise<object[]> | null} */
let enCurso = null;
// Una invalidación durante un Scan en curso no debe dejar cacheado el resultado viejo.
let generacion = 0;

async function escanearLocales() {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tables.locales,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []).map((item) => item || {}));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

function cargar() {
  if (cache && cache.expira > Date.now()) return Promise.resolve(cache.items);
  if (!enCurso) {
    const generacionInicio = generacion;
    const promesa = escanearLocales()
      .then((items) => {
        if (generacionInicio === generacion) {
          cache = { items, expira: Date.now() + CACHE_TTL_MS };
        }
        return items;
      })
      .finally(() => {
        if (enCurso === promesa) enCurso = null;
      });
    enCurso = promesa;
  }
  return enCurso;
}

/**
 * Todos los locales, con todos sus atributos. Devuelve copias: el llamador puede
 * mutarlas sin tocar la caché. Si el Scan falla, el error se propaga y no se cachea.
 */
export async function listarLocalesCacheados() {
  const items = await cargar();
  return items.map((item) => structuredClone(item));
}

/** Llamar tras cualquier escritura en igp_Locales. */
export function invalidarCacheLocales() {
  generacion += 1;
  cache = null;
  enCurso = null;
}

alInvalidarMaestroLocales(invalidarCacheLocales);
