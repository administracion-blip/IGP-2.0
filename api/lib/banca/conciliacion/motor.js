/**
 * Motor de sugerencias de conciliación bancaria: qué facturas puede estar
 * pagando cada movimiento de un extracto.
 *
 * Funciones **puras**: reciben movimientos y facturas ya cargados y devuelven
 * sugerencias. Nada de Dynamo ni de S3 —eso vive en `store.js` y en el router—,
 * de modo que todo el criterio de emparejamiento se puede probar sin AWS.
 *
 * ## La trampa del modelo de facturas
 *
 * En `Igp_Facturas`, **en los dos tipos**, `emisor_*` es la sociedad del grupo y
 * `empresa_*` la contraparte externa:
 *
 * - `IN` (gasto, la pagamos): `emisor_*` = nuestra sociedad pagadora,
 *   `empresa_*` = el proveedor.
 * - `OUT` (venta, nos la pagan): `emisor_*` = nuestra sociedad emisora,
 *   `empresa_*` = el cliente.
 *
 * O sea: la cuenta bancaria del movimiento (su `empresaId`) se cruza SIEMPRE con
 * `factura.emisor_id`, y el nombre/CIF que se busca en el concepto del extracto
 * es SIEMPRE `empresa_nombre` / `empresa_cif`. Al revés salen emparejamientos
 * absurdos —nuestra propia sociedad como "proveedor" de todo— y encima con
 * aspecto de acierto.
 *
 * ## Cómo puntúa
 *
 * Cada pareja (movimiento, factura) suma los pesos de las señales que casan y de
 * ahí sale un nivel de confianza. El desglose viaja con la sugerencia: un
 * emparejamiento que el usuario no entiende no lo confirma.
 */

import { formatId6 } from '../../usuarioLocales.js';
import { numeroFacturaParaConciliacion } from '../../facturacion/albaranesConciliados.js';
import {
  ESTADO_IGNORADO,
  TOLERANCIA_CENTIMOS,
  conciliableCentimos,
  descartadasDe,
  facturaElegible,
  importeMovimientoCentimos,
  mismoImporte,
  saldoPendienteCentimos,
  signoCompatible,
} from './estado.js';
import {
  PATRONES_EXCLUSION_POR_DEFECTO,
  cifCoincidente,
  nombreCoincidente,
  patronExcluyente,
  referenciaCoincidente,
  referenciasFactura,
  textosMovimiento,
} from './texto.js';

/** Tipos de sugerencia. */
export const TIPO_EXACTA = 'exacta';
export const TIPO_PARCIAL = 'parcial';
export const TIPO_COMBINACION = 'combinacion';

/** Niveles de confianza, de más a menos. */
export const NIVEL_ALTA = 'alta';
export const NIVEL_MEDIA = 'media';
export const NIVEL_BAJA = 'baja';

/**
 * Pesos de las señales, de más a menos fiable.
 *
 * El número de factura en el concepto es la señal reina: en los extractos reales
 * aparece literalmente ("2026FM53 BD417B83 COCTEMAT"). La fecha no confirma
 * nada por sí sola; sirve para desempatar.
 */
export const PESOS = {
  numeroFactura: 60,
  cif: 30,
  importeExacto: 25,
  nombre: 15,
  fecha: 10,
};

export const OPCIONES_POR_DEFECTO = {
  /** Antigüedad máxima de la factura respecto al movimiento. */
  diasAtras: 365,
  /** Margen por si la factura se emite unos días después del cobro/pago. */
  diasMargenPosterior: 5,
  /** A partir de esta distancia en días, la señal de fecha ya no aporta. */
  ventanaFecha: 60,
  maxSugerenciasPorMovimiento: 5,
  maxSugerenciasPorFactura: 5,
  /** Nunca más de 4: la búsqueda de suma exacta está pensada para eso. */
  maxFacturasCombinacion: 4,
  /** Tope defensivo de candidatas que entran en la búsqueda de combinaciones. */
  maxCandidatasCombinacion: 60,
  maxCombinacionesPorMovimiento: 3,
  /** Contrapartes distintas para las que se busca combinación en un movimiento. */
  maxGruposCombinacion: 25,
  /** Puntuación mínima para molestar al usuario con una sugerencia. */
  umbralPuntuacion: 20,
  /** Factor de castigo si no se pudo comprobar la sociedad (IBAN sin dar de alta). */
  factorSinEmpresa: 0.8,
  patronesExclusion: PATRONES_EXCLUSION_POR_DEFECTO,
};

