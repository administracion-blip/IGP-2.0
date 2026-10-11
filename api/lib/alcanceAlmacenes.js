/**
 * Alcance por almacén: un almacén es de un usuario si lo es alguno de los locales
 * que lo tienen en `almacen origen` (mapa local ↔ almacén de MIA). La decisión
 * sigue en `alcance.js` / `alcanceLecturas.js`; aquí solo se traduce el almacén
 * a las referencias de sus locales.
 */

import { cargarAlcance, permiteAlgunLocal } from './alcance.js';
import { permiteLecturaLocal } from './alcanceLecturas.js';
import { buildMapaLocalAlmacen } from './mia/localAlmacen.js';
import { normalizeWarehouseId } from './mia/keys.js';

const mapaPorPeticion = new WeakMap();

/** `porWarehouseId` del mapa, una sola vez por petición. */
function localesPorAlmacen(req) {
  let promesa = mapaPorPeticion.get(req);
  if (!promesa) {
    promesa = buildMapaLocalAlmacen().then((mapa) => mapa.porWarehouseId);
    mapaPorPeticion.set(req, promesa);
  }
  return promesa;
}

/**
 * Referencias `{ idLocal }` de los locales dueños del almacén.
 * @returns {Promise<Array<{ idLocal: string }>>} [] si no es de ningún local (denegado a restringidos).
 */
export async function refsAlmacen(req, warehouseId) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') return [];
  const porAlmacen = await localesPorAlmacen(req);
  return (porAlmacen[wid] || []).map((idLocal) => ({ idLocal }));
}

/** Escrituras y acciones sobre un almacén: bloquean siempre. */
export async function permiteAlmacen(req, warehouseId) {
  const alcance = await cargarAlcance(req);
  if (alcance.global) return true;
  return permiteAlgunLocal(alcance, await refsAlmacen(req, warehouseId));
}

/** Lecturas de un almacén: siguen `modoLecturas()`. */
export async function permiteLecturaAlmacen(req, warehouseId) {
  const alcance = await cargarAlcance(req);
  if (alcance.global) return true;
  return permiteLecturaLocal(req, await refsAlmacen(req, warehouseId));
}
