/**
 * En facturas de gasto (IN), la sociedad GRUPO PARIPE (receptora → emisor_*)
 * y el proveedor externo (empresa_*) no pueden ser la misma entidad.
 */

import { normalizeCif } from '../empresaCif.js';

function normNombreEmpresa(val) {
  return String(val ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Record<string, unknown>} b Borrador OCR o payload de confirmación.
 */
export function proveedorCoincideConSociedad(b) {
  const socCif = normalizeCif(b.sociedad_grupo_cif || b.emisor_cif || '');
  const provCif = normalizeCif(b.proveedor_cif || b.empresa_cif || '');
  if (socCif.length >= 6 && provCif.length >= 6 && socCif === provCif) return true;

  const socNom = normNombreEmpresa(b.sociedad_grupo_nombre || b.emisor_nombre);
  const provNom = normNombreEmpresa(b.proveedor_nombre || b.empresa_nombre);
  if (socNom && provNom && socNom === provNom) return true;

  const socId = String(b.sociedad_grupo_id || b.emisor_id || '').trim();
  const empId = String(b.empresa_id || '').trim();
  if (socId && empId && socId === empId) return true;

  return false;
}

export const ERROR_PROVEEDOR_IGUAL_SOCIEDAD =
  'El proveedor no puede coincidir con la empresa del grupo (GRUPO PARIPE) en uno o más borradores.';
