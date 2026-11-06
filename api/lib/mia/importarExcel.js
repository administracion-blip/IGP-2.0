/**
 * Lee el Excel de conteo que genera IGP (hoja «Inventario»).
 * No calcula pedido ni previsión: solo Id y Stock Real.
 * Vacío = no se importa. Un 0 escrito es 0 y sí se importa. Se admiten decimales.
 * Un Id repetido entre filas con stock no se suma: se avisa y se queda la primera.
 */

import ExcelJS from 'exceljs';
import { BatchGetCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { queryUltimaCompraPorProductos } from '../dynamo/comprasProveedor.js';
import { CABECERAS } from '../inventarios/excel.js';
import { listConfigByWarehouse } from './configProducto.js';
import { skInformeLinea } from './keys.js';
import { resolverProveedor } from './motor.js';

export const MAX_EXCEL_CONTEO_BYTES = 5 * 1024 * 1024;
export const MENSAJE_NO_XLSX = 'El fichero tiene que ser un Excel .xlsx';
export const MENSAJE_SIN_HOJA = 'El Excel no tiene la hoja «Inventario»';
export const MENSAJE_CABECERAS = 'Las cabeceras no coinciden con la plantilla de inventario';
export const MENSAJE_SIN_CONTADAS = 'No hay ninguna línea contada';

const COL_ID = 1;
const COL_NOMBRE = 3;
const COL_STOCK = 8;

function fallo(mensaje) {
  return Object.assign(new Error(mensaje), { status: 400, expose: true });
}

function texto(valor) {
  if (valor == null) return '';
  if (typeof valor === 'object') {
    if (Array.isArray(valor.richText)) return valor.richText.map((t) => t.text || '').join('').trim();
    if (valor.text != null) return String(valor.text).trim();
    if (valor.result != null) return texto(valor.result);
  }
  return String(valor).trim();
}

function idDe(valor) {
  const t = texto(valor);
  if (!t) return '';
  if (/^\d+(\.0+)?$/.test(t)) return String(parseInt(t, 10));
  return t;
}

/** null si la celda está vacía. Número (incluido 0 y decimales) si hay conteo. */
function stockDe(valor, fila) {
  if (valor == null || valor === '') return null;
  if (typeof valor === 'object' && valor.result !== undefined) return stockDe(valor.result, fila);
  const t = typeof valor === 'number' ? String(valor) : texto(valor).replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) throw fallo(`El stock real de la fila ${fila} no es un número`);
  if (n < 0) throw fallo(`El stock real de la fila ${fila} no puede ser negativo`);
  return n;
}

function cabecerasDe(hoja) {
  const vals = hoja.getRow(1).values || [];
  const out = [];
  for (let i = 1; i < vals.length; i += 1) out.push(texto(vals[i]));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ filas: Array<object>, duplicados: string[], lineasLeidas: number }>}
 */
export async function leerExcelConteo(buffer) {
  let wb;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
  } catch {
    throw fallo(MENSAJE_NO_XLSX);
  }
  const hoja = wb.getWorksheet('Inventario');
  if (!hoja) throw fallo(MENSAJE_SIN_HOJA);
  const cab = cabecerasDe(hoja);
  if (cab.length !== CABECERAS.length || cab.some((h, i) => h !== CABECERAS[i])) {
    throw fallo(MENSAJE_CABECERAS);
  }

  /** @type {Map<string, object>} */
  const porId = new Map();
  /** @type {string[]} */
  const duplicados = [];
  let lineasLeidas = 0;

  hoja.eachRow((row, n) => {
    if (n === 1) return;
    const vals = row.values || [];
    const id = idDe(vals[COL_ID]);
    const nombre = texto(vals[COL_NOMBRE]);
    const stock = stockDe(vals[COL_STOCK], n);
    const restoVacio = vals.slice(2).every((c) => texto(c) === '' || c == null);
    if (!id && stock == null && !nombre && restoVacio) return;
    if (stock == null) return;
    if (!id) throw fallo(`La fila ${n} no tiene Id`);
    lineasLeidas += 1;
    if (porId.has(id)) {
      if (!duplicados.includes(id)) duplicados.push(id);
      return;
    }
    porId.set(id, { productId: id, nombre, stockReal: stock });
  });

  return { filas: [...porId.values()], duplicados, lineasLeidas };
}

