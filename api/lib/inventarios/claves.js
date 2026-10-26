/**
 * Claves de Igp_Inventarios.
 *
 * Una sola tabla:
 *   PK = PLANTILLA#<id> | INV#<id>
 *   SK = META | FAMILIA#<id> | PRODUCTO#<id> | LINE#<productId> | FOTO#<n>#<posicion> | LECTURA#<n>
 * GSI WarehouseId-Clave-index, solo en los META:
 *   Clave = PLANTILLA#<id> | INV#<fecha>#<id>
 */

import { normalizeWarehouseId } from '../mia/keys.js';

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
