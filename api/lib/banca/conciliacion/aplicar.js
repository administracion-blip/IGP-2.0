/**
 * Aplicar y deshacer conciliaciones: de una sugerencia aceptada a un pago real.
 *
 * El pago se registra siempre con `registrarPagoFactura` —la misma función que
 * usan las remesas y el alta manual— con una **clave de idempotencia**
 * `banca:{movementHash}:{id_factura}`. De ahí salen dos garantías que este
 * módulo da por hechas: reintentar es seguro, y aplicar dos veces el mismo
 * movimiento a la misma factura es imposible.
 *
 * Los pasos de entrada/salida entran por `deps` para poder probar la
 * orquestación sin AWS, igual que en `lib/banca/ingesta.js`.
 */

import { registrarPagoFactura } from '../../facturacion/registrarPago.js';
import { eliminarPagoFactura } from '../../facturacion/eliminarPago.js';
import { findRemesaActivaDeFactura } from '../../remesas/facturaEnRemesa.js';
import {
  ESTADO_IGNORADO,
  TOLERANCIA_CENTIMOS,
  asignadoCentimos,
  centimosAEuro,
  conciliacionesDe,
  derivarEstado,
  euroACentimos,
  fusionarConciliaciones,
  importeMovimientoCentimos,
  quitarConciliacion,
  saldoPendienteCentimos,
  validarAsignaciones,
} from './estado.js';
import {
  CODIGO_CONFLICTO_MOVIMIENTO,
  descartarSugerencia,
  getFactura,
  getMovimiento,
  guardarConciliacion,
  guardarEstadoMovimiento,
} from './store.js';

/** Un extracto bancario es, por definición, una transferencia o un recibo. */
const METODO_PAGO_POR_DEFECTO = 'transferencia';

/** Tope de la observación automática: el concepto de un N43 puede ser larguísimo. */
const MAX_OBSERVACIONES = 200;

/**
 * Intentos de la escritura del movimiento, contando el primero.
 *
 * Cada reintento resuelve una escritura ajena colada en medio. Cuatro cubre de
 * sobra el caso real (dos o tres personas conciliando a la vez) y pone un techo:
 * si no entra, es que algo está escribiendo en bucle y hay que enterarse, no
 * seguir insistiendo.
 */
const MAX_INTENTOS_GUARDADO = 4;

/** Códigos de resultado y su traducción a HTTP, para que el router no la invente. */
export const HTTP_POR_CODIGO = {
  OK: 200,
  /** Algo se aplicó y algo falló: el cliente tiene que ver las dos listas. */
  PARCIAL: 207,
  NADA_APLICADO: 409,
  VALIDACION: 400,
  MOVIMIENTO_NO_ENCONTRADO: 404,
  MOVIMIENTO_IGNORADO: 409,
  MOVIMIENTO_CON_CONCILIACIONES: 409,
  CONCILIACION_NO_ENCONTRADA: 404,
  /** Fuera del alcance del usuario: se responde como si no existiera. */
  FACTURA_NO_ENCONTRADA: 404,
  /** Otra persona escribió el movimiento a la vez y no se pudo cuadrar. */
  CONFLICTO_MOVIMIENTO: 409,
};

const depsPorDefecto = {
  getMovimiento,
  getFactura,
  buscarRemesaActiva: findRemesaActivaDeFactura,
  registrarPago: registrarPagoFactura,
  eliminarPago: eliminarPagoFactura,
  guardarConciliacion,
  guardarEstadoMovimiento,
  descartarSugerencia,
};

function texto(val) {
  return val != null ? String(val).trim() : '';
}

/** Clave de idempotencia del pago de un movimiento a una factura. */
export function claveIdempotencia(movementHash, idFactura) {
  return `banca:${texto(movementHash)}:${texto(idFactura)}`;
}

function datosUsuario(usuario) {
  return {
    usuario_id: texto(usuario?.id),
    usuario_nombre: texto(usuario?.nombre) || texto(usuario?.id),
  };
}

