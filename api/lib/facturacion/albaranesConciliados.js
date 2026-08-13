/**
 * Sanea el array `albaranes_conciliados` de una factura IN.
 * Fuerza id/numero/fecha de factura desde ctx; asignado_en si falta.
 */

function str(v) {
  return v == null ? '' : String(v).trim();
}

function toBase(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Normaliza a YYYY-MM-DD si es posible; si no, string limpio. */
function fechaDia(v) {
  const s = str(v);
  if (!s) return '';
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return s;
}

/**
 * @param {unknown} raw
 * @param {{
 *   id_factura: string,
 *   numero_factura: string,
 *   fecha_factura: string,
 *   ahoraIso: string,
 *   asignado_por?: string,
 *   asignado_por_id?: string,
 * }} ctx
 * @returns {{ ok: true, items: object[] } | { ok: false, error: string }}
 */
export function sanitizeAlbaranesConciliados(raw, ctx) {
  if (raw == null) {
    return { ok: true, items: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'albaranes_conciliados debe ser un array' };
  }

  const idFactura = str(ctx.id_factura);
  const numeroFactura = str(ctx.numero_factura);
  const fechaFactura = fechaDia(ctx.fecha_factura);
  const ahora = str(ctx.ahoraIso) || new Date().toISOString();
  const defaultPor = str(ctx.asignado_por);
  const defaultPorId = str(ctx.asignado_por_id);

  const items = [];
  const seen = new Set();

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `albaranes_conciliados[${i}]: item inválido` };
    }

    const key = str(row.key);
    if (!key) {
      return { ok: false, error: `albaranes_conciliados[${i}]: key obligatorio` };
    }
    if (seen.has(key)) {
      return { ok: false, error: `albaranes_conciliados[${i}]: key duplicado (${key})` };
    }
    seen.add(key);

    const asignadoEn = str(row.asignado_en) || ahora;

    items.push({
      key,
      serie: str(row.serie),
      numero: str(row.numero),
      fecha_albaran: fechaDia(row.fecha_albaran),
      base: toBase(row.base),
      // Siempre desde factura del servidor (no confiar en el body)
      id_factura: idFactura,
      numero_factura: numeroFactura,
      fecha_factura: fechaFactura,
      asignado_en: asignadoEn,
      asignado_por: str(row.asignado_por) || defaultPor,
      asignado_por_id: str(row.asignado_por_id) || defaultPorId,
    });
  }

  return { ok: true, items };
}

/** Número de factura visible en conciliación: proveedor si hay, si no interno. */
export function numeroFacturaParaConciliacion(factura) {
  const prov = str(factura?.numero_factura_proveedor);
  if (prov) return prov;
  return str(factura?.numero_factura);
}
