/**
 * Claves de Igp_Inventarios.
 *
 * Una sola tabla:
 *   PK = PLANTILLA#<id> | INV#<id>
 *   SK = META | FAMILIA#<id> | PRODUCTO#<id> | LINE#<productId> | FOTO#<n>#<posicion> | LECTURA#<n>
 * GSI WarehouseId-Clave-index, solo en los META:
 *   Clave = PLANTILLA#<id> | INV#<fecha>#<id>
 */

import { createHash } from 'node:crypto';
import { normalizeWarehouseId } from '../mia/keys.js';
import { normalizarAlias } from './dictado/matcher.js';

export const GSI_ALMACEN = 'WarehouseId-Clave-index';

export const ESTADOS = Object.freeze(['borrador', 'contado', 'revisado', 'exportado', 'importado']);

/** Destinos permitidos desde cada estado. `importado` queda cerrado. */
export const TRANSICIONES = Object.freeze({
  borrador: Object.freeze(['contado']),
  contado: Object.freeze(['revisado', 'borrador']),
  revisado: Object.freeze(['exportado', 'contado']),
  exportado: Object.freeze(['importado', 'revisado']),
  importado: Object.freeze([]),
});

/** Fracciones de botella abierta. Se guardan tal cual, sin redondear a entero. */
export const BOTELLAS_ABIERTAS = Object.freeze([0, 0.1, 0.25, 0.5, 0.75, 0.9]);

export function errorInventario(mensaje, status = 400) {
  return Object.assign(new Error(mensaje), { status });
}

export function pkPlantilla(id) {
  return `PLANTILLA#${id}`;
}

export function pkInventario(id) {
  return `INV#${id}`;
}

export function skMeta() {
  return 'META';
}

export function skFamilia(id) {
  return `FAMILIA#${id}`;
}

export function skProducto(id) {
  return `PRODUCTO#${id}`;
}

export function skLinea(productId) {
  return `LINE#${productId}`;
}

/** Foto de un par del conteo. `posicion` es `frente` o `superior`. */
export function skFoto(numero, posicion) {
  return `FOTO#${numero}#${posicion}`;
}

/** Lectura de un par. No lleva stock teórico ni WarehouseId. */
export function skLectura(numero) {
  return `LECTURA#${numero}`;
}

export function claveListadoPlantilla(id) {
  return `PLANTILLA#${id}`;
}

export function claveListadoInventario(fecha, id) {
  return `INV#${fecha}#${id}`;
}

export function almacenId(raw) {
  const id = normalizeWarehouseId(raw);
  if (!id || id === '000000') throw errorInventario('warehouseId es obligatorio');
  return id;
}

/** Id que puede ir dentro de una clave. Rechaza `#` para no partir PK/SK. */
export function idSegmento(raw, campo) {
  const s = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) throw errorInventario(`${campo} no válido`);
  return s;
}

export function fechaIso(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw errorInventario('fecha debe ser YYYY-MM-DD');
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw errorInventario('fecha no válida');
  }
  return s;
}

export function texto(raw, campo, { obligatorio = false, max = 200 } = {}) {
  const s = String(raw ?? '').trim();
  if (!s && obligatorio) throw errorInventario(`${campo} es obligatorio`);
  if (s.length > max) throw errorInventario(`${campo} es demasiado largo`);
  return s;
}

/**
 * Número ≥ 0, con los decimales que vengan. No redondea.
 * Acepta coma decimal («10,5»).
 */
export function numeroNoNegativo(raw, campo) {
  if (typeof raw === 'boolean' || raw == null || raw === '') {
    throw errorInventario(`${campo} es obligatorio`);
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw errorInventario(`${campo} debe ser un número ≥ 0`);
  return n;
}

/** `null` o ausente significa «aún no contado». Un número se guarda sin redondear. */
export function stockRealDe(raw) {
  if (raw == null || raw === '') return null;
  return numeroNoNegativo(raw, 'stockReal');
}

export function botellasAbiertasDe(raw) {
  if (raw == null || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n)) throw errorInventario('botellasAbiertas no válida');
  const canon = BOTELLAS_ABIERTAS.find((v) => Object.is(v, n) || Math.abs(v - n) < 1e-9);
  if (canon === undefined) {
    throw errorInventario('botellasAbiertas solo puede ser 0, 0.10, 0.25, 0.50, 0.75 o 0.90');
  }
  return canon;
}

// ─── Dictado por voz ───
//
// Alias y formatos son globales (no por almacén) y viven en su propia PK:
//   PK = ALIAS#GLOBAL    SK = TXT#<texto normalizado>
//   PK = FORMATO#GLOBAL  SK = PROD#<productId>
// Las sesiones de dictado cuelgan del inventario, así que borrarInventario se las lleva:
//   PK = INV#<id>        SK = DICTADO#<usuario>#META | DICTADO#<usuario>#LINEA#<000001>
// Ninguno lleva WarehouseId ni Clave: no entran en el GSI de almacén.

const LONGITUD_HASH_USUARIO = 24;
const MAX_LINEA_DICTADO = 999999;

export function pkAliasGlobal() {
  return 'ALIAS#GLOBAL';
}

/** `norm` pasa por normalizarAlias; vacío tras normalizar → 400. */
export function skAlias(norm) {
  const n = normalizarAlias(norm);
  if (!n) throw errorInventario('El alias no puede estar vacío.');
  return `TXT#${n}`;
}

export function pkFormatoGlobal() {
  return 'FORMATO#GLOBAL';
}

export function skFormato(productId) {
  return `PROD#${idSegmento(productId, 'productId')}`;
}

/**
 * Segmento de clave para un usuario. Un id válido (`idSegmento`) va tal cual; cualquier
 * otro (email, espacios…) pasa a 'U' + sha256 hex recortado a 24, estable entre llamadas.
 * Es idempotente: el resultado vuelve a cumplir idSegmento y no cambia.
 */
export function usuarioSegmento(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw errorInventario('usuario no válido');
  try {
    return idSegmento(s, 'usuario');
  } catch {
    return `U${createHash('sha256').update(s, 'utf8').digest('hex').slice(0, LONGITUD_HASH_USUARIO)}`;
  }
}

export function prefijoDictado(usuario) {
  return `DICTADO#${usuarioSegmento(usuario)}#`;
}

export function skDictadoMeta(usuario) {
  return `${prefijoDictado(usuario)}META`;
}

/** `n` entero 1..999999, con ceros a 6 dígitos para que el SK ordene por número. */
export function skDictadoLinea(usuario, n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > MAX_LINEA_DICTADO) {
    throw errorInventario('Número de línea de dictado no válido.');
  }
  return `${prefijoDictado(usuario)}LINEA#${String(num).padStart(6, '0')}`;
}