function clavesProducto(productId) {
  const id = String(productId || '').trim();
  if (!id) return [];
  const claves = [id];
  if (/^\d+$/.test(id)) {
    const corto = id.replace(/^0+/, '') || '0';
    if (!claves.includes(corto)) claves.push(corto);
  }
  return claves;
}

/** Una lectura por lote de 100, en vez de un Get por fila del Excel. */
async function fichasPorId(ids) {
  const mapa = new Map();
  const claves = [...new Set(ids.flatMap(clavesProducto))];
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

function fichaDe(mapa, productId) {
  for (const sk of clavesProducto(productId)) {
    const ficha = mapa.get(sk);
    if (ficha) return ficha;
  }
  return null;
}

async function fichaProducto(productId) {
  const candidatos = [productId];
  if (/^\d+$/.test(productId)) {
    const corto = productId.replace(/^0+/, '') || '0';
    if (!candidatos.includes(corto)) candidatos.push(corto);
  }
  for (const sk of candidatos) {
    const r = await docClient.send(new GetCommand({
      TableName: tables.agoraProducts,
      Key: { PK: 'GLOBAL', SK: sk },
    }));
    if (r.Item && r.Item.SK !== 'META') return r.Item;
  }
  return null;
}

/**
 * Proveedor: ficha de stock máximo, y si no hay, la última compra.
 * Unidad: la de la ficha; si no hay, la de la última compra; si tampoco, el formato base.
 * Un proveedor o una unidad marcados a mano no se pisan.
 */
export function completarProveedorYUnidad({ config, ultima, producto, linea }) {
  const manualProv = linea?.proveedorManual === true;
  const manualUnidad = linea?.unidadManual === true;
  const auto = resolverProveedor(config, ultima);
  let proveedorId = manualProv ? String(linea?.proveedorId || '').trim() : auto.proveedorId;
  let proveedorNombre = manualProv
    ? (String(linea?.proveedorNombre || '').trim() || proveedorId)
    : auto.proveedorNombre;
  if (!manualProv && (!proveedorId || proveedorId === 'SIN_PROVEEDOR')) {
    const ya = String(linea?.proveedorId || '').trim();
    if (ya && ya !== 'SIN_PROVEEDOR') {
      proveedorId = ya;
      proveedorNombre = String(linea?.proveedorNombre || '').trim();
    }
  }
  if (!proveedorId) {
    proveedorId = 'SIN_PROVEEDOR';
    proveedorNombre = proveedorNombre || 'Sin proveedor';
  }

  let purchaseUnitId = String(linea?.purchaseUnitId || '').trim();
  let unit = String(linea?.unit || linea?.purchaseUnitName || '').trim();
  if (!manualUnidad) {
    const cfgId = String(config?.purchaseUnitId ?? '').trim();
    const cfgNombre = String(config?.purchaseUnitName || '').trim();
    const ultId = String(ultima?.PurchaseUnitId ?? '').trim();
    const ultNombre = String(ultima?.PurchaseUnitName || '').trim();
    if (cfgId) {
      purchaseUnitId = cfgId;
      unit = cfgNombre || cfgId;
    } else if (ultId) {
      purchaseUnitId = ultId;
      unit = ultNombre || ultId;
    } else {
      const baseId = String(producto?.BaseSaleFormatId ?? '').trim();
      const baseNombre = String(producto?.FormatoBaseNombre || '').trim();
      const idOk = baseId !== '' && baseId !== '0';
      if (idOk || baseNombre) {
        purchaseUnitId = idOk ? baseId : purchaseUnitId;
        unit = baseNombre || baseId;
      }
    }
  }

  return {
    proveedorId,
    proveedorNombre,
    purchaseUnitId,
    unit,
    proveedorManual: manualProv,
    unidadManual: manualUnidad,
  };
}

/**
 * Precio y descuentos de la última compra, solo si es la misma unidad.
 * El descuento en euros del albarán es de aquella línea: se guarda por unidad.
 * Un regalo (descuento ≈ 100 %) no se copia.
 * @returns {{ costeUnitario: number|null, discountRate: number, cashDiscountUnitario: number }}
 */
export function precioDeUltimaCompra(purchaseUnitId, ultima) {
  const vacio = { costeUnitario: null, discountRate: 0, cashDiscountUnitario: 0 };
  const id = String(purchaseUnitId || '').trim();
  const ultId = String(ultima?.PurchaseUnitId || '').trim();
  if (!id || !ultId || id !== ultId) return vacio;
  const price = Number(ultima.Price);
  if (!Number.isFinite(price) || price < 0) return vacio;
  const rate = Number(ultima.DiscountRate);
  if (Number.isFinite(rate) && rate >= 0.999) return vacio;
  const descuento = Number.isFinite(rate) && rate > 0 && rate < 0.999 ? rate : 0;
  const qty = Number(ultima.Quantity);
  const cash = Number(ultima.CashDiscount);
  const porUnidad = Number.isFinite(qty) && qty > 0 && Number.isFinite(cash) && cash > 0
    ? Math.round((cash / qty) * 10000) / 10000
    : 0;
  return { costeUnitario: price, discountRate: descuento, cashDiscountUnitario: porUnidad };
}

async function configsPorProducto(warehouseId) {
  if (!warehouseId) return new Map();
  try {
    const items = await listConfigByWarehouse(warehouseId);
    const map = new Map();
    for (const c of items) {
      if (c?.ProductId != null) map.set(String(c.ProductId), c);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function ultimasSeguras(warehouseId, ids) {
  try {
    return await queryUltimaCompraPorProductos(ids, { warehouseId });
  } catch {
    return new Map();
  }
}

async function fichaSegura(productId) {
  try {
    return await fichaProducto(productId);
  } catch {
    return null;
  }
}

/**
 * Rellena proveedor y unidad. Conserva lo marcado a mano.
 * Si la última compra no se puede leer, sigue sin ella.
 */
export async function aplicarProveedorYUnidad(lineas, warehouseId) {
  const lista = Array.isArray(lineas) ? lineas : [];
  const configs = await configsPorProducto(warehouseId);
  const ultimas = await ultimasSeguras(warehouseId, lista.map((ln) => ln.productId).filter(Boolean));
  const out = [];
  for (const linea of lista) {
    const producto = linea._producto || await fichaSegura(linea.productId);
    const config = configs.get(String(linea.productId));
    const ultima = ultimas.get(String(linea.productId))
      || ultimas.get(String(Number(linea.productId)))
      || null;
    const datos = completarProveedorYUnidad({ config, ultima, producto, linea });
    const precio = ultima ? precioDeUltimaCompra(datos.purchaseUnitId, ultima) : null;
    const resto = { ...linea };
    delete resto._producto;
    out.push({
      ...resto,
      ...datos,
      ...(precio || {}),
      SK: skInformeLinea(datos.proveedorId, linea.productId),
    });
  }
  return out;
}

/**
 * Cruza las filas con la copia de productos y rellena proveedor y unidad.
 * No inventa los Id que no existen.
 * @returns {Promise<{ lineas: object[], desconocidos: string[], duplicados: string[], lineasLeidas: number, lineasContadas: number }>}
 */
export async function prepararLineasConteo(buffer, warehouseId) {
  const leido = await leerExcelConteo(buffer);
  const fichas = await fichasPorId(leido.filas.map((fila) => fila.productId));
  const conocidas = [];
  const desconocidos = [];
  for (const fila of leido.filas) {
    const ficha = fichaDe(fichas, fila.productId);
    if (!ficha) {
      desconocidos.push(fila.productId);
      continue;
    }
    conocidas.push({
      productId: String(ficha.Id ?? fila.productId),
      nombre: String(ficha.Name || fila.nombre || fila.productId).trim(),
      stockReal: fila.stockReal,
      _producto: ficha,
    });
  }
  const lineas = await aplicarProveedorYUnidad(conocidas, warehouseId);
  const lineasContadas = lineas.filter((ln) => ln.stockReal != null).length;
  if (lineasContadas === 0) {
    const err = fallo(MENSAJE_SIN_CONTADAS);
    err.desconocidos = desconocidos;
    err.duplicados = leido.duplicados;
    throw err;
  }
  return {
    lineas,
    desconocidos,
    duplicados: leido.duplicados,
    lineasLeidas: leido.lineasLeidas,
    lineasContadas,
  };
}
