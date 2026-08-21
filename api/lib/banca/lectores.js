/**
 * Registro de lectores de extractos bancarios.
 *
 * Añadir un formato (los Excel/CSV de Santander, CaixaBank o BBVA) es escribir
 * un lector aquí que devuelva un `ExtractoCanonico`: ni la ingesta ni el router
 * cambian. `traeIban` distingue los formatos que identifican la cuenta dentro
 * del propio fichero (Norma 43, Excel con IBAN) de los que no, donde el IBAN
 * tiene que llegar en la petición.
 *
 * Varios formatos comparten extensión `.xlsx`: la extensión ya no identifica el
 * banco. Sin `formato` explícito, un lector wrapper abre el workbook una vez y
 * elige BBVA o CaixaBank por el contenido de la hoja.
 */

import path from 'path';
import { parsearN43 } from '../n43/parser.js';
import { FORMATO_BBVA_XLSX, leerBbvaXlsx, NOMBRE_BBVA_XLSX } from './bbvaXlsx.js';
import { FORMATO_CAIXA_XLSX, leerCaixaXlsx, NOMBRE_CAIXA_XLSX } from './caixaXlsx.js';
import { adaptarN43, FORMATO_N43 } from './canonico.js';
import { leerExcelBancario } from './xlsxAuto.js';

/**
 * @typedef {object} LectorExtracto
 * @property {string} clave
 * @property {string} nombre
 * @property {string[]} extensiones Extensiones (con punto) que se le asignan por defecto.
 * @property {boolean} traeIban Si el fichero identifica la cuenta por sí mismo.
 * @property {(buffer: Buffer) => import('./canonico.js').ExtractoCanonico
 *   | Promise<import('./canonico.js').ExtractoCanonico>} leer Puede ser
 *   asíncrono (descomprimir un .xlsx lo es): quien lo llame hace `await`.
 */

/**
 * Lector meta para `.xlsx` sin `formato`: autodetection por contenido.
 * No se lista en `listarFormatos` (sí BBVA_XLSX y CAIXA_XLSX).
 * @type {LectorExtracto}
 */
const LECTOR_XLSX_AUTO = {
  clave: 'XLSX',
  nombre: 'Excel bancario (detección automática)',
  extensiones: ['.xlsx'],
  traeIban: true,
  leer: (buffer) => leerExcelBancario(buffer),
};

/** @type {LectorExtracto[]} */
const LECTORES = [
  {
    clave: FORMATO_N43,
    nombre: 'Norma 43 (Cuaderno 43 AEB/CECA)',
    extensiones: ['.q43', '.n43', '.043', '.txt', '.dat'],
    traeIban: true,
    leer: (buffer) => adaptarN43(parsearN43(buffer)),
  },
  {
    clave: FORMATO_BBVA_XLSX,
    nombre: NOMBRE_BBVA_XLSX,
    // La extensión .xlsx se documenta para la UI; la detección real va por
    // contenido vía LECTOR_XLSX_AUTO (o formato=BBVA_XLSX forzado).
    extensiones: ['.xlsx'],
    traeIban: true,
    leer: (buffer) => leerBbvaXlsx(buffer),
  },
  {
    clave: FORMATO_CAIXA_XLSX,
    nombre: NOMBRE_CAIXA_XLSX,
    extensiones: ['.xlsx'],
    traeIban: true,
    leer: (buffer) => leerCaixaXlsx(buffer),
  },
];

/** Extensiones que el router acepta subir, aunque su lector aún no exista. */
export const EXTENSIONES_EXTRACTO = ['.q43', '.n43', '.043', '.txt', '.dat', '.csv', '.xls', '.xlsx'];

/** @returns {Array<{ clave: string, nombre: string, extensiones: string[], traeIban: boolean }>} */
export function listarFormatos() {
  return LECTORES.map(({ clave, nombre, extensiones, traeIban }) => ({
    clave,
    nombre,
    extensiones,
    traeIban,
  }));
}

/** @param {string} clave @returns {LectorExtracto|null} */
export function getLector(clave) {
  const c = String(clave || '').trim().toUpperCase();
  if (c === LECTOR_XLSX_AUTO.clave) return LECTOR_XLSX_AUTO;
  return LECTORES.find((l) => l.clave === c) || null;
}

/** Extensión en minúsculas de un nombre de fichero ('' si no tiene). */
export function extensionDe(nombreFichero) {
  return path.extname(String(nombreFichero || '')).toLowerCase();
}

/**
 * Elige el lector de un fichero. Con `formato` explícito manda ese; si no, se
 * decide por extensión. Para `.xlsx` se usa autodetection por contenido.
 * @param {{ nombreFichero?: string, formato?: string }} datos
 * @returns {{ ok: true, lector: LectorExtracto } | { ok: false, code: string, motivo: string }}
 */
export function detectarLector({ nombreFichero, formato } = {}) {
  if (formato) {
    const lector = getLector(formato);
    if (!lector) {
      return { ok: false, code: 'FORMATO_DESCONOCIDO', motivo: `Formato no soportado: ${formato}` };
    }
    return { ok: true, lector };
  }
  const ext = extensionDe(nombreFichero);
  if (ext === '.xlsx') {
    return { ok: true, lector: LECTOR_XLSX_AUTO };
  }
  const lector = LECTORES.find((l) => l.extensiones.includes(ext));
  if (!lector) {
    return {
      ok: false,
      code: 'FORMATO_NO_SOPORTADO',
      motivo: ext
        ? `Todavía no se leen extractos "${ext}". Sube el fichero Norma 43 (.q43) del banco`
        : 'No se reconoce el formato del extracto. Sube el fichero Norma 43 (.q43) del banco',
    };
  }
  return { ok: true, lector };
}
