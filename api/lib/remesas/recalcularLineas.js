import { evaluarFacturaParaRemesa } from './resolverDatos.js';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Edición de líneas de una remesa desde el cliente.
 *
 * Del cliente solo se acepta `importe` y `concepto` de facturas que ya están en
 * la remesa. IBAN, importe máximo, proveedor, saldo… salen siempre de la línea
 * guardada, que se construyó desde la factura con `evaluarFacturaParaRemesa`.
 * Las facturas nuevas no entran por aquí (van por `anadirFacturaIds`), y las
 * existentes que no vengan en la lista se quitan.
 */
export function normalizarLineasEntrada(raw, existentes = []) {
  if (!Array.isArray(raw)) return existentes;
  const mapExistentes = new Map((existentes || []).map((l) => [l.id_factura, l]));
  const vistas = new Set();
  const out = [];
  for (const l of raw) {
    const id = String(l?.id_factura || '').trim();
    const prev = mapExistentes.get(id);
    if (!prev || vistas.has(id)) continue;
    vistas.add(id);
    const importeMax = round2(Number(prev.importeMaximo ?? prev.saldoPendiente ?? prev.importe) || 0);
    let importe = round2(Number(l.importe ?? prev.importe) || 0);
    if (importe > importeMax) importe = importeMax;
    if (importe < 0) importe = 0;
    out.push({
      ...prev,
      importe,
      importeMaximo: importeMax,
      concepto: String(l.concepto ?? prev.concepto ?? '').slice(0, 140),
    });
  }
  return out;
}

/**
 * Recalcula cada línea de la remesa desde la factura actual: IBAN beneficiario y
 * datos del proveedor del maestro/factura, importe limitado al pendiente de hoy.
 * Si alguna factura ya no es remesable o aparece repetida devuelve `ok: false` con las inválidas,
 * para no generar un fichero ni ejecutar pagos con parte de las líneas.
 *
 * @param {object} remesa
 * @param {{ cargarFactura: (id: string) => Promise<object|null>,
 *           cargarLineasFactura: (id: string) => Promise<object[]>,
 *           empresasIdx: { byId: Map, byCif: Map } }} deps
 */
export async function recalcularLineasRemesa(remesa, { cargarFactura, cargarLineasFactura, empresasIdx }) {
  const lineas = [];
  const invalidas = [];
  const vistas = new Set();
  for (const linea of remesa.lineas || []) {
    const idNormalizado = String(linea.id_factura ?? '').trim();
    if (vistas.has(idNormalizado)) {
      invalidas.push({ id_factura: linea.id_factura, motivo: 'Factura duplicada en la remesa' });
      continue;
    }
    vistas.add(idNormalizado);
    const factura = await cargarFactura(linea.id_factura);
    if (!factura) {
      invalidas.push({ id_factura: linea.id_factura, motivo: 'Factura no encontrada' });
      continue;
    }
    const lineasFactura = await cargarLineasFactura(linea.id_factura);
    const ev = evaluarFacturaParaRemesa(factura, lineasFactura, remesa.sociedadId, empresasIdx);
    if (ev.excluida || !ev.linea) {
      invalidas.push(ev.excluida || { id_factura: linea.id_factura, motivo: 'Factura no válida para la remesa' });
      continue;
    }
    const importePrev = round2(Number(linea.importe) || 0);
    lineas.push({
      ...ev.linea,
      id_factura: linea.id_factura,
      importe: Math.max(0, Math.min(importePrev, ev.linea.importeMaximo)),
      concepto: String(linea.concepto || ev.linea.concepto || '').slice(0, 140),
    });
  }
  return invalidas.length > 0 ? { ok: false, invalidas } : { ok: true, lineas };
}
