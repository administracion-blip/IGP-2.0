/**
 * Explosión de demanda de un plato a ingredientes de compra.
 * Sin conversión de unidades (kg↔L): se acumula en la unidad de la receta.
 */

import { normalizeProductId } from './keys.js';

function escandalloError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function resolveReceta(getReceta, productoId) {
  if (!getReceta) return null;
  const id = normalizeProductId(productoId);
  if (!id) return null;
  if (typeof getReceta === 'function') {
    return await getReceta(id);
  }
  if (typeof getReceta.get === 'function') {
    return getReceta.get(id) ?? getReceta.get(productoId) ?? null;
  }
  return null;
}

function recetaActiva(receta) {
  if (!receta || typeof receta !== 'object') return false;
  const meta = receta.meta && typeof receta.meta === 'object' ? receta.meta : receta;
  if (receta.meta === null) return false;
  return meta.activo !== false;
}

function listIngredientes(receta) {
  if (!receta || typeof receta !== 'object') return [];
  if (Array.isArray(receta.ingredientes)) return receta.ingredientes;
  return [];
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundQty(n) {
  return Math.round(n * 1e12) / 1e12;
}

function addLeaf(acc, ingredienteId, { cantidad, unidad, nombre }) {
  const qty = roundQty(cantidad);
  const prev = acc.get(ingredienteId);
  if (prev) {
    prev.cantidad = roundQty(prev.cantidad + qty);
    if (!prev.unidad && unidad) prev.unidad = unidad;
    if (!prev.nombre && nombre) prev.nombre = nombre;
    return;
  }
  acc.set(ingredienteId, { cantidad: qty, unidad, nombre });
}

async function explodeNode({
  productoId,
  unidadesPlato,
  getReceta,
  maxDepth,
  depth,
  chain,
  acc,
}) {
  const receta = await resolveReceta(getReceta, productoId);
  if (!recetaActiva(receta)) {
    return acc;
  }

  for (const raw of listIngredientes(receta)) {
    const ingredienteId = normalizeProductId(raw?.ingredienteId ?? raw?.productoId);
    if (!ingredienteId) continue;

    const cantidad = toNum(raw.cantidad, 0);
    const mermaPct = toNum(raw.mermaPct, 0);
    const qty = roundQty(unidadesPlato * cantidad * (1 + mermaPct / 100));
    const unidad = raw.unidad != null ? String(raw.unidad) : '';
    const nombre = raw.nombre != null ? String(raw.nombre).trim() : '';

    if (chain.has(ingredienteId)) {
      throw escandalloError(
        'escandallo_ciclo',
        `Ciclo en escandallo: ${[...chain, ingredienteId].join(' → ')}`,
      );
    }

    const sub = await resolveReceta(getReceta, ingredienteId);
    if (recetaActiva(sub)) {
      if (depth >= maxDepth) {
        throw escandalloError(
          'escandallo_profundidad',
          `Profundidad máxima de escandallo superada (${maxDepth}) en ${ingredienteId}`,
        );
      }
      const nextChain = new Set(chain);
      nextChain.add(ingredienteId);
      await explodeNode({
        productoId: ingredienteId,
        unidadesPlato: qty,
        getReceta,
        maxDepth,
        depth: depth + 1,
        chain: nextChain,
        acc,
      });
      continue;
    }

    addLeaf(acc, ingredienteId, { cantidad: qty, unidad, nombre });
  }

  return acc;
}

/**
 * @param {{
 *   productoId: string|number,
 *   unidadesPlato: number,
 *   getReceta: Function|Map,
 *   maxDepth?: number,
 * }} input
 * @returns {Promise<Map<string, { cantidad: number, unidad: string, nombre: string }>>}
 */
export async function explodeDemanda({ productoId, unidadesPlato, getReceta, maxDepth = 5 }) {
  const id = normalizeProductId(productoId);
  const acc = new Map();
  if (!id) return acc;

  const uds = Number(unidadesPlato);
  const platos = Number.isFinite(uds) ? uds : 0;
  const depthLimit = Math.max(0, Math.floor(Number(maxDepth) || 5));

  const chain = new Set([id]);
  return explodeNode({
    productoId: id,
    unidadesPlato: platos,
    getReceta,
    maxDepth: depthLimit,
    depth: 0,
    chain,
    acc,
  });
}
