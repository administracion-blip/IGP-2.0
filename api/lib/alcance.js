/**
 * Alcance por local: ¿puede el usuario de esta petición actuar sobre este local?
 *
 * Único punto donde se decide el aislamiento por local. Los routers no comparan
 * `user.Locales` a mano: piden el alcance aquí (o usan `middleware/alcance.js`).
 *
 * Global = Administrador (por token), llamada interna (`req.isInternal`) o
 * usuario con `Local` vacío en igp_usuarios. El resto queda restringido a los
 * locales de su lista, resueltos contra el maestro de locales.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from './db.js';
import { cargarContextoAcceso } from './tasks/acceso.js';
import { formatId6 } from './usuarioLocales.js';

export const MENSAJE_SIN_ACCESO_LOCAL = 'No tienes acceso a este local';

const MAESTRO_TTL_MS = 60_000;

// ─── Maestro de locales ───

let maestroCache = null;
let maestroEnCurso = null;
// Una invalidación durante un Scan en curso no debe dejar cacheado el resultado viejo.
let maestroGeneracion = 0;

function normalizarNombre(valor) {
  return String(valor ?? '').trim().toLowerCase();
}

function normalizarCodigo(valor) {
  return String(valor ?? '').trim();
}

/** formatId6 solo para ids numéricos: 'abc' daría '000000' y podría coincidir con un local real. */
function normalizarIdLocal(valor) {
  const s = String(valor ?? '').trim();
  if (!/^\d+$/.test(s)) return '';
  return formatId6(s);
}

function normalizarIdEmpresa(valor) {
  const id = normalizarIdLocal(valor);
  return id === '000000' ? '' : id;
}

