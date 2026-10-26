/**
 * Abre un conteo: copia los productos de la plantilla y el stock teórico
 * de Ágora en ese momento. Solo lee Ágora (exportStocks). No escribe inventario allí.
 */

import { exportStocks as exportStocksAgora } from '../agora/client.js';
import { almacenId, errorInventario } from './claves.js';
import { crearInventario, guardarLinea, obtenerInventario } from './inventarios.js';
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
  const wid = almacenId(body?.warehouseId);
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
    filas = await leer({ warehouseId: wid });
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
    warehouseId: wid,
    fecha: body?.fecha,
    employeeId: body?.employeeId,
    employeeNombre: body?.employeeNombre,
    plantillaId: plantilla.plantillaId,
    lineas,
  }, usuario);
}

/**
 * Añade al conteo un producto que no estaba en la plantilla.
 * El teórico sale del almacén del inventario, no del cuerpo de la petición.
 */
export async function anadirProducto(inventarioId, productId, usuario, opts = {}) {
  const inventario = await obtenerInventario(inventarioId);
  if (inventario.estado !== 'borrador' && inventario.estado !== 'contado') {
    throw errorInventario('El conteo ya no se puede modificar', 403);
  }
  const pid = String(productId ?? '').trim();
  if ((inventario.lineas || []).some((l) => l.productId === pid)) {
    throw errorInventario('Este producto ya está en el conteo', 409);
  }
  const productos = await listarProductosInventario({ productIds: [pid] });
  const producto = productos.find((p) => p.productId === pid);
  if (!producto) throw errorInventario('Producto no encontrado', 404);

  const leer = opts.exportStocks || exportStocksAgora;
  let filas;
  try {
    filas = await leer({ warehouseId: inventario.warehouseId });
  } catch {
    throw Object.assign(new Error('No se ha podido leer el stock de Ágora'), { status: 502, expose: true });
  }
  const stocks = mapaStockTeorico(filas);
  return guardarLinea(inventarioId, pid, {
    nombre: producto.nombre,
    familiaNombre: producto.familiaNombre,
    unidad: producto.unidad,
    stockTeorico: stocks.get(claveProducto(pid)) ?? 0,
    stockReal: null,
    botellasAbiertas: 0,
  }, usuario, { soloContar: opts.soloContar === true, crear: true });
}