function esConflicto(err) {
  // Se acepta el error crudo del SDK además del propio: así un doble de test o
  // una llamada que no pase por `store.js` se tratan igual.
  return err?.code === CODIGO_CONFLICTO_MOVIMIENTO || err?.name === 'ConditionalCheckFailedException';
}

/**
 * Escribe las conciliaciones del movimiento resolviendo la carrera con quien
 * escriba a la vez.
 *
 * La escritura va condicionada a que `conciliadoCentimos` siga como se leyó. Si
 * no, se relee el movimiento y se recalcula sobre lo que haya ahora. Reintentar
 * es seguro porque a estas alturas los pagos ya existen: `recalcular` parte
 * siempre del array recién leído y deduplica por factura+pago, así que la
 * operación es conmutativa e idempotente y converge al conjunto real de
 * conciliaciones, se apliquen en el orden que se apliquen.
 *
 * @param {object} datos
 * @param {Record<string, any>} datos.movimiento
 * @param {(existentes: object[]) => { conciliaciones: object[], asignadoCentimos: number }} datos.recalcular
 * @param {string} [datos.usuario]
 * @param {typeof depsPorDefecto} datos.d
 * @returns {Promise<{ ok: boolean, movimiento: object, conciliaciones?: object[],
 *   asignadoCentimos?: number, estado?: string, intentos: number, conflicto?: boolean, error?: Error }>}
 */
async function guardarConReintento({ movimiento, recalcular, usuario, d }) {
  let actual = movimiento;

  for (let intento = 1; intento <= MAX_INTENTOS_GUARDADO; intento += 1) {
    const calculo = recalcular(conciliacionesDe(actual));
    const estado = derivarEstado({
      importeCentimos: importeMovimientoCentimos(actual),
      asignadoCentimos: calculo.asignadoCentimos,
    });
    try {
      const guardado = await d.guardarConciliacion({
        movimiento: actual,
        conciliaciones: calculo.conciliaciones,
        conciliadoCentimos: calculo.asignadoCentimos,
        estadoConciliacion: estado,
        esperadoCentimos: asignadoCentimos(actual),
        usuario,
      });
      return {
        ok: true,
        movimiento: guardado || actual,
        conciliaciones: calculo.conciliaciones,
        asignadoCentimos: calculo.asignadoCentimos,
        estado,
        intentos: intento,
      };
    } catch (err) {
      const conflicto = esConflicto(err);
      if (!conflicto || intento === MAX_INTENTOS_GUARDADO) {
        return { ok: false, conflicto, error: err, movimiento: actual, intentos: intento };
      }
      const releido = await d.getMovimiento(actual.cuentaRef, actual.movementHash, {
        fechaOperacion: actual.fechaOperacion,
      });
      // Si el movimiento ha desaparecido, insistir no lo va a traer de vuelta.
      if (!releido) return { ok: false, conflicto, error: err, movimiento: actual, intentos: intento };
      actual = releido;
    }
  }

  return { ok: false, conflicto: true, movimiento: actual, intentos: MAX_INTENTOS_GUARDADO };
}

/** Estado del movimiento tal y como se devuelve al cliente. */
function resumenMovimiento(movimiento, { conciliaciones, asignado, estado } = {}) {
  const total = importeMovimientoCentimos(movimiento);
  const puesto = asignado != null ? asignado : asignadoCentimos(movimiento);
  const lista = conciliaciones || conciliacionesDe(movimiento);
  return {
    movementHash: texto(movimiento?.movementHash),
    cuentaRef: texto(movimiento?.cuentaRef),
    fechaOperacion: texto(movimiento?.fechaOperacion),
    concepto: texto(movimiento?.concepto),
    importe: centimosAEuro(total),
    importeCentimos: total,
    estadoConciliacion: estado || texto(movimiento?.estadoConciliacion),
    conciliado: centimosAEuro(puesto),
    conciliadoCentimos: puesto,
    libre: centimosAEuro(Math.max(0, Math.abs(total) - puesto)),
    libreCentimos: Math.max(0, Math.abs(total) - puesto),
    conciliaciones: lista,
  };
}

