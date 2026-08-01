/**
 * Compensación entre facturas de gasto (IN): misma sociedad + mismo proveedor.
 * No modifica registrarPagoFactura — flujo dedicado con saldos con signo (abonos).
 */

import crypto from 'crypto';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { queryPagosByFactura } from '../dynamo/facturasRelacionadas.js';
import { normalizeCif } from '../empresaCif.js';

export const METODO_PAGO_COMPENSACION = 'compensacion';

const ESTADOS_COMPENSABLES = new Set([
  'pendiente_pago',
  'pendiente_revision',
  'parcialmente_pagada',
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

/** Saldo firmado: positivo = deuda, negativo = crédito (abono). */
export function saldoFirmadoFactura(f) {
  if (!f) return 0;
  if (f.saldo_pendiente != null && f.saldo_pendiente !== '') {
    return round2(Number(f.saldo_pendiente));
  }
  return round2((Number(f.total_factura) || 0) - (Number(f.total_cobrado) || 0));
}

/** Capacidad de absorber compensación (siempre valor positivo). */
export function capacidadCompensacionFactura(f) {
  return round2(Math.abs(saldoFirmadoFactura(f)));
}

function mismoParEmisorProveedor(a, b) {
  const cifEmA = normalizeCif(a.emisor_cif);
  const cifEmB = normalizeCif(b.emisor_cif);
  const cifProvA = normalizeCif(a.empresa_cif);
  const cifProvB = normalizeCif(b.empresa_cif);

  if (cifEmA.length >= 6 && cifEmB.length >= 6 && cifEmA === cifEmB) {
    if (cifProvA.length >= 6 && cifProvB.length >= 6 && cifProvA === cifProvB) return true;
  }

  const idEmA = String(a.emisor_id || '').trim();
  const idEmB = String(b.emisor_id || '').trim();
  const idProvA = String(a.empresa_id || '').trim();
  const idProvB = String(b.empresa_id || '').trim();
  if (idEmA && idEmB && idEmA === idEmB && idProvA && idProvB && idProvA === idProvB) return true;

  return false;
}

export function esFacturaCompensable(origen, candidata) {
  if (!origen || !candidata) return false;
  if (String(candidata.id_factura) === String(origen.id_factura)) return false;
  if (candidata.tipo !== 'IN' || origen.tipo !== 'IN') return false;
  if (candidata.estado === 'anulada' || candidata.estado === 'borrador' || candidata.estado === 'pagada') {
    return false;
  }
  if (!ESTADOS_COMPENSABLES.has(String(candidata.estado || ''))) return false;
  if (Math.abs(saldoFirmadoFactura(candidata)) < 0.001) return false;
  const saldoOrigen = saldoFirmadoFactura(origen);
  const saldoCandidata = saldoFirmadoFactura(candidata);
  if (saldoOrigen * saldoCandidata >= 0) return false;
  return mismoParEmisorProveedor(origen, candidata);
}

export function etiquetaFacturaCompensable(f) {
  const num = String(f.numero_factura_proveedor || f.numero_factura || f.id_factura || '').trim();
  const prov = String(f.empresa_nombre || '').trim();
  return num && prov ? `${num} · ${prov}` : num || prov || f.id_factura;
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

function calcularEstadoTrasSaldo(factura, nuevoSaldo) {
  const absSaldo = Math.abs(nuevoSaldo);
  if (absSaldo <= 0.001) {
    return 'pagada';
  }
  const cobrado = round2(Number(factura.total_cobrado) || 0);
  if (Math.abs(cobrado) > 0.001) {
    return 'parcialmente_pagada';
  }
  return factura.estado;
}

/**
 * Aplica importe positivo `delta` hacia saldo cero.
 * Deuda (+saldo): incrementa total_cobrado.
 * Crédito (-saldo): decrementa total_cobrado.
 * @returns {number} importe realmente aplicado
 */
function aplicarCompensacionAFactura(factura, delta) {
  const saldo = saldoFirmadoFactura(factura);
  if (Math.abs(saldo) < 0.001 || delta <= 0) return 0;

  let aplicar = round2(Math.min(delta, Math.abs(saldo)));
  if (saldo > 0) {
    factura.total_cobrado = round2((Number(factura.total_cobrado) || 0) + aplicar);
  } else {
    factura.total_cobrado = round2((Number(factura.total_cobrado) || 0) - aplicar);
  }

  const nuevoSaldo = round2((Number(factura.total_factura) || 0) - (Number(factura.total_cobrado) || 0));
  factura.saldo_pendiente = nuevoSaldo;
  factura.estado = calcularEstadoTrasSaldo(factura, nuevoSaldo);
  return aplicar;
}

async function cargarFactura(id) {
  const r = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
  );
  return r.Item || null;
}

function buildPagoCompensacion(factura, id_pago, opts) {
  return {
    id_entrada: `${factura.id_factura}#${id_pago}`,
    id_factura: factura.id_factura,
    id_pago,
    fecha: opts.fechaIso,
    importe: opts.importe,
    metodo_pago: METODO_PAGO_COMPENSACION,
    cuenta_caja: '',
    referencia: opts.referencia || '',
    observaciones: opts.observaciones || '',
    justificante: '',
    recibo_file_key: '',
    recibo_nombre: '',
    compensacion_grupo_id: opts.grupoId,
    compensacion_con: opts.compensacionCon || [],
    creado_por: opts.usuario_id || '',
    creado_en: now(),
  };
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
      conteoPagos.set(id, pagos.length);
    }),
  );
  return conteoPagos;
}

