import crypto from 'crypto';
import { PutCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { queryPagosByFactura } from '../dynamo/facturasRelacionadas.js';
import { METODO_PAGO_COMPENSACION } from './compensacionFactura.js';
import {
  METODO_PAGO_APLICACION_EXCESO,
  recalcularExcesoPendiente,
} from './excesoPago.js';
import { conReintentoFactura, putFacturaVersionada } from './versionFactura.js';
import { aplicarClavesPago } from './clavesIndice.js';

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Saldo con signo: positivo = deuda, negativo = abono todavía abierto. */
export function saldoRealFactura(factura) {
  return round2((Number(factura?.total_factura) || 0) - (Number(factura?.total_cobrado) || 0));
}

/**
 * Exceso real. En un abono (total negativo) solo hay exceso si se ha saldado
 * de más: el cobrado queda más negativo que el total.
 */
export function excesoSegunSigno(total, cobrado) {
  const t = round2(Number(total) || 0);
  const c = round2(Number(cobrado) || 0);
  if (t < 0) return round2(Math.max(0, t - c));
  return round2(Math.max(0, c - t));
}

/** Estado tras un cobro que puede dejar el saldo en negativo (abono a medias). */
export function estadoTrasSaldoFirmado(factura, cobrado, saldo) {
  if (factura?.estado === 'anulada') return factura.estado;
  const venta = factura?.tipo === 'OUT';
  if (Math.abs(saldo) <= 0.001) return venta ? 'cobrada' : 'pagada';
  if (Math.abs(cobrado) > 0.001) return venta ? 'parcialmente_cobrada' : 'parcialmente_pagada';
  return venta ? 'emitida' : 'pendiente_pago';
}

function fechaToIsoGuardada(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo}-${d}`;
  }
  return s;
}

/**
 * Siguiente `id_pago` de una factura: el correlativo sale del **máximo** ya
 * usado, no del número de pagos.
 *
 * Con la longitud, borrar un pago intermedio hace que el siguiente reutilice un
 * id vivo y su `PutCommand` pise el pago existente: la factura sigue sumando los
 * dos importes en `total_cobrado` pero en `Igp_FacturasPagos` solo queda uno.
 *
 * Los ids que no siguen el formato `Pnnn` se ignoran: no pueden colisionar con
 * `P{max+1}`, así que basta con no dejar que rompan el cálculo.
 *
 * @param {Array<{ id_pago?: string }>} pagos
 * @returns {string}
 */
export function siguienteIdPago(pagos) {
  return `P${String(ordinalMaximoIdPago(pagos) + 1).padStart(3, '0')}`;
}

/**
 * Mayor correlativo usado en los `id_pago` de una factura, o 0 si no hay ninguno
 * reconocible. Lo necesita quien reparte varios ids de golpe (la compensación
 * entre facturas), que no puede llamar a `siguienteIdPago` una vez por pago
 * porque los anteriores todavía no están escritos.
 *
 * @param {Array<{ id_pago?: string }>} pagos
 * @returns {number}
 */
export function ordinalMaximoIdPago(pagos) {
  let maximo = 0;
  for (const pago of pagos || []) {
    const encaja = /^P(\d+)$/.exec(String(pago?.id_pago || '').trim());
    const numero = encaja ? Number(encaja[1]) : 0;
    if (Number.isFinite(numero) && numero > maximo) maximo = numero;
  }
  return maximo;
}

async function registrarAuditoria(id_factura, accion, usuario_id, usuario_nombre, detalle) {
  const id_entrada = `AUD-${id_factura}-${Date.now()}`;
  await docClient.send(
    new PutCommand({
      TableName: tables.facturasAuditoria,
      Item: {
        id_entrada,
        id_factura,
        timestamp_accion: now(),
        accion,
        usuario_id: usuario_id || '',
        usuario_nombre: usuario_nombre || '',
        detalle: typeof detalle === 'string' ? detalle : JSON.stringify(detalle || {}),
      },
    }),
  );
}

/**
 * Registra un pago/cobro en una factura (lógica compartida con remesas).
 * @param {object} opts
 * @param {string} opts.id_factura
 * @param {string} opts.fecha — YYYY-MM-DD o dd/mm/aaaa
 * @param {number} opts.importe
 * @param {string} [opts.metodo_pago]
 * @param {string} [opts.referencia]
 * @param {string} [opts.observaciones]
 * @param {string} [opts.usuario_id]
 * @param {string} [opts.usuario_nombre]
 * @param {number} [opts.importeMaximo] — tope opcional (p. ej. saldo pendiente en remesa)
 * @param {string} [opts.idempotencyKey] — si ya existe un pago con la misma clave, no duplica
 * @param {string} [opts.banca_movement_hash] — movimiento bancario del que sale el pago
 * @param {string} [opts.banca_cuenta_ref] — cuenta (IBAN) de ese movimiento
 * @param {boolean} [opts.permitirSobrepago] — solo flujo manual; remesas/banca dejan false
 * @param {string} [opts.cuenta_caja]
 * @param {string} [opts.recibo_file_key]
 * @param {string} [opts.recibo_nombre]
 * Si otra escritura toca la factura entre la lectura y el guardado se relee y
 * se reintenta; agotados los intentos, error 409 `FACTURA_CAMBIADA`.
 */
export async function registrarPagoFactura(opts) {
  const { fecha, importe, metodo_pago = '' } = opts;

  const fechaIso = fechaToIsoGuardada(fecha);
  if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
    throw Object.assign(new Error('La fecha es obligatoria (AAAA-MM-DD o dd/mm/aaaa)'), { status: 400 });
  }

  const importeNum = round2(Number(importe));
  if (!importe || Number.isNaN(importeNum) || importeNum <= 0) {
    throw Object.assign(new Error('Importe debe ser mayor que 0'), { status: 400 });
  }

  const metodoNorm = String(metodo_pago || '').trim().toLowerCase();
  if (metodoNorm === METODO_PAGO_COMPENSACION) {
    throw Object.assign(
      new Error('La compensación entre facturas debe registrarse desde el flujo dedicado de compensación'),
      { status: 400 },
    );
  }
  if (metodoNorm === METODO_PAGO_APLICACION_EXCESO) {
    throw Object.assign(
      new Error('La aplicación de exceso debe registrarse desde el flujo dedicado de aplicación de exceso'),
      { status: 400 },
    );
  }

  const saldarAbono = opts.saldar_abono === true || opts.saldar_abono === 'true' || opts.saldarAbono === true;
  return conReintentoFactura(() => registrarPagoUnaVez({ ...opts, fechaIso, importeNum, saldarAbono }));
}

/** Lectura, cálculo y escritura de un intento; si otra escritura se adelanta, falla con conflicto. */
async function registrarPagoUnaVez({
  id_factura,
  fechaIso,
  importeNum,
  metodo_pago = '',
  referencia = '',
  observaciones = '',
  usuario_id = '',
  usuario_nombre = '',
  importeMaximo,
  idempotencyKey,
  banca_movement_hash = '',
  banca_cuenta_ref = '',
  permitirSobrepago = false,
  cuenta_caja = '',
  recibo_file_key = '',
  recibo_nombre = '',
  saldarAbono = false,
}) {
  const existing = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id_factura), ConsistentRead: true }),
  );
  if (!existing.Item) {
    throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  }
  const factura = existing.Item;
  const versionLeida = factura.version;

  // Idempotencia: si ya hay un pago con la misma clave, no crear otro
  if (idempotencyKey) {
    const pagosExistentes = await queryPagosByFactura(id_factura, { consistente: true });
    const previo = pagosExistentes.find((p) => p.idempotency_key === idempotencyKey);
    if (previo) {
      return { ok: true, pago: previo, factura, idempotent: true };
    }
  }

  const saldoReal = saldoRealFactura(factura);
  // «Otro» en un abono abierto: el importe salda el crédito (resta de lo cobrado)
  // en vez de sumarse como un pago normal, que dejaría un exceso falso.
  const saldar = saldarAbono === true && saldoReal < -0.001;
  const saldo = round2(
    factura.saldo_pendiente != null && factura.saldo_pendiente !== ''
      ? Number(factura.saldo_pendiente)
      : saldoReal,
  );
  if (saldar) {
    const credito = round2(-saldoReal);
    if (importeNum > credito + 0.001) {
      throw Object.assign(
        new Error(`Importe ${importeNum} supera el crédito del abono (${credito})`),
        { status: 400 },
      );
    }
  }
  // El tope es el más restrictivo de los dos, nunca el que pasa quien llama: ese
  // se calculó sobre una lectura anterior de la factura y quedarse con él anula
  // la defensa contra el sobrepago justo cuando hace falta (dos conciliaciones
  // del mismo cargo, dos claves de idempotencia, el saldo ya consumido por la
  // primera). El clamp de `saldo_pendiente` de más abajo deja el exceso invisible.
  // `permitirSobrepago` (solo POST manual) permite importe > saldo; remesas/banca no.
  // En el saldado de un abono el tope es el crédito, ya comprobado arriba.
  if (!saldar && !permitirSobrepago) {
    const tope = importeMaximo != null ? Math.min(saldo, round2(Number(importeMaximo))) : saldo;
    if (importeNum > tope + 0.001) {
      throw Object.assign(
        new Error(`Importe ${importeNum} supera el pendiente (${tope})`),
        { status: 400 },
      );
    }
  } else if (importeMaximo != null && importeNum > round2(Number(importeMaximo)) + 0.001) {
    throw Object.assign(
      new Error(`Importe ${importeNum} supera el máximo permitido (${round2(Number(importeMaximo))})`),
      { status: 400 },
    );
  }

  const pagos = await queryPagosByFactura(id_factura, { consistente: true });
  const id_pago = siguienteIdPago(pagos);

  const pago = {
    id_entrada: `${id_factura}#${id_pago}`,
    id_factura,
    id_pago,
    fecha: fechaIso,
    importe: importeNum,
    metodo_pago: metodo_pago || '',
    cuenta_caja: cuenta_caja || '',
    referencia: referencia || '',
    observaciones: observaciones || '',
    justificante: '',
    recibo_file_key: recibo_file_key || '',
    recibo_nombre: recibo_nombre || '',
    creado_por: usuario_id || '',
    creado_en: now(),
    idempotency_key: idempotencyKey || '',
    ...(saldar ? { saldar_abono: true } : {}),
    // Trazabilidad inversa de la conciliación bancaria: desde el pago se llega
    // al apunte del extracto que lo originó. Los atributos solo se escriben
    // cuando vienen, para que los pagos de remesas y los manuales queden
    // exactamente igual que antes.
    ...(String(banca_movement_hash || '').trim() && {
      banca_movement_hash: String(banca_movement_hash).trim(),
    }),
    ...(String(banca_cuenta_ref || '').trim() && {
      banca_cuenta_ref: String(banca_cuenta_ref).trim(),
    }),
  };

  const nuevoTotalCobrado = saldar
    ? round2((factura.total_cobrado || 0) - importeNum)
    : round2((factura.total_cobrado || 0) + importeNum);
  const nuevoSaldo = round2(factura.total_factura - nuevoTotalCobrado);

  let nuevoEstado = factura.estado;
  if (saldar) {
    nuevoEstado = estadoTrasSaldoFirmado(factura, nuevoTotalCobrado, nuevoSaldo);
  } else if (nuevoSaldo <= 0) {
    nuevoEstado = factura.tipo === 'OUT' ? 'cobrada' : 'pagada';
  } else if (nuevoTotalCobrado > 0) {
    nuevoEstado = factura.tipo === 'OUT' ? 'parcialmente_cobrada' : 'parcialmente_pagada';
  }

  // El saldo se guarda clampado a 0 —una factura no debe quedar con pendiente
  // negativo— pero un saldo negativo es un descuadre real: se ha cobrado más que
  // el total. Sin dejar rastro, el clamp lo borra y nadie se entera nunca.
  // En el saldado de un abono el saldo negativo que queda es crédito pendiente,
  // no un descuadre: se guarda con signo.
  const descuadre = !saldar && nuevoSaldo < 0 ? round2(-nuevoSaldo) : 0;
  if (descuadre > 0) {
    console.warn(
      `[registrarPagoFactura] Sobrepago en ${id_factura}: cobrado ${nuevoTotalCobrado} `
      + `sobre un total de ${factura.total_factura} (exceso ${descuadre})`,
    );
  }

  factura.total_cobrado = nuevoTotalCobrado;
  factura.saldo_pendiente = saldar
    ? (Math.abs(nuevoSaldo) <= 0.001 ? 0 : nuevoSaldo)
    : Math.max(0, nuevoSaldo);
  factura.estado = nuevoEstado;
  const exceso = saldar
    ? (factura.exceso_pendiente = excesoSegunSigno(factura.total_factura, nuevoTotalCobrado))
    : recalcularExcesoPendiente(factura);
  factura.modificado_por = usuario_id || '';
  factura.modificado_en = now();

  // Pago y saldo van juntos: si la factura cambió desde la lectura, o el id_pago
  // ya lo cogió otro, no se escribe ninguno de los dos y se reintenta.
  await docClient.send(new TransactWriteCommand({
    TransactItems: [
      { Put: putFacturaVersionada(factura, versionLeida) },
      {
        Put: {
          TableName: tables.facturasPagos,
          Item: aplicarClavesPago(pago),
          ConditionExpression: 'attribute_not_exists(id_pago)',
        },
      },
    ],
  }));
  await registrarAuditoria(id_factura, 'pago', usuario_id, usuario_nombre, {
    importe: importeNum,
    metodo_pago,
    referencia,
    nuevo_estado: nuevoEstado,
    ...(exceso > 0 && { sobrepago: exceso }),
  });

  return { ok: true, pago, factura };
}
