/**
 * Movimiento bancario canónico: la forma con la que trabaja la ingesta,
 * independiente del formato del extracto.
 *
 * Hoy solo se lee Norma 43, pero enseguida habrá que leer los Excel y CSV de
 * Santander, CaixaBank y BBVA. Para que añadir un formato sea escribir un lector
 * más (y no tocar la ingesta), el reparto es:
 *
 *   lector de formato → extracto canónico → ingesta (huellas, idempotencia, escritura)
 *
 * La ingesta no sabe que existe el Norma 43: recibe siempre un `ExtractoCanonico`.
 * Aquí vive además el adaptador desde la salida de `parsearN43`.
 */

import { hashMovimiento } from '../n43/hash.js';
import { limpiarIban } from '../remesas/iban.js';

/**
 * @typedef {object} MovimientoCanonico
 * @property {string} cuentaRef Cuenta con la que se calculó la huella: IBAN, o CCC si no hubo IBAN válido.
 * @property {string} iban IBAN normalizado ('' si el formato no lo trae o no es válido).
 * @property {string} fechaOperacion ISO `YYYY-MM-DD`.
 * @property {string} fechaValor ISO `YYYY-MM-DD`.
 * @property {number} importe Con signo (cargo negativo, abono positivo).
 * @property {number} importeCentimos Con signo, entero.
 * @property {'D'|'H'} signo
 * @property {string} concepto Texto del concepto tal como se muestra al usuario.
 * @property {string} conceptoNormalizado Concepto en mayúsculas sin ruido, para búsquedas.
 * @property {string} nif NIF/CIF detectado en el concepto ('' si no hay).
 * @property {string} referencia1
 * @property {string} referencia2
 * @property {string} numeroDocumento
 * @property {string} conceptoComun Código de concepto común del banco ('' si el formato no lo trae).
 * @property {string} conceptoPropio Código de concepto propio del banco ('' si el formato no lo trae).
 * @property {string} divisa
 * @property {number} ordinal Orden dentro de su cuenta y su fecha de operación (desde 1).
 * @property {string} movementHash Huella del movimiento (identidad a efectos de no duplicarlo).
 * @property {number} lineaOrigen Línea/fila del fichero de origen, para poder auditar.
 */

/**
 * @typedef {object} DescuadreCanonico
 * @property {string} campo
 * @property {number|null} declarado Lo que dice el fichero.
 * @property {number} calculado Lo que sale de los movimientos leídos.
 */

/**
 * @typedef {object} CuentaCanonica
 * @property {string} cuentaRef Clave de agrupación: IBAN, o CCC si no hubo IBAN válido.
 * @property {string} iban
 * @property {string} ccc
 * @property {boolean} ibanValido
 * @property {string} titular
 * @property {string} divisa
 * @property {string} fechaInicial Rango declarado por el fichero (ISO, '' si no lo trae).
 * @property {string} fechaFinal
 * @property {number} saldoInicial
 * @property {number|null} saldoFinal Saldo final declarado.
 * @property {MovimientoCanonico[]} movimientos
 * @property {DescuadreCanonico[]} descuadres
 */

/**
 * @typedef {object} IncidenciaCanonica
 * @property {number} linea
 * @property {string} tipo
 * @property {string} motivo
 */

/**
 * @typedef {object} ExtractoCanonico
 * @property {string} formato Clave del formato de origen ('N43', 'SANTANDER_XLSX'…).
 * @property {string} hashFichero SHA-256 hex del fichero en bruto.
 * @property {string} codificacion
 * @property {CuentaCanonica[]} cuentas
 * @property {IncidenciaCanonica[]} errores
 * @property {IncidenciaCanonica[]} avisos
 */

/** Clave del formato Norma 43. */
export const FORMATO_N43 = 'N43';

/**
 * Huella de un movimiento canónico. Se expone desde aquí para que un lector
 * nuevo (Excel, CSV) no tenga que importar nada del Norma 43: la receta usa solo
 * datos que traen todos los formatos, así que el mismo apunte descargado en dos
 * formatos distintos produce la misma huella.
 * @param {{ cuenta: string, fechaOperacion: string, importeCentimos: number, ordinal: number }} datos
 * @returns {string}
 */
export function huellaMovimiento(datos) {
  return hashMovimiento(datos);
}

function texto(val) {
  return val != null ? String(val).trim() : '';
}