/**
 * Aplica un movimiento a una o varias facturas.
 *
 * Si una asignación falla no se aborta en silencio: se aplica lo que se puede, se
 * devuelve qué falló y el movimiento queda con el estado que le corresponde
 * según lo realmente aplicado. Reintentar la parte fallida es seguro gracias a la
 * clave de idempotencia.
 *
 * El caso real de fallo por factura es la que está metida en una remesa activa
 * (`FACTURA_EN_REMESA`): se comprueba aquí, porque `registrarPagoFactura` no lo
 * hace y por esta vía se colaba el pago de una factura que la remesa va a pagar
 * otra vez —y que después no se puede deshacer, porque el borrado del pago sí
 * está bloqueado mientras la remesa siga activa.
 *
 * @param {object} entrada
 * @param {string} entrada.cuentaRef
 * @param {string} entrada.movementHash
 * @param {string} [entrada.fechaOperacion] Camino rápido para localizar el movimiento.
 * @param {Array<{ id_factura: string, importe?: number, importeCentimos?: number }>} entrada.asignaciones
 * @param {string} [entrada.fecha] Fecha del pago (por defecto, la del movimiento).
 * @param {string} [entrada.metodo_pago]
 * @param {string} [entrada.referencia]
 * @param {string} [entrada.observaciones]
 * @param {{ id?: string, nombre?: string }} [entrada.usuario]
 * @param {Partial<typeof depsPorDefecto>} [deps]
 */
