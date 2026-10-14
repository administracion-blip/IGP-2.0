/**
 * Vencimiento por defecto de las facturas de gasto (`IN`) a partir del plazo
 * del proveedor. Las ventas no pasan por aquí: ver
 * `vencimientoVentaPorCondiciones`.
 *
 * Orden: el vencimiento que ya traiga la factura manda siempre; si no hay,
 * los días de `condiciones_pago`; y si tampoco, el `Vencimiento` del proveedor
 * (`empresa_id`) en el maestro de empresas.
 */

import { buscarEmpresaPorIdEmpresa } from './ibanCongelado.js';
import { parseDiasPlazo, condicionesDesdeDias, calcularFechaVencimiento } from './plazoVencimiento.js';

function texto(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Días de plazo del proveedor en el maestro, o null si no tiene (o no se pudo
 * leer: un fallo del maestro no debe impedir registrar la factura).
 * @param {unknown} idEmpresa
 * @param {Map<string, number|null>} [cache] evita releer el maestro en tandas
 * @returns {Promise<number|null>}
 */
export async function diasPlazoProveedor(idEmpresa, cache = new Map()) {
  const id = texto(idEmpresa);
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  let dias = null;
  try {
    const empresa = await buscarEmpresaPorIdEmpresa(id);
    dias = parseDiasPlazo(empresa?.Vencimiento);
  } catch (e) {
    console.error('[facturación] plazo de vencimiento del proveedor:', e.message);
  }
  cache.set(id, dias);
  return dias;
}

/**
 * Rellena `fecha_vencimiento` (y `condiciones_pago` si está vacío) en la
 * factura de gasto. No toca nada si no es `IN` o si ya trae vencimiento.
 * @param {object} factura se modifica en el sitio
 * @param {{ cache?: Map<string, number|null> }} [opciones]
 * @returns {Promise<{ dias: number, origen: 'condiciones'|'proveedor' }|null>} null si no se ha rellenado
 */
export async function completarVencimientoFactura(factura, { cache = new Map() } = {}) {
  if (!factura || factura.tipo !== 'IN' || texto(factura.fecha_vencimiento)) return null;
  let dias = parseDiasPlazo(factura.condiciones_pago);
  let origen = 'condiciones';
  if (dias == null) {
    dias = await diasPlazoProveedor(factura.empresa_id, cache);
    origen = 'proveedor';
  }
  if (dias == null) return null;
  const vencimiento = calcularFechaVencimiento(factura.fecha_emision, dias);
  if (!vencimiento) return null;
  factura.fecha_vencimiento = vencimiento;
  if (!texto(factura.condiciones_pago)) factura.condiciones_pago = condicionesDesdeDias(dias);
  return { dias, origen };
}
