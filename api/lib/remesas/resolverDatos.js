import { normalizeCif, getCifFromEmpresaItem, getIdEmpresaFromItem } from '../empresaCif.js';
import { validarIban, limpiarIban } from './iban.js';
import { ibanPredeterminadoDeEmpresa } from '../empresaIban.js';
import { buildConceptoRemesa, resumenDescripcionFactura } from './concepto.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function ibanAltFromEmpresaItem(item) {
  if (!item) return '';
  return limpiarIban(item.IbanAlternativo ?? item.ibanAlternativo ?? '');
}

/**
 * Índice de empresas por id y por CIF normalizado.
 * @param {object[]} empresasItems
 */
export function indexarEmpresas(empresasItems) {
  const byId = new Map();
  const byCif = new Map();
  for (const item of empresasItems || []) {
    const id = getIdEmpresaFromItem(item);
    if (id) byId.set(id, item);
    const cif = normalizeCif(getCifFromEmpresaItem(item));
    if (cif && !byCif.has(cif)) byCif.set(cif, item);
  }
  return { byId, byCif };
}

/* ── Por qué el maestro manda sobre el IBAN congelado en la factura ──────────
 *
 * Parece un bug —lo normal es respetar el dato congelado del documento— pero es
 * deliberado: el dinero sale a la cuenta que el proveedor tiene HOY, no a la que
 * tenía el día que se registró la factura. El maestro de empresas es la fuente
 * de verdad y se mantiene al día; si un proveedor cambia de banco, una factura
 * de hace seis meses debe pagarse igualmente en la cuenta nueva.
 *
 * El valor congelado no se descarta: queda como último recurso para que un hueco
 * en el maestro no deje sin remesar una factura que hoy se paga sin problemas.
 *
 * Orden de preferencia (el primero que valide gana), igual para ordenante y
 * beneficiario:
 *   1. cuenta predeterminada actual de la empresa en el maestro,
 *   2. IBAN congelado en la factura,
 *   3. IBAN alternativo congelado en la factura,
 *   4. `IbanAlternativo` del maestro.
 */

/**
 * IBAN beneficiario (proveedor) — factura IN: campos empresa_*.
 * @param {object} factura
 * @param {{ byId: Map, byCif: Map }} empresasIdx
 */
export function resolverIbanBeneficiario(factura, empresasIdx) {
  // El proveedor se busca por id y, si no aparece, por CIF: hay facturas
  // antiguas sin `empresa_id`. Solo una ficha entra en la cascada, la misma que
  // elige la pantalla: si un CIF estuviera duplicado en el maestro, meter las
  // dos fichas haría que la remesa pagase a una cuenta que el usuario no ha
  // visto en ningún sitio.
  let emp = null;
  if (factura.empresa_id && empresasIdx.byId.has(factura.empresa_id)) {
    emp = empresasIdx.byId.get(factura.empresa_id);
  } else {
    const cif = normalizeCif(factura.empresa_cif);
    if (cif && empresasIdx.byCif.has(cif)) emp = empresasIdx.byCif.get(cif);
  }

  const candidatos = [
    ibanPredeterminadoDeEmpresa(emp),
    factura.empresa_iban,
    factura.empresa_iban_alternativo,
    ibanAltFromEmpresaItem(emp),
  ];

  for (const raw of candidatos) {
    const v = validarIban(limpiarIban(raw));
    if (v.valido) return v;
  }
  return { valido: false, iban: '', motivo: 'Sin IBAN válido del proveedor' };
}

/**
 * IBAN cuenta ordenante — factura IN: emisor_* (sociedad GRUPO PARIPE).
 */
export function resolverIbanOrdenante(emisorId, factura, empresasIdx) {
  const emp = emisorId && empresasIdx.byId.has(emisorId) ? empresasIdx.byId.get(emisorId) : null;
  const candidatos = [
    ibanPredeterminadoDeEmpresa(emp),
    factura?.emisor_iban,
    factura?.emisor_iban_alternativo,
    ibanAltFromEmpresaItem(emp),
  ];
  for (const raw of candidatos) {
    const v = validarIban(limpiarIban(raw));
    if (v.valido) return v;
  }
  return { valido: false, iban: '', motivo: 'Sin IBAN válido de la sociedad ordenante' };
}

export function calcularSaldoPendiente(factura) {
  const total = round2(Number(factura.total_factura) || 0);
  const cobrado = round2(Number(factura.total_cobrado) || 0);
  if (factura.saldo_pendiente != null && factura.saldo_pendiente !== '') {
    return Math.max(0, round2(Number(factura.saldo_pendiente)));
  }
  return Math.max(0, round2(total - cobrado));
}

const ESTADOS_PAGABLES = new Set(['pendiente_pago', 'parcialmente_pagada', 'vencida']);

/**
 * Construye línea o exclusión desde una factura IN.
 */
export function evaluarFacturaParaRemesa(factura, lineasFactura, sociedadId, empresasIdx) {
  const id = factura.id_factura || factura.id_entrada;
  if (!id) {
    return { excluida: { id_factura: '', motivo: 'Factura sin identificador' } };
  }
  if (factura.tipo !== 'IN') {
    return { excluida: { id_factura: id, motivo: 'No es factura de gasto (IN)' } };
  }
  if (!ESTADOS_PAGABLES.has(factura.estado)) {
    return { excluida: { id_factura: id, motivo: `Estado no pagable: ${factura.estado}` } };
  }
  const emisorId = String(factura.emisor_id || '').trim();
  if (!emisorId || emisorId !== String(sociedadId || '').trim()) {
    return { excluida: { id_factura: id, motivo: 'No pertenece a la sociedad ordenante seleccionada' } };
  }
  const pendiente = calcularSaldoPendiente(factura);
  if (pendiente <= 0) {
    return { excluida: { id_factura: id, motivo: 'Sin saldo pendiente' } };
  }
  const ibanRes = resolverIbanBeneficiario(factura, empresasIdx);
  if (!ibanRes.valido) {
    return {
      excluida: {
        id_factura: id,
        numero_factura: factura.numero_factura,
        proveedorNombre: factura.empresa_nombre,
        motivo: ibanRes.motivo || 'IBAN inválido',
      },
    };
  }
  const descripcionResumen = resumenDescripcionFactura(null, factura.observaciones);
  const concepto = buildConceptoRemesa({
    numeroFacturaProveedor: factura.numero_factura_proveedor,
    numeroFactura: factura.numero_factura,
    proveedorNombre: factura.empresa_nombre,
    descripcionResumen,
  });

  return {
    linea: {
      id_factura: id,
      numero_factura: factura.numero_factura || '',
      numero_factura_proveedor: factura.numero_factura_proveedor || '',
      proveedorNombre: factura.empresa_nombre || '',
      proveedorCif: factura.empresa_cif || '',
      ibanBeneficiario: ibanRes.iban,
      importe: pendiente,
      importeMaximo: pendiente,
      totalFactura: round2(Number(factura.total_factura) || 0),
      totalPagado: round2(Number(factura.total_cobrado) || 0),
      saldoPendiente: pendiente,
      concepto,
    },
  };
}
