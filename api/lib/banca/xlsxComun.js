/**
 * Utilidades compartidas por los lectores de extractos bancarios en Excel
 * (BBVA, CaixaBank, …). Fechas, importes, celdas y cuadre de saldos.
 */

import ExcelJS from 'exceljs';
import { centimosAEuros, limpiarTexto } from '../n43/campos.js';

/** El extracto trae cientos de filas vacías al final: tantas seguidas cierran la tabla. */
export const MAX_FILAS_VACIAS_SEGUIDAS = 10;

/** Filas que se exploran buscando la cabecera de la tabla antes de rendirse. */
export const MAX_FILAS_BUSQUEDA = 100;

/** Celdas que se miran a la derecha de una etiqueta de cabecera buscando su valor. */
export const MAX_CELDAS_A_LA_DERECHA = 12;

/**
 * El canónico guarda la divisa con el código numérico ISO 4217 porque es lo que
 * trae el Norma 43 ('978'); el Excel la trae en alfabético.
 */
export const DIVISA_ISO = { EUR: '978', USD: '840', GBP: '826', CHF: '756' };

/** Texto comparable: mayúsculas, sin acentos y sin puntuación ("F. CONTABLE" → "FCONTABLE"). */
export function clave(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Valor primitivo de una celda de exceljs (texto enriquecido, enlace o fórmula ya resuelta). */
export function valorCelda(celda) {
  const v = celda?.value;
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text ?? '').join('');
  if (v.text != null) return v.text;
  if ('result' in v) return v.result ?? null;
  return null;
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

function isoSiExiste(anio, mes, dia) {
  if (!(mes >= 1 && mes <= 12)) return '';
  const diasDelMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  if (!(dia >= 1 && dia <= diasDelMes)) return '';
  return `${anio}-${dosDigitos(mes)}-${dosDigitos(dia)}`;
}

/**
 * Fecha de celda a ISO `YYYY-MM-DD`. Llega como `Date` si Excel la guardó con
 * formato de fecha y como texto `dd/mm/aaaa` o `aaaa-mm-dd` si el volcado la
 * dejó en texto.
 *
 * Los `Date` de exceljs vienen en UTC: se leen con los getters UTC porque con
 * los locales, en España, el 01/02 se convertiría en el 31/01.
 *
 * @param {unknown} valor
 * @returns {{ ok: boolean, iso: string, motivo?: string }}
 */
export function fechaDesde(valor) {
  if (valor == null || valor === '') return { ok: false, iso: '', motivo: 'la celda está vacía' };
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return { ok: false, iso: '', motivo: 'la fecha no es válida' };
    return {
      ok: true,
      iso: isoSiExiste(valor.getUTCFullYear(), valor.getUTCMonth() + 1, valor.getUTCDate()),
    };
  }
  const texto = limpiarTexto(String(valor));
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(texto);
  if (isoMatch) {
    const iso = isoSiExiste(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    if (!iso) return { ok: false, iso: '', motivo: `"${texto}" no existe en el calendario` };
    return { ok: true, iso };
  }
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(texto);
  if (!m) return { ok: false, iso: '', motivo: `"${texto}" no tiene formato dd/mm/aaaa` };
  const iso = isoSiExiste(Number(m[3]), Number(m[2]), Number(m[1]));
  if (!iso) return { ok: false, iso: '', motivo: `"${texto}" no existe en el calendario` };
  return { ok: true, iso };
}

/**
 * Número de una celda. Se aceptan numéricos y texto con las dos convenciones de
 * separadores ("1.234,56" y "1,234.56").
 * @param {unknown} valor
 * @returns {number|null}
 */
export function numeroDesde(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const s = String(valor ?? '').replace(/[\s\u00a0€]/g, '');
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^-?\d+(,\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

/**
 * Euros a céntimos enteros. `Math.round` sobre el producto: los flotantes de
 * Excel dan 4,35 × 100 = 434,99999999999994, que truncado serían 4,34 €.
 * @param {number} importe
 * @returns {number}
 */
export function aCentimos(importe) {
  const centimos = Math.round(Number(importe) * 100);
  return centimos === 0 ? 0 : centimos;
}

export function textoDeCelda(celda) {
  const v = valorCelda(celda);
  if (v == null) return '';
  if (v instanceof Date) return fechaDesde(v).iso;
  return limpiarTexto(String(v));
}

export function crudoDe(fila, columna) {
  return columna ? valorCelda(fila.getCell(columna)) : null;
}

export function textoDe(fila, columna) {
  return columna ? textoDeCelda(fila.getCell(columna)) : '';
}

export function divisaCanonica(texto) {
  const t = limpiarTexto(texto).toUpperCase();
  if (!t) return '';
  return DIVISA_ISO[t] || t;
}

/**
 * Saldos de la cuenta a partir de la columna SALDO (saldo *posterior* a cada
 * movimiento). El inicial sale del apunte más antiguo restándole su importe.
 * El sentido del listado se deduce de las fechas.
 *
 * @param {import('./canonico.js').CuentaCanonica} cuenta
 * @param {Array<number|null>} saldos Saldo en céntimos de cada movimiento, en el mismo orden.
 */
export function aplicarSaldos(cuenta, saldos) {
  const movs = cuenta.movimientos;
  if (movs.length === 0) return;

  const descendente = movs[0].fechaOperacion >= movs[movs.length - 1].fechaOperacion;
  const iReciente = descendente ? 0 : movs.length - 1;
  const iAntiguo = descendente ? movs.length - 1 : 0;
  if (saldos[iReciente] == null || saldos[iAntiguo] == null) return;

  const inicialCentimos = saldos[iAntiguo] - movs[iAntiguo].importeCentimos;
  cuenta.saldoInicial = centimosAEuros(inicialCentimos);
  cuenta.saldoFinal = centimosAEuros(saldos[iReciente]);

  if (saldos.some((s) => s == null)) return;
  const calculado = movs.reduce((acc, m) => acc + m.importeCentimos, inicialCentimos);
  if (calculado !== saldos[iReciente]) {
    cuenta.descuadres.push({
      campo: 'saldoFinal',
      declarado: centimosAEuros(saldos[iReciente]),
      calculado: centimosAEuros(calculado),
    });
  }
}

/**
 * @param {Buffer} bruto
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function cargarWorkbook(bruto) {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(bruto);
  return libro;
}
