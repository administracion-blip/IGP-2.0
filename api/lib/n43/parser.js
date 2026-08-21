/**
 * Parser de ficheros Norma 43 (Cuaderno 43 AEB/CECA).
 *
 * Función pura: entra el `Buffer` del fichero y sale la estructura parseada
 * (cuentas, movimientos, descuadres, errores y avisos). No persiste nada ni
 * conoce endpoints: la ingesta se construye encima.
 *
 * Criterio general: un registro que no cuadra no revienta el fichero. Se anota
 * en `errores` con su número de línea y el parseo continúa, porque un extracto
 * a medias es más útil que una excepción.
 */

import {
  LARGO_REGISTRO,
  aplicarSigno,
  campo,
  centimosAEuros,
  limpiarTexto,
  parsearClaveSigno,
  parsearFechaAammdd,
  parsearImporteCentimos,
  rellenarRegistro,
} from './campos.js';
import { construirIbanN43 } from './ccc.js';
import { normalizarConcepto } from './concepto.js';
import { hashFichero, hashMovimiento } from './hash.js';

/** Máximo de registros 23 por movimiento según el cuaderno. */
const MAX_CONCEPTOS_COMPLEMENTARIOS = 5;

/**
 * @typedef {object} IncidenciaN43
 * @property {number} linea Línea (o registro) del fichero donde se detectó.
 * @property {string} tipo Tipo de registro detectado ('' si no se pudo determinar).
 * @property {string} motivo Explicación en español, apta para mostrar en pantalla.
 */

/**
 * @typedef {object} ConceptoComplementarioN43
 * @property {string} codigoDato Código de dato del registro 23 (posiciones 3-4).
 * @property {string} texto Concepto del registro, con espacios colapsados.
 * @property {string} crudo Los 76 caracteres del concepto tal cual vienen en el fichero.
 */

/**
 * @typedef {object} EquivalenciaN43
 * @property {string} codigoDato
 * @property {string} divisa Divisa de origen del importe equivalente.
 * @property {number} importe
 * @property {number} importeCentimos
 */

/**
 * @typedef {object} MovimientoN43
 * @property {number} linea
 * @property {string} oficinaOrigen
 * @property {string} fechaOperacion ISO `YYYY-MM-DD`.
 * @property {string} fechaValor ISO `YYYY-MM-DD`.
 * @property {string} conceptoComun
 * @property {string} conceptoPropio
 * @property {string} clave Clave debe/haber original ('1' debe, '2' haber).
 * @property {'D'|'H'} signo
 * @property {number} importe Con signo (debe negativo, haber positivo).
 * @property {number} importeCentimos Con signo, entero.
 * @property {string} numeroDocumento
 * @property {string} referencia1
 * @property {string} referencia2
 * @property {ConceptoComplementarioN43[]} conceptosComplementarios
 * @property {EquivalenciaN43[]} equivalencias
 * @property {string} conceptoTexto
 * @property {string} conceptoNormalizado
 * @property {string} nif
 * @property {number} ordinal Orden entre los apuntes de la misma cuenta, fecha e importe del fichero (desde 1).
 * @property {string} movementHash SHA-256 hex del movimiento.
 */

/**
 * @typedef {object} FinalCuentaN43 Datos declarados en el registro 33.
 * @property {number} linea
 * @property {string} entidad
 * @property {string} oficina
 * @property {string} numeroCuenta
 * @property {number|null} numeroApuntesDebe
 * @property {number|null} totalDebe
 * @property {number|null} numeroApuntesHaber
 * @property {number|null} totalHaber
 * @property {string} claveSaldoFinal
 * @property {number|null} saldoFinal
 * @property {number|null} saldoFinalCentimos
 * @property {string} divisa
 */

/**
 * @typedef {object} TotalesCuentaN43 Totales calculados con los movimientos parseados.
 * @property {number} numeroApuntesDebe
 * @property {number} totalDebe Importe al debe en positivo.
 * @property {number} numeroApuntesHaber
 * @property {number} totalHaber
 * @property {number} saldoFinal Saldo inicial + haber − debe.
 * @property {number} saldoFinalCentimos
 */

