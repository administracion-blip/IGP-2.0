/**
 * Identificación del Almacén General: **origen único del criterio** en el backend.
 *
 * El maestro `igp_Almacenes` se sincroniza desde Ágora (Id, Nombre, NombreFiscal,
 * Cif, Descripcion, Direccion) y no tiene ningún campo que marque el almacén
 * central, así que el nombre es lo único que lo distingue. Quien decide sobre un
 * pedido compara luego el `Id`, que es la clave del maestro y el valor que viaja
 * en `AlmacenOrigenId`.
 *
 * El criterio vive aquí porque de él dependen dos cosas que no pueden discrepar:
 * el permiso que exige `api/routes/pedidos.js` para servir mercancía desde el
 * almacén de otro local, y la sociedad emisora que resuelve la facturación
 * mensual de compras. Con el criterio duplicado, renombrar el almacén en el
 * maestro empezaba a exigir el permiso a todos los pedidos normales y, a la vez,
 * dejaba a la facturación sin emisor; y corregirlo en un sitio no arreglaba el
 * otro.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

/** Nombre del Almacén General, ya normalizado. */
export const NOMBRE_ALMACEN_GENERAL = 'almacen general';

/** Nombre de almacén comparable: sin acentos, en minúsculas y sin dobles espacios. */
export function normalizarNombreAlmacen(val) {
  return String(val ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * ¿Es este el Almacén General?
 *
 * La comparación es por igualdad exacta a propósito: por inclusión colarían
 * almacenes de local como "ALMACEN GENERAL NEPTUNO", que sí generan factura
 * entre sociedades.
 */
export function esAlmacenGeneral(nombre) {
  return normalizarNombreAlmacen(nombre) === NOMBRE_ALMACEN_GENERAL;
}

/**
 * Vigencia de los ids en memoria. El maestro lo sincroniza Ágora y cambia muy de
 * tarde en tarde, mientras que la consulta estaba en el camino crítico de cada
 * alta y cada edición de pedido: un escaneo del maestro por pedido.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Espera antes de reintentar cuando la lectura falla, con valor anterior o sin él.
 * Sin esto, una avería del maestro convertía cada alta y cada edición de pedido en
 * un escaneo completo contra una tabla que ya estaba en apuros. Es corta a
 * propósito: mientras dura, el permiso interlocal no se puede exigir.
 */
const REINTENTO_TRAS_FALLO_MS = 15 * 1000;

/** `{ ids, expira }`; `ids: null` recuerda que la última lectura falló. */
let cache = null;

/**
 * Olvida los ids en memoria. La usan las pruebas y sirve para refrescar el
 * criterio en caliente después de sincronizar el maestro de almacenes.
 */
export function olvidarAlmacenGeneralCacheado() {
  cache = null;
}

async function leerIdsAlmacenGeneral() {
  const ids = new Set();
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.almacenes,
      ProjectionExpression: 'Id, Nombre',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const alm of r.Items || []) {
      if (!esAlmacenGeneral(alm.Nombre)) continue;
      const id = String(alm.Id ?? '').trim();
      if (id) ids.add(id);
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return ids;
}

/**
 * Ids del maestro que son el Almacén General (normalmente uno solo).
 *
 * `ok: false` significa que **no se pudo leer el maestro**, y es distinto de leerlo
 * y no encontrar ninguno: quien decide un permiso a partir de esto no puede
 * tratar una caída de DynamoDB como si el almacén no existiera.
 *
 * Si la lectura falla pero hay un valor anterior, se sigue usando aunque esté
 * caducado: un criterio de hace unos minutos es infinitamente mejor que ninguno.
 * Y falle con valor anterior o sin él, se espera antes de reintentar para no
 * castigar al maestro con un escaneo por petición mientras dure la avería.
 *
 * @returns {Promise<{ ok: boolean, ids: Set<string>, caducada?: boolean }>}
 */
export async function idsAlmacenGeneral() {
  const ahora = Date.now();
  if (cache && ahora < cache.expira) {
    return cache.ids ? { ok: true, ids: cache.ids } : { ok: false, ids: new Set() };
  }
  try {
    const ids = await leerIdsAlmacenGeneral();
    cache = { ids, expira: ahora + CACHE_TTL_MS };
    return { ok: true, ids };
  } catch (err) {
    console.error('[almacenGeneral] No se pudo leer el maestro de almacenes:', err?.message || err);
    const anteriores = cache?.ids ?? null;
    cache = { ids: anteriores, expira: ahora + REINTENTO_TRAS_FALLO_MS };
    return anteriores ? { ok: true, ids: anteriores, caducada: true } : { ok: false, ids: new Set() };
  }
}
