/**
 * Lee el Excel de conteo que genera IGP (hoja «Inventario»).
 * No calcula pedido ni previsión: solo Id y Stock Real.
 * Vacío = no contado. Un 0 escrito es 0. Se admiten decimales.
 * Un Id repetido no se suma: se avisa y se queda la primera fila.
 */

import ExcelJS from 'exceljs';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { CABECERAS } from '../inventarios/excel.js';

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
 * Cruza las filas con la copia de productos. No inventa los Id que no existen.
 * @returns {Promise<{ lineas: object[], desconocidos: string[], duplicados: string[], lineasLeidas: number, lineasContadas: number }>}
 */
export async function prepararLineasConteo(buffer) {
  const leido = await leerExcelConteo(buffer);
  const lineas = [];
  const desconocidos = [];
  for (const fila of leido.filas) {
    const ficha = await fichaProducto(fila.productId);
    if (!ficha) {
      desconocidos.push(fila.productId);
      continue;
    }
    lineas.push({
      productId: String(ficha.Id ?? fila.productId),
      nombre: String(ficha.Name || fila.nombre || fila.productId).trim(),
      stockReal: fila.stockReal,
      proveedorId: 'SIN_PROVEEDOR',
      proveedorNombre: '',
    });
  }
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
