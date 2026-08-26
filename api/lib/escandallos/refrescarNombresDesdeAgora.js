/**
 * Tras un sync de Igp_AgoraProducts, alinea los nombres guardados en
 * Igp_Escandallos (META e ING#) con el Name actual de Ágora.
 * El ID es la clave; si el artículo no está en Ágora se deja el snapshot.
 */

import { listRecetasConIngredientes, updateNombreCampo } from './store.js';
import { normalizeProductId, skIng, skMeta } from './keys.js';

/** Claves de búsqueda: id crudo y sin ceros a la izquierda. */
export function clavesIdProducto(id) {
  const raw = normalizeProductId(id);
  if (!raw) return [];
  const keys = new Set([raw]);
  const stripped = raw.replace(/^0+/, '');
  if (stripped && stripped !== raw) keys.add(stripped);
  return [...keys];
}

export function nombreProductoAgora(p) {
  if (!p || typeof p !== 'object') return '';
  return String(p.Name ?? p.Nombre ?? p.nombre ?? p.ProductName ?? '').trim();
}

export function idProductoAgora(p) {
  if (!p || typeof p !== 'object') return '';
  const id = p.Id ?? p.id ?? p.Code ?? p.code ?? p.SK;
  return normalizeProductId(id);
}

/** @param {Array<Record<string, unknown>>} productos */
export function construirMapaNombresAgora(productos) {
  const mapa = new Map();
  for (const p of productos || []) {
    const id = idProductoAgora(p);
    const nombre = nombreProductoAgora(p);
    if (!id || !nombre) continue;
    for (const k of clavesIdProducto(id)) mapa.set(k, nombre);
  }
  return mapa;
}

function nombreEnMapa(mapa, id) {
  const raw = normalizeProductId(id);
  if (!raw) return '';
  return mapa.get(raw) || mapa.get(raw.replace(/^0+/, '')) || '';
}

/**
 * Calcula qué nombres hay que pisar (sin escribir).
 * @param {Array<{ productoId: string, nombre?: string, ingredientes?: Array<{ ingredienteId: string, nombre?: string }> }>} recetas
 * @param {Map<string, string>} mapa
 */
export function planRefrescoNombres(recetas, mapa) {
  const cambios = [];
  for (const r of recetas || []) {
    const productoId = normalizeProductId(r.productoId);
    if (!productoId) continue;
    const nombrePlato = nombreEnMapa(mapa, productoId);
    if (nombrePlato && nombrePlato !== String(r.nombre || '').trim()) {
      cambios.push({ productoId, sk: skMeta(), nombre: nombrePlato, tipo: 'meta' });
    }
    for (const ing of r.ingredientes || []) {
      const ingId = normalizeProductId(ing.ingredienteId);
      if (!ingId) continue;
      const nombreIng = nombreEnMapa(mapa, ingId);
      if (nombreIng && nombreIng !== String(ing.nombre || '').trim()) {
        cambios.push({
          productoId,
          sk: skIng(ingId),
          nombre: nombreIng,
          tipo: 'ing',
        });
      }
    }
  }
  return cambios;
}

/**
 * @param {Array<Record<string, unknown>>} productosAgora
 * @returns {Promise<{ recetas: number, metaActualizadas: number, ingredientesActualizados: number }>}
 */
export async function refrescarNombresEscandallosDesdeAgora(productosAgora) {
  const mapa = construirMapaNombresAgora(productosAgora);
  if (mapa.size === 0) {
    return { recetas: 0, metaActualizadas: 0, ingredientesActualizados: 0 };
  }
  const recetas = await listRecetasConIngredientes();
  const cambios = planRefrescoNombres(recetas, mapa);
  let metaActualizadas = 0;
  let ingredientesActualizados = 0;
  for (const c of cambios) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await updateNombreCampo(c.productoId, c.sk, c.nombre);
      if (!r?.ok) continue;
      if (c.tipo === 'meta') metaActualizadas += 1;
      else ingredientesActualizados += 1;
    } catch (e) {
      console.warn(
        `[escandallos] no se pudo actualizar nombre ${c.sk} de ${c.productoId}:`,
        e?.message || e,
      );
    }
  }
  return {
    recetas: recetas.length,
    metaActualizadas,
    ingredientesActualizados,
  };
}