/** Tope de trabajo de la búsqueda de combinaciones: el peor caso no se dispara. */
const MAX_ITERACIONES_COMBINACION = 200000;

const MS_DIA = 86400000;

function aMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Días de `desde` a `hasta` (negativo si `hasta` es anterior), o null. */
function diasEntre(desde, hasta) {
  const a = aMs(desde);
  const b = aMs(hasta);
  if (a == null || b == null) return null;
  return Math.round((b - a) / MS_DIA);
}

/**
 * Compara dos id de empresa. El maestro no los guarda normalizados: el mismo
 * id está unas veces como "7" y otras como "000007" (mismo problema que resuelve
 * `mismaEmpresa` en `lib/dynamo/bankAccounts.js`).
 */
function mismaSociedad(a, b) {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  return formatId6(sa) === formatId6(sb);
}

/** Fecha de la factura contra la que se mide la cercanía: vencimiento y, si no, emisión. */
function fechaReferenciaFactura(factura) {
  return String(factura?.fecha_vencimiento || '').trim() || String(factura?.fecha_emision || '').trim();
}

/** Distancia en días del movimiento a la factura más cercana del grupo. */
function distanciaDias(fechaMovimiento, facturas) {
  let mejor = null;
  for (const factura of facturas) {
    const dias = diasEntre(fechaReferenciaFactura(factura), fechaMovimiento);
    if (dias == null) continue;
    const abs = Math.abs(dias);
    if (mejor == null || abs < Math.abs(mejor)) mejor = dias;
  }
  return mejor;
}

/**
 * ¿Entra la factura en la ventana de fechas del movimiento? Una factura emitida
 * mucho después del apunte no la puede estar pagando ese apunte.
 */
function dentroDeVentana(factura, fechaOperacion, opciones) {
  const dias = diasEntre(factura?.fecha_emision, fechaOperacion);
  if (dias == null) return true; // Sin fecha de emisión no se descarta: decide el resto de señales.
  if (dias < -opciones.diasMargenPosterior) return false;
  return dias <= opciones.diasAtras;
}

