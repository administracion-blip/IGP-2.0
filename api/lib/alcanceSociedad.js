/**
 * Lecturas y listados por sociedad (id_empresa) con el modo de `modoLecturas()`.
 *
 * En 'observar' se sirve todo y se deja un aviso por sociedad que se denegaría;
 * en 'bloquear' se filtra. Las escrituras no pasan por aquí: comprueban
 * `permiteEmpresa` sobre `cargarAlcance(req)` y bloquean siempre.
 */

import { cargarAlcance, permiteEmpresa, modoLecturas } from './alcance.js';

function usuarioDe(req) {
  return req?.user?.sub ?? req?.user?.id_usuario ?? '?';
}

/** Aviso del modo observación, sin datos del registro. */
export function avisarDenegaria(req, empresa) {
  const ruta = String(req?.originalUrl || req?.url || '').split('?')[0];
  console.warn('[alcance] denegaría', { ruta, usuario: usuarioDe(req), empresa: String(empresa ?? '') });
}

/**
 * @param {(item: object) => string|string[]} empresasDe sociedad o sociedades del elemento;
 *   con varias, basta con que una esté permitida.
 * @returns {Promise<object[]>} todo en 'observar'; solo lo permitido en 'bloquear'.
 */
export async function filtrarLecturaPorEmpresa(req, items, empresasDe) {
  const lista = Array.isArray(items) ? items : [];
  const alcance = await cargarAlcance(req);
  if (alcance.global) return lista;

  const permitidos = [];
  const ajenas = new Set();
  for (const it of lista) {
    const valor = empresasDe(it);
    const empresas = Array.isArray(valor) ? valor : [valor];
    if (empresas.some((e) => permiteEmpresa(alcance, e))) permitidos.push(it);
    else ajenas.add(empresas.map((e) => String(e ?? '')).join(',') || '');
  }
  if (ajenas.size === 0) return lista;
  if (modoLecturas() === 'bloquear') return permitidos;
  for (const e of ajenas) avisarDenegaria(req, e);
  return lista;
}

/**
 * Lectura de un registro de una sociedad.
 * @returns {Promise<boolean>} `false` solo en 'bloquear' y con la sociedad fuera de alcance.
 */
export async function permiteLecturaEmpresa(req, empresa) {
  const alcance = await cargarAlcance(req);
  if (permiteEmpresa(alcance, empresa)) return true;
  if (modoLecturas() === 'bloquear') return false;
  avisarDenegaria(req, empresa);
  return true;
}