/**
 * @typedef {object} DescuadreN43
 * @property {string} campo
 * @property {number|null} declarado Valor del registro 33.
 * @property {number} calculado Valor obtenido de los movimientos.
 */

/**
 * @typedef {object} CuentaN43
 * @property {number} linea Línea del registro 11.
 * @property {string} entidad
 * @property {string} oficina
 * @property {string} numeroCuenta
 * @property {string} ccc CCC de 20 dígitos (con los DC calculados).
 * @property {string} iban IBAN construido y validado ('' si no se pudo validar).
 * @property {boolean} ibanValido
 * @property {string} fechaInicial ISO.
 * @property {string} fechaFinal ISO.
 * @property {string} claveSaldoInicial
 * @property {number} saldoInicial Con signo.
 * @property {number} saldoInicialCentimos
 * @property {string} divisa
 * @property {string} modalidad
 * @property {string} nombreAbreviado Titular abreviado del registro 11.
 * @property {MovimientoN43[]} movimientos
 * @property {FinalCuentaN43|null} final
 * @property {TotalesCuentaN43|null} totales
 * @property {DescuadreN43[]} descuadres
 */

/**
 * @typedef {object} FinFicheroN43
 * @property {number} linea
 * @property {number|null} registrosDeclarados Contador del registro 88.
 * @property {number} registrosLeidos Registros de 80 caracteres procesados (incluido el 88).
 * @property {boolean} cuadra
 */

/**
 * @typedef {object} ResultadoN43
 * @property {'utf-8'|'iso-8859-1'} codificacion Codificación con la que se leyó el fichero.
 * @property {string} hashFichero SHA-256 hex del buffer en bruto.
 * @property {number} totalRegistros Registros de 80 caracteres procesados.
 * @property {FinFicheroN43|null} finFichero `null` si el fichero no trae registro 88.
 * @property {CuentaN43[]} cuentas
 * @property {IncidenciaN43[]} errores
 * @property {IncidenciaN43[]} avisos
 */

/**
 * Los tres bancos que leemos emiten en ISO-8859-1, así que UTF-8 solo se acepta
 * cuando decodifica sin excepción y sin carácter de reemplazo. Al revés
 * (asumir UTF-8) se destrozarían las Ñ, Ç y acentos del titular y del concepto.
 * @param {Buffer} buffer
 * @returns {{ texto: string, codificacion: 'utf-8'|'iso-8859-1' }}
 */
function decodificar(buffer) {
  try {
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (!texto.includes('\uFFFD')) {
      return { texto: texto.replace(/^\uFEFF/, ''), codificacion: 'utf-8' };
    }
  } catch {
    // Secuencia inválida en UTF-8: el fichero es latin1.
  }
  // `latin1` de Node es ISO-8859-1 puro; TextDecoder('iso-8859-1') pasaría por windows-1252.
  return { texto: buffer.toString('latin1'), codificacion: 'iso-8859-1' };
}

/**
 * Trocea el fichero en registros de 80 caracteres tolerando CRLF, LF, ningún
 * separador (bloque continuo), líneas recortadas por la derecha y líneas en
 * blanco.
 * @param {string} texto
 * @returns {Array<{ linea: number, texto?: string, motivo?: string }>}
 */
function trocearRegistros(texto) {
  const salida = [];
  if (!/[\r\n]/.test(texto)) {
    const continuo = texto.replace(/\s+$/, '');
    for (let p = 0, n = 1; p < continuo.length; p += LARGO_REGISTRO, n += 1) {
      salida.push({ linea: n, texto: rellenarRegistro(continuo.slice(p, p + LARGO_REGISTRO)) });
    }
    return salida;
  }
  const lineas = texto.split(/\r\n|\n|\r/);
  for (let i = 0; i < lineas.length; i += 1) {
    const numero = i + 1;
    const cruda = lineas[i].replace(/\s+$/, '');
    if (!cruda) continue;
    if (cruda.length <= LARGO_REGISTRO) {
      salida.push({ linea: numero, texto: rellenarRegistro(cruda) });
      continue;
    }
    if (cruda.length % LARGO_REGISTRO === 0) {
      for (let p = 0; p < cruda.length; p += LARGO_REGISTRO) {
        salida.push({ linea: numero, texto: cruda.slice(p, p + LARGO_REGISTRO) });
      }
      continue;
    }
    salida.push({
      linea: numero,
      motivo: `Línea de ${cruda.length} caracteres: se esperaban 80`,
    });
  }
  return salida;
}

