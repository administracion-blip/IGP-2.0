import { normalizeCif } from '../empresaCif.js';
import { fechaEmisionFacturaAIso } from './idDocumento.js';

/** Nº factura proveedor normalizado (espacios, guiones, barras). */
export function normNumeroFacturaProveedor(s) {
  return String(s ?? '').toUpperCase().replace(/[\s\-/.]/g, '');
}

/** Año yyyy de la fecha de emisión; vacío si no parsea. */
export function anioEmisionFactura(raw) {
  const iso = fechaEmisionFacturaAIso(raw);
  return iso ? iso.slice(0, 4) : '';
}

/**
 * Duplicado de factura recibida: mismo CIF proveedor + mismo nº factura + mismo año.
 * Sin los tres datos completos no se considera coincidencia.
 */
export function esDuplicadoFacturaProveedor(ref, existente) {
  const cif = normalizeCif(ref.proveedor_cif ?? ref.empresa_cif ?? '');
  const doc = normNumeroFacturaProveedor(ref.numero_factura_proveedor);
  const anio = anioEmisionFactura(ref.fecha_emision);
  if (!cif || !doc || !anio) return false;

  const cifE = normalizeCif(existente.empresa_cif ?? existente.proveedor_cif ?? '');
  const docE = normNumeroFacturaProveedor(existente.numero_factura_proveedor);
  const anioE = anioEmisionFactura(existente.fecha_emision);

  return cif === cifE && doc === docE && anio === anioE;
}