/**
 * Rango de fechas de operación que cubre una lista de movimientos.
 * Se calcula con los movimientos y no con el rango declarado en la cabecera:
 * hay extractos que declaran el mes entero y solo traen apuntes de una semana.
 * @param {MovimientoCanonico[]} movimientos
 * @returns {{ desde: string, hasta: string }} Cadenas vacías si no hay movimientos.
 */
export function rangoFechasMovimientos(movimientos) {
  let desde = '';
  let hasta = '';
  for (const mov of movimientos || []) {
    const fecha = texto(mov?.fechaOperacion);
    if (!fecha) continue;
    if (!desde || fecha < desde) desde = fecha;
    if (!hasta || fecha > hasta) hasta = fecha;
  }
  return { desde, hasta };
}

/** Total de movimientos de un extracto canónico. */
export function contarMovimientos(extracto) {
  return (extracto?.cuentas || []).reduce((acc, c) => acc + (c.movimientos?.length || 0), 0);
}

/**
 * Convierte un movimiento del parser Norma 43 al canónico.
 * @param {Record<string, any>} mov
 * @param {CuentaCanonica} cuenta
 * @returns {MovimientoCanonico}
 */
function movimientoDesdeN43(mov, cuenta) {
  return {
    cuentaRef: cuenta.cuentaRef,
    iban: cuenta.iban,
    fechaOperacion: texto(mov.fechaOperacion),
    fechaValor: texto(mov.fechaValor) || texto(mov.fechaOperacion),
    importe: Number(mov.importe) || 0,
    importeCentimos: Math.trunc(Number(mov.importeCentimos) || 0),
    signo: mov.signo === 'D' ? 'D' : 'H',
    concepto: texto(mov.conceptoTexto),
    conceptoNormalizado: texto(mov.conceptoNormalizado),
    nif: texto(mov.nif),
    referencia1: texto(mov.referencia1),
    referencia2: texto(mov.referencia2),
    numeroDocumento: texto(mov.numeroDocumento),
    conceptoComun: texto(mov.conceptoComun),
    conceptoPropio: texto(mov.conceptoPropio),
    divisa: cuenta.divisa,
    ordinal: Number(mov.ordinal) || 0,
    movementHash: texto(mov.movementHash) || huellaMovimiento({
      cuenta: cuenta.cuentaRef,
      fechaOperacion: texto(mov.fechaOperacion),
      importeCentimos: Math.trunc(Number(mov.importeCentimos) || 0),
      ordinal: Number(mov.ordinal) || 0,
    }),
    lineaOrigen: Number(mov.linea) || 0,
  };
}

/**
 * Adapta la salida de `parsearN43` al extracto canónico.
 * @param {Record<string, any>} resultado Salida de `parsearN43`.
 * @returns {ExtractoCanonico}
 */
export function adaptarN43(resultado) {
  const cuentas = (resultado?.cuentas || []).map((c) => {
    const iban = c.ibanValido ? limpiarIban(c.iban) : '';
    const ccc = texto(c.ccc);
    /** @type {CuentaCanonica} */
    const cuenta = {
      // Misma preferencia que la huella del parser: sin IBAN válido manda el CCC,
      // así dos cuentas del mismo fichero nunca comparten clave.
      cuentaRef: iban || ccc,
      iban,
      ccc,
      ibanValido: c.ibanValido === true,
      titular: texto(c.nombreAbreviado),
      divisa: texto(c.divisa),
      fechaInicial: texto(c.fechaInicial),
      fechaFinal: texto(c.fechaFinal),
      saldoInicial: Number(c.saldoInicial) || 0,
      saldoFinal: c.final?.saldoFinal ?? null,
      movimientos: [],
      descuadres: (c.descuadres || []).map((d) => ({
        campo: texto(d.campo),
        declarado: d.declarado ?? null,
        calculado: Number(d.calculado) || 0,
      })),
    };
    cuenta.movimientos = (c.movimientos || []).map((m) => movimientoDesdeN43(m, cuenta));
    return cuenta;
  });

  return {
    formato: FORMATO_N43,
    hashFichero: texto(resultado?.hashFichero),
    codificacion: texto(resultado?.codificacion),
    cuentas,
    errores: (resultado?.errores || []).map((e) => ({
      linea: Number(e.linea) || 0,
      tipo: texto(e.tipo),
      motivo: texto(e.motivo),
    })),
    avisos: (resultado?.avisos || []).map((a) => ({
      linea: Number(a.linea) || 0,
      tipo: texto(a.tipo),
      motivo: texto(a.motivo),
    })),
  };
}
