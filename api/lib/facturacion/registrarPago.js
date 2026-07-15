import crypto from 'crypto';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { queryPagosByFactura } from '../dynamo/facturasRelacionadas.js';

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
  } = opts;

  const fechaIso = fechaToIsoGuardada(fecha);
  if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
    throw Object.assign(new Error('La fecha es obligatoria (AAAA-MM-DD o dd/mm/aaaa)'), { status: 400 });
  }

  const importeNum = round2(Number(importe));
  if (!importe || Number.isNaN(importeNum) || importeNum <= 0) {
    throw Object.assign(new Error('Importe debe ser mayor que 0'), { status: 400 });
  }

  const existing = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id_factura) }),
  );
  if (!existing.Item) {
    throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  }
  const factura = existing.Item;

  const saldo = round2(
    factura.saldo_pendiente != null && factura.saldo_pendiente !== ''
      ? Number(factura.saldo_pendiente)
      : (Number(factura.total_factura) || 0) - (Number(factura.total_cobrado) || 0),
  );
  const tope = importeMaximo != null ? round2(Number(importeMaximo)) : saldo;
  if (importeNum > tope + 0.001) {
    throw Object.assign(
      new Error(`Importe ${importeNum} supera el pendiente (${tope})`),
      { status: 400 },
    );
  }

  const pagos = await queryPagosByFactura(id_factura);
  const nextIdx = pagos.length + 1;
  const id_pago = `P${String(nextIdx).padStart(3, '0')}`;

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
  });

  return { ok: true, pago, factura };
}
