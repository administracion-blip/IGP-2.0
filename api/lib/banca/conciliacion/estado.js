/**
 * Estado de conciliación de un movimiento bancario y aritmética en céntimos.
 *
 * **Todo se compara en céntimos enteros.** Un extracto y una factura que "valen
 * lo mismo" pueden no ser iguales en coma flotante (`0.1 + 0.2 !== 0.3`), y un
 * emparejamiento que falla por 1e-15 es imposible de explicar al usuario.
 *
 * `estadoConciliacion` es la clave HASH del GSI `Estado-FechaOperacion-index`:
 * cambiarla mueve el ítem de partición en el índice. Es correcto —así se listan
 * los pendientes sin recorrer la tabla— pero significa que el estado no es un
 * campo cualquiera y no se debe escribir con valores fuera de esta lista.
 *
 * Módulo puro: no toca Dynamo.
 */

/** Nada asignado todavía. */
export const ESTADO_PENDIENTE = 'pendiente';
/** Parte del importe está ligada a facturas y el resto sigue libre. */
export const ESTADO_PARCIAL = 'parcial';
/** Todo el importe está ligado a facturas. */
export const ESTADO_CONCILIADO = 'conciliado';
/** No es una factura (comisión, traspaso, nómina): lo marca el usuario. */
export const ESTADO_IGNORADO = 'ignorado';

export const ESTADOS_CONCILIACION = [
  ESTADO_PENDIENTE,
  ESTADO_PARCIAL,
  ESTADO_CONCILIADO,
  ESTADO_IGNORADO,
];

/** Estados que aún pueden recibir sugerencias. */
export const ESTADOS_ABIERTOS = [ESTADO_PENDIENTE, ESTADO_PARCIAL];

/**
 * Por debajo de un céntimo dos importes son el mismo. Los redondeos de IVA y de
 * retención dejan restos de 1 céntimo en las facturas, y sin tolerancia esas
 * facturas quedarían "pendientes" para siempre.
 */
export const TOLERANCIA_CENTIMOS = 1;

/**
 * Estados de factura que entran en la conciliación.
 *
 * `pendiente_revision` entra a propósito (decisión de negocio): son facturas de
 * gasto recién pasadas por OCR que muchas veces se pagan antes de revisarlas.
 * Quedan fuera `borrador`, `anulada`, `pagada` y `cobrada`.
 */
export const ESTADOS_FACTURA_ELEGIBLES = new Set([
  // Gasto (IN)
  'pendiente_revision',
  'pendiente_pago',
  'parcialmente_pagada',
  // Venta (OUT)
  'emitida',
  'parcialmente_cobrada',
  // Ambas
  'vencida',
]);

