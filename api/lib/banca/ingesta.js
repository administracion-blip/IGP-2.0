/**
 * Ingesta de extractos bancarios: idempotente por fichero y por movimiento.
 *
 * Trabaja solo sobre el `ExtractoCanonico` (ver `canonico.js`): no sabe si el
 * fichero era Norma 43, un Excel de Santander o un CSV de BBVA.
 *
 * Los pasos de entrada/salida (Dynamo, S3) entran por `deps` para poder probar
 * la orquestación sin AWS.
 */

import { getCuentaByIban } from '../dynamo/bankAccounts.js';
import { rangoFechasMovimientos } from './canonico.js';
import {
  ESTADO_FICHERO_CARGADO,
  ESTADO_FICHERO_EN_CURSO,
  ESTADO_FICHERO_PENDIENTE_CUENTA,
  ESTADO_PENDIENTE,
  escribirMovimientos,
  getFicheroCarga,
  movimientosEnRango,
  pkCuenta,
  putFicheroCarga,
  putFicheroCargaSiNueva,
  skMovimiento,
} from './store.js';

/** Tope de incidencias que se guardan en el resumen: un fichero roto puede generar cientos y el ítem tiene 400 KB. */
const MAX_INCIDENCIAS_GUARDADAS = 100;

function texto(val) {
  return val != null ? String(val).trim() : '';
}

function recortar(lista) {
  const arr = lista || [];
  return { lista: arr.slice(0, MAX_INCIDENCIAS_GUARDADAS), truncada: arr.length > MAX_INCIDENCIAS_GUARDADAS };
}

/**
 * Construye el ítem de `Igp_BankMovements` a partir de un movimiento canónico.
 *
 * OJO con `empresaId`: cuando el IBAN del extracto no está dado de alta en
 * `Igp_BankAccounts` el atributo **no se escribe**. DynamoDB no indexa los ítems
 * a los que les falta la clave de un GSI, así que esos movimientos se guardan
 * igual pero quedan fuera de `EmpresaId-FechaOperacion-index` hasta que se les
 * asigne cuenta (`asignarEmpresaAMovimientos`). No lo "arregles" poniendo
 * `empresaId: ''`: eso sí indexa, y llenaría el índice de basura bajo una
 * partición vacía.
 *
 * @param {object} datos
 * @param {import('./canonico.js').MovimientoCanonico} datos.movimiento
 * @param {string} [datos.empresaId]
 * @param {string} [datos.empresaNombre]
 * @param {string} datos.hashFichero
 * @param {string} [datos.nombreFichero]
 * @param {string} datos.formato
 * @param {string} datos.importadoEn
 * @param {string} [datos.importadoPor]
 * @returns {Record<string, any>}
 */
export function construirItemMovimiento({
  movimiento,
  empresaId,
  empresaNombre,
  hashFichero,
  nombreFichero,
  formato,
  importadoEn,
  importadoPor,
}) {
  const empresa = texto(empresaId);
  return {
    PK: pkCuenta(movimiento.cuentaRef),
    SK: skMovimiento(movimiento.fechaOperacion, movimiento.movementHash),
    movementHash: texto(movimiento.movementHash),
    cuentaRef: texto(movimiento.cuentaRef),
    iban: texto(movimiento.iban),
    ...(empresa ? { empresaId: empresa } : {}),
    empresaNombre: texto(empresaNombre),
    fechaOperacion: texto(movimiento.fechaOperacion),
    fechaValor: texto(movimiento.fechaValor),
    importe: Number(movimiento.importe) || 0,
    importeCentimos: Math.trunc(Number(movimiento.importeCentimos) || 0),
    signo: movimiento.signo === 'D' ? 'D' : 'H',
    concepto: texto(movimiento.concepto),
    conceptoNormalizado: texto(movimiento.conceptoNormalizado),
    nif: texto(movimiento.nif),
    referencia1: texto(movimiento.referencia1),
    referencia2: texto(movimiento.referencia2),
    numeroDocumento: texto(movimiento.numeroDocumento),
    conceptoComun: texto(movimiento.conceptoComun),
    conceptoPropio: texto(movimiento.conceptoPropio),
    divisa: texto(movimiento.divisa),
    ordinal: Number(movimiento.ordinal) || 0,
    estadoConciliacion: ESTADO_PENDIENTE,
    // Arranca a cero para que el estado del movimiento se pueda derivar siempre
    // de lo asignado (ver `conciliacion/estado.js`). `conciliaciones` y
    // `sugerenciasDescartadas` no se escriben hasta que hay algo que guardar.
    conciliadoCentimos: 0,
    hashFichero: texto(hashFichero),
    nombreFichero: texto(nombreFichero),
    formatoOrigen: texto(formato),
    lineaOrigen: Number(movimiento.lineaOrigen) || 0,
    importadoEn: texto(importadoEn),
    importadoPor: texto(importadoPor),
  };
}

