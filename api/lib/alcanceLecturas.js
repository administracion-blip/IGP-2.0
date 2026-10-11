/**
 * Lecturas y listados por local con el modo de `modoLecturas()`.
 *
 * En 'observar' se sirve todo y se deja un aviso con los locales que se
 * denegarían; en 'bloquear' se filtra (listados) o se responde 403 (lectura de
 * un local ajeno). Las escrituras no pasan por aquí: bloquean siempre.
 *
 * La referencia de local puede ser una lista (ver `permiteAlgunLocal`): basta
 * con que una esté permitida.
 */

import { cargarAlcance, permiteLocal, permiteAlgunLocal, modoLecturas } from './alcance.js';

function usuarioDe(req) {
  return req?.user?.sub ?? req?.user?.id_usuario ?? '?';
}

function valorRef(ref) {
  if (Array.isArray(ref)) return ref.map(valorRef).filter(Boolean).join('|');
  if (!ref || typeof ref !== 'object') return '';
  return String(ref.workplaceId ?? ref.agoraCode ?? ref.idLocal ?? ref.nombre ?? '').trim();
}

/** Aviso del modo observación, sin datos del registro. */
export function avisarDenegaria(req, locales) {
  const ruta = String(req?.originalUrl || req?.url || '').split('?')[0];
  console.warn('[alcance] denegaría', { ruta, usuario: usuarioDe(req), locales: [...locales] });
}

/**
 * @param {(item: object) => object|object[]} refDe referencia de local de cada elemento.
 * @returns {Promise<object[]>} todo en 'observar'; solo lo permitido en 'bloquear'.
 */
export async function filtrarLecturaPorLocal(req, items, refDe) {
  const lista = Array.isArray(items) ? items : [];
  const alcance = await cargarAlcance(req);
  if (alcance.global) return lista;

  const permitidos = [];
  const ajenos = new Set();
  for (const it of lista) {
    const ref = refDe(it);
    if (permiteAlgunLocal(alcance, ref)) permitidos.push(it);
    else ajenos.add(valorRef(ref));
  }
  if (ajenos.size === 0) return lista;
  if (modoLecturas() === 'bloquear') return permitidos;
  avisarDenegaria(req, ajenos);
  return lista;
}

/**
 * Lectura de un local concreto.
 * @returns {Promise<boolean>} `false` solo en 'bloquear' y con el local fuera de alcance.
 */
export async function permiteLecturaLocal(req, ref) {
  const alcance = await cargarAlcance(req);
  if (permiteAlgunLocal(alcance, ref)) return true;
  if (modoLecturas() === 'bloquear') return false;
  avisarDenegaria(req, [valorRef(ref)]);
  return true;
}

/**
 * workplaceIds (agoraCode) con los que consultar una lectura que acepta una lista,
 * donde la lista vacía significa «todos los locales».
 *
 * - Global u 'observar': `pedidos` tal cual (en 'observar' avisa de los ajenos;
 *   con la lista vacía, de que pide todos).
 * - 'bloquear': solo los permitidos; la lista vacía pasa a ser todos los suyos.
 *
 * @returns {Promise<string[]|null>} `null` si no queda ningún local permitido (403).
 */
export async function workplacesLectura(req, pedidos) {
  const lista = [...new Set((Array.isArray(pedidos) ? pedidos : []).map((v) => String(v ?? '').trim()).filter(Boolean))];
  const alcance = await cargarAlcance(req);
  if (alcance.global) return lista;

  const permitidos = lista.filter((v) => permiteLocal(alcance, { workplaceId: v }));
  const bloquear = modoLecturas() === 'bloquear';
  if (lista.length === 0) {
    if (bloquear) return alcance.agoraCodes.size > 0 ? [...alcance.agoraCodes] : null;
    avisarDenegaria(req, ['*']);
    return lista;
  }
  if (permitidos.length === lista.length) return lista;
  if (bloquear) return permitidos.length > 0 ? permitidos : null;
  avisarDenegaria(req, lista.filter((v) => !permitidos.includes(v)));
  return lista;
}