export async function aplicarConciliacion({
  cuentaRef,
  movementHash,
  fechaOperacion,
  asignaciones,
  fecha,
  metodo_pago,
  referencia,
  observaciones,
  usuario,
}, deps = {}) {
  const d = { ...depsPorDefecto, ...deps };

  const movimiento = await d.getMovimiento(cuentaRef, movementHash, { fechaOperacion });
  if (!movimiento) {
    return { ok: false, code: 'MOVIMIENTO_NO_ENCONTRADO', mensaje: 'Movimiento bancario no encontrado' };
  }
  if (texto(movimiento.estadoConciliacion) === ESTADO_IGNORADO) {
    return {
      ok: false,
      code: 'MOVIMIENTO_IGNORADO',
      mensaje: 'El movimiento está marcado como ignorado: quítale la marca antes de conciliarlo',
    };
  }

  const facturas = new Map();
  for (const asignacion of asignaciones || []) {
    const id = texto(asignacion?.id_factura);
    if (!id || facturas.has(id)) continue;
    const factura = await d.getFactura(id);
    if (factura) facturas.set(id, factura);
  }

  // Lo que ya está aplicado se aparta antes de validar. Sin esto, reintentar
  // una petición que falló a medias es imposible: la parte que sí se aplicó dejó
  // su factura sin saldo y su importe fuera del libre del movimiento, así que la
  // validación tumbaría toda la petición y la parte que faltaba no se aplicaría
  // nunca.
  const existentes = conciliacionesDe(movimiento);
  const yaAplicadas = [];
  const pendientes = [];
  for (const asignacion of asignaciones || []) {
    const id = texto(asignacion?.id_factura);
    const previa = id ? existentes.find((c) => texto(c?.id_factura) === id) : null;
    if (previa) yaAplicadas.push({ asignacion, previa });
    else pendientes.push(asignacion);
  }

  const validacion = pendientes.length === 0 && yaAplicadas.length > 0
    ? { ok: true, errores: [], avisos: [], asignaciones: [] }
    : validarAsignaciones({ movimiento, asignaciones: pendientes, facturas });
  if (!validacion.ok) {
    return {
      ok: false,
      code: 'VALIDACION',
      mensaje: validacion.errores[0]?.mensaje || 'La asignación no es válida',
      errores: validacion.errores,
      avisos: validacion.avisos,
      movimiento: resumenMovimiento(movimiento),
    };
  }

  const { usuario_id, usuario_nombre } = datosUsuario(usuario);
  const fechaPago = texto(fecha) || texto(movimiento.fechaOperacion);
  const metodo = texto(metodo_pago) || METODO_PAGO_POR_DEFECTO;
  const referenciaPago = texto(referencia)
    || texto(movimiento.referencia1)
    || texto(movimiento.numeroDocumento);
  const observacionesPago = texto(observaciones)
    || `Conciliación bancaria ${texto(movimiento.fechaOperacion)} · ${texto(movimiento.concepto)}`
      .slice(0, MAX_OBSERVACIONES);

  const aplicadas = [];
  const fallidas = [];
  const nuevas = [];
  const avisos = [...validacion.avisos];
  const ahora = new Date().toISOString();

  for (const { asignacion, previa } of yaAplicadas) {
    const idFactura = texto(asignacion.id_factura);
    const factura = facturas.get(idFactura);
    const centimos = Math.trunc(Number(previa.importeCentimos) || 0);
    aplicadas.push({
      id_factura: idFactura,
      id_pago: texto(previa.id_pago),
      importe: centimosAEuro(centimos),
      importeCentimos: centimos,
      idempotente: true,
      estadoFactura: texto(factura?.estado),
      saldoPendiente: Number(factura?.saldo_pendiente) || 0,
    });
    const pedido = asignacion?.importeCentimos != null && asignacion.importeCentimos !== ''
      ? Math.trunc(Number(asignacion.importeCentimos) || 0)
      : euroACentimos(asignacion?.importe);
    if (pedido > 0 && pedido !== centimos) {
      avisos.push({
        code: 'ASIGNACION_YA_APLICADA',
        id_factura: idFactura,
        mensaje: `Este movimiento ya se aplicó a la factura por ${centimosAEuro(centimos)} €: `
          + 'para cambiar el importe hay que deshacer la conciliación primero',
      });
    }
  }

  for (const asignacion of validacion.asignaciones) {
    const { id_factura: idFactura, centimos, factura } = asignacion;
    const remesaActiva = await d.buscarRemesaActiva(idFactura);
    if (remesaActiva) {
      fallidas.push({
        id_factura: idFactura,
        code: 'FACTURA_EN_REMESA',
        status: 409,
        mensaje: `Esta factura está en la remesa «${texto(remesaActiva.nombre) || texto(remesaActiva.remesaId)}»`,
        remesaActiva,
      });
      continue;
    }
    try {
      const resultado = await d.registrarPago({
        id_factura: idFactura,
        fecha: fechaPago,
        importe: centimosAEuro(centimos),
        metodo_pago: metodo,
        referencia: referenciaPago,
        observaciones: observacionesPago,
        usuario_id,
        usuario_nombre,
        importeMaximo: centimosAEuro(saldoPendienteCentimos(factura)),
        idempotencyKey: claveIdempotencia(movementHash, idFactura),
        banca_movement_hash: texto(movementHash),
        banca_cuenta_ref: texto(cuentaRef),
      });

      const pago = resultado?.pago || {};
      // En un reintento idempotente vale el importe del pago que ya existía, no
      // el que se pidió: es el que de verdad está en la factura.
      const importeCentimos = euroACentimos(pago.importe != null ? pago.importe : centimosAEuro(centimos));
      aplicadas.push({
        id_factura: idFactura,
        id_pago: texto(pago.id_pago),
        importe: centimosAEuro(importeCentimos),
        importeCentimos,
        idempotente: resultado?.idempotent === true,
        estadoFactura: texto(resultado?.factura?.estado),
        saldoPendiente: Number(resultado?.factura?.saldo_pendiente) || 0,
      });
      nuevas.push({
        id_factura: idFactura,
        id_pago: texto(pago.id_pago),
        importeCentimos,
        fecha: texto(pago.fecha) || fechaPago,
        usuario: usuario_nombre || usuario_id,
        creadoEn: ahora,
      });
    } catch (err) {
      fallidas.push({
        id_factura: idFactura,
        code: err?.code || 'ERROR_PAGO',
        status: Number(err?.status) || 500,
        mensaje: err?.message || 'No se ha podido registrar el pago',
        ...(err?.remesaActiva && { remesaActiva: err.remesaActiva }),
      });
    }
  }

  const fusion = fusionarConciliaciones(existentes, nuevas);
  const estado = derivarEstado({
    importeCentimos: importeMovimientoCentimos(movimiento),
    asignadoCentimos: fusion.asignadoCentimos,
  });

  // Solo se escribe si hay algo nuevo que escribir: un reintento en el que todo
  // estaba ya aplicado no toca el movimiento.
  const debeGuardar = fusion.anadidas.length > 0 || estado !== texto(movimiento.estadoConciliacion);
  const guardado = debeGuardar
    ? await guardarConReintento({
      movimiento,
      recalcular: (previas) => fusionarConciliaciones(previas, nuevas),
      usuario: usuario_nombre || usuario_id,
      d,
    })
    : {
      ok: true,
      movimiento,
      conciliaciones: fusion.conciliaciones,
      asignadoCentimos: asignadoCentimos(movimiento),
      estado: texto(movimiento.estadoConciliacion),
      intentos: 0,
    };

  if (!guardado.ok) {
    // Los pagos ya están creados: callarlo sería lo peor que se puede hacer aquí.
    // Y no se promete que reintentar lo arregle: la factura ya está cobrada, así
    // que la misma petición no pasaría la validación. Lo que queda pendiente es
    // apuntar el pago en el movimiento, y eso se reconstruye desde
    // `Igp_FacturasPagos` por `banca_movement_hash`.
    return {
      ok: false,
      code: 'CONFLICTO_MOVIMIENTO',
      mensaje: guardado.conflicto
        ? 'Los pagos se han registrado, pero no se ha podido anotar la conciliación en el movimiento '
          + 'porque otra persona lo estaba cambiando a la vez. Revisa el movimiento en banca.'
        : 'Los pagos se han registrado, pero no se ha podido anotar la conciliación en el movimiento. '
          + 'Revisa el movimiento en banca.',
      aplicadas,
      fallidas,
      avisos,
      intentos: guardado.intentos,
      movimiento: resumenMovimiento(guardado.movimiento),
    };
  }

  // Puede acabar aplicado más de lo que vale el movimiento: dos personas
  // conciliando el mismo apunte a la vez crean cada una su pago, y la fusión los
  // conserva a los dos porque ya existen y no se pueden anular solos. Nada más lo
  // dice —`derivarEstado` devuelve `conciliado` y el libre se clampa a 0—, así
  // que el exceso viaja como aviso para que la pantalla pueda señalarlo.
  const totalMovimiento = Math.abs(importeMovimientoCentimos(guardado.movimiento));
  const asignadoFinal = Math.max(0, Math.trunc(Number(guardado.asignadoCentimos) || 0));
  const excesoCentimos = asignadoFinal - totalMovimiento;
  if (excesoCentimos > TOLERANCIA_CENTIMOS) {
    avisos.push({
      code: 'MOVIMIENTO_SOBREASIGNADO',
      excesoCentimos,
      exceso: centimosAEuro(excesoCentimos),
      mensaje: `Las conciliaciones de este movimiento suman ${centimosAEuro(asignadoFinal)} € sobre un `
        + `importe de ${centimosAEuro(totalMovimiento)} €: hay ${centimosAEuro(excesoCentimos)} € aplicados `
        + 'de más. Deshaz la conciliación que sobre.',
    });
  }

  let code = 'OK';
  if (fallidas.length > 0) code = aplicadas.length > 0 ? 'PARCIAL' : 'NADA_APLICADO';

  return {
    ok: code === 'OK',
    code,
    aplicadas,
    fallidas,
    avisos,
    movimiento: resumenMovimiento(guardado.movimiento, {
      conciliaciones: guardado.conciliaciones,
      asignado: guardado.asignadoCentimos,
      estado: guardado.estado,
    }),
  };
}

