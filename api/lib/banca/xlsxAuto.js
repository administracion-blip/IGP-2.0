/**
 * Autodetección y lectura de extractos bancarios en Excel (.xlsx).
 *
 * Abre el workbook una sola vez y elige BBVA o CaixaBank según el contenido
 * (cabeceras / título), no por el nombre del fichero.
 */

import { leerBbvaDesdeLibro, pareceBbvaXlsx } from './bbvaXlsx.js';
import { leerCaixaDesdeLibro, pareceCaixaXlsx } from './caixaXlsx.js';
import { cargarWorkbook } from './xlsxComun.js';

/**
 * Lee un .xlsx bancario detectando el formato por el contenido.
 *
 * @param {Buffer|Uint8Array} contenido
 * @returns {Promise<import('./canonico.js').ExtractoCanonico>}
 */
export async function leerExcelBancario(contenido) {
  const bruto = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido ?? []);
  const libro = await cargarWorkbook(bruto);

  // Caixa primero: su cabecera (Fecha + Importe + Movimiento) no se confunde con
  // la de BBVA (F. CONTABLE + IMPORTE). Si ambas fallaran el orden no importa.
  if (pareceCaixaXlsx(libro)) {
    return leerCaixaDesdeLibro(libro, bruto);
  }
  if (pareceBbvaXlsx(libro)) {
    return leerBbvaDesdeLibro(libro, bruto);
  }

  throw new Error(
    'El fichero no parece un extracto BBVA ni CaixaBank conocidos. '
    + 'Comprueba que sea el Excel de movimientos del banco o indica el formato (BBVA_XLSX / CAIXA_XLSX)',
  );
}
