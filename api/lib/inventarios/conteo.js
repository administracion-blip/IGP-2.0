/**
 * Abre un conteo: copia los productos de la plantilla y el stock teórico
 * de Ágora en ese momento. Solo lee Ágora (exportStocks). No escribe inventario allí.
 */

import { exportStocks as exportStocksAgora } from '../agora/client.js';
import { errorInventario } from './claves.js';
import { crearInventario } from './inventarios.js';
import { obtenerPlantilla } from './plantillas.js';
import { listarProductosInventario } from './productos.js';

function cantidadStock(raw) {
  if (raw == null || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function claveProducto(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

/** @param {Array<Record<string, unknown>>} filas */
export function mapaStockTeorico(filas) {
  const mapa = new Map();
  for (const row of filas || []) {
    const id = claveProducto(row?.ProductId ?? row?.productId);
    if (!id) continue;
    mapa.set(id, cantidadStock(row?.Quantity ?? row?.quantity));
  }
  return mapa;
}

/**
 * @param {object} body
 * @param {string} usuario
 * @param {{ exportStocks?: typeof exportStocksAgora }} [opts]
 */
export async function abrirConteo(body, usuario, opts = {}) {
  const plantilla = await obtenerPlantilla(body?.plantillaId);
  const miembros = plantilla.miembros || [];
  if (miembros.length === 0) throw errorInventario('La plantilla no tiene familias ni productos');
  const productos = await listarProductosInventario(
    plantilla.modo === 'productos'
      ? { productIds: miembros.map((m) => m.id) }
      : { familiaIds: miembros.map((m) => m.id) },
  );
  if (productos.length === 0) {
    throw errorInventario('No hay productos activos para esta plantilla');
  }

  const leer = opts.exportStocks || exportStocksAgora;
  let filas;
  try {
    filas = await leer({ warehouseId: plantilla.warehouseId });
  } catch {
    throw Object.assign(new Error('No se ha podido leer el stock de Ágora'), { status: 502, expose: true });
  }
  const stocks = mapaStockTeorico(filas);
  const lineas = productos.map((p) => ({
    productId: p.productId,
    nombre: p.nombre,
    familiaNombre: p.familiaNombre,
    unidad: p.unidad,
    stockTeorico: stocks.get(claveProducto(p.productId)) ?? 0,
    stockReal: null,
    botellasAbiertas: 0,
  }));

  return crearInventario({
    warehouseId: body?.warehouseId || plantilla.warehouseId,
    fecha: body?.fecha,
    employeeId: body?.employeeId,
    employeeNombre: body?.employeeNombre,
    plantillaId: plantilla.plantillaId,
    lineas,
  }, usuario);
}