/**
 * Deshace una conciliación: borra el pago que creó y devuelve el importe al
 * movimiento. El borrado del pago (y el recálculo del estado de la factura) es
 * el mismo que usa el detalle de la factura.
 *
 * @param {object} entrada
 * @param {string} entrada.cuentaRef
 * @param {string} entrada.movementHash
 * @param {string} [entrada.fechaOperacion]
 * @param {string} entrada.id_factura
 * @param {string} [entrada.id_pago] Si no viene, se deshace el pago que tenga apuntado el movimiento.
 * @param {{ id?: string, nombre?: string }} [entrada.usuario]
 * @param {Partial<typeof depsPorDefecto>} [deps]
 */
export async function deshacerConciliacion({
  cuentaRef,
  movementHash,
  fechaOperacion,
  id_factura,
  id_pago,
  usuario,
}, deps = {}) {
  const d = { ...depsPorDefecto, ...deps };
  const idFactura = texto(id_factura);
  const idPago = texto(id_pago);

  const movimiento = await d.getMovimiento(cuentaRef, movementHash, { fechaOperacion });
  if (!movimiento) {
    return { ok: false, code: 'MOVIMIENTO_NO_ENCONTRADO', mensaje: 'Movimiento bancario no encontrado' };
  }

  const existentes = conciliacionesDe(movimiento);
  const objetivo = existentes.find((c) => texto(c?.id_factura) === idFactura
    && (!idPago || texto(c?.id_pago) === idPago));
  if (!objetivo) {
    return {
      ok: false,
      code: 'CONCILIACION_NO_ENCONTRADA',
      mensaje: 'Este movimiento no tiene ninguna conciliación con esa factura',
    };
  }

  // La factura se lee por `getFactura`, que es donde el router mete el alcance de
  // sociedades del usuario: una factura fuera de su alcance no existe para él, y
  // deshacer su pago tampoco.
  const facturaObjetivo = await d.getFactura(idFactura);
  if (!facturaObjetivo) {
    return { ok: false, code: 'FACTURA_NO_ENCONTRADA', mensaje: 'Factura no encontrada' };
  }

  const { usuario_id, usuario_nombre } = datosUsuario(usuario);
  let factura = null;
  try {
    const borrado = await d.eliminarPago({
      id_factura: idFactura,
      id_pago: texto(objetivo.id_pago),
      factura: facturaObjetivo,
      usuario_id,
      usuario_nombre,
      accionAuditoria: 'eliminar_pago',
      detalleAuditoria: { origen: 'conciliacion_bancaria', movementHash: texto(movementHash) },
    });
    factura = borrado?.factura || null;
  } catch (err) {
    return {
      ok: false,
      code: err?.code || 'ERROR_BORRADO_PAGO',
      status: Number(err?.status) || 500,
      mensaje: err?.message || 'No se ha podido eliminar el pago',
      ...(err?.remesaActiva && { remesaActiva: err.remesaActiva }),
    };
  }

  const deshecha = { id_factura: idFactura, id_pago: texto(objetivo.id_pago) };
  // El pago ya está borrado, así que quitarlo del array es una reparación: si en
  // medio entra otra conciliación, se relee y se vuelve a quitar sobre lo nuevo.
  const guardado = await guardarConReintento({
    movimiento,
    recalcular: (previas) => quitarConciliacion(previas, deshecha),
    usuario: usuario_nombre || usuario_id,
    d,
  });

  if (!guardado.ok) {
    return {
      ok: false,
      code: 'CONFLICTO_MOVIMIENTO',
      mensaje: guardado.conflicto
        ? 'El pago se ha eliminado, pero no se ha podido quitar la conciliación del movimiento '
          + 'porque otra persona lo estaba cambiando a la vez. Revisa el movimiento en banca.'
        : 'El pago se ha eliminado, pero no se ha podido quitar la conciliación del movimiento. '
          + 'Revisa el movimiento en banca.',
      deshecha,
      factura,
      intentos: guardado.intentos,
      movimiento: resumenMovimiento(guardado.movimiento),
    };
  }

  return {
    ok: true,
    code: 'OK',
    deshecha,
    factura,
    movimiento: resumenMovimiento(guardado.movimiento, {
      conciliaciones: guardado.conciliaciones,
      asignado: guardado.asignadoCentimos,
      estado: guardado.estado,
    }),
  };
}

