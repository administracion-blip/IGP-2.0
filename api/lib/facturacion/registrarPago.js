import crypto from 'crypto';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { queryPagosByFactura } from '../dynamo/facturasRelacionadas.js';
import { METODO_PAGO_COMPENSACION } from './compensacionFactura.js';

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
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
 */
export async function registrarPagoFactura(opts) {
  const {
    id_factura,
    fecha,
    importe,
    metodo_pago = '',
    referencia = '',
    observaciones = '',
    usuario_id = '',
    usuario_nombre = '',
    importeMaximo,
    idempotencyKey,
    banca_movement_hash = '',
    banca_cuenta_ref = '',
  } = opts;

  const fechaIso = fechaToIsoGuardada(fecha);
  if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
    throw Object.assign(new Error('La fecha es obligatoria (AAAA-MM-DD o dd/mm/aaaa)'), { status: 400 });
  }

  const importeNum = round2(Number(importe));
  if (!importe || Number.isNaN(importeNum) || importeNum <= 0) {
    throw Object.assign(new Error('Importe debe ser mayor que 0'), { status: 400 });
  }

  if (String(metodo_pago || '').trim().toLowerCase() === METODO_PAGO_COMPENSACION) {
    throw Object.assign(
      new Error('La compensación entre facturas debe registrarse desde el flujo dedicado de compensación'),
      { status: 400 },
    );
  }

  const existing = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id_factura) }),
  );
  if (!existing.Item) {
    throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  }
  const factura = existing.Item;

  // Idempotencia: si ya hay un pago con la misma clave, no crear otro
  if (idempotencyKey) {
    const pagosExistentes = await queryPagosByFactura(id_factura);
    const previo = pagosExistentes.find((p) => p.idempotency_key === idempotencyKey);
    if (previo) {
      return { ok: true, pago: previo, factura, idempotent: true };
    }
  }

  const saldo = round2(
    factura.saldo_pendiente != null && factura.saldo_pendiente !== ''
      ? Number(factura.saldo_pendiente)
      : (Number(factura.total_factura) || 0) - (Number(factura.total_cobrado) || 0),
  );
  // El tope es el más restrictivo de los dos, nunca el que pasa quien llama: ese
  // se calculó sobre una lectura anterior de la factura y quedarse con él anula
  // la defensa contra el sobrepago justo cuando hace falta (dos conciliaciones
  // del mismo cargo, dos claves de idempotencia, el saldo ya consumido por la
  // primera). El clamp de `saldo_pendiente` de más abajo deja el exceso invisible.
  const tope = importeMaximo != null ? Math.min(saldo, round2(Number(importeMaximo))) : saldo;
  if (importeNum > tope + 0.001) {
    throw Object.assign(
      new Error(`Importe ${importeNum} supera el pendiente (${tope})`),
      { status: 400 },
    );
  }

  const pagos = await queryPagosByFactura(id_factura);
  const id_pago = siguienteIdPago(pagos);

  const pago = {
    id_entrada: `${id_factura}#${id_pago}`,
    id_factura,
    id_pago,
    fecha: fechaIso,
    importe: importeNum,
    metodo_pago: metodo_pago || '',
    cuenta_caja: '',
    referencia: referencia || '',
    observaciones: observaciones || '',
    justificante: '',
    recibo_file_key: '',
    recibo_nombre: '',
    creado_por: usuario_id || '',
    creado_en: now(),
    idempotency_key: idempotencyKey || '',
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

  await docClient.send(new PutCommand({ TableName: tables.facturasPagos, Item: pago }));

  const nuevoTotalCobrado = round2((factura.total_cobrado || 0) + importeNum);
  const nuevoSaldo = round2(factura.total_factura - nuevoTotalCobrado);

  let nuevoEstado = factura.estado;
  if (nuevoSaldo <= 0) {
    nuevoEstado = factura.tipo === 'OUT' ? 'cobrada' : 'pagada';
  } else if (nuevoTotalCobrado > 0) {
    nuevoEstado = factura.tipo === 'OUT' ? 'parcialmente_cobrada' : 'parcialmente_pagada';
  }

  // El saldo se guarda clampado a 0 —una factura no debe quedar con pendiente
  // negativo— pero un saldo negativo es un descuadre real: se ha cobrado más que
  // el total. Sin dejar rastro, el clamp lo borra y nadie se entera nunca.
  const descuadre = nuevoSaldo < 0 ? round2(-nuevoSaldo) : 0;
  if (descuadre > 0) {
    console.warn(
      `[registrarPagoFactura] Sobrepago en ${id_factura}: cobrado ${nuevoTotalCobrado} `
      + `sobre un total de ${factura.total_factura} (exceso ${descuadre})`,
    );
  }

  factura.total_cobrado = nuevoTotalCobrado;
  factura.saldo_pendiente = Math.max(0, nuevoSaldo);
  factura.estado = nuevoEstado;
  factura.modificado_por = usuario_id || '';
  factura.modificado_en = now();

  await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
  await registrarAuditoria(id_factura, 'pago', usuario_id, usuario_nombre, {
    importe: importeNum,
    metodo_pago,
    referencia,
    nuevo_estado: nuevoEstado,
    ...(descuadre > 0 && { sobrepago: descuadre }),
  });

  return { ok: true, pago, factura };
}
