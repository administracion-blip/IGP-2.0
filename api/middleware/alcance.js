/**
 * Middlewares de aislamiento por local. La decisión vive en `lib/alcance.js`.
 *
 * Van después del permiso (`requirePermission`/`requireAnyPermission`) y, en
 * rutas multipart, después de `upload.single(...)` para que exista `req.body`.
 *
 * Todos aceptan `{ modo: 'observar' }`: registra lo que denegaría y deja pasar.
 */

import {
  cargarAlcance,
  permiteLocal,
  registrarObservacion,
  MENSAJE_SIN_ACCESO_LOCAL,
} from '../lib/alcance.js';

function valoresDe(bruto) {
  if (bruto == null) return [];
  if (Array.isArray(bruto)) return bruto.flatMap(valoresDe);
  const s = String(bruto).trim();
  return s ? [s] : [];
}

/** Como `valoresDe`, pero además separa por comas (`?ids=a,b`). */
function listaDe(bruto) {
  return valoresDe(bruto)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

function denegar(res) {
  return res.status(403).json({ error: MENSAJE_SIN_ACCESO_LOCAL });
}

function fallo(res, err) {
  console.error('[alcance]', err?.message || err);
  return res.status(500).json({ error: 'Error verificando el acceso al local' });
}

/**
 * Extractores. Usan la semántica de `??` (primera clave no null/undefined), igual
 * que los handlers, para que el middleware compruebe el mismo valor que se usa.
 */
function primeraDefinida(objeto, claves) {
  for (const k of claves) {
    const v = objeto?.[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export const desde = {
  query: (...claves) => (req) => primeraDefinida(req.query, claves),
  body: (...claves) => (req) => primeraDefinida(req.body, claves),
  /** Primer extractor que devuelva algo no null/undefined. */
  primero: (...extractores) => (req) => {
    for (const ex of extractores) {
      const v = ex(req);
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  },
  /**
   * Segmento `indiceSegmento` de una clave S3 (`?key=` o `body.key`). Si la clave no
   * empieza por `prefijo` devuelve '' (denegado a restringidos).
   */
  claveS3: (prefijo, indiceSegmento, campo = 'key') => (req) => {
    const key = String(primeraDefinida(req.query, [campo]) ?? primeraDefinida(req.body, [campo]) ?? '').trim();
    if (!key.startsWith(prefijo) || key.includes('..')) return '';
    return key.split('/')[indiceSegmento] ?? '';
  },
};

/**
 * Exige que el local de la petición esté en el alcance del usuario.
 * `extraer(req)` devuelve el valor (o varios: todos deben estar permitidos).
 * Sin valor: los restringidos reciben 403; los globales siguen (el handler valida).
 *
 * @param {(req: object) => unknown} extraer
 * @param {{ tipo?: 'workplaceId'|'agoraCode'|'idLocal'|'nombre', modo?: 'bloquear'|'observar' }} [opciones]
 */
export function requireLocal(extraer, { tipo = 'workplaceId', modo = 'bloquear' } = {}) {
  return async (req, res, next) => {
    try {
      const alcance = await cargarAlcance(req);
      if (alcance.global) return next();
      const valores = valoresDe(extraer(req));
      const ok = valores.length > 0 && valores.every((v) => permiteLocal(alcance, { [tipo]: v }));
      if (ok) return next();
      if (modo === 'observar') {
        registrarObservacion(req, `${tipo}=${JSON.stringify(valores)}`);
        return next();
      }
      return denegar(res);
    } catch (err) {
      return fallo(res, err);
    }
  };
}

/**
 * Lista de locales (array o separada por comas) intersecada con el alcance.
 * Deja el resultado en `req.alcanceLocales`; no toca `req.query` ni `req.body`.
 *
 * - Global: `req.alcanceLocales` = la lista pedida, tal cual (puede ser []).
 * - Restringido: solo los permitidos; si no queda ninguno, 403.
 * - Lista vacía: con `obligatorio` es 403 para restringidos; sin él pasa con []
 *   sin cargar el alcance, y el handler no debe interpretar [] como «todos».
 *
 * @param {(req: object) => unknown} extraer
 * @param {{ obligatorio?: boolean, tipo?: 'workplaceId'|'agoraCode'|'idLocal'|'nombre', modo?: 'bloquear'|'observar' }} [opciones]
 */
export function requireLocales(extraer, { obligatorio = false, tipo = 'workplaceId', modo = 'bloquear' } = {}) {
  return async (req, res, next) => {
    try {
      const pedidos = [...new Set(listaDe(extraer(req)))];
      if (pedidos.length === 0 && !obligatorio) {
        req.alcanceLocales = [];
        return next();
      }
      const alcance = await cargarAlcance(req);
      if (alcance.global) {
        req.alcanceLocales = pedidos;
        return next();
      }
      const permitidos = pedidos.filter((v) => permiteLocal(alcance, { [tipo]: v }));
      if (permitidos.length > 0 && permitidos.length === pedidos.length) {
        req.alcanceLocales = permitidos;
        return next();
      }
      if (modo === 'observar') {
        registrarObservacion(req, `${tipo} pedidos=${JSON.stringify(pedidos)} permitidos=${JSON.stringify(permitidos)}`);
        req.alcanceLocales = pedidos;
        return next();
      }
      if (permitidos.length === 0) return denegar(res);
      req.alcanceLocales = permitidos;
      return next();
    } catch (err) {
      return fallo(res, err);
    }
  };
}

/** Solo usuarios con alcance a todos los locales (o llamadas internas). */
export function requireAlcanceGlobal({ modo = 'bloquear' } = {}) {
  return async (req, res, next) => {
    try {
      const alcance = await cargarAlcance(req);
      if (alcance.global) return next();
      if (modo === 'observar') {
        registrarObservacion(req, 'requiere alcance global');
        return next();
      }
      return res.status(403).json({ error: 'Esta acción requiere acceso a todos los locales' });
    } catch (err) {
      return fallo(res, err);
    }
  };
}
