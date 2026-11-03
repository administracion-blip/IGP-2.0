/**
 * Vista de stock máximo por almacén: une el stock sincronizado con el nombre,
 * la familia y las unidades de Ágora del producto. No llama a Ágora.
 * El máximo admite decimales y no puede ser negativo.
 * La unidad de compra tiene que ser una unidad real del producto.
 */

import { BatchGetCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { upsertConfigProducto, listConfigByWarehouse } from './configProducto.js';
import { normalizeProductId, normalizeWarehouseId } from './keys.js';

export const MENSAJE_MAXIMO = 'El máximo tiene que ser un número ≥ 0';
export const MENSAJE_MAXIMO_NEGATIVO = 'El máximo no puede ser negativo';
export const MENSAJE_FORMATO = 'El formato de compra tiene que ser un número mayor que 0';
export const MENSAJE_UNIDAD = 'La unidad de compra no es una unidad de Ágora de este producto';
export const MENSAJE_UNIDAD_LIBRE = 'La unidad de compra se elige de las unidades de Ágora del producto';

const LIMITE_DEFECTO = 80;
const LIMITE_MAXIMO = 200;

function fallo(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400, expose: true });
}

function textoNumero(raw) {
  return String(raw ?? '').trim().replace(',', '.');
}

/**
 * Vacío borra el máximo. Si no, número finito ≥ 0, con decimales.
 * @param {unknown} raw
 * @returns {{ vacio: true, valor: null } | { vacio: false, valor: number }}
 */
export function interpretarMaximo(raw) {
  if (raw == null || raw === '') return { vacio: true, valor: null };
  const t = textoNumero(raw);
  if (!t) return { vacio: true, valor: null };
  if (t.startsWith('-')) throw fallo(MENSAJE_MAXIMO_NEGATIVO);
  if (!/^\d+(\.\d+)?$/.test(t)) throw fallo(MENSAJE_MAXIMO);
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) throw fallo(n < 0 ? MENSAJE_MAXIMO_NEGATIVO : MENSAJE_MAXIMO);
  return { vacio: false, valor: n };
}

/** Vacío borra el formato. Si no, número mayor que 0. */
export function interpretarFormato(raw) {
  if (raw == null || raw === '') return { vacio: true, valor: null };
  const t = textoNumero(raw);
  if (!t) return { vacio: true, valor: null };
  if (!/^\d+(\.\d+)?$/.test(t)) throw fallo(MENSAJE_FORMATO);
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw fallo(MENSAJE_FORMATO);
  return { vacio: false, valor: n };
}

function anadirUnidad(salida, vistos, id, nombre) {
  const i = String(id ?? '').trim();
  const n = String(nombre ?? '').trim();
  if (!i) return;
  if (vistos.has(i)) return;
  vistos.add(i);
  salida.push({ id: i, nombre: n || i });
}

/**
 * Unidades con id de Ágora que hay en la copia del producto:
 * el formato base y, si siguen guardados, los formatos adicionales.
 * @param {object|null|undefined} producto
 * @returns {Array<{ id: string, nombre: string }>}
 */
export function unidadesAgora(producto) {
  const salida = [];
  const vistos = new Set();
  if (!producto || typeof producto !== 'object') return salida;
  anadirUnidad(salida, vistos, producto.BaseSaleFormatId, producto.FormatoBaseNombre);
  const listas = [producto.Formatos, producto.SaleFormats, producto.AdditionalSaleFormats];
  for (const lista of listas) {
    if (!Array.isArray(lista)) continue;
    for (const f of lista) {
      if (!f || typeof f !== 'object') continue;
      anadirUnidad(
        salida,
        vistos,
        f.Id ?? f.id ?? f.SaleFormatId ?? f.saleFormatId,
        f.nombre ?? f.Name ?? f.name,
      );
    }
  }
  return salida;
}

async function leerProducto(productId) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  const candidatos = [id];
  if (/^\d+$/.test(id)) {
    const corto = id.replace(/^0+/, '') || '0';
    if (!candidatos.includes(corto)) candidatos.push(corto);
  }
  for (const sk of candidatos) {
    const r = await docClient.send(new GetCommand({
      TableName: tables.agoraProducts,
      Key: { PK: 'GLOBAL', SK: sk },
    }));
    if (r.Item && r.Item.SK !== 'META' && r.Item.SK !== '__meta__') return r.Item;
  }
  return null;
}

async function leerProductos(ids) {
  /** @type {Map<string, object>} */
  const mapa = new Map();
  const claves = [...new Set(ids.map((id) => normalizeProductId(id)).filter(Boolean))];
  for (let i = 0; i < claves.length; i += 100) {
    const Keys = claves.slice(i, i + 100).map((id) => ({ PK: 'GLOBAL', SK: id }));
    const r = await docClient.send(new BatchGetCommand({
      RequestItems: { [tables.agoraProducts]: { Keys } },
    }));
    for (const it of r.Responses?.[tables.agoraProducts] || []) {
      const sk = String(it.SK ?? '');
      if (sk && sk !== 'META' && sk !== '__meta__') mapa.set(sk, it);
    }
  }
  return mapa;
}

/**
 * Si viene unidad, tiene que existir en el producto. El nombre lo pone Ágora,
 * no el texto que envíe el cliente. Vacío borra la unidad.
 * @returns {Promise<{ id: string, nombre: string }>}
 */
