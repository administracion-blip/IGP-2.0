/**
 * Facturas incluidas en remesas activas: Borrador / Generada, y las facturas de
 * `lineasPendientesPago` de una remesa Ejecutada (el banco ya tiene el fichero:
 * meterlas en otra remesa o pagarlas a mano sería pagarlas dos veces).
 * Enfoque B: flag derivado `remesaActiva`, sin estado `en_remesa` en la factura.
 */
import { remesasActivas } from '../facturacion/consultaIndice.js';

export const ESTADOS_ACTIVOS = new Set(['Borrador', 'Generada']);

/** Ids de factura que mantienen activa la remesa `rem`. */
function facturasActivasDeRemesa(rem) {
  if (ESTADOS_ACTIVOS.has(rem?.estado)) return (rem.lineas || []).map((l) => l?.id_factura);
  if (rem?.estado === 'Ejecutada' && Array.isArray(rem.lineasPendientesPago)) return rem.lineasPendientesPago;
  return [];
}

/**
 * @param {object|null|undefined} rem
 * @returns {{ remesaId: string, nombre: string, estado: string }|null}
 */
export function infoRemesaActiva(rem) {
  if (!rem) return null;
  return {
    remesaId: rem.remesaId,
    nombre: rem.nombre || '',
    estado: rem.estado,
  };
}

/**
 * Devuelve la remesa activa que incluye la factura, o null.
 * @param {object[]} remesas
 * @param {string} facturaId
 * @param {string|null} [excludeRemesaId]
 */
export function facturaEnRemesaActiva(remesas, facturaId, excludeRemesaId = null) {
  if (!facturaId) return null;
  for (const rem of remesas || []) {
    if (excludeRemesaId && rem.remesaId === excludeRemesaId) continue;
    if (facturasActivasDeRemesa(rem).some((id) => String(id) === String(facturaId))) {
      return rem;
    }
  }
  return null;
}

/**
 * Índice id_factura → { remesaId, nombre, estado } para remesas activas.
 * Si una factura aparece en varias (no debería), prevalece la primera encontrada.
 * @param {object[]} remesas
 * @returns {Map<string, { remesaId: string, nombre: string, estado: string }>}
 */
export function indexRemesasActivasPorFactura(remesas) {
  const map = new Map();
  for (const rem of remesas || []) {
    const ids = facturasActivasDeRemesa(rem);
    if (ids.length === 0) continue;
    const info = infoRemesaActiva(rem);
    for (const id of ids) {
      if (!id || map.has(id)) continue;
      map.set(id, info);
    }
  }
  return map;
}

/**
 * Remesas del índice Activa + lookup de la que incluye la factura.
 * Ejecutada solo sigue activa si conserva `lineasPendientesPago`.
 * @param {string} facturaId
 * @returns {Promise<{ remesaId: string, nombre: string, estado: string }|null>}
 */
export async function findRemesaActivaDeFactura(facturaId) {
  if (!facturaId) return null;
  const remesas = await remesasActivas();
  return infoRemesaActiva(facturaEnRemesaActiva(remesas, facturaId));
}