function contador(raw, largo) {
  const s = String(raw ?? '').trim();
  const re = new RegExp(`^\\d{1,${largo}}$`);
  return re.test(s) ? Number(s) : null;
}

function calcularTotales(cuenta) {
  let debeCentimos = 0;
  let haberCentimos = 0;
  let numeroApuntesDebe = 0;
  let numeroApuntesHaber = 0;
  for (const mov of cuenta.movimientos) {
    if (mov.signo === 'D') {
      numeroApuntesDebe += 1;
      debeCentimos += Math.abs(mov.importeCentimos);
    } else {
      numeroApuntesHaber += 1;
      haberCentimos += Math.abs(mov.importeCentimos);
    }
  }
  const saldoFinalCentimos = cuenta.saldoInicialCentimos + haberCentimos - debeCentimos;
  return {
    numeroApuntesDebe,
    totalDebe: centimosAEuros(debeCentimos),
    numeroApuntesHaber,
    totalHaber: centimosAEuros(haberCentimos),
    saldoFinal: centimosAEuros(saldoFinalCentimos),
    saldoFinalCentimos,
  };
}

function calcularDescuadres(totales, final) {
  if (!final) return [];
  const descuadres = [];
  const comparar = (nombre, declarado, calculado) => {
    if (declarado == null) return;
    if (declarado !== calculado) descuadres.push({ campo: nombre, declarado, calculado });
  };
  comparar('numeroApuntesDebe', final.numeroApuntesDebe, totales.numeroApuntesDebe);
  comparar('totalDebe', final.totalDebe, totales.totalDebe);
  comparar('numeroApuntesHaber', final.numeroApuntesHaber, totales.numeroApuntesHaber);
  comparar('totalHaber', final.totalHaber, totales.totalHaber);
  if (final.saldoFinalCentimos != null) {
    comparar('saldoFinal', final.saldoFinal, totales.saldoFinal);
  }
  return descuadres;
}

/**
 * Parsea un fichero Norma 43.
 * @param {Buffer|Uint8Array} contenido
 * @returns {ResultadoN43}
 */