export async function resolverUnidad(productId, purchaseUnitId, purchaseUnitName) {
  const id = String(purchaseUnitId ?? '').trim();
  const nombreLibre = String(purchaseUnitName ?? '').trim();
  if (!id) {
    if (nombreLibre) throw fallo(MENSAJE_UNIDAD_LIBRE);
    return { id: '', nombre: '' };
  }
  const producto = await leerProducto(productId);
  const hit = unidadesAgora(producto).find((u) => u.id === id);
  if (!hit) throw fallo(MENSAJE_UNIDAD);
  return { id: hit.id, nombre: hit.nombre };
}

function numeroONull(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Prepara el cuerpo de PUT /mia/config cuando toca máximo, formato o unidad.
 * No añade campos que el cliente no haya enviado.
 * @param {Record<string, unknown>} body
 */
export async function sanearConfigStock(body) {
  const out = { ...body };
  if (Object.prototype.hasOwnProperty.call(body, 'maximo')) {
    const m = interpretarMaximo(body.maximo);
    out.maximo = m.vacio ? '' : m.valor;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'formatoCompra')) {
    const f = interpretarFormato(body.formatoCompra);
    out.formatoCompra = f.vacio ? '' : f.valor;
  }
  if (
    Object.prototype.hasOwnProperty.call(body, 'purchaseUnitId')
    || Object.prototype.hasOwnProperty.call(body, 'purchaseUnitName')
  ) {
    const u = await resolverUnidad(body.productId, body.purchaseUnitId, body.purchaseUnitName);
    out.purchaseUnitId = u.id;
    out.purchaseUnitName = u.nombre;
  }
  return out;
}

async function prepararLinea(warehouseId, linea) {
  const productId = normalizeProductId(linea?.productId);
  if (!productId) throw fallo('Cada cambio necesita productId');
  const maximo = interpretarMaximo(linea?.maximo);
  const formato = interpretarFormato(linea?.formatoCompra);
  const unidad = await resolverUnidad(productId, linea?.purchaseUnitId, linea?.purchaseUnitName);
  return {
    warehouseId,
    productId,
    maximo: maximo.vacio ? '' : maximo.valor,
    formatoCompra: formato.vacio ? '' : formato.valor,
    purchaseUnitId: unidad.id,
    purchaseUnitName: unidad.nombre,
  };
}

/**
 * Valida todas las filas antes de escribir ninguna.
 * @param {string} warehouseId
 * @param {Array<object>} lineas
 */
export async function guardarLineasStockMaximo(warehouseId, lineas) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') throw fallo('warehouseId es obligatorio');
  if (!Array.isArray(lineas) || lineas.length === 0) throw fallo('No hay cambios que guardar');
  const preparadas = [];
  for (const ln of lineas) preparadas.push(await prepararLinea(wid, ln));
  const guardadas = [];
  for (const p of preparadas) guardadas.push(await upsertConfigProducto(p));
  return guardadas;
}

function vistaDe(cfg, producto) {
  const productId = normalizeProductId(cfg.ProductId || String(cfg.SK || '').replace(/^PRODUCT#/, ''));
  const maximo = numeroONull(cfg.maximo);
  const formato = numeroONull(cfg.formatoCompra);
  return {
    productId,
    nombre: String(producto?.Name || productId).trim(),
    familiaId: String(producto?.FamilyId ?? '').trim(),
    familiaNombre: String(producto?.FamilyName || '').trim(),
    stock: numeroONull(cfg.Quantity),
    maximo,
    formatoCompra: formato != null && formato > 0 ? formato : null,
    purchaseUnitId: String(cfg.purchaseUnitId || '').trim(),
    purchaseUnitName: String(cfg.purchaseUnitName || '').trim(),
    unidades: unidadesAgora(producto),
    sinMaximo: maximo == null,
  };
}

/**
 * @param {string} warehouseId
 * @param {{ familia?: string, sinMaximo?: boolean, q?: string, offset?: number, limit?: number }} [opts]
 */
export async function listarVistaStockMaximo(warehouseId, opts = {}) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') throw fallo('warehouseId es obligatorio');
  const configs = await listConfigByWarehouse(wid);
  const productos = await leerProductos(configs.map((c) => c.ProductId));
  let filas = configs.map((cfg) => {
    const id = normalizeProductId(cfg.ProductId);
    return vistaDe(cfg, productos.get(id));
  });

  const familiasMapa = new Map();
  for (const f of filas) {
    if (!f.familiaId && !f.familiaNombre) continue;
    const id = f.familiaId || f.familiaNombre;
    if (!familiasMapa.has(id)) familiasMapa.set(id, { id, nombre: f.familiaNombre || id });
  }
  const familias = [...familiasMapa.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  const familia = String(opts.familia || '').trim();
  if (familia) filas = filas.filter((f) => f.familiaId === familia || f.familiaNombre === familia);
  if (opts.sinMaximo) filas = filas.filter((f) => f.sinMaximo);
  const q = String(opts.q || '').trim().toLowerCase();
  if (q) {
    filas = filas.filter((f) => f.nombre.toLowerCase().includes(q) || f.productId.toLowerCase().includes(q));
  }
  filas.sort((a, b) => a.familiaNombre.localeCompare(b.familiaNombre, 'es') || a.nombre.localeCompare(b.nombre, 'es'));

  const total = filas.length;
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  let limit = Math.floor(Number(opts.limit) || LIMITE_DEFECTO);
  if (!Number.isFinite(limit) || limit < 1) limit = LIMITE_DEFECTO;
  if (limit > LIMITE_MAXIMO) limit = LIMITE_MAXIMO;
  return {
    warehouseId: wid,
    total,
    offset,
    limit,
    familias,
    items: filas.slice(offset, offset + limit),
  };
}