/**
 * Marca (o desmarca) el movimiento como "no es una factura".
 *
 * Al desmarcarlo el estado no vuelve a `pendiente` a ciegas: se recalcula desde
 * lo que tenga asignado, porque un movimiento pudo ignorarse teniendo ya una
 * parte conciliada.
 */
export async function ignorarMovimiento({ cuentaRef, movementHash, fechaOperacion, ignorar = true, usuario }, deps = {}) {
  const d = { ...depsPorDefecto, ...deps };
  const movimiento = await d.getMovimiento(cuentaRef, movementHash, { fechaOperacion });
  if (!movimiento) {
    return { ok: false, code: 'MOVIMIENTO_NO_ENCONTRADO', mensaje: 'Movimiento bancario no encontrado' };
  }

  if (ignorar && conciliacionesDe(movimiento).length > 0) {
    return {
      ok: false,
      code: 'MOVIMIENTO_CON_CONCILIACIONES',
      mensaje: 'El movimiento tiene pagos aplicados: deshaz la conciliación antes de ignorarlo',
    };
  }

  const estado = ignorar
    ? ESTADO_IGNORADO
    : derivarEstado({
      importeCentimos: importeMovimientoCentimos(movimiento),
      asignadoCentimos: asignadoCentimos(movimiento),
    });

  const { usuario_id, usuario_nombre } = datosUsuario(usuario);
  let actualizado = movimiento;
  try {
    actualizado = await d.guardarEstadoMovimiento({
      movimiento,
      estadoConciliacion: estado,
      esperadoCentimos: asignadoCentimos(movimiento),
      usuario: usuario_nombre || usuario_id,
    }) || movimiento;
  } catch (err) {
    if (!esConflicto(err)) throw err;
    // Aquí no se reintenta: la comprobación de arriba —que el movimiento no
    // tenga pagos aplicados— puede haber dejado de ser cierta, y volver a
    // escribir a ciegas marcaría como "no es una factura" un apunte que acaba de
    // recibir un pago.
    return {
      ok: false,
      code: 'CONFLICTO_MOVIMIENTO',
      mensaje: 'El movimiento ha cambiado mientras se guardaba: vuelve a intentarlo',
    };
  }

  return { ok: true, code: 'OK', movimiento: resumenMovimiento(actualizado, { estado }) };
}

/** Apunta que una factura NO es de este movimiento, para no volver a sugerirla. */
export async function descartarSugerenciaMovimiento({
  cuentaRef,
  movementHash,
  fechaOperacion,
  id_factura,
  usuario,
}, deps = {}) {
  const d = { ...depsPorDefecto, ...deps };
  const idFactura = texto(id_factura);
  if (!idFactura) {
    return { ok: false, code: 'VALIDACION', mensaje: 'Indica la factura que se descarta' };
  }

  const movimiento = await d.getMovimiento(cuentaRef, movementHash, { fechaOperacion });
  if (!movimiento) {
    return { ok: false, code: 'MOVIMIENTO_NO_ENCONTRADO', mensaje: 'Movimiento bancario no encontrado' };
  }

  const { usuario_nombre, usuario_id } = datosUsuario(usuario);
  const resultado = await d.descartarSugerencia({
    movimiento,
    idFactura,
    usuario: usuario_nombre || usuario_id,
  });

  return {
    ok: true,
    code: 'OK',
    yaEstaba: resultado?.yaEstaba === true,
    sugerenciasDescartadas: resultado?.descartadas || [],
  };
}