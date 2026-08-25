/**
 * Sobrepago / exceso en facturas: medir, persistir y aplicar crédito a otra factura.
 * No introduce estado `pagada_exceso`: se mantiene `pagada`/`cobrada` + `exceso_pendiente`.
 */

import crypto from 'crypto';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { queryPagosByFactura } from '../dynamo/facturasRelacionadas.js';
import { ordinalMaximoIdPago } from './registrarPago.js';
import {
  mismoParEmisorProveedor,
  etiquetaFacturaCompensable,
} from './compensacionFactura.js';

export const METODO_PAGO_APLICACION_EXCESO = 'aplicacion_exceso';

/** Destinos IN a los que se puede aplicar un exceso. */
const ESTADOS_DESTINO_EXCESO = new Set([
  'pendiente_pago',
  'parcialmente_pagada',
  'vencida',
  'pendiente_revision',
]);

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function now() {
  return new Date().toISOString();
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
 * Exceso bruto frente a `total_factura` (ya neto de retención).
 * @param {object} factura
 * @returns {number}
 */
export function excesoBruto(factura) {
  if (!factura) return 0;
  const cobrado = Number(factura.total_cobrado) || 0;
  const total = Number(factura.total_factura) || 0;
  return round2(Math.max(0, cobrado - total));
}

/**
 * Recalcula y escribe `exceso_pendiente` en la factura (≥ 0).
 * @param {object} factura
 * @returns {number}
 */
export function recalcularExcesoPendiente(factura) {
  const valor = excesoBruto(factura);
  factura.exceso_pendiente = valor;
  return valor;
}

/**
 * Exceso disponible efectivo según cobrado − total.
 * No confía en `exceso_pendiente` persistido (puede estar stale a 0 y ocultar crédito).
 * @param {object} factura
 * @returns {number}
 */
export function excesoPendienteEfectivo(factura) {
  return excesoBruto(factura);
}

export const MSG_FACTURA_CON_APLICACION_EXCESO =
  'No se puede modificar este pago porque la factura tiene aplicaciones de exceso. '
  + 'Revierte primero esas aplicaciones o contacta con administración.';

/**
 * @param {object[]} pagos
 * @returns {boolean}
 */
export function facturaTienePagosAplicacionExceso(pagos) {
  return (pagos || []).some(
    (p) => String(p?.metodo_pago || '') === METODO_PAGO_APLICACION_EXCESO,
  );
}

/**
 * Bloquea borrar/editar pagos si la factura ya tiene aplicaciones de exceso.
 * @param {string} id_factura
 */
export async function assertSinAplicacionesExcesoEnFactura(id_factura) {
  const pagos = await queryPagosByFactura(id_factura);
  if (facturaTienePagosAplicacionExceso(pagos)) {
    throw Object.assign(new Error(MSG_FACTURA_CON_APLICACION_EXCESO), {
      status: 400,
      code: 'FACTURA_CON_APLICACION_EXCESO',
    });
  }
}

/**
 * @param {object} f
 * @returns {boolean}
 */
export function facturaTieneExceso(f) {
  return excesoPendienteEfectivo(f) > 0.001;
}

function saldoPendienteFactura(f) {
  if (!f) return 0;
  if (f.saldo_pendiente != null && f.saldo_pendiente !== '') {
    return round2(Math.max(0, Number(f.saldo_pendiente) || 0));
  }
  return round2(Math.max(0, (Number(f.total_factura) || 0) - (Number(f.total_cobrado) || 0)));
}

/**
 * Candidata IN con exceso aplicable al destino (mismo emisor+proveedor).
 * @param {object} destino
 * @param {object} candidata — factura origen del exceso
 */
export function esFacturaConExcesoDisponible(destino, candidata) {
  if (!destino || !candidata) return false;
  if (String(candidata.id_factura) === String(destino.id_factura)) return false;
  if (candidata.tipo !== 'IN' || destino.tipo !== 'IN') return false;
  if (candidata.estado === 'anulada' || candidata.estado === 'borrador') return false;
  if (!facturaTieneExceso(candidata)) return false;
  return mismoParEmisorProveedor(destino, candidata);
}

export function filtrarFacturasConExceso(destino, todasFacturas) {
  if (!destino || destino.tipo !== 'IN') return [];
  return (todasFacturas || []).filter((f) => esFacturaConExcesoDisponible(destino, f));
}

export function etiquetaFacturaExceso(f) {
  return etiquetaFacturaCompensable(f);
}

function calcularEstadoTrasCobrado(factura, nuevoTotalCobrado, nuevoSaldo) {
  if (factura.estado === 'anulada') return factura.estado;
  if (nuevoSaldo <= 0.001) {
    return factura.tipo === 'OUT' ? 'cobrada' : 'pagada';
  }
  if (nuevoTotalCobrado > 0.001) {
    return factura.tipo === 'OUT' ? 'parcialmente_cobrada' : 'parcialmente_pagada';
  }
  return factura.tipo === 'OUT' ? 'emitida' : 'pendiente_pago';
}

async function registrarAuditoria(id_factura, accion, usuario_id, usuario_nombre, detalle) {
  const id_entrada = `AUD-${id_factura}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

async function cargarFactura(id) {
  const r = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
  );
  return r.Item || null;
}

function allocIdPago(facturaId, conteoPagos) {
  const n = (conteoPagos.get(facturaId) || 0) + 1;
  conteoPagos.set(facturaId, n);
  return `P${String(n).padStart(3, '0')}`;
}

async function cargarConteosPagos(ids) {
  const conteoPagos = new Map();
  await Promise.all(
    ids.map(async (id) => {
      const pagos = await queryPagosByFactura(id);
      conteoPagos.set(id, ordinalMaximoIdPago(pagos));
    }),
  );
  return conteoPagos;
}

function buildPagoAplicacionExceso(factura, id_pago, opts) {
  return {
    id_entrada: `${factura.id_factura}#${id_pago}`,
    id_factura: factura.id_factura,
    id_pago,
    fecha: opts.fechaIso,
    importe: opts.importe,
    metodo_pago: METODO_PAGO_APLICACION_EXCESO,
    cuenta_caja: '',
    referencia: opts.referencia || '',
    observaciones: opts.observaciones || '',
    justificante: '',
    recibo_file_key: '',
    recibo_nombre: '',
    aplicacion_exceso_grupo_id: opts.grupoId,
    aplicacion_exceso_con: opts.aplicacionCon || [],
    creado_por: opts.usuario_id || '',
    creado_en: now(),
  };
}

async function persistirTransaccion(items) {
  const bloques = [];
  for (let i = 0; i < items.length; i += 100) {
    bloques.push(items.slice(i, i + 100));
  }
  for (const bloque of bloques) {
    await docClient.send(new TransactWriteCommand({ TransactItems: bloque }));
  }
}

/**
 * Aplica importe de exceso de una factura origen a un destino IN pagable.
 *
 * @param {object} opts
 * @param {string} opts.id_factura — destino
 * @param {string} opts.id_factura_exceso — origen con exceso
 * @param {number} opts.importe
 * @param {string} opts.fecha
 * @param {string} [opts.observaciones]
 * @param {string} [opts.usuario_id]
 * @param {string} [opts.usuario_nombre]
 */
export async function aplicarExcesoPago(opts) {
  const {
    id_factura,
    id_factura_exceso,
    importe,
    fecha,
    observaciones = '',
    usuario_id = '',
    usuario_nombre = '',
  } = opts;

  const fechaIso = fechaToIsoGuardada(fecha);
  if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
    throw Object.assign(new Error('La fecha es obligatoria (AAAA-MM-DD o dd/mm/aaaa)'), { status: 400 });
  }

  const importeNum = round2(Number(importe));
  if (!importe || Number.isNaN(importeNum) || importeNum <= 0) {
    throw Object.assign(new Error('Importe debe ser mayor que 0'), { status: 400 });
  }

  const idDestino = String(id_factura || '').trim();
  const idOrigen = String(id_factura_exceso || '').trim();
  if (!idDestino || !idOrigen) {
    throw Object.assign(new Error('Faltan la factura destino y la factura con exceso'), { status: 400 });
  }
  if (idDestino === idOrigen) {
    throw Object.assign(new Error('No puedes aplicar el exceso de una factura sobre sí misma'), { status: 400 });
  }

  const destino = await cargarFactura(idDestino);
  if (!destino) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  if (destino.tipo !== 'IN') {
    throw Object.assign(new Error('La aplicación de exceso solo está disponible en facturas de gasto'), { status: 400 });
  }
  if (!ESTADOS_DESTINO_EXCESO.has(String(destino.estado || ''))) {
    throw Object.assign(
      new Error('La factura destino no admite aplicación de exceso en su estado actual'),
      { status: 400 },
    );
  }

  const origen = await cargarFactura(idOrigen);
  if (!origen) throw Object.assign(new Error(`Factura con exceso no encontrada: ${idOrigen}`), { status: 404 });
  if (!esFacturaConExcesoDisponible(destino, origen)) {
    throw Object.assign(
      new Error(
        `La factura ${etiquetaFacturaExceso(origen)} no tiene exceso aplicable `
        + '(sociedad/proveedor distinto, sin exceso o estado no válido)',
      ),
      { status: 400 },
    );
  }

  const excesoOrigen = excesoPendienteEfectivo(origen);
  if (importeNum > excesoOrigen + 0.001) {
    throw Object.assign(
      new Error(`Importe ${importeNum} supera el exceso disponible (${excesoOrigen})`),
      { status: 400 },
    );
  }

  const saldoDestino = saldoPendienteFactura(destino);
  if (saldoDestino < 0.001) {
    throw Object.assign(new Error('La factura destino no tiene saldo pendiente'), { status: 400 });
  }
  if (importeNum > saldoDestino + 0.001) {
    throw Object.assign(
      new Error(`Importe ${importeNum} supera el pendiente de la factura destino (${saldoDestino})`),
      { status: 400 },
    );
  }

  const grupoId = crypto.randomUUID();
  const etiquetaOrigen = etiquetaFacturaExceso(origen);
  const etiquetaDestino = etiquetaFacturaExceso(destino);

  const origenMut = { ...origen };
  origenMut.total_cobrado = round2((Number(origenMut.total_cobrado) || 0) - importeNum);
  const saldoOrigen = round2((Number(origenMut.total_factura) || 0) - (Number(origenMut.total_cobrado) || 0));
  origenMut.saldo_pendiente = Math.max(0, saldoOrigen);
  origenMut.estado = calcularEstadoTrasCobrado(origenMut, origenMut.total_cobrado, origenMut.saldo_pendiente);
  recalcularExcesoPendiente(origenMut);
  origenMut.modificado_por = usuario_id || '';
  origenMut.modificado_en = now();

  const destinoMut = { ...destino };
  destinoMut.total_cobrado = round2((Number(destinoMut.total_cobrado) || 0) + importeNum);
  const saldoDest = round2((Number(destinoMut.total_factura) || 0) - (Number(destinoMut.total_cobrado) || 0));
  destinoMut.saldo_pendiente = Math.max(0, saldoDest);
  destinoMut.estado = calcularEstadoTrasCobrado(destinoMut, destinoMut.total_cobrado, destinoMut.saldo_pendiente);
  recalcularExcesoPendiente(destinoMut);
  destinoMut.modificado_por = usuario_id || '';
  destinoMut.modificado_en = now();

  const conteoPagos = await cargarConteosPagos([origenMut.id_factura, destinoMut.id_factura]);
  const idPagoOrigen = allocIdPago(origenMut.id_factura, conteoPagos);
  const idPagoDestino = allocIdPago(destinoMut.id_factura, conteoPagos);

  const obsBase = observaciones ? `${String(observaciones).trim()} · ` : '';
  const pagoOrigen = buildPagoAplicacionExceso(origenMut, idPagoOrigen, {
    fechaIso,
    importe: importeNum,
    referencia: destinoMut.id_factura,
    observaciones: `${obsBase}Aplicación de exceso a: ${etiquetaDestino}`,
    grupoId,
    aplicacionCon: [destinoMut.id_factura],
    usuario_id,
  });
  const pagoDestino = buildPagoAplicacionExceso(destinoMut, idPagoDestino, {
    fechaIso,
    importe: importeNum,
    referencia: origenMut.id_factura,
    observaciones: `${obsBase}Aplicación de exceso desde: ${etiquetaOrigen}`,
    grupoId,
    aplicacionCon: [origenMut.id_factura],
    usuario_id,
  });

  // Condición sobre el cobrado leído: un segundo request concurrente no debe
  // sobrescribir tras haber validado el mismo exceso/saldo.
  const tcOrigenLeido = round2(Number(origen.total_cobrado) || 0);
  const tcDestinoLeido = round2(Number(destino.total_cobrado) || 0);

  try {
    await persistirTransaccion([
      {
        Put: {
          TableName: tables.facturas,
          Item: origenMut,
          ConditionExpression: 'total_cobrado = :tcLeido',
          ExpressionAttributeValues: { ':tcLeido': tcOrigenLeido },
        },
      },
      {
        Put: {
          TableName: tables.facturas,
          Item: destinoMut,
          ConditionExpression: 'total_cobrado = :tcLeido',
          ExpressionAttributeValues: { ':tcLeido': tcDestinoLeido },
        },
      },
      { Put: { TableName: tables.facturasPagos, Item: pagoOrigen } },
      { Put: { TableName: tables.facturasPagos, Item: pagoDestino } },
    ]);
  } catch (err) {
    const razones = Array.isArray(err?.CancellationReasons) ? err.CancellationReasons : [];
    const esConflicto =
      err?.name === 'ConditionalCheckFailedException'
      || (err?.name === 'TransactionCanceledException'
        && razones.some((r) => r?.Code === 'ConditionalCheckFailed'));
    if (esConflicto) {
      throw Object.assign(
        new Error(
          'Otro usuario ha modificado una de las facturas mientras se aplicaba el exceso. '
          + 'Recarga e inténtalo de nuevo.',
        ),
        { status: 409, code: 'CONFLICTO_APLICACION_EXCESO' },
      );
    }
    throw err;
  }

  await registrarAuditoria(destinoMut.id_factura, 'aplicacion_exceso', usuario_id, usuario_nombre, {
    importe: importeNum,
    origen: origenMut.id_factura,
    grupoId,
    nuevo_estado: destinoMut.estado,
  });
  await registrarAuditoria(origenMut.id_factura, 'aplicacion_exceso', usuario_id, usuario_nombre, {
    importe: importeNum,
    destino: destinoMut.id_factura,
    grupoId,
    exceso_pendiente: origenMut.exceso_pendiente,
    nuevo_estado: origenMut.estado,
  });

  return {
    ok: true,
    aplicacion_exceso_grupo_id: grupoId,
    importe: importeNum,
    factura: destinoMut,
    factura_exceso: origenMut,
    pago: pagoDestino,
    pago_exceso: pagoOrigen,
  };
}