/** Contraparte de la factura: el CIF si lo hay y, si no, el nombre. */
function claveContraparte(factura) {
  const cif = String(factura?.empresa_cif || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (cif) return `CIF:${cif}`;
  return `NOM:${String(factura?.empresa_nombre || '').trim().toUpperCase()}`;
}

function degradarNivel(nivel) {
  if (nivel === NIVEL_ALTA) return NIVEL_MEDIA;
  if (nivel === NIVEL_MEDIA) return NIVEL_BAJA;
  return NIVEL_BAJA;
}

/**
 * Puntúa un grupo de facturas contra un movimiento.
 *
 * @param {object} datos
 * @param {Record<string, any>} datos.movimiento
 * @param {import('./texto.js').TextosMovimiento} datos.textos
 * @param {Array<Record<string, any>>} datos.facturas Una factura, o varias si es combinación.
 * @param {boolean} datos.importeExacto
 * @param {boolean} datos.sinEmpresa El movimiento no tiene sociedad con la que cruzar.
 * @param {typeof OPCIONES_POR_DEFECTO} datos.opciones
 * @returns {{ puntuacion: number, nivel: string, senales: object, motivos: string[] }}
 */
export function puntuar({ movimiento, textos, facturas, importeExacto, sinEmpresa, opciones }) {
  const o = { ...OPCIONES_POR_DEFECTO, ...(opciones || {}) };

  let referencia = '';
  for (const factura of facturas) {
    referencia = referenciaCoincidente(referenciasFactura(factura), textos);
    if (referencia) break;
  }

  let cif = '';
  for (const factura of facturas) {
    cif = cifCoincidente(factura?.empresa_cif, movimiento, textos);
    if (cif) break;
  }

  // Las facturas de una combinación son de la misma contraparte, así que basta
  // mirar el nombre de la primera.
  const tokens = facturas.length ? nombreCoincidente(facturas[0]?.empresa_nombre, textos) : [];
  const dias = distanciaDias(movimiento?.fechaOperacion, facturas);

  let puntuacion = 0;
  const motivos = [];
  if (referencia) {
    puntuacion += PESOS.numeroFactura;
    motivos.push(`El número «${referencia}» aparece en el concepto del movimiento`);
  }
  if (cif) {
    puntuacion += PESOS.cif;
    motivos.push(`Coincide el CIF de la contraparte (${cif})`);
  }
  if (importeExacto) {
    puntuacion += PESOS.importeExacto;
    motivos.push(
      facturas.length > 1
        ? 'La suma de los saldos pendientes cuadra exactamente con el movimiento'
        : 'El importe cuadra exactamente con el pendiente de la factura',
    );
  }
  if (tokens.length) {
    puntuacion += PESOS.nombre;
    motivos.push(`El nombre de la contraparte aparece en el concepto (${tokens.join(', ')})`);
  }
  if (dias != null) {
    const cercania = Math.max(0, 1 - Math.abs(dias) / Math.max(1, o.ventanaFecha));
    puntuacion += PESOS.fecha * cercania;
    if (cercania > 0) {
      motivos.push(
        dias === 0
          ? 'El movimiento es del mismo día que el vencimiento'
          : `A ${Math.abs(dias)} día(s) del vencimiento de la factura`,
      );
    }
  }

  let nivel = NIVEL_BAJA;
  if (importeExacto && (cif || referencia)) nivel = NIVEL_ALTA;
  else if (importeExacto && tokens.length) nivel = NIVEL_MEDIA;

  if (sinEmpresa) {
    // El IBAN del extracto no está en el maestro: no se ha podido comprobar que
    // el movimiento sea de la misma sociedad que emite/recibe la factura.
    puntuacion *= o.factorSinEmpresa;
    nivel = degradarNivel(nivel);
    motivos.push('El IBAN del movimiento no está dado de alta: no se ha podido comprobar la sociedad');
  }

  return {
    puntuacion: Math.round(puntuacion * 10) / 10,
    nivel,
    senales: {
      numeroFactura: Boolean(referencia),
      referencia,
      cif: Boolean(cif),
      cifCoincidente: cif,
      importeExacto: Boolean(importeExacto),
      nombre: tokens.length > 0,
      tokensNombre: tokens,
      dias,
      sinEmpresa: Boolean(sinEmpresa),
    },
    motivos,
  };
}

/**
 * Subconjuntos de `valores` que suman exactamente `objetivo` (céntimos enteros).
 *
 * Meet in the middle: se indexan las sumas de todos los pares y con ese mapa se
 * resuelven los subconjuntos de 3 y 4 elementos con una consulta en vez de
 * recorrer el espacio exponencial. Con el tope de candidatas de arriba (60) el
 * mapa tiene ~1.800 entradas.
 *
 * @param {number[]} valores
 * @param {number} objetivo
 * @param {{ maxElementos?: number, maxResultados?: number }} [opciones]
 * @returns {number[][]} Índices de cada combinación, en orden ascendente.
 */
export function buscarCombinaciones(valores, objetivo, opciones = {}) {
  const maxElementos = Math.min(4, Math.max(2, Number(opciones.maxElementos) || 4));
  const maxResultados = Math.max(1, Number(opciones.maxResultados) || 3);
  const lista = (valores || []).map((v) => Math.trunc(Number(v) || 0));
  const total = Math.trunc(Number(objetivo) || 0);
  const resultados = [];
  if (lista.length < 2 || total <= 0) return resultados;

  const vistos = new Set();
  const anadir = (indices) => {
    const orden = [...indices].sort((a, b) => a - b);
    const clave = orden.join('-');
    if (vistos.has(clave)) return;
    vistos.add(clave);
    resultados.push(orden);
  };
  const lleno = () => resultados.length >= maxResultados;

  const pares = new Map();
  for (let i = 0; i < lista.length; i += 1) {
    for (let j = i + 1; j < lista.length; j += 1) {
      const suma = lista[i] + lista[j];
      if (suma > total) continue;
      const previos = pares.get(suma);
      if (previos) previos.push([i, j]);
      else pares.set(suma, [[i, j]]);
    }
  }

  for (const par of pares.get(total) || []) {
    anadir(par);
    if (lleno()) return resultados;
  }

  if (maxElementos >= 3) {
    for (let i = 0; i < lista.length; i += 1) {
      for (const [a, b] of pares.get(total - lista[i]) || []) {
        if (a === i || b === i) continue;
        anadir([i, a, b]);
        if (lleno()) return resultados;
      }
    }
  }

  if (maxElementos >= 4) {
    let iteraciones = 0;
    for (const [suma, izquierdos] of pares) {
      const derechos = pares.get(total - suma);
      if (!derechos) continue;
      for (const izq of izquierdos) {
        for (const der of derechos) {
          iteraciones += 1;
          if (iteraciones > MAX_ITERACIONES_COMBINACION) return resultados;
          if (izq[0] === der[0] || izq[0] === der[1] || izq[1] === der[0] || izq[1] === der[1]) continue;
          anadir([...izq, ...der]);
          if (lleno()) return resultados;
        }
      }
    }
  }

  return resultados;
}

function facturaResumen(factura, asignadoCentimos) {
  const saldo = saldoPendienteCentimos(factura);
  return {
    id_factura: String(factura.id_factura || factura.id_entrada || ''),
    tipo: String(factura.tipo || ''),
    estado: String(factura.estado || ''),
    numero: numeroFacturaParaConciliacion(factura),
    serie: String(factura.serie || ''),
    emisor_id: String(factura.emisor_id || ''),
    emisor_nombre: String(factura.emisor_nombre || ''),
    empresa_nombre: String(factura.empresa_nombre || ''),
    empresa_cif: String(factura.empresa_cif || ''),
    fecha_emision: String(factura.fecha_emision || ''),
    fecha_vencimiento: String(factura.fecha_vencimiento || ''),
    saldoPendienteCentimos: saldo,
    asignadoCentimos,
    restoFacturaCentimos: Math.max(0, saldo - asignadoCentimos),
    pendienteRevision: String(factura.estado) === 'pendiente_revision',
  };
}

/**
 * Descripción del apunte que acompaña a la sugerencia.
 *
 * La sugerencia identifica el movimiento (huella, cuenta, fecha, importes) pero
 * eso no le dice nada al usuario. En `porFactura` las sugerencias viajan sueltas,
 * sin la entrada de `porMovimiento` que las envuelve, así que sin esto el panel
 * del movimiento solo podría pintar «1.076,43 € del 02/02/2026» y nadie confirma
 * una conciliación que no entiende.
 *
 * Los nombres son los del ítem de `Igp_BankMovements` sin tocar: el frontend ya
 * decide con ellos qué enseñar (`beneficiarioMovimiento`, `conceptoCortoMovimiento`)
 * y renombrarlos aquí obligaría a duplicar ese criterio.
 */
function movimientoResumen(movimiento) {
  return {
    concepto: String(movimiento?.concepto || ''),
    conceptoNormalizado: String(movimiento?.conceptoNormalizado || ''),
    nif: String(movimiento?.nif || ''),
    referencia1: String(movimiento?.referencia1 || ''),
    referencia2: String(movimiento?.referencia2 || ''),
    numeroDocumento: String(movimiento?.numeroDocumento || ''),
    empresaId: String(movimiento?.empresaId || ''),
    empresaNombre: String(movimiento?.empresaNombre || ''),
    iban: String(movimiento?.iban || ''),
    fechaValor: String(movimiento?.fechaValor || ''),
    formatoOrigen: String(movimiento?.formatoOrigen || ''),
    nombreFichero: String(movimiento?.nombreFichero || ''),
    estadoConciliacion: String(movimiento?.estadoConciliacion || ''),
  };
}

function construirSugerencia({ movimiento, textos, tipo, facturas, asignaciones, conciliable, importeExacto, sinEmpresa, opciones }) {
  const evaluacion = puntuar({ movimiento, textos, facturas, importeExacto, sinEmpresa, opciones });
  const asignadoTotal = asignaciones.reduce((acc, n) => acc + n, 0);
  const ids = facturas.map((f) => String(f.id_factura || f.id_entrada || ''));
  return {
    clave: `${movimiento.movementHash}:${ids.join('+')}`,
    tipo,
    movementHash: String(movimiento.movementHash || ''),
    cuentaRef: String(movimiento.cuentaRef || ''),
    fechaOperacion: String(movimiento.fechaOperacion || ''),
    movimiento: movimientoResumen(movimiento),
    importeCentimos: importeMovimientoCentimos(movimiento),
    conciliableCentimos: conciliable,
    asignadoCentimos: asignadoTotal,
    restoMovimientoCentimos: Math.max(0, conciliable - asignadoTotal),
    puntuacion: evaluacion.puntuacion,
    nivel: evaluacion.nivel,
    senales: evaluacion.senales,
    motivos: evaluacion.motivos,
    facturas: facturas.map((f, i) => facturaResumen(f, asignaciones[i])),
  };
}

const ORDEN_TIPO = { [TIPO_EXACTA]: 0, [TIPO_COMBINACION]: 1, [TIPO_PARCIAL]: 2 };

function compararSugerencias(a, b) {
  if (b.puntuacion !== a.puntuacion) return b.puntuacion - a.puntuacion;
  const orden = (ORDEN_TIPO[a.tipo] ?? 9) - (ORDEN_TIPO[b.tipo] ?? 9);
  if (orden !== 0) return orden;
  const diasA = Math.abs(a.senales?.dias ?? 9999);
  const diasB = Math.abs(b.senales?.dias ?? 9999);
  if (diasA !== diasB) return diasA - diasB;
  return String(a.clave).localeCompare(String(b.clave));
}

/**
 * Combinaciones de varias facturas de la misma contraparte cuya suma de saldos
 * es exactamente el importe libre del movimiento.
 */
function combinacionesDelMovimiento({ movimiento, textos, candidatas, conciliable, sinEmpresa, opciones }) {
  const grupos = new Map();
  for (const factura of candidatas) {
    const saldo = saldoPendienteCentimos(factura);
    // Una factura que ya llega sola al importe no forma combinación: es exacta.
    if (saldo <= 0 || saldo >= conciliable) continue;
    const clave = `${formatId6(factura.emisor_id)}|${claveContraparte(factura)}`;
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(factura);
    else grupos.set(clave, [factura]);
  }

  const utiles = [...grupos.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, opciones.maxGruposCombinacion);

  const sugerencias = [];
  for (const grupo of utiles) {
    // Recorte determinista: por saldo descendente y, a igualdad, por fecha.
    const ordenado = [...grupo].sort((a, b) => {
      const d = saldoPendienteCentimos(b) - saldoPendienteCentimos(a);
      if (d !== 0) return d;
      return String(a.fecha_emision || '').localeCompare(String(b.fecha_emision || ''));
    });
    const acotado = ordenado.slice(0, opciones.maxCandidatasCombinacion);
    const combinaciones = buscarCombinaciones(
      acotado.map((f) => saldoPendienteCentimos(f)),
      conciliable,
      {
        maxElementos: opciones.maxFacturasCombinacion,
        maxResultados: opciones.maxCombinacionesPorMovimiento,
      },
    );
    for (const indices of combinaciones) {
      const facturas = indices.map((i) => acotado[i]);
      sugerencias.push(construirSugerencia({
        movimiento,
        textos,
        tipo: TIPO_COMBINACION,
        facturas,
        asignaciones: facturas.map((f) => saldoPendienteCentimos(f)),
        conciliable,
        importeExacto: true,
        sinEmpresa,
        opciones,
      }));
    }
    if (sugerencias.length >= opciones.maxCombinacionesPorMovimiento) break;
  }
  return sugerencias;
}

/**
 * @typedef {object} EntradaMovimiento
 * @property {string} movementHash
 * @property {string} cuentaRef
 * @property {string} fechaOperacion
 * @property {number} importeCentimos
 * @property {number} conciliableCentimos
 * @property {boolean} excluido Descartado por una regla de concepto.
 * @property {string} patronExclusion Patrón que lo descartó ('' si ninguno).
 * @property {boolean} ignorado Marcado a mano como "no es una factura".
 * @property {number} candidatas Facturas que pasaron los filtros previos.
 * @property {object[]} sugerencias
 */

/**
 * Sugerencias de un solo movimiento.
 *
 * @param {object} datos
 * @param {Record<string, any>} datos.movimiento Ítem de `Igp_BankMovements`.
 * @param {Array<Record<string, any>>} datos.facturas Facturas candidatas (de cualquier tipo).
 * @param {Partial<typeof OPCIONES_POR_DEFECTO>} [datos.opciones]
 * @returns {EntradaMovimiento}
 */
export function sugerirParaMovimiento({ movimiento, facturas, opciones }) {
  const o = { ...OPCIONES_POR_DEFECTO, ...(opciones || {}) };
  const textos = textosMovimiento(movimiento);
  const importeCentimos = importeMovimientoCentimos(movimiento);
  const conciliable = conciliableCentimos(movimiento);
  const base = {
    movementHash: String(movimiento?.movementHash || ''),
    cuentaRef: String(movimiento?.cuentaRef || ''),
    fechaOperacion: String(movimiento?.fechaOperacion || ''),
    concepto: String(movimiento?.concepto || ''),
    empresaId: String(movimiento?.empresaId || ''),
    importeCentimos,
    conciliableCentimos: conciliable,
    estadoConciliacion: String(movimiento?.estadoConciliacion || ''),
    excluido: false,
    patronExclusion: '',
    ignorado: String(movimiento?.estadoConciliacion || '') === ESTADO_IGNORADO,
    candidatas: 0,
    sugerencias: [],
  };

  if (base.ignorado) return base;

  const patron = patronExcluyente(textos, o.patronesExclusion);
  if (patron) return { ...base, excluido: true, patronExclusion: patron };
  if (conciliable <= TOLERANCIA_CENTIMOS) return base;

  const descartadas = new Set(descartadasDe(movimiento));
  const sinEmpresa = !String(movimiento?.empresaId || '').trim();

  const candidatas = (facturas || []).filter((factura) => {
    if (!factura) return false;
    const id = String(factura.id_factura || factura.id_entrada || '');
    if (!id || descartadas.has(id)) return false;
    if (!facturaElegible(factura)) return false;
    if (!signoCompatible(factura.tipo, importeCentimos)) return false;
    if (!sinEmpresa && !mismaSociedad(movimiento.empresaId, factura.emisor_id)) return false;
    return dentroDeVentana(factura, base.fechaOperacion, o);
  });

  const sugerencias = [];
  for (const factura of candidatas) {
    const saldo = saldoPendienteCentimos(factura);
    const exacta = mismoImporte(saldo, conciliable);
    // Se asigna lo que quepa: puede quedarse corta la factura (pago parcial) o
    // sobrar importe en el movimiento (conciliación parcial del movimiento, que
    // negocio permite a propósito). Nunca más que el pendiente de la factura,
    // aunque el movimiento cuadre "exactamente" dentro de la tolerancia de un
    // céntimo: ese céntimo de más no se puede registrar como pago, y proponerlo
    // solo lleva a una asignación que la validación rechaza. El céntimo que sobra
    // en el movimiento entra igual en la tolerancia de `derivarEstado`, así que
    // el apunte sigue quedando `conciliado`.
    const asignado = Math.min(saldo, conciliable);
    if (asignado <= 0) continue;
    sugerencias.push(construirSugerencia({
      movimiento,
      textos,
      tipo: exacta ? TIPO_EXACTA : TIPO_PARCIAL,
      facturas: [factura],
      asignaciones: [asignado],
      conciliable,
      importeExacto: exacta,
      sinEmpresa,
      opciones: o,
    }));
  }

  sugerencias.push(...combinacionesDelMovimiento({
    movimiento,
    textos,
    candidatas,
    conciliable,
    sinEmpresa,
    opciones: o,
  }));

  const utiles = sugerencias
    .filter((s) => s.puntuacion >= o.umbralPuntuacion)
    .sort(compararSugerencias)
    .slice(0, o.maxSugerenciasPorMovimiento);

  return { ...base, candidatas: candidatas.length, sugerencias: utiles };
}

/**
 * Barrido completo: sugerencias de un conjunto de movimientos contra un conjunto
 * de facturas, indexadas por movimiento y por factura.
 *
 * El índice por factura es lo que consume el listado de facturas para pintar el
 * icono de "tiene un cobro/pago candidato".
 *
 * @param {object} datos
 * @param {Array<Record<string, any>>} datos.movimientos
 * @param {Array<Record<string, any>>} datos.facturas
 * @param {Partial<typeof OPCIONES_POR_DEFECTO>} [datos.opciones]
 * @returns {{ porMovimiento: EntradaMovimiento[],
 *   porFactura: Array<{ id_factura: string, sugerencias: object[] }>,
 *   totales: { movimientos: number, movimientosConSugerencias: number,
 *     movimientosExcluidos: number, facturasElegibles: number, sugerencias: number } }}
 */
export function sugerirConciliaciones({ movimientos, facturas, opciones } = {}) {
  const o = { ...OPCIONES_POR_DEFECTO, ...(opciones || {}) };
  const elegibles = (facturas || []).filter(facturaElegible);

  const porMovimiento = (movimientos || []).map((movimiento) => sugerirParaMovimiento({
    movimiento,
    facturas: elegibles,
    opciones: o,
  }));

  const indice = new Map();
  let sugerencias = 0;
  for (const entrada of porMovimiento) {
    sugerencias += entrada.sugerencias.length;
    for (const sugerencia of entrada.sugerencias) {
      for (const factura of sugerencia.facturas) {
        const lista = indice.get(factura.id_factura);
        if (lista) lista.push(sugerencia);
        else indice.set(factura.id_factura, [sugerencia]);
      }
    }
  }

  const porFactura = [...indice.entries()].map(([id_factura, lista]) => {
    const ordenadas = [...lista].sort(compararSugerencias).slice(0, o.maxSugerenciasPorFactura);
    return {
      id_factura,
      mejorNivel: ordenadas[0]?.nivel || NIVEL_BAJA,
      mejorPuntuacion: ordenadas[0]?.puntuacion || 0,
      sugerencias: ordenadas,
    };
  }).sort((a, b) => b.mejorPuntuacion - a.mejorPuntuacion);

  return {
    porMovimiento,
    porFactura,
    totales: {
      movimientos: porMovimiento.length,
      movimientosConSugerencias: porMovimiento.filter((m) => m.sugerencias.length > 0).length,
      movimientosExcluidos: porMovimiento.filter((m) => m.excluido).length,
      facturasElegibles: elegibles.length,
      sugerencias,
    },
  };
}