/**
 * ¿La cuenta ya tiene movimientos guardados dentro del rango que trae el fichero?
 *
 * No es lo mismo que la idempotencia por movimiento y hace falta igual: el
 * `ordinal` que forma parte de la huella se numera dentro de cada fichero, así
 * que dos extractos que se solapen a mitad de un día pueden numerar distinto el
 * mismo apunte —el que en un fichero es el 1º del día en el otro es el 3º—,
 * salir con huellas distintas y colarse dos veces pese al Put condicional. Por
 * eso, si hay solapamiento no se importa: decide el usuario.
 *
 * @param {object} datos
 * @param {string} datos.cuentaRef
 * @param {string} [datos.iban]
 * @param {string} datos.desde
 * @param {string} datos.hasta
 * @param {Array<Record<string, any>>} datos.movimientosExistentes
 * @returns {{ solapa: boolean, cuentaRef: string, iban: string, desde: string, hasta: string,
 *   movimientosExistentes: number, cargas: Array<{ hashFichero: string, nombreFichero: string, movimientos: number }> }}
 */
export function detectarSolapamiento({ cuentaRef, iban, desde, hasta, movimientosExistentes }) {
  const dentro = (movimientosExistentes || []).filter((mov) => {
    const fecha = texto(mov?.fechaOperacion);
    return fecha && fecha >= texto(desde) && fecha <= texto(hasta);
  });

  const porCarga = new Map();
  for (const mov of dentro) {
    const clave = texto(mov.hashFichero);
    const previo = porCarga.get(clave) || {
      hashFichero: clave,
      nombreFichero: texto(mov.nombreFichero),
      movimientos: 0,
    };
    previo.movimientos += 1;
    porCarga.set(clave, previo);
  }

  return {
    solapa: dentro.length > 0,
    cuentaRef: texto(cuentaRef),
    iban: texto(iban),
    desde: texto(desde),
    hasta: texto(hasta),
    movimientosExistentes: dentro.length,
    cargas: [...porCarga.values()].sort((a, b) => b.movimientos - a.movimientos),
  };
}

/**
 * Resumen de la carga a partir de lo escrito cuenta por cuenta.
 * @param {object} datos
 * @param {import('./canonico.js').ExtractoCanonico} datos.extracto
 * @param {Array<Record<string, any>>} datos.cuentas Resultado por cuenta (con nuevos/duplicados).
 * @returns {Record<string, any>}
 */
