/**
 * Excel de inventario con el formato de docs/agora/plantilla_inv.xlsx.
 * Hoja «Inventario», columnas A–H. Ubicación y código de barras se dejan vacíos.
 * La columna de stock real es las enteras más la botella abierta. No llama a Ágora.
 */

import ExcelJS from 'exceljs';
import { stockContado } from './diferencia.js';

const CABECERAS = [
  'Id',
  'Familia',
  'Nombre',
  'Ubicación',
  'Código Barras',
  'Unidad',
  'Stock Teórico (Uds. Venta)',
  'Stock Real (Uds. Venta)',
];

/** Anchos de la plantilla de Ágora, para que el fichero se parezca al original. */
const ANCHOS = [9.140625, 26.42578125, 43.85546875, 10, 15.85546875, 9.140625, 24.85546875, 22.42578125];

function idCelda(productId) {
  const s = String(productId ?? '').trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
}

function numeroCelda(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function bufferInventario(inventario) {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet('Inventario');
  hoja.addRow(CABECERAS);
  for (const linea of inventario?.lineas || []) {
    hoja.addRow([
      idCelda(linea.productId),
      linea.familiaNombre || '',
      linea.nombre || '',
      null,
      null,
      linea.unidad || '',
      numeroCelda(linea.stockTeorico),
      stockContado(linea),
    ]);
  }
  ANCHOS.forEach((ancho, i) => {
    hoja.getColumn(i + 1).width = ancho;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
