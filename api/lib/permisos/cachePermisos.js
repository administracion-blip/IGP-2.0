/**
 * Caché en memoria de los permisos por rol.
 *
 * `hasPermission` se ejecuta en casi todas las peticiones; sin caché hacía un
 * `GetItem` por código (y por alias) cada vez. Aquí se carga el rol entero con
 * una sola Query y se guarda unos segundos.
 *
 * Toda escritura sobre `tables.rolesPermisos` debe llamar a
 * `invalidarPermisosRol`. En otra instancia de la API el cambio tarda como mucho
 * `CACHE_TTL_MS` en verse.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { codigosPermisoEfectivos } from '../permisoAliases.js';

const CACHE_TTL_MS = 60_000;

/** @type {Map<string, { codigos: Set<string>, expira: number }>} */
const cache = new Map();
/** @type {Map<string, Promise<Set<string>>>} */
const enVuelo = new Map();
/** Sube en cada invalidación: una carga empezada antes no debe repoblar la caché. */
let generacion = 0;
let reloj = () => Date.now();

/** Lee de DynamoDB, sin caché, los códigos concedidos al rol. */
export async function permisosDelRol(rol) {
  const codigos = new Set();
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tables.rolesPermisos,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `ROL#${rol}`, ':sk': 'PERMISO#' },
        ProjectionExpression: 'SK',
        // Tras invalidar, una lectura eventual podría traer aún un permiso borrado y cachearlo.
        ConsistentRead: true,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    for (const item of result.Items || []) {
      const codigo = String(item.SK || '').replace(/^PERMISO#/, '');
      if (codigo) codigos.add(codigo);
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return codigos;
}

/** El `Set` cacheado se comparte entre peticiones: se anulan sus mutadores. */
function conjuntoInmutable(codigos) {
  const bloquear = () => {
    throw new Error('Los permisos cacheados del rol son inmutables');
  };
  codigos.add = bloquear;
  codigos.delete = bloquear;
  codigos.clear = bloquear;
  return Object.freeze(codigos);
}

/**
 * Códigos del rol desde la caché (inmutables).
 * Si la Query falla, el error se propaga y no se cachea nada.
 */
export async function permisosRolCacheados(rol) {
  const clave = String(rol);
  const entrada = cache.get(clave);
  if (entrada && entrada.expira > reloj()) return entrada.codigos;

  const pendiente = enVuelo.get(clave);
  if (pendiente) return pendiente;

  const generacionInicio = generacion;
  const promesa = permisosDelRol(clave)
    .then(conjuntoInmutable)
    .then((codigos) => {
      if (generacionInicio === generacion) {
        cache.set(clave, { codigos, expira: reloj() + CACHE_TTL_MS });
      }
      return codigos;
    })
    .finally(() => {
      if (enVuelo.get(clave) === promesa) enVuelo.delete(clave);
    });
  enVuelo.set(clave, promesa);
  return promesa;
}

/** Sin argumento vacía toda la caché; con rol, solo ese rol. */
export function invalidarPermisosRol(rol) {
  generacion += 1;
  if (rol === undefined) {
    cache.clear();
    enVuelo.clear();
    return;
  }
  const clave = String(rol);
  cache.delete(clave);
  enVuelo.delete(clave);
}

/** ¿Concede el rol el permiso (o alguno de sus alias)? No trata Administrador. */
export async function tienePermisoRol(rol, permiso) {
  const codigos = await permisosRolCacheados(rol);
  return codigosPermisoEfectivos(permiso).some((c) => codigos.has(c));
}

/** Solo para pruebas: sustituye el reloj de la caducidad; sin argumento restaura `Date.now`. */
export function fijarRelojCachePermisos(fn) {
  reloj = fn ?? (() => Date.now());
}
