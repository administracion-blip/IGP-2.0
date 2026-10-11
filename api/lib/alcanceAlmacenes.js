/**
 * Alcance por almacén: un almacén es de un usuario si lo es alguno de los locales
 * que lo tienen en `almacen origen` (mapa local ↔ almacén de MIA). La decisión
 * sigue en `alcance.js` / `alcanceLecturas.js`; aquí solo se traduce el almacén
 * a las referencias de sus locales.
 */

import { cargarAlcance, permiteAlgunLocal, alInvalidarMaestroLocales } from './alcance.js';
import { permiteLecturaLocal } from './alcanceLecturas.js';
import { buildMapaLocalAlmacen } from './mia/localAlmacen.js';
import { normalizeWarehouseId } from './mia/keys.js';

const MAPA_TTL_MS = 60_000;

let mapaCache = null;
let mapaEnCurso = null;
// Una invalidación durante un Scan en curso no debe dejar cacheado el resultado viejo.
let mapaGeneracion = 0;

/** `porWarehouseId` del mapa local ↔ almacén. Caché de 60 s, como el maestro de locales. */
function localesPorAlmacen() {
  if (mapaCache && mapaCache.expira > Date.now()) return Promise.resolve(mapaCache.valor);
  if (!mapaEnCurso) {
    const generacion = mapaGeneracion;
    const promesa = buildMapaLocalAlmacen()
      .then((mapa) => {
        const valor = mapa.porWarehouseId;
        if (generacion === mapaGeneracion) {
          mapaCache = { valor, expira: Date.now() + MAPA_TTL_MS };
        }
        return valor;
      })
      .finally(() => {
        if (mapaEnCurso === promesa) mapaEnCurso = null;
      });
    mapaEnCurso = promesa;
  }
  return mapaEnCurso;
}

/** Llamar al crear, editar o borrar un almacén. Los cambios de locales llegan por `invalidarMaestroLocales`. */
export function invalidarMapaAlmacenes() {
  mapaGeneracion += 1;
  mapaCache = null;
  mapaEnCurso = null;
}

alInvalidarMaestroLocales(invalidarMapaAlmacenes);

/**
 * Referencias `{ idLocal }` de los locales dueños del almacén.
 * @returns {Promise<Array<{ idLocal: string }>>} [] si no es de ningún local (denegado a restringidos).
 */
export async function refsAlmacen(_req, warehouseId) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') return [];
  const porAlmacen = await localesPorAlmacen();
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
