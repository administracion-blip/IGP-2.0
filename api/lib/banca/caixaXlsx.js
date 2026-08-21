/**
 * Lector de extractos bancarios de CaixaBank en Excel (.xlsx).
 *
 * Misma forma canónica que Norma 43 / BBVA (`canonico.js`). El ordinal se
 * numera por pareja (fecha de operación, importe), independiente del orden de
 * las filas: Caixa lista del más reciente al más antiguo.
 *
 * La tabla se localiza por nombres de columna (Fecha + Importe + Movimiento /
 * Más datos), nunca por número de fila. El IBAN va en el título de la hoja.
 */

import { centimosAEuros } from '../n43/campos.js';
import { normalizarConcepto } from '../n43/concepto.js';
import { hashFichero } from '../n43/hash.js';
import { limpiarIban, validarIban } from '../remesas/iban.js';
import { huellaMovimiento } from './canonico.js';
import {
  aCentimos,
  aplicarSaldos,
  cargarWorkbook,
  clave,
  crudoDe,
  fechaDesde,
  MAX_FILAS_BUSQUEDA,
  MAX_FILAS_VACIAS_SEGUIDAS,
  numeroDesde,
  textoDe,
  textoDeCelda,
} from './xlsxComun.js';

/** Clave del formato. */
export const FORMATO_CAIXA_XLSX = 'CAIXA_XLSX';

/** Nombre visible del formato. */
export const NOMBRE_CAIXA_XLSX = 'CaixaBank — extracto Excel';

/** Divisa fija del extracto Caixa (euros). */
const DIVISA_EUR = '978';

/**
 * Cabecera Caixa → campo interno. "Fecha" y "Fecha valor" se distinguen porque
 * `clave("Fecha valor")` es FECHAVALOR, no FECHA.
 */
const COLUMNAS = {
  FECHA: 'fechaOperacion',
  FECHAVALOR: 'fechaValor',
  MOVIMIENTO: 'movimiento',
  MASDATOS: 'masDatos',
  IMPORTE: 'importe',
  SALDO: 'saldo',
};

/** IBAN español dentro de un texto (título con espacios o sin ellos). */
const RE_IBAN_ES = /\bES\s*\d{2}(?:[\s-]?\d{4}){5}\b/i;

/**
 * Localiza la hoja y la fila de cabecera. Se reconoce porque trae a la vez
 * "Fecha", "Importe" y "Movimiento" (o "Más datos").
 * @param {import('exceljs').Workbook} libro
 * @returns {{ hoja: import('exceljs').Worksheet, filaCabecera: number, columnas: Record<string, number> }|null}
 */
export function localizarTablaCaixa(libro) {
  for (const hoja of libro.worksheets || []) {
    const tope = Math.min(hoja.rowCount || 0, MAX_FILAS_BUSQUEDA);
    for (let f = 1; f <= tope; f += 1) {
      const fila = hoja.getRow(f);
      /** @type {Record<string, number>} */
      const columnas = {};
      for (let c = 1; c <= fila.cellCount; c += 1) {
        const campo = COLUMNAS[clave(textoDeCelda(fila.getCell(c)))];
        if (campo && !columnas[campo]) columnas[campo] = c;
      }
      const tieneConcepto = columnas.movimiento || columnas.masDatos;
      if (columnas.fechaOperacion && columnas.importe && tieneConcepto) {
        return { hoja, filaCabecera: f, columnas };
      }
    }
  }
  return null;
}

/**
 * Extrae el IBAN ES del bloque de título (filas anteriores a la cabecera).
 * @returns {{ fila: number, valor: string }}
 */
function ibanDelTitulo(hoja, filaCabecera) {
  for (let f = 1; f < filaCabecera; f += 1) {
    const fila = hoja.getRow(f);
    const tope = Math.max(fila.cellCount, 1);
    for (let c = 1; c <= tope; c += 1) {
      const texto = textoDeCelda(fila.getCell(c));
      if (!texto) continue;
      const m = RE_IBAN_ES.exec(texto);
      if (m) return { fila: f, valor: m[0] };
    }
  }
  return { fila: 0, valor: '' };
}

/**
 * ¿Parece un extracto CaixaBank? Cabecera con Fecha + Importe + Movimiento/Más datos.
 * (El nombre de hoja Movimientos_cuenta_* y el IBAN del título confirman al leer.)
 * @param {import('exceljs').Workbook} libro
 */
export function pareceCaixaXlsx(libro) {
  return Boolean(localizarTablaCaixa(libro));
}

/**
 * Lee un extracto CaixaBank ya cargado como workbook.
 * @param {import('exceljs').Workbook} libro
 * @param {Buffer} bruto
 * @returns {import('./canonico.js').ExtractoCanonico}
 */