export function parsearN43(contenido) {
  const bruto = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido ?? []);
  /** @type {ResultadoN43} */
  const resultado = {
    codificacion: 'utf-8',
    hashFichero: hashFichero(bruto),
    totalRegistros: 0,
    finFichero: null,
    cuentas: [],
    errores: [],
    avisos: [],
  };

  const { texto, codificacion } = decodificar(bruto);
  resultado.codificacion = codificacion;

  const anotarError = (linea, tipo, motivo) => resultado.errores.push({ linea, tipo, motivo });
  const anotarAviso = (linea, tipo, motivo) => resultado.avisos.push({ linea, tipo, motivo });

  /** @type {CuentaN43|null} */
  let cuenta = null;
  /**
   * Ordinales por cuenta, fecha de operación e importe, con alcance de fichero
   * entero. No se reinicia al abrir un registro 11 porque una misma cuenta puede
   * aparecer en varios bloques del mismo fichero: contando por bloque, dos
   * apuntes idénticos repartidos entre ellos recibirían el mismo ordinal, la
   * misma huella, y el segundo se descartaría como duplicado.
   * @type {Map<string, number>}
   */
  const ordinales = new Map();
  /** @type {MovimientoN43|null} */
  let movimiento = null;
  /** Un movimiento descartado se recuerda para no marcar sus 23/24 como huérfanos. */
  let movimientoDescartado = false;

  const cerrarCuenta = (final) => {
    if (!cuenta) return;
    cuenta.final = final ?? null;
    cuenta.totales = calcularTotales(cuenta);
    cuenta.descuadres = calcularDescuadres(cuenta.totales, cuenta.final);
    cuenta = null;
    movimiento = null;
    movimientoDescartado = false;
  };

  for (const registro of trocearRegistros(texto)) {
    if (registro.motivo) {
      anotarError(registro.linea, '', registro.motivo);
      continue;
    }
    const linea = registro.linea;
    const reg = registro.texto;
    resultado.totalRegistros += 1;
    const tipo = campo(reg, 1, 2);

    if (resultado.finFichero) {
      anotarAviso(linea, tipo, 'Registro posterior al fin de fichero (88)');
    }

    switch (tipo) {
      case '11': {
        if (cuenta) {
          anotarAviso(linea, '11', 'La cuenta anterior no trae registro 33 de cierre');
          cerrarCuenta(null);
        }
        const entidad = campo(reg, 3, 6);
        const oficina = campo(reg, 7, 10);
        const numeroCuenta = campo(reg, 11, 20);
        const fechaInicial = parsearFechaAammdd(campo(reg, 21, 26));
        const fechaFinal = parsearFechaAammdd(campo(reg, 27, 32));
        const clave = parsearClaveSigno(campo(reg, 33, 33));
        const importe = parsearImporteCentimos(campo(reg, 34, 47));
        const cuentaIban = construirIbanN43({ entidad, oficina, numeroCuenta });

        if (!fechaInicial.ok) anotarError(linea, '11', `Fecha inicial: ${fechaInicial.motivo}`);
        if (!fechaFinal.ok) anotarError(linea, '11', `Fecha final: ${fechaFinal.motivo}`);
        if (!clave.ok) anotarError(linea, '11', `Saldo inicial: ${clave.motivo}`);
        if (!importe.ok) anotarError(linea, '11', `Saldo inicial: ${importe.motivo}`);
        if (!cuentaIban.valido) {
          anotarAviso(linea, '11', `No se pudo construir un IBAN válido: ${cuentaIban.motivo}`);
        }

        const saldoInicialCentimos = clave.ok && importe.ok
          ? aplicarSigno(importe.centimos, clave.factor)
          : 0;

        cuenta = {
          linea,
          entidad,
          oficina,
          numeroCuenta,
          ccc: cuentaIban.ccc,
          iban: cuentaIban.iban,
          ibanValido: cuentaIban.valido,
          fechaInicial: fechaInicial.iso,
          fechaFinal: fechaFinal.iso,
          claveSaldoInicial: clave.clave,
          saldoInicial: centimosAEuros(saldoInicialCentimos),
          saldoInicialCentimos,
          divisa: limpiarTexto(campo(reg, 48, 50)),
          modalidad: limpiarTexto(campo(reg, 51, 51)),
          nombreAbreviado: limpiarTexto(campo(reg, 52, 77)),
          movimientos: [],
          final: null,
          totales: null,
          descuadres: [],
        };
        movimiento = null;
        movimientoDescartado = false;
        resultado.cuentas.push(cuenta);
        break;
      }

      case '22': {
        movimiento = null;
        movimientoDescartado = false;
        if (!cuenta) {
          anotarError(linea, '22', 'Movimiento sin cabecera de cuenta (registro 11) previa');
          movimientoDescartado = true;
          break;
        }
        const fechaOperacion = parsearFechaAammdd(campo(reg, 11, 16));
        const fechaValor = parsearFechaAammdd(campo(reg, 17, 22));
        const clave = parsearClaveSigno(campo(reg, 28, 28));
        const importe = parsearImporteCentimos(campo(reg, 29, 42));

        const fallos = [];
        if (!fechaOperacion.ok) fallos.push(`Fecha de operación: ${fechaOperacion.motivo}`);
        if (!clave.ok) fallos.push(clave.motivo);
        if (!importe.ok) fallos.push(importe.motivo);
        if (fallos.length) {
          anotarError(linea, '22', fallos.join('; '));
          movimientoDescartado = true;
          break;
        }
        if (!fechaValor.ok) {
          anotarAviso(linea, '22', `Fecha valor: ${fechaValor.motivo}. Se usa la de operación`);
        }

        const importeCentimos = aplicarSigno(importe.centimos, clave.factor);
        // Sin IBAN válido se usa el CCC para que dos cuentas del mismo fichero
        // no compartan huella ni ordinal.
        const claveCuenta = cuenta.iban || cuenta.ccc;
        // El ordinal cuenta dentro del grupo de apuntes idénticos (misma cuenta,
        // fecha e importe), no dentro del día entero: así no depende del orden
        // en que el fichero los liste. Los extractos en Excel vienen del más
        // reciente al más antiguo y el Norma 43 al revés, de modo que contando
        // por día el mismo apunte recibiría un número distinto según el formato
        // y acabaría guardado dos veces.
        const claveOrdinal = `${claveCuenta}|${fechaOperacion.iso}|${importeCentimos}`;
        const ordinal = (ordinales.get(claveOrdinal) ?? 0) + 1;
        ordinales.set(claveOrdinal, ordinal);

        movimiento = {
          linea,
          entidadOrigen: campo(reg, 3, 6),
          oficinaOrigen: campo(reg, 7, 10),
          fechaOperacion: fechaOperacion.iso,
          fechaValor: fechaValor.ok ? fechaValor.iso : fechaOperacion.iso,
          conceptoComun: campo(reg, 23, 24),
          conceptoPropio: campo(reg, 25, 27),
          clave: clave.clave,
          signo: clave.signo,
          importe: centimosAEuros(importeCentimos),
          importeCentimos,
          numeroDocumento: limpiarTexto(campo(reg, 43, 52)),
          referencia1: limpiarTexto(campo(reg, 53, 64)),
          referencia2: limpiarTexto(campo(reg, 65, 80)),
          conceptosComplementarios: [],
          equivalencias: [],
          conceptoTexto: '',
          conceptoNormalizado: '',
          nif: '',
          ordinal,
          movementHash: '',
        };
        // BBVA no manda registro 23 en la mayoría de apuntes: mete la
        // descripción en las posiciones de referencia, partida en dos campos
        // ("ADEUDO DE IB" + "ERDROLA"). Sin este respaldo, casi todos los
        // movimientos llegarían sin concepto y no habría nada que conciliar.
        // Los registros 23, cuando llegan, lo sustituyen por ser más completos.
        const conceptoReferencias = normalizarConcepto(campo(reg, 53, 64) + campo(reg, 65, 80));
        movimiento.conceptoTexto = conceptoReferencias.conceptoTexto;
        movimiento.conceptoNormalizado = conceptoReferencias.conceptoNormalizado;
        movimiento.nif = conceptoReferencias.nif;

        movimiento.movementHash = hashMovimiento({
          cuenta: claveCuenta,
          fechaOperacion: movimiento.fechaOperacion,
          importeCentimos: movimiento.importeCentimos,
          ordinal: movimiento.ordinal,
        });
        cuenta.movimientos.push(movimiento);
        break;
      }

      case '23': {
        if (!movimiento) {
          if (!movimientoDescartado) {
            anotarError(linea, '23', 'Concepto complementario sin movimiento (registro 22) previo');
          }
          break;
        }
        if (movimiento.conceptosComplementarios.length >= MAX_CONCEPTOS_COMPLEMENTARIOS) {
          anotarAviso(linea, '23', `El movimiento supera los ${MAX_CONCEPTOS_COMPLEMENTARIOS} conceptos complementarios`);
        }
        const crudo = campo(reg, 5, 42) + campo(reg, 43, 80);
        movimiento.conceptosComplementarios.push({
          codigoDato: campo(reg, 3, 4),
          texto: limpiarTexto(crudo),
          crudo,
        });
        const concepto = normalizarConcepto(
          movimiento.conceptosComplementarios.map((c) => c.crudo),
        );
        movimiento.conceptoTexto = concepto.conceptoTexto;
        movimiento.conceptoNormalizado = concepto.conceptoNormalizado;
        movimiento.nif = concepto.nif;
        break;
      }

      case '24': {
        if (!movimiento) {
          if (!movimientoDescartado) {
            anotarError(linea, '24', 'Equivalencia de importe sin movimiento (registro 22) previo');
          }
          break;
        }
        const importe = parsearImporteCentimos(campo(reg, 8, 21));
        if (!importe.ok) {
          anotarError(linea, '24', `Importe equivalente: ${importe.motivo}`);
          break;
        }
        movimiento.equivalencias.push({
          codigoDato: campo(reg, 3, 4),
          divisa: limpiarTexto(campo(reg, 5, 7)),
          importe: centimosAEuros(importe.centimos),
          importeCentimos: importe.centimos,
        });
        break;
      }

      case '33': {
        if (!cuenta) {
          anotarError(linea, '33', 'Final de cuenta sin cabecera (registro 11) previa');
          break;
        }
        const entidad = campo(reg, 3, 6);
        const oficina = campo(reg, 7, 10);
        const numeroCuenta = campo(reg, 11, 20);
        if (entidad !== cuenta.entidad || oficina !== cuenta.oficina || numeroCuenta !== cuenta.numeroCuenta) {
          anotarAviso(linea, '33', 'El final de cuenta no coincide con la cabecera de cuenta abierta');
        }
        const numeroApuntesDebe = contador(campo(reg, 21, 25), 5);
        const totalDebe = parsearImporteCentimos(campo(reg, 26, 39));
        const numeroApuntesHaber = contador(campo(reg, 40, 44), 5);
        const totalHaber = parsearImporteCentimos(campo(reg, 45, 58));
        const clave = parsearClaveSigno(campo(reg, 59, 59));
        const saldoFinal = parsearImporteCentimos(campo(reg, 60, 73));

        if (numeroApuntesDebe == null) anotarError(linea, '33', 'Nº de apuntes al debe no numérico');
        if (!totalDebe.ok) anotarError(linea, '33', `Total debe: ${totalDebe.motivo}`);
        if (numeroApuntesHaber == null) anotarError(linea, '33', 'Nº de apuntes al haber no numérico');
        if (!totalHaber.ok) anotarError(linea, '33', `Total haber: ${totalHaber.motivo}`);
        if (!clave.ok) anotarError(linea, '33', `Saldo final: ${clave.motivo}`);
        if (!saldoFinal.ok) anotarError(linea, '33', `Saldo final: ${saldoFinal.motivo}`);

        const saldoFinalCentimos = clave.ok && saldoFinal.ok
          ? aplicarSigno(saldoFinal.centimos, clave.factor)
          : null;

        cerrarCuenta({
          linea,
          entidad,
          oficina,
          numeroCuenta,
          numeroApuntesDebe,
          totalDebe: totalDebe.ok ? centimosAEuros(totalDebe.centimos) : null,
          numeroApuntesHaber,
          totalHaber: totalHaber.ok ? centimosAEuros(totalHaber.centimos) : null,
          claveSaldoFinal: clave.clave,
          saldoFinal: saldoFinalCentimos == null ? null : centimosAEuros(saldoFinalCentimos),
          saldoFinalCentimos,
          divisa: limpiarTexto(campo(reg, 74, 76)),
        });
        break;
      }

      case '88': {
        if (cuenta) {
          anotarAviso(linea, '88', 'El fichero termina sin registro 33 de la última cuenta');
          cerrarCuenta(null);
        }
        if (campo(reg, 3, 20) !== '9'.repeat(18)) {
          anotarAviso(linea, '88', 'El registro de fin de fichero no trae los dieciocho nueves');
        }
        const declarados = contador(campo(reg, 21, 26), 6);
        // Unos emisores cuentan el propio registro 88 y otros no (BBVA lo
        // excluye), así que las dos cifras se dan por buenas. Avisar de la
        // diferencia de uno sería ruido en todos los ficheros de medio banco.
        const cuadra = declarados === resultado.totalRegistros
          || declarados === resultado.totalRegistros - 1;
        if (declarados == null) {
          anotarAviso(linea, '88', 'El nº de registros del fin de fichero no es numérico');
        } else if (!cuadra) {
          anotarAviso(
            linea,
            '88',
            `El fin de fichero declara ${declarados} registros y se han leído ${resultado.totalRegistros}`,
          );
        }
        resultado.finFichero = {
          linea,
          registrosDeclarados: declarados,
          registrosLeidos: resultado.totalRegistros,
          cuadra: declarados != null && cuadra,
        };
        break;
      }

      default:
        anotarError(linea, tipo, `Tipo de registro desconocido ("${tipo}")`);
        break;
    }
  }

  if (cuenta) {
    anotarAviso(cuenta.linea, '11', 'La última cuenta no trae registro 33 de cierre');
    cerrarCuenta(null);
  }
  if (!resultado.finFichero) {
    anotarAviso(resultado.totalRegistros, '88', 'Falta el registro 88 de fin de fichero');
  }

  return resultado;
}
