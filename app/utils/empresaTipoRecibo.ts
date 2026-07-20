import { labelFormaPago, mapTipoReciboToFormaPago, type FormaPagoClave } from './facturacion';

/** Compatible con ítems de GET /api/empresas (Dynamo / front mapeado). */
export type EmpresaConTipoRecibo = {
  id_empresa?: string;
  Cif?: string;
  cif?: string;
  Nombre?: string;
  Etiqueta?: string[];
  tipoRecibo?: string;
  'Tipo de recibo'?: string;
};

/** Estados IN con saldo pendiente de gestionar en tesorería. */
export const ESTADOS_FACTURA_COLA_PAGO = new Set([
  'pendiente_pago',
  'parcialmente_pagada',
  'vencida',
]);

export type FiltroColaPago = 'todos' | 'cola_transferencia' | 'otro_metodo';

export type FacturaRefFormaPago = {
  estado?: string | null;
  forma_pago?: string | null;
  empresa_id?: string | null;
  empresa_cif?: string | null;
};

function normalizeCif(val: unknown): string {
  return String(val ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function tipoReciboDeEmpresa(e: EmpresaConTipoRecibo): string {
  return String(e.tipoRecibo ?? e['Tipo de recibo'] ?? '').trim();
}

function etiquetasDeEmpresa(e: EmpresaConTipoRecibo | undefined): string[] {
  if (!e?.Etiqueta) return [];
  if (!Array.isArray(e.Etiqueta)) {
    const uno = String(e.Etiqueta).trim();
    return uno ? [uno] : [];
  }
  return e.Etiqueta.map((t) => String(t).trim()).filter(Boolean);
}

/** Busca empresa en catálogo por id_empresa o CIF (proveedor / emisor). */
export function getEmpresaFromCatalog(
  empresas: EmpresaConTipoRecibo[] | undefined | null,
  empresaId: string | undefined | null,
  empresaCif?: string | undefined | null,
): EmpresaConTipoRecibo | undefined {
  if (!empresas?.length) return undefined;
  const id = (empresaId ?? '').trim();
  if (id) {
    const e = empresas.find((x) => String(x?.id_empresa ?? '').trim() === id);
    if (e) return e;
  }
  const cif = normalizeCif(empresaCif);
  if (cif) {
    return empresas.find((x) => normalizeCif(x.Cif ?? x.cif) === cif);
  }
  return undefined;
}

/**
 * Lee «Tipo de recibo» desde una lista ya cargada (evita GET /empresas en cada modal).
 * Busca por id_empresa y, si no hay match, por CIF normalizado.
 */
export function getTipoReciboFromEmpresasList(
  empresas: EmpresaConTipoRecibo[] | undefined | null,
  empresaId: string | undefined | null,
  empresaCif?: string | undefined | null,
): string {
  const e = getEmpresaFromCatalog(empresas, empresaId, empresaCif);
  return e ? tipoReciboDeEmpresa(e) : '';
}

/** Etiquetas del proveedor según maestro de empresas (campo Etiqueta). */
export function getProveedorEtiquetasFromEmpresasList(
  empresas: EmpresaConTipoRecibo[] | undefined | null,
  empresaId: string | undefined | null,
  empresaCif?: string | undefined | null,
): string[] {
  return etiquetasDeEmpresa(getEmpresaFromCatalog(empresas, empresaId, empresaCif));
}

/** Lista única de etiquetas definidas en el maestro de empresas (orden alfabético). */
export function listEtiquetasUnicasEmpresas(
  empresas: EmpresaConTipoRecibo[] | undefined | null,
): string[] {
  const canon = new Map<string, string>();
  for (const e of empresas ?? []) {
    for (const t of etiquetasDeEmpresa(e)) {
      const k = t.toLowerCase();
      if (!canon.has(k)) canon.set(k, t);
    }
  }
  return [...canon.values()].sort((a, b) => a.localeCompare(b, 'es'));
}

/** True si la factura tiene proveedor con al menos una etiqueta seleccionada. */
export function facturaProveedorCoincideEtiquetas(
  factura: { empresa_id?: string | null; empresa_cif?: string | null },
  etiquetasSeleccionadas: string[],
  empresas: EmpresaConTipoRecibo[] | undefined | null,
): boolean {
  if (!etiquetasSeleccionadas.length) return true;
  const tags = getProveedorEtiquetasFromEmpresasList(
    empresas,
    factura.empresa_id,
    factura.empresa_cif,
  );
  const sel = new Set(etiquetasSeleccionadas.map((t) => t.trim().toLowerCase()));
  return tags.some((t) => sel.has(t.trim().toLowerCase()));
}

/** Indica si el texto de «Tipo de recibo» se interpreta como transferencia bancaria. */
export function esTipoReciboTransferencia(tipoRecibo: string | null | undefined): boolean {
  return mapTipoReciboToFormaPago(tipoRecibo).clave === 'transferencia';
}

export type ProveedorTipoReciboAviso = {
  key: string;
  nombre: string;
  /** Texto legible del tipo de recibo en ficha (o etiqueta de forma de pago). */
  tipoReciboLabel: string;
};

type FacturaProveedorRef = {
  empresa_id?: string | null;
  empresa_cif?: string | null;
  empresa_nombre?: string | null;
};

/**
 * Proveedores únicos cuyo «Tipo de recibo» en ficha no es transferencia.
 * Vacío en ficha cuenta como transferencia (convención mapTipoReciboToFormaPago).
 */
export function listProveedoresNoTransferenciaRemesa(
  facturas: FacturaProveedorRef[],
  empresas: EmpresaConTipoRecibo[] | undefined | null,
): ProveedorTipoReciboAviso[] {
  const map = new Map<string, ProveedorTipoReciboAviso>();
  for (const f of facturas) {
    const id = String(f.empresa_id ?? '').trim();
    const cif = normalizeCif(f.empresa_cif);
    const key = id || cif || String(f.empresa_nombre ?? '').trim();
    if (!key) continue;
    const tipoRaw = getTipoReciboFromEmpresasList(empresas, id, cif);
    if (esTipoReciboTransferencia(tipoRaw)) continue;
    if (map.has(key)) continue;
    const { clave, otroTexto } = mapTipoReciboToFormaPago(tipoRaw);
    const tipoReciboLabel = tipoRaw || (clave === 'otro' ? otroTexto : labelFormaPago(clave));
    map.set(key, {
      key,
      nombre: String(f.empresa_nombre ?? '—').trim() || '—',
      tipoReciboLabel: tipoReciboLabel || '—',
    });
  }
  return [...map.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/** Forma de pago efectiva: `forma_pago` de la factura o tipo de recibo del proveedor. */
export function resolverFormaPagoEfectiva(
  factura: Pick<FacturaRefFormaPago, 'forma_pago' | 'empresa_id' | 'empresa_cif'>,
  empresas: EmpresaConTipoRecibo[] | undefined | null,
): FormaPagoClave {
  const fp = String(factura.forma_pago ?? '').trim();
  if (fp) {
    return mapTipoReciboToFormaPago(fp).clave;
  }
  const tipoRecibo = getTipoReciboFromEmpresasList(empresas, factura.empresa_id, factura.empresa_cif);
  return mapTipoReciboToFormaPago(tipoRecibo).clave;
}

/** Factura pendiente de pago cuyo método esperado es transferencia (cola de trabajo manual/remesa). */
export function esFacturaColaTransferencia(
  factura: FacturaRefFormaPago,
  empresas: EmpresaConTipoRecibo[] | undefined | null,
): boolean {
  const estado = String(factura.estado ?? '').trim();
  if (!ESTADOS_FACTURA_COLA_PAGO.has(estado)) return false;
  return resolverFormaPagoEfectiva(factura, empresas) === 'transferencia';
}

/** Factura pendiente con método distinto de transferencia (tarjeta, efectivo, remesa en ficha…). */
export function esFacturaOtroMetodoPago(
  factura: FacturaRefFormaPago,
  empresas: EmpresaConTipoRecibo[] | undefined | null,
): boolean {
  const estado = String(factura.estado ?? '').trim();
  if (!ESTADOS_FACTURA_COLA_PAGO.has(estado)) return false;
  return resolverFormaPagoEfectiva(factura, empresas) !== 'transferencia';
}

export function filtrarFacturasPorColaPago<T extends FacturaRefFormaPago>(
  facturas: T[],
  filtro: FiltroColaPago,
  empresas: EmpresaConTipoRecibo[] | undefined | null,
): T[] {
  if (filtro === 'todos') return facturas;
  if (filtro === 'cola_transferencia') {
    return facturas.filter((f) => esFacturaColaTransferencia(f, empresas));
  }
  return facturas.filter((f) => esFacturaOtroMetodoPago(f, empresas));
}
