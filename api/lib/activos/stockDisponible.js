/**
 * Stock «disponible»: en almacén y sin custodio.
 * Unidad = 1; lote = cantidad. Lo entregado no cuenta.
 */

/** Unidades que representa la fila, sea cual sea su estado. */
export function unidadesDe(item) {
  if (!item) return 0;
  if (item.granularidad === 'lote') {
    const n = Number(item.cantidad);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }
  return 1;
}

export function tallaDe(item) {
  const talla = item?.atributos?.talla;
  if (talla == null) return null;
  const t = String(talla).trim();
  return t || null;
}

export function unidadesDisponiblesAlmacen(item) {
  if (!item || item.estado !== 'en_almacen' || item.custodio_id) return 0;
  return unidadesDe(item);
}

export function acumularDisponiblePorModelo(items, mapa = new Map()) {
  for (const it of items || []) {
    const n = unidadesDisponiblesAlmacen(it);
    if (!n || !it.modelo_id) continue;
    mapa.set(it.modelo_id, (mapa.get(it.modelo_id) || 0) + n);
  }
  return mapa;
}

/** Mapa modelo_id → Map(talla → unidades). Solo filas con talla. */
export function acumularDisponiblePorTalla(items, mapa = new Map()) {
  for (const it of items || []) {
    const n = unidadesDisponiblesAlmacen(it);
    const talla = tallaDe(it);
    if (!n || !it.modelo_id || !talla) continue;
    let inner = mapa.get(it.modelo_id);
    if (!inner) {
      inner = new Map();
      mapa.set(it.modelo_id, inner);
    }
    inner.set(talla, (inner.get(talla) || 0) + n);
  }
  return mapa;
}

export function tallasDesdeMapa(inner) {
  if (!inner?.size) return [];
  return [...inner.entries()].map(([talla, cantidad]) => ({ talla, cantidad }));
}

function texto(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Detalle de stock libre de un modelo: una línea por fila con unidades
 * disponibles, ordenada por local y talla para poder elegir en la entrega.
 */
export function lineasDisponibles(items) {
  const lineas = [];
  for (const it of items || []) {
    const disponibles = unidadesDisponiblesAlmacen(it);
    if (!disponibles) continue;
    lineas.push({
      asset_id: it.asset_id,
      etiqueta_legible: it.etiqueta_legible ?? null,
      id_local: it.id_local ?? null,
      local_nombre: it.local_nombre ?? null,
      granularidad: it.granularidad ?? null,
      talla: tallaDe(it),
      numero_serie: it.numero_serie ?? null,
      disponibles,
    });
  }
  return lineas.sort((a, b) => (
    texto(a.local_nombre).localeCompare(texto(b.local_nombre), 'es')
    || texto(a.talla).localeCompare(texto(b.talla), 'es')
    || texto(a.etiqueta_legible).localeCompare(texto(b.etiqueta_legible), 'es')
  ));
}