async function persistirCompensacionTransaccion(items) {
  const bloques = [];
  for (let i = 0; i < items.length; i += 100) {
    bloques.push(items.slice(i, i + 100));
  }
  for (const bloque of bloques) {
    await docClient.send(new TransactWriteCommand({ TransactItems: bloque }));
  }
}

/**
 * @param {object} opts
 * @param {string} opts.id_factura_origen
 * @param {string[]} opts.facturas_compensar
 * @param {number} opts.importe
 * @param {string} opts.fecha
 */
export async function registrarPagoCompensacion(opts) {
  const {
    id_factura_origen,
    facturas_compensar = [],
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

  const idsDestino = [...new Set(facturas_compensar.map((x) => String(x).trim()).filter(Boolean))];
  if (idsDestino.length === 0) {
    throw Object.assign(new Error('Selecciona al menos una factura a compensar'), { status: 400 });
  }

  const origen = await cargarFactura(id_factura_origen);
  if (!origen) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });
  if (origen.tipo !== 'IN') {
    throw Object.assign(new Error('La compensación solo está disponible en facturas de gasto'), { status: 400 });
  }
  if (origen.estado === 'anulada' || origen.estado === 'borrador' || origen.estado === 'pagada') {
    throw Object.assign(new Error('La factura origen no admite compensación en su estado actual'), { status: 400 });
  }
  if (!ESTADOS_COMPENSABLES.has(String(origen.estado || ''))) {
    throw Object.assign(new Error('La factura origen no admite compensación en su estado actual'), { status: 400 });
  }

  const capOrigen = capacidadCompensacionFactura(origen);
  if (capOrigen < 0.001) {
    throw Object.assign(new Error('La factura origen no tiene saldo pendiente'), { status: 400 });
  }

  const destinos = [];
  for (const id of idsDestino) {
    if (id === id_factura_origen) {
      throw Object.assign(new Error('No puedes compensar una factura consigo misma'), { status: 400 });
    }
    const f = await cargarFactura(id);
    if (!f) throw Object.assign(new Error(`Factura no encontrada: ${id}`), { status: 404 });
    if (!esFacturaCompensable(origen, f)) {
      throw Object.assign(
        new Error(`La factura ${etiquetaFacturaCompensable(f)} no es compensable con la origen (sociedad/proveedor/estado/saldo)`),
        { status: 400 },
      );
    }
    destinos.push(f);
  }

  destinos.sort((a, b) => {
    const cmp = String(a.fecha_emision || '').localeCompare(String(b.fecha_emision || ''));
    if (cmp !== 0) return cmp;
    return String(a.id_factura || '').localeCompare(String(b.id_factura || ''));
  });

  const capDestinos = round2(destinos.reduce((s, f) => s + capacidadCompensacionFactura(f), 0));
  const maxPermitido = round2(Math.min(capOrigen, capDestinos));
  if (importeNum > maxPermitido + 0.001) {
    throw Object.assign(
      new Error(`Importe ${importeNum} supera el máximo compensable (${maxPermitido})`),
      { status: 400 },
    );
  }

  const grupoId = crypto.randomUUID();
  let restante = importeNum;
  const reparto = [];

  for (const dest of destinos) {
    if (restante <= 0.001) break;
    const cap = capacidadCompensacionFactura(dest);
    const aplicar = round2(Math.min(restante, cap));
    if (aplicar <= 0) continue;
    reparto.push({ factura: dest, importe: aplicar });
    restante = round2(restante - aplicar);
  }

  if (reparto.length === 0 || restante > 0.001) {
    throw Object.assign(new Error('No se pudo repartir el importe entre las facturas seleccionadas'), { status: 400 });
  }

  const idsDestinoRep = reparto.map((r) => r.factura.id_factura);
  const refOrigen = idsDestinoRep.join(', ');
  const etiquetaOrigen = etiquetaFacturaCompensable(origen);

  const origenMut = { ...origen };
  const aplicadoOrigen = aplicarCompensacionAFactura(origenMut, importeNum);
  if (aplicadoOrigen < importeNum - 0.001) {
    throw Object.assign(new Error('No se pudo aplicar la compensación en la factura origen'), { status: 400 });
  }

  origenMut.modificado_por = usuario_id || '';
  origenMut.modificado_en = now();

  const idsInvolucrados = [
    origenMut.id_factura,
    ...reparto.map((r) => r.factura.id_factura),
  ];
  const conteoPagos = await cargarConteosPagos(idsInvolucrados);

  const idPagoOrigen = allocIdPago(origenMut.id_factura, conteoPagos);
  const pagoOrigen = buildPagoCompensacion(origenMut, idPagoOrigen, {
    fechaIso,
    importe: importeNum,
    referencia: refOrigen,
    observaciones:
      (observaciones ? `${observaciones.trim()} · ` : '') +
      `Compensación con: ${idsDestinoRep.map((id) => id).join(', ')}`,
    grupoId,
    compensacionCon: idsDestinoRep,
    usuario_id,
  });

  const pagosDestino = [];
  const facturasDestino = [];
  const transactItems = [
    { Put: { TableName: tables.facturas, Item: origenMut } },
    { Put: { TableName: tables.facturasPagos, Item: pagoOrigen } },
  ];

  for (const { factura: destRaw, importe: impDest } of reparto) {
    const destMut = { ...destRaw };
    const aplicado = aplicarCompensacionAFactura(destMut, impDest);
    if (aplicado < impDest - 0.001) {
      throw Object.assign(new Error(`Error al aplicar compensación en ${destMut.id_factura}`), { status: 500 });
    }
    destMut.modificado_por = usuario_id || '';
    destMut.modificado_en = now();

    const idPagoDest = allocIdPago(destMut.id_factura, conteoPagos);
    const pagoDest = buildPagoCompensacion(destMut, idPagoDest, {
      fechaIso,
      importe: impDest,
      referencia: origenMut.id_factura,
      observaciones: `Compensación con factura ${etiquetaOrigen}`,
      grupoId,
      compensacionCon: [origenMut.id_factura],
      usuario_id,
    });

    transactItems.push({ Put: { TableName: tables.facturas, Item: destMut } });
    transactItems.push({ Put: { TableName: tables.facturasPagos, Item: pagoDest } });
    pagosDestino.push(pagoDest);
    facturasDestino.push(destMut);
  }

  await persistirCompensacionTransaccion(transactItems);

  for (const destMut of facturasDestino) {
    await registrarAuditoria(destMut.id_factura, 'pago_compensacion', usuario_id, usuario_nombre, {
      importe: pagosDestino.find((p) => p.id_factura === destMut.id_factura)?.importe,
      origen: origenMut.id_factura,
      grupoId,
    });
  }

  await registrarAuditoria(origenMut.id_factura, 'pago_compensacion', usuario_id, usuario_nombre, {
    importe: importeNum,
    destinos: idsDestinoRep,
    grupoId,
  });

  return {
    ok: true,
    compensacion_grupo_id: grupoId,
    pago: pagoOrigen,
    factura: origenMut,
    destinos: facturasDestino.map((f, i) => ({ factura: f, pago: pagosDestino[i] })),
  };
}

export function filtrarFacturasCompensables(origen, todasFacturas) {
  if (!origen || origen.tipo !== 'IN') return [];
  return (todasFacturas || []).filter((f) => esFacturaCompensable(origen, f));
}
