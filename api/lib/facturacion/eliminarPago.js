/**
 * Borrado de un pago/cobro de factura, con el recálculo del estado.
 *
 * Vive aquí y no dentro de `DELETE /facturacion/pagos/:id_factura/:id_pago`
 * porque ahora hay dos formas de deshacer un pago: la de siempre, desde el
 * detalle de la factura, y deshacer una conciliación bancaria. Si cada una
 * recalculara el estado por su cuenta, divergirían en silencio en el caso que
 * nadie prueba a mano —el pago parcial que vuelve a `pendiente_pago`— y la
 * factura se quedaría marcada como pagada sin pagos.
 *
 * Es la contrapartida de `registrarPago.js` y mantiene su forma: lanza errores
 * con `status` y `code` para que el router los traduzca a HTTP.
 */

import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { findRemesaActivaDeFactura } from '../remesas/facturaEnRemesa.js';
import { METODO_PAGO_COMPENSACION } from './compensacionFactura.js';
import {
  METODO_PAGO_APLICACION_EXCESO,
  assertSinAplicacionesExcesoEnFactura,
  recalcularExcesoPendiente,
} from './excesoPago.js';

function now() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function error(status, mensaje, code, extra) {
  return Object.assign(new Error(mensaje), { status, ...(code && { code }), ...extra });
}

async function registrarAuditoria(id_factura, accion, usuario_id, usuario_nombre, detalle) {
  await docClient.send(
    new PutCommand({
      TableName: tables.facturasAuditoria,
      Item: {
        id_entrada: `AUD-${id_factura}-${Date.now()}`,
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
 * Estado que le queda a la factura al quitarle un pago.
 * Una factura anulada no cambia de estado: la anulación manda.
 * @returns {string}
 */
export function estadoTrasQuitarPago(factura, nuevoTotalCobrado, nuevoSaldo) {
  if (factura.estado === 'anulada') return factura.estado;
  if (nuevoTotalCobrado <= 0) return factura.tipo === 'OUT' ? 'emitida' : 'pendiente_pago';
  if (nuevoSaldo > 0) return factura.tipo === 'OUT' ? 'parcialmente_cobrada' : 'parcialmente_pagada';
  return factura.estado;
}

/**
 * Elimina un pago y recalcula `total_cobrado`, `saldo_pendiente` y el estado.
 *
 * @param {object} opts
 * @param {string} opts.id_factura
 * @param {string} opts.id_pago
 * @param {string} [opts.usuario_id]
 * @param {string} [opts.usuario_nombre]
 * @param {object} [opts.factura] Factura ya leída (evita un Get de más).
 * @param {string} [opts.accionAuditoria] Acción que se registra en la auditoría.
 * @param {object} [opts.detalleAuditoria] Datos extra para la auditoría.
 * @returns {Promise<{ ok: true, factura: object, pago: object }>}
 */
export async function eliminarPagoFactura({
  id_factura,
  id_pago,
  usuario_id = '',
  usuario_nombre = '',
  factura: facturaPrevia,
  accionAuditoria = 'eliminar_pago',
  detalleAuditoria = {},
}) {
  const idFactura = String(id_factura || '').trim();
  const idPago = String(id_pago || '').trim();
  if (!idFactura || !idPago) throw error(400, 'Faltan la factura y el pago a eliminar');

  let factura = facturaPrevia;
  if (!factura) {
    const result = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(idFactura) }),
    );
    if (!result.Item) throw error(404, 'Factura no encontrada');
    factura = result.Item;
  }

  const remesaActiva = await findRemesaActivaDeFactura(idFactura);
  if (remesaActiva) {
    throw error(
      409,
      `Esta factura está en la remesa «${remesaActiva.nombre || remesaActiva.remesaId}»`,
      'FACTURA_EN_REMESA',
      { remesaActiva },
    );
  }

  const pagoResult = await docClient.send(
    new GetCommand({ TableName: tables.facturasPagos, Key: { id_factura: idFactura, id_pago: idPago } }),
  );
  if (!pagoResult.Item) throw error(404, 'Pago no encontrado');
  const pago = pagoResult.Item;
  if (String(pago.metodo_pago || '') === METODO_PAGO_COMPENSACION) {
    throw error(
      400,
      'Los pagos por compensación no se pueden eliminar desde aquí. Contacta con administración si necesitas corregirlos.',
      'PAGO_COMPENSACION',
    );
  }
  if (String(pago.metodo_pago || '') === METODO_PAGO_APLICACION_EXCESO) {
    throw error(
      400,
      'Los pagos por aplicación de exceso no se pueden eliminar desde aquí. Contacta con administración si necesitas corregirlos.',
      'PAGO_APLICACION_EXCESO',
    );
  }
  // Si la factura ya tiene aplicaciones de exceso (como origen o destino),
  // borrar otro pago dejaría crédito/cobro huérfano en la contraparte.
  await assertSinAplicacionesExcesoEnFactura(idFactura);

  await docClient.send(
    new DeleteCommand({ TableName: tables.facturasPagos, Key: { id_factura: idFactura, id_pago: idPago } }),
  );

  const nuevoTotalCobrado = round2(Math.max(0, (factura.total_cobrado || 0) - (Number(pago.importe) || 0)));
  const nuevoSaldo = round2((Number(factura.total_factura) || 0) - nuevoTotalCobrado);

  factura.total_cobrado = nuevoTotalCobrado;
  factura.saldo_pendiente = Math.max(0, nuevoSaldo);
  factura.estado = estadoTrasQuitarPago(factura, nuevoTotalCobrado, nuevoSaldo);
  recalcularExcesoPendiente(factura);
  factura.modificado_en = now();

  await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
  await registrarAuditoria(idFactura, accionAuditoria, usuario_id, usuario_nombre, {
    id_pago: idPago,
    importe: pago.importe,
    nuevo_estado: factura.estado,
    ...detalleAuditoria,
  });

  return { ok: true, factura, pago };
}
