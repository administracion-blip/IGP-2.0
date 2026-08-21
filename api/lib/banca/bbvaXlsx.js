/**
 * Lector de extractos bancarios de BBVA en Excel (.xlsx).
 *
 * Devuelve el mismo `ExtractoCanonico` que el Norma 43 (ver `canonico.js`), así
 * que la ingesta no distingue de qué formato viene un apunte. Lo importante es
 * que el `ordinal` se numere igual que en el parser N43 —por pareja (fecha de
 * operación, importe)—: el mismo movimiento descargado en los dos formatos tiene
 * que dar la misma huella o entraría dos veces.
 *
 * El maquetado del fichero se localiza buscando etiquetas y nombres de columna,
 * nunca por número de fila: BBVA cambia la plantilla cada temporada y una fila
 * de más no puede dejar el extracto ilegible.
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
  divisaCanonica,
  fechaDesde,
  MAX_CELDAS_A_LA_DERECHA,
  MAX_FILAS_BUSQUEDA,
  MAX_FILAS_VACIAS_SEGUIDAS,
  numeroDesde,
  textoDe,
  textoDeCelda,
} from './xlsxComun.js';

/** Clave del formato. */
export const FORMATO_BBVA_XLSX = 'BBVA_XLSX';

/** Nombre visible del formato. */
export const NOMBRE_BBVA_XLSX = 'BBVA — extracto Excel';

/** Nombre de columna del extracto → campo interno. La clave va normalizada (ver `clave`). */
const COLUMNAS = {
  FCONTABLE: 'fechaOperacion',
  FVALOR: 'fechaValor',
  CODIGO: 'codigo',
  CONCEPTO: 'concepto',
  BENEFICIARIOORDENANTE: 'contraparte',
  OBSERVACIONES: 'observaciones',
  IMPORTE: 'importe',
  SALDO: 'saldo',
  DIVISA: 'divisa',
  OFICINA: 'oficina',
  REMESA: 'remesa',
};

/**
 * Localiza la hoja y la fila de cabecera de la tabla de movimientos, y deduce de
 * ella el índice de cada columna. Se reconoce la cabecera porque trae a la vez
 * "F. CONTABLE" e "IMPORTE"; ni el nombre de la hoja ni los números de fila o
 * columna están fijados.
 * @param {import('exceljs').Workbook} libro
 * @returns {{ hoja: import('exceljs').Worksheet, filaCabecera: number, columnas: Record<string, number> }|null}
 */
export function localizarTablaBbva(libro) {
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
      if (columnas.fechaOperacion && columnas.importe) {
        return { hoja, filaCabecera: f, columnas };
      }
    }
  }
  return null;
}

/**
 * ¿Parece un extracto BBVA? Cabecera F. CONTABLE + IMPORTE y etiqueta "Cuenta".
 * @param {import('exceljs').Workbook} libro
 */
export function pareceBbvaXlsx(libro) {
  const tabla = localizarTablaBbva(libro);
  if (!tabla) return false;
  return Boolean(valorEtiqueta(tabla.hoja, tabla.filaCabecera, 'Cuenta').valor);
}

/**
 * Valor de una etiqueta del bloque de cabecera ("Cuenta", "Titular"…): se busca
 * la etiqueta en las filas anteriores a la tabla y se toma la primera celda no
 * vacía a su derecha.
 * @returns {{ fila: number, valor: string }}
 */
function valorEtiqueta(hoja, filaCabecera, etiqueta) {
  const buscada = clave(etiqueta);
  for (let f = 1; f < filaCabecera; f += 1) {
    const fila = hoja.getRow(f);
    for (let c = 1; c <= fila.cellCount; c += 1) {
      if (clave(textoDeCelda(fila.getCell(c))) !== buscada) continue;
      const tope = Math.max(fila.cellCount, c + MAX_CELDAS_A_LA_DERECHA);
      for (let d = c + 1; d <= tope; d += 1) {
        const valor = textoDeCelda(fila.getCell(d));
        if (valor) return { fila: f, valor };
      }
    }
  }
  return { fila: 0, valor: '' };
}

/** Rango declarado en la etiqueta "Periodo" (`01/02/2026-31/07/2026`). */
function periodoDesde(texto) {
  const m = /(\d{1,2}[/-]\d{1,2}[/-]\d{4})\D+(\d{1,2}[/-]\d{1,2}[/-]\d{4})/.exec(String(texto || ''));
  if (!m) return { desde: '', hasta: '' };
  const a = fechaDesde(m[1]);
  const b = fechaDesde(m[2]);
  return { desde: a.ok ? a.iso : '', hasta: b.ok ? b.iso : '' };
}