/** Euros → céntimos enteros. */
export function euroACentimos(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Céntimos → euros, para devolver al frontend. */
export function centimosAEuro(centimos) {
  return Math.trunc(Number(centimos) || 0) / 100;
}

function entero(valor) {
  return Math.trunc(Number(valor) || 0);
}

/** Saldo pendiente de la factura en céntimos (con el signo que tenga). */
export function saldoPendienteCentimos(factura) {
  if (factura?.saldo_pendiente != null && factura.saldo_pendiente !== '') {
    return euroACentimos(factura.saldo_pendiente);
  }
  return euroACentimos(factura?.total_factura) - euroACentimos(factura?.total_cobrado);
}

/**
 * Importe del movimiento en céntimos, con signo (negativo = cargo).
 * `importeCentimos` es el campo bueno; `importe` es el respaldo para ítems
 * antiguos que se guardaran sin él.
 */
export function importeMovimientoCentimos(movimiento) {
  const centimos = entero(movimiento?.importeCentimos);
  if (centimos !== 0) return centimos;
  return euroACentimos(movimiento?.importe);
}

/** Cuánto del movimiento está ya asignado a facturas. */
export function asignadoCentimos(movimiento) {
  return Math.max(0, entero(movimiento?.conciliadoCentimos));
}

/** Importe del movimiento que queda libre, en valor absoluto. */
export function conciliableCentimos(movimiento) {
  const total = Math.abs(importeMovimientoCentimos(movimiento));
  return Math.max(0, total - asignadoCentimos(movimiento));
}

/** Conciliaciones ya aplicadas (los ítems antiguos no tienen el atributo). */
export function conciliacionesDe(movimiento) {
  return Array.isArray(movimiento?.conciliaciones) ? movimiento.conciliaciones : [];
}

/** Facturas que el usuario ha dicho que NO son de este movimiento. */
export function descartadasDe(movimiento) {
  const lista = movimiento?.sugerenciasDescartadas;
  return Array.isArray(lista) ? lista.map((id) => String(id)) : [];
}

/** ¿Puede esta factura recibir el pago de un movimiento? */
export function facturaElegible(factura) {
  if (!factura) return false;
  if (!ESTADOS_FACTURA_ELEGIBLES.has(String(factura.estado || ''))) return false;
  return saldoPendienteCentimos(factura) > TOLERANCIA_CENTIMOS;
}

/**
 * Una factura de gasto (IN) la pagamos: solo casa con un cargo. Una de venta
 * (OUT) nos la pagan: solo con un abono.
 */
export function signoCompatible(tipo, importeCentimos) {
  const centimos = entero(importeCentimos);
  if (centimos === 0) return false;
  return String(tipo) === 'IN' ? centimos < 0 : centimos > 0;
}

/** ¿Son iguales dos importes en céntimos, dentro de la tolerancia? */
export function mismoImporte(a, b) {
  return Math.abs(entero(a) - entero(b)) <= TOLERANCIA_CENTIMOS;
}

/**
 * Estado que le corresponde a un movimiento según lo asignado.
 * `ignorado` no se deriva: lo pone el usuario y manda sobre el resto.
 *
 * @param {{ importeCentimos: number, asignadoCentimos: number, ignorado?: boolean }} datos
 * @returns {string}
 */
export function derivarEstado({ importeCentimos, asignadoCentimos: asignado, ignorado = false }) {
  if (ignorado) return ESTADO_IGNORADO;
  const total = Math.abs(entero(importeCentimos));
  const puesto = Math.max(0, entero(asignado));
  if (puesto <= 0) return ESTADO_PENDIENTE;
  if (puesto + TOLERANCIA_CENTIMOS >= total) return ESTADO_CONCILIADO;
  return ESTADO_PARCIAL;
}

function leerFactura(facturas, id) {
  if (!facturas) return null;
  if (typeof facturas.get === 'function') return facturas.get(id) || null;
  return facturas[id] || null;
}

/** Clave con la que se identifica una conciliación dentro del movimiento. */
function claveConciliacion(entrada) {
  return `${String(entrada?.id_factura || '')}#${String(entrada?.id_pago || '')}`;
}

/**
 * Comprueba lo que se quiere aplicar de un movimiento a unas facturas.
 *
 * Distingue entre lo que impide aplicar (`errores`) y lo que solo hay que
 * contarle al usuario (`avisos`): pagar una factura que todavía está en
 * `pendiente_revision` está permitido —lo decidió negocio— pero la pantalla
 * tiene que poder advertirlo.
 *
 * @param {object} datos
 * @param {Record<string, any>} datos.movimiento
 * @param {Array<{ id_factura: string, importe?: number, importeCentimos?: number }>} datos.asignaciones
 * @param {Map<string, object>|Record<string, object>} datos.facturas Facturas por id.
 * @returns {{ ok: boolean, errores: object[], avisos: object[], conciliableCentimos: number,
 *   sumaCentimos: number, asignaciones: Array<{ id_factura: string, centimos: number, factura: object }> }}
 */
export function validarAsignaciones({ movimiento, asignaciones, facturas }) {
  const errores = [];
  const avisos = [];
  const salida = [];
  const disponible = conciliableCentimos(movimiento);
  const lista = Array.isArray(asignaciones) ? asignaciones : [];

  if (lista.length === 0) {
    errores.push({
      code: 'SIN_ASIGNACIONES',
      mensaje: 'Indica al menos una factura a la que aplicar el movimiento',
    });
  }
  if (disponible <= 0) {
    errores.push({
      code: 'MOVIMIENTO_SIN_IMPORTE_LIBRE',
      mensaje: 'El movimiento ya está conciliado por completo',
    });
  }

  const vistas = new Set();
  let suma = 0;

  for (const asignacion of lista) {
    const id = String(asignacion?.id_factura || '').trim();
    if (!id) {
      errores.push({ code: 'FACTURA_REQUERIDA', mensaje: 'Falta el id de la factura en una asignación' });
      continue;
    }
    if (vistas.has(id)) {
      errores.push({
        code: 'FACTURA_DUPLICADA',
        id_factura: id,
        mensaje: 'La misma factura aparece dos veces en la asignación',
      });
      continue;
    }
    vistas.add(id);

    const factura = leerFactura(facturas, id);
    if (!factura) {
      errores.push({ code: 'FACTURA_NO_ENCONTRADA', id_factura: id, mensaje: 'Factura no encontrada' });
      continue;
    }

    const centimos = asignacion?.importeCentimos != null && asignacion.importeCentimos !== ''
      ? entero(asignacion.importeCentimos)
      : euroACentimos(asignacion?.importe);
    if (centimos <= 0) {
      errores.push({
        code: 'IMPORTE_INVALIDO',
        id_factura: id,
        mensaje: 'El importe asignado debe ser mayor que 0',
      });
      continue;
    }

    if (!ESTADOS_FACTURA_ELEGIBLES.has(String(factura.estado || ''))) {
      errores.push({
        code: 'ESTADO_NO_CONCILIABLE',
        id_factura: id,
        mensaje: `Una factura en estado «${factura.estado || 'sin estado'}» no se puede conciliar`,
      });
      continue;
    }

    // Sin tolerancia a propósito: `registrarPagoFactura` corta en el pendiente
    // exacto, así que admitir aquí un céntimo de más solo consigue que la
    // asignación pase la validación y reviente al registrar el pago, y el usuario
    // reciba un 409 técnico en vez de este error claro.
    const saldo = saldoPendienteCentimos(factura);
    if (centimos > saldo) {
      errores.push({
        code: 'IMPORTE_SUPERA_SALDO',
        id_factura: id,
        mensaje: `El importe asignado (${centimosAEuro(centimos)}) supera el pendiente de la factura (${centimosAEuro(saldo)})`,
      });
      continue;
    }

    // Bloquea, no avisa: un cargo no puede pagar una factura de venta ni un abono
    // una de gasto, y registrar ese pago mueve el saldo de la factura en el
    // sentido contrario al del dinero. El motor ya filtra por signo, así que solo
    // se llega llamando al endpoint a mano. Los abonos (notas de crédito) no son
    // la excepción: nacen con saldo negativo, no son elegibles y se liquidan por
    // el flujo de compensación, no por aquí.
    if (!signoCompatible(factura.tipo, importeMovimientoCentimos(movimiento))) {
      errores.push({
        code: 'SIGNO_INCOMPATIBLE',
        id_factura: id,
        mensaje: factura.tipo === 'IN'
          ? 'Una factura de gasto se paga con un cargo, y este movimiento es un abono'
          : 'Una factura de venta se cobra con un abono, y este movimiento es un cargo',
      });
      continue;
    }
    if (String(factura.estado) === 'pendiente_revision') {
      avisos.push({
        code: 'FACTURA_PENDIENTE_REVISION',
        id_factura: id,
        mensaje: 'La factura todavía está pendiente de revisión',
      });
    }

    suma += centimos;
    salida.push({ id_factura: id, centimos, factura });
  }

  if (suma > disponible + TOLERANCIA_CENTIMOS) {
    errores.push({
      code: 'SUMA_SUPERA_CONCILIABLE',
      mensaje: `La suma asignada (${centimosAEuro(suma)}) supera el importe libre del movimiento (${centimosAEuro(disponible)})`,
    });
  }

  return {
    ok: errores.length === 0,
    errores,
    avisos,
    conciliableCentimos: disponible,
    sumaCentimos: suma,
    asignaciones: salida,
  };
}

/**
 * Une las conciliaciones que ya tenía el movimiento con las nuevas y recalcula
 * el total asignado.
 *
 * El total se recalcula **desde el array**, no sumando al contador anterior: con
 * reintentos y fallos parciales el contador se desincroniza en cuanto se suma a
 * ciegas, y entonces el estado del movimiento deja de cuadrar con sus pagos.
 * La clave es factura+pago, así que un reintento idempotente (mismo pago) no
 * cuenta dos veces.
 *
 * @param {object[]} existentes
 * @param {object[]} nuevas
 * @returns {{ conciliaciones: object[], asignadoCentimos: number, anadidas: object[] }}
 */
export function fusionarConciliaciones(existentes, nuevas) {
  const conciliaciones = [];
  const anadidas = [];
  const vistas = new Set();

  for (const entrada of [...(existentes || []), ...(nuevas || [])]) {
    if (!entrada?.id_factura) continue;
    const clave = claveConciliacion(entrada);
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    conciliaciones.push(entrada);
    if ((nuevas || []).includes(entrada)) anadidas.push(entrada);
  }

  const total = conciliaciones.reduce((acc, c) => acc + Math.max(0, entero(c.importeCentimos)), 0);
  return { conciliaciones, asignadoCentimos: total, anadidas };
}

/**
 * Quita una conciliación del movimiento (deshacer) y recalcula el total.
 * @param {object[]} existentes
 * @param {{ id_factura: string, id_pago?: string }} objetivo
 */
export function quitarConciliacion(existentes, { id_factura, id_pago } = {}) {
  const id = String(id_factura || '');
  const pago = String(id_pago || '');
  const quitadas = [];
  const conciliaciones = (existentes || []).filter((c) => {
    const coincide = String(c?.id_factura || '') === id
      && (!pago || String(c?.id_pago || '') === pago);
    if (coincide) quitadas.push(c);
    return !coincide;
  });
  const total = conciliaciones.reduce((acc, c) => acc + Math.max(0, entero(c.importeCentimos)), 0);
  return { conciliaciones, asignadoCentimos: total, quitadas };
}