export function construirResumen({
  extracto,
  cuentas,
  nombreFichero,
  tamanoBytes,
  s3Key,
  importadoEn,
  importadoPor,
  confirmado,
}) {
  const errores = recortar(extracto.errores);
  const avisos = recortar(extracto.avisos);
  const totales = cuentas.reduce(
    (acc, c) => ({
      leidos: acc.leidos + c.movimientos,
      nuevos: acc.nuevos + c.nuevos,
      duplicados: acc.duplicados + c.duplicados,
    }),
    { leidos: 0, nuevos: 0, duplicados: 0 },
  );
  const pendienteCuenta = cuentas.some((c) => c.pendienteAsignar);

  return {
    hashFichero: texto(extracto.hashFichero),
    nombreFichero: texto(nombreFichero),
    formato: texto(extracto.formato),
    codificacion: texto(extracto.codificacion),
    estado: pendienteCuenta ? ESTADO_FICHERO_PENDIENTE_CUENTA : ESTADO_FICHERO_CARGADO,
    s3Key: texto(s3Key),
    tamanoBytes: Number(tamanoBytes) || 0,
    importadoEn: texto(importadoEn),
    importadoPor: texto(importadoPor),
    importadoConSolapamiento: confirmado === true,
    movimientosLeidos: totales.leidos,
    movimientosNuevos: totales.nuevos,
    movimientosDuplicados: totales.duplicados,
    lineasConError: (extracto.errores || []).length,
    avisosTotal: (extracto.avisos || []).length,
    errores: errores.lista,
    erroresTruncados: errores.truncada,
    avisos: avisos.lista,
    avisosTruncados: avisos.truncada,
    cuentas: cuentas.map((c) => ({
      cuentaRef: c.cuentaRef,
      iban: c.iban,
      ccc: c.ccc,
      ibanValido: c.ibanValido,
      titular: c.titular,
      divisa: c.divisa,
      empresaId: c.empresaId,
      empresaNombre: c.empresaNombre,
      pendienteAsignar: c.pendienteAsignar,
      fechaDesde: c.fechaDesde,
      fechaHasta: c.fechaHasta,
      saldoInicial: c.saldoInicial,
      saldoFinal: c.saldoFinal,
      movimientos: c.movimientos,
      nuevos: c.nuevos,
      duplicados: c.duplicados,
      descuadres: c.descuadres,
    })),
  };
}

const depsPorDefecto = {
  getCuentaByIban,
  getFicheroCarga,
  movimientosEnRango,
  escribirMovimientos,
  putFicheroCargaSiNueva,
  putFicheroCarga,
};

/**
 * Resuelve la empresa de cada cuenta del extracto contra el maestro de cuentas.
 * Un IBAN que no está de alta no es un error: los movimientos se guardan sin
 * empresa y la carga queda `pendiente_cuenta`.
 */
async function resolverCuentas(extracto, deps) {
  const salida = [];
  for (const cuenta of extracto.cuentas || []) {
    const maestro = cuenta.iban ? await deps.getCuentaByIban(cuenta.iban) : null;
    const { desde, hasta } = rangoFechasMovimientos(cuenta.movimientos);
    salida.push({
      cuenta,
      cuentaRef: cuenta.cuentaRef,
      iban: cuenta.iban,
      ccc: cuenta.ccc,
      ibanValido: cuenta.ibanValido,
      titular: cuenta.titular,
      divisa: cuenta.divisa,
      empresaId: texto(maestro?.empresaId),
      empresaNombre: texto(maestro?.empresaNombre),
      pendienteAsignar: !texto(maestro?.empresaId),
      fechaDesde: desde,
      fechaHasta: hasta,
      saldoInicial: Number(cuenta.saldoInicial) || 0,
      saldoFinal: cuenta.saldoFinal ?? null,
      descuadres: cuenta.descuadres || [],
      movimientos: (cuenta.movimientos || []).length,
      nuevos: 0,
      duplicados: 0,
    });
  }
  return salida;
}

/**
 * Ingesta un extracto canónico.
 *
 * @param {object} entrada
 * @param {import('./canonico.js').ExtractoCanonico} entrada.extracto
 * @param {string} [entrada.nombreFichero]
 * @param {number} [entrada.tamanoBytes]
 * @param {string} [entrada.usuario]
 * @param {boolean} [entrada.confirmar] Importar aunque haya solapamiento.
 * @param {() => Promise<string>} [entrada.guardarOriginal] Sube el fichero y devuelve la key de S3.
 * @param {Partial<typeof depsPorDefecto>} [deps]
 * @returns {Promise<{ ok: true, yaCargado: boolean, carga: Record<string, any> }
 *   | { ok: false, code: 'SOLAPAMIENTO', solapamientos: Array<Record<string, any>> }>}
 */