/**
 * Lee un extracto BBVA ya cargado como workbook (para autodetection sin abrir dos veces).
 * @param {import('exceljs').Workbook} libro
 * @param {Buffer} bruto
 * @returns {import('./canonico.js').ExtractoCanonico}
 */
export function leerBbvaDesdeLibro(libro, bruto) {
  const tabla = localizarTablaBbva(libro);
  if (!tabla) {
    throw new Error(
      'El fichero no parece un extracto de BBVA: no se encuentra la fila de cabecera con las columnas "F. CONTABLE" e "IMPORTE"',
    );
  }
  const { hoja, filaCabecera, columnas } = tabla;

  const etiquetaCuenta = valorEtiqueta(hoja, filaCabecera, 'Cuenta');
  if (!etiquetaCuenta.valor) {
    throw new Error(
      'El fichero no parece un extracto de BBVA: no se encuentra la etiqueta "Cuenta" con el IBAN',
    );
  }

  /** @type {import('./canonico.js').IncidenciaCanonica[]} */
  const errores = [];
  /** @type {import('./canonico.js').IncidenciaCanonica[]} */
  const avisos = [];

  const ibanLimpio = limpiarIban(etiquetaCuenta.valor);
  const validacion = validarIban(ibanLimpio);
  if (!validacion.valido) {
    avisos.push({
      linea: etiquetaCuenta.fila,
      tipo: 'CUENTA',
      motivo: `La cuenta "${etiquetaCuenta.valor}" no es un IBAN válido: ${validacion.motivo}`,
    });
  }

  const periodo = periodoDesde(valorEtiqueta(hoja, filaCabecera, 'Periodo').valor);

  /** @type {import('./canonico.js').CuentaCanonica} */
  const cuenta = {
    cuentaRef: validacion.valido ? validacion.iban : ibanLimpio,
    iban: validacion.valido ? validacion.iban : '',
    ccc: '',
    ibanValido: validacion.valido,
    titular: valorEtiqueta(hoja, filaCabecera, 'Titular').valor,
    divisa: divisaCanonica(valorEtiqueta(hoja, filaCabecera, 'Divisa').valor),
    fechaInicial: periodo.desde,
    fechaFinal: periodo.hasta,
    saldoInicial: 0,
    saldoFinal: null,
    movimientos: [],
    descuadres: [],
  };

  if (!columnas.saldo) {
    avisos.push({
      linea: filaCabecera,
      tipo: 'CABECERA',
      motivo: 'El extracto no trae columna SALDO: no se pueden calcular los saldos ni comprobar el cuadre',
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
    if (!fechaOperacion.ok) fallos.push(`Fecha contable: ${fechaOperacion.motivo}`);
    if (importe == null) fallos.push(`Importe "${textoDe(fila, columnas.importe)}" no es numérico`);
    if (fallos.length) {
      errores.push({ linea: f, tipo: 'FILA', motivo: fallos.join('; ') });
      continue;
    }

    const fechaValor = fechaDesde(crudoDe(fila, columnas.fechaValor));
    const importeCentimos = aCentimos(importe);
    const contraparte = textoDe(fila, columnas.contraparte);
    const observaciones = textoDe(fila, columnas.observaciones);
    const concepto = normalizarConcepto(
      [textoDe(fila, columnas.concepto), contraparte, observaciones].filter(Boolean).join(' '),
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
      referencia1: contraparte,
      referencia2: observaciones,
      numeroDocumento: textoDe(fila, columnas.remesa),
      conceptoComun: '',
      conceptoPropio: textoDe(fila, columnas.codigo),
      divisa: divisaCanonica(textoDe(fila, columnas.divisa)) || cuenta.divisa,
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
    formato: FORMATO_BBVA_XLSX,
    hashFichero: hashFichero(bruto),
    codificacion: 'xlsx',
    cuentas: [cuenta],
    errores,
    avisos,
  };
}

/**
 * Lee un extracto de BBVA en Excel.
 *
 * Una fila ilegible se anota en `errores` y la lectura sigue. Solo se lanza
 * cuando el fichero no es un extracto de BBVA (sin cabecera de tabla o sin la
 * cuenta), porque entonces no hay nada que importar.
 *
 * @param {Buffer|Uint8Array} contenido
 * @returns {Promise<import('./canonico.js').ExtractoCanonico>}
 */
export async function leerBbvaXlsx(contenido) {
  const bruto = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido ?? []);
  const libro = await cargarWorkbook(bruto);
  return leerBbvaDesdeLibro(libro, bruto);
}