async function escanearLocales() {
  const porId = new Map();
  const porAgora = new Map();
  const porNombre = new Map();
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.locales,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    for (const loc of result.Items || []) {
      const entrada = Object.freeze({
        idLocal: normalizarIdLocal(loc.id_Locales),
        nombre: String(loc.nombre ?? loc.Nombre ?? '').trim(),
        agoraCode: normalizarCodigo(loc.agoraCode ?? loc.AgoraCode),
        idEmpresa: normalizarIdEmpresa(loc.id_empresa),
        empresa: String(loc.empresa ?? loc.Empresa ?? '').trim(),
      });
      if (entrada.idLocal) porId.set(entrada.idLocal, entrada);
      if (entrada.agoraCode) porAgora.set(entrada.agoraCode, entrada);
      const nombre = normalizarNombre(entrada.nombre);
      if (nombre) porNombre.set(nombre, entrada);
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return Object.freeze({ porId, porAgora, porNombre });
}

/**
 * Maestro de locales con índices `porId` (formatId6), `porAgora` (agoraCode) y
 * `porNombre` (minúsculas, sin espacios extremos). Caché de 60 s.
 */
export async function maestroLocales() {
  if (maestroCache && maestroCache.expira > Date.now()) return maestroCache.valor;
  if (!maestroEnCurso) {
    const generacion = maestroGeneracion;
    const promesa = escanearLocales()
      .then((valor) => {
        if (generacion === maestroGeneracion) {
          maestroCache = { valor, expira: Date.now() + MAESTRO_TTL_MS };
        }
        return valor;
      })
      .finally(() => {
        if (maestroEnCurso === promesa) maestroEnCurso = null;
      });
    maestroEnCurso = promesa;
  }
  return maestroEnCurso;
}

const derivadasDelMaestro = new Set();

/** Registra la invalidación de una caché construida también a partir de igp_Locales. */
export function alInvalidarMaestroLocales(invalidar) {
  derivadasDelMaestro.add(invalidar);
}

/** Llamar al crear, editar o borrar un local. */
export function invalidarMaestroLocales() {
  maestroGeneracion += 1;
  maestroCache = null;
  maestroEnCurso = null;
  for (const invalidar of derivadasDelMaestro) invalidar();
}

// ─── Alcance ───

const ALCANCE_GLOBAL = Object.freeze({ global: true });

function alcanceRestringido({ localIds = [], agoraCodes = [], nombres = [], empresaIds = [] } = {}) {
  return Object.freeze({
    global: false,
    localIds: new Set(localIds),
    agoraCodes: new Set(agoraCodes),
    nombres: new Set(nombres),
    empresaIds: new Set(empresaIds),
  });
}

async function resolverAlcance(req) {
  if (req?.isInternal) return ALCANCE_GLOBAL;
  const user = req?.user;
  if (!user) return alcanceRestringido();
  if (user.rol === 'Administrador') return ALCANCE_GLOBAL;

  const ctx = await cargarContextoAcceso(user);
  // contextoVacio() (usuario borrado o token sin id) marca alcanceGlobalLocales=true
  // porque no tiene locales: aquí eso tiene que ser «ningún local», no «todos».
  if (!ctx.idUsuario) return alcanceRestringido();
  if (ctx.locales.length === 0) return ALCANCE_GLOBAL;

  const maestro = await maestroLocales();
  const nombres = [];
  const localIds = [];
  const agoraCodes = [];
  const empresaIds = [];
  for (const bruto of ctx.locales) {
    const nombre = normalizarNombre(bruto);
    if (!nombre) continue;
    nombres.push(nombre);
    const loc = maestro.porNombre.get(nombre);
    if (!loc) continue;
    if (loc.idLocal) localIds.push(loc.idLocal);
    if (loc.agoraCode) agoraCodes.push(loc.agoraCode);
    if (loc.idEmpresa) empresaIds.push(loc.idEmpresa);
  }
  return alcanceRestringido({ localIds, agoraCodes, nombres, empresaIds });
}

const memoPeticion = new WeakMap();

/**
 * Alcance del usuario de la petición, memorizado por petición.
 * @returns {Promise<{global:true}|{global:false, localIds:Set<string>, agoraCodes:Set<string>, nombres:Set<string>, empresaIds:Set<string>}>}
 */
export function cargarAlcance(req) {
  let promesa = memoPeticion.get(req);
  if (!promesa) {
    promesa = resolverAlcance(req);
    memoPeticion.set(req, promesa);
  }
  return promesa;
}

/**
 * @param {object} alcance
 * @param {{workplaceId?:string, agoraCode?:string, idLocal?:string, nombre?:string}} ref
 *   Referencia vacía o que no está en el maestro: denegada a restringidos.
 */
export function permiteLocal(alcance, ref) {
  if (!alcance) return false;
  if (alcance.global) return true;
  if (!ref || typeof ref !== 'object') return false;
  const codigo = normalizarCodigo(ref.workplaceId ?? ref.agoraCode);
  if (codigo) return alcance.agoraCodes.has(codigo);
  const id = normalizarIdLocal(ref.idLocal);
  if (id) return alcance.localIds.has(id);
  const nombre = normalizarNombre(ref.nombre);
  if (nombre) return alcance.nombres.has(nombre);
  return false;
}

/**
 * Como `permiteLocal`, pero `refs` puede ser una lista: basta con que una de sus
 * referencias esté permitida (registro que pertenece a varios locales a la vez).
 */
export function permiteAlgunLocal(alcance, refs) {
  if (!Array.isArray(refs)) return permiteLocal(alcance, refs);
  if (alcance?.global) return true;
  return refs.some((ref) => permiteLocal(alcance, ref));
}

/**
 * Deja solo los valores permitidos. `tipo` indica qué es cada valor.
 * @param {'workplaceId'|'agoraCode'|'idLocal'|'nombre'} [tipo]
 */
export function intersecarLocales(alcance, valores, tipo = 'workplaceId') {
  const lista = Array.isArray(valores) ? valores : [];
  return lista.filter((v) => permiteLocal(alcance, { [tipo]: v }));
}

/** @param {(item: object) => object} refDe referencia de local de cada elemento. */
export function filtrarPorLocal(alcance, items, refDe) {
  const lista = Array.isArray(items) ? items : [];
  if (alcance?.global) return lista;
  return lista.filter((it) => permiteLocal(alcance, refDe(it)));
}

export function permiteEmpresa(alcance, idEmpresa) {
  if (!alcance) return false;
  if (alcance.global) return true;
  const id = normalizarIdEmpresa(idEmpresa);
  return id !== '' && alcance.empresaIds.has(id);
}

/** @param {(item: object) => string} empresaDe id_empresa de cada elemento. */
export function filtrarPorEmpresa(alcance, items, empresaDe) {
  const lista = Array.isArray(items) ? items : [];
  if (alcance?.global) return lista;
  return lista.filter((it) => permiteEmpresa(alcance, empresaDe(it)));
}

/**
 * Claves S3 `{prefijo}{workplaceId}/...` que se van a guardar en un registro del
 * local `workplaceId`. Un restringido no puede meter una clave nueva de la carpeta
 * `anon` ni de otro local: con ella en un registro suyo, `requireLocalClaveS3` le
 * dejaría leer un fichero que no subió. Las que el registro ya tenía pasan.
 *
 * @param {object} alcance
 * @param {{ prefijo: string, workplaceId: string, claves: string[], previas?: string[] }} datos
 * @returns {string|null} la primera clave rechazada, o null si todas valen
 */
export function claveS3AjenaAlLocal(alcance, { prefijo, workplaceId, claves, previas = [] }) {
  if (alcance?.global) return null;
  const yaEstaban = new Set((previas || []).filter(Boolean));
  const propio = normalizarCodigo(workplaceId);
  for (const clave of claves || []) {
    if (!clave || yaEstaban.has(clave)) continue;
    const segmento = String(clave).startsWith(prefijo) ? String(clave).slice(prefijo.length).split('/')[0] : '';
    if (!segmento || segmento === 'anon' || !propio || normalizarCodigo(segmento) !== propio) return clave;
  }
  return null;
}

export function errorSinAccesoLocal(mensaje = MENSAJE_SIN_ACCESO_LOCAL) {
  return Object.assign(new Error(mensaje), { status: 403 });
}

/**
 * Modo de las lecturas y listados por alcance: `ALCANCE_MODO_LECTURAS=bloquear`
 * filtra; cualquier otro valor (o ausente) solo observa. Las escrituras bloquean siempre.
 * @returns {'bloquear'|'observar'}
 */
export function modoLecturas() {
  return String(process.env.ALCANCE_MODO_LECTURAS ?? '').trim().toLowerCase() === 'bloquear'
    ? 'bloquear'
    : 'observar';
}

/** Deja traza de lo que se denegaría sin bloquear (modo 'observar'). */
export function registrarObservacion(req, detalle) {
  const ruta = String(req?.originalUrl || req?.url || '').split('?')[0];
  const usuario = req?.user?.sub ?? req?.user?.id_usuario ?? '?';
  console.warn(`[alcance] denegaría ${req?.method || ''} ${ruta} usuario=${usuario} ${detalle}`);
}

/**
 * Para usar dentro de un handler cuando el local solo se conoce tras leer datos.
 * Lanza un error HTTP 403 (lo recoge errorHandler). Con `modo: 'observar'` solo avisa.
 * `ref` puede ser una lista de referencias (ver `permiteAlgunLocal`).
 * @param {{ modo?: 'bloquear'|'observar' }} [opciones]
 */
export async function asegurarLocal(req, ref, { modo = 'bloquear' } = {}) {
  const alcance = await cargarAlcance(req);
  if (permiteAlgunLocal(alcance, ref)) return alcance;
  if (modo === 'observar') {
    registrarObservacion(req, `ref=${JSON.stringify(ref ?? null)}`);
    return alcance;
  }
  throw errorSinAccesoLocal();
}