export function leerCaixaDesdeLibro(libro, bruto) {
  const tabla = localizarTablaCaixa(libro);
  if (!tabla) {
    throw new Error(
      'El fichero no parece un extracto de CaixaBank: no se encuentra la fila de cabecera con las columnas "Fecha", "Importe" y "Movimiento"',
    );
  }
  const { hoja, filaCabecera, columnas } = tabla;

  const etiquetaIban = ibanDelTitulo(hoja, filaCabecera);
  if (!etiquetaIban.valor) {
    throw new Error(
      'El fichero no parece un extracto de CaixaBank: no se encuentra el IBAN en el título del extracto',
    );
  }

  /** @type {import('./canonico.js').IncidenciaCanonica[]} */
  const errores = [];
  /** @type {import('./canonico.js').IncidenciaCanonica[]} */
  const avisos = [];

  const ibanLimpio = limpiarIban(etiquetaIban.valor);
  const validacion = validarIban(ibanLimpio);
  if (!validacion.valido) {
    avisos.push({
      linea: etiquetaIban.fila,
      tipo: 'CUENTA',
      motivo: `La cuenta "${etiquetaIban.valor}" no es un IBAN válido: ${validacion.motivo}`,
    });
  }

  /** @type {import('./canonico.js').CuentaCanonica} */
  const cuenta = {
    cuentaRef: validacion.valido ? validacion.iban : ibanLimpio,
    iban: validacion.valido ? validacion.iban : '',
    ccc: '',
    ibanValido: validacion.valido,
    titular: '',
    divisa: DIVISA_EUR,
    fechaInicial: '',
    fechaFinal: '',
    saldoInicial: 0,
    saldoFinal: null,
    movimientos: [],
    descuadres: [],
  };

  if (!columnas.saldo) {
    avisos.push({
      linea: filaCabecera,
      tipo: 'CABECERA',
      motivo: 'El extracto no trae columna Saldo: no se pueden calcular los saldos ni comprobar el cuadre',
    });
  }

  /** @type {Map<string, number>} */
  const ordinales = new Map();
  /** @type {Array<number|null>} */
  const saldos = [];
  let vaciasSeguidas = 0;

  for (let f = filaCabecera + 1; f <= (hoja.rowCount || 0); f += 1) {
    const fila = hoja.getRow(f);
    const fechaCruda = crudoDe(fila, columnas.fechaOperacion);
    const importeCrudo = crudoDe(fila, columnas.importe);
    const vacia = (fechaCruda == null || fechaCruda === '')
      && (importeCrudo == null || importeCrudo === '');
    if (vacia) {
      vaciasSeguidas += 1;
      if (vaciasSeguidas >= MAX_FILAS_VACIAS_SEGUIDAS) break;
      continue;
    }
    vaciasSeguidas = 0;

    const fechaOperacion = fechaDesde(fechaCruda);
    const importe = numeroDesde(importeCrudo);
    const fallos = [];
    if (!fechaOperacion.ok) fallos.push(`Fecha: ${fechaOperacion.motivo}`);
    if (importe == null) fallos.push(`Importe "${textoDe(fila, columnas.importe)}" no es numérico`);
    if (fallos.length) {
      errores.push({ linea: f, tipo: 'FILA', motivo: fallos.join('; ') });
      continue;
    }

    const fechaValor = fechaDesde(crudoDe(fila, columnas.fechaValor));
    const importeCentimos = aCentimos(importe);
    const movimiento = textoDe(fila, columnas.movimiento);
    const masDatos = textoDe(fila, columnas.masDatos);
    const concepto = normalizarConcepto(
      [movimiento, masDatos].filter(Boolean).join(' '),
    );

    const claveOrdinal = `${fechaOperacion.iso}|${importeCentimos}`;
    const ordinal = (ordinales.get(claveOrdinal) ?? 0) + 1;
    ordinales.set(claveOrdinal, ordinal);

    cuenta.movimientos.push({
      cuentaRef: cuenta.cuentaRef,
      iban: cuenta.iban,
      fechaOperacion: fechaOperacion.iso,
      fechaValor: fechaValor.ok ? fechaValor.iso : fechaOperacion.iso,
      importe: centimosAEuros(importeCentimos),
      importeCentimos,
      signo: importeCentimos < 0 ? 'D' : 'H',
      concepto: concepto.conceptoTexto,
      conceptoNormalizado: concepto.conceptoNormalizado,
      nif: concepto.nif,
      referencia1: masDatos,
      referencia2: '',
      numeroDocumento: '',
      conceptoComun: '',
      conceptoPropio: '',
      divisa: DIVISA_EUR,
      ordinal,
      movementHash: huellaMovimiento({
        cuenta: cuenta.cuentaRef,
        fechaOperacion: fechaOperacion.iso,
        importeCentimos,
        ordinal,
      }),
      lineaOrigen: f,
    });

    const saldo = numeroDesde(crudoDe(fila, columnas.saldo));
    saldos.push(saldo == null ? null : aCentimos(saldo));
  }

  aplicarSaldos(cuenta, saldos);

  return {
    formato: FORMATO_CAIXA_XLSX,
    hashFichero: hashFichero(bruto),
    codificacion: 'xlsx',
    cuentas: [cuenta],
    errores,
    avisos,
  };
}

/**
 * Lee un extracto de CaixaBank en Excel.
 *
 * @param {Buffer|Uint8Array} contenido
 * @returns {Promise<import('./canonico.js').ExtractoCanonico>}
 */
export async function leerCaixaXlsx(contenido) {
  const bruto = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido ?? []);
  const libro = await cargarWorkbook(bruto);
  return leerCaixaDesdeLibro(libro, bruto);
}