export async function ingestarExtracto({
  extracto,
  nombreFichero,
  tamanoBytes,
  usuario,
  confirmar = false,
  guardarOriginal,
}, deps = {}) {
  const d = { ...depsPorDefecto, ...deps };

  // Idempotencia por fichero: el mismo fichero no se reprocesa nunca. Se
  // devuelve el resumen de la primera carga, no uno recalculado. La excepción es
  // una carga que se quedó a medias: esa se reanuda.
  const previa = await d.getFicheroCarga(extracto.hashFichero);
  const reanudando = previa?.estado === ESTADO_FICHERO_EN_CURSO;
  if (previa && !reanudando) return { ok: true, yaCargado: true, carga: previa };

  const cuentas = await resolverCuentas(extracto, d);

  // Al reanudar, los movimientos que hay en el rango los escribió el intento
  // anterior de este mismo fichero: avisar de solapamiento sería acusar al
  // fichero de pisarse a sí mismo. Los Put condicionales los dan por duplicados.
  const solapamientos = [];
  if (!reanudando) {
    for (const c of cuentas) {
      if (!c.fechaDesde) continue;
      const existentes = await d.movimientosEnRango(c.cuentaRef, c.fechaDesde, c.fechaHasta);
      const solapamiento = detectarSolapamiento({
        cuentaRef: c.cuentaRef,
        iban: c.iban,
        desde: c.fechaDesde,
        hasta: c.fechaHasta,
        movimientosExistentes: existentes,
      });
      if (solapamiento.solapa) solapamientos.push(solapamiento);
    }
    if (solapamientos.length > 0 && !confirmar) {
      return { ok: false, code: 'SOLAPAMIENTO', solapamientos };
    }
  }

  const importadoEn = texto(previa?.importadoEn) || new Date().toISOString();
  const importadoPor = texto(usuario);

  // La ficha se reserva ANTES de escribir apuntes. Si el proceso se corta a
  // mitad, el reintento encuentra la reserva y se reanuda; al revés (escribir
  // primero) quedarían movimientos huérfanos sin carga que los explique y el
  // siguiente intento los denunciaría como solapamiento de otro fichero.
  if (!reanudando) {
    const { creado, existente } = await d.putFicheroCargaSiNueva({
      hashFichero: texto(extracto.hashFichero),
      nombreFichero: texto(nombreFichero),
      formato: texto(extracto.formato),
      estado: ESTADO_FICHERO_EN_CURSO,
      tamanoBytes: Number(tamanoBytes) || 0,
      importadoEn,
      importadoPor,
    });
    // Otra petición se adelantó con el mismo fichero entre el Get y el Put.
    if (!creado && existente && existente.estado !== ESTADO_FICHERO_EN_CURSO) {
      return { ok: true, yaCargado: true, carga: existente };
    }
  }

  const s3Key = texto(previa?.s3Key) || (guardarOriginal ? await guardarOriginal() : '');

  for (const c of cuentas) {
    const items = (c.cuenta.movimientos || []).map((movimiento) => construirItemMovimiento({
      movimiento,
      empresaId: c.empresaId,
      empresaNombre: c.empresaNombre,
      hashFichero: extracto.hashFichero,
      nombreFichero,
      formato: extracto.formato,
      importadoEn,
      importadoPor,
    }));
    const escrito = await d.escribirMovimientos(items);
    c.nuevos = escrito.nuevos;
    c.duplicados = escrito.duplicados;
  }

  const carga = construirResumen({
    extracto,
    cuentas,
    nombreFichero,
    tamanoBytes,
    s3Key,
    importadoEn,
    importadoPor,
    confirmado: confirmar === true && solapamientos.length > 0,
  });

  await d.putFicheroCarga(carga);
  return { ok: true, yaCargado: false, carga };
}
