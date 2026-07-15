const SEP = ' · ';
const MAX_CONCEPTO = 140;

/**
 * Resumen de descripción desde líneas de factura u observaciones.
 * @param {{ descripcion?: string }[]} lineas
 * @param {string} observaciones
 * @param {number} maxLen
 */
export function resumenDescripcionFactura(lineas, observaciones, maxLen = 80) {
  const textos = [];
  if (Array.isArray(lineas)) {
    for (const l of lineas) {
      const d = String(l?.descripcion ?? '').trim();
      if (d && !textos.includes(d)) textos.push(d);
    }
  }
  let base = textos.join(SEP);
  if (!base) {
    base = String(observaciones ?? '').trim().replace(/\s+/g, ' ');
  }
  if (!base) return '';
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen).trim();
}

/**
 * Concepto FIT: nº factura proveedor · proveedor · descripción (máx 140).
 * @param {object} opts
 * @param {string} opts.numeroFacturaProveedor
 * @param {string} opts.numeroFactura
 * @param {string} opts.proveedorNombre
 * @param {string} [opts.descripcionResumen]
 */
export function buildConceptoRemesa({
  numeroFacturaProveedor,
  numeroFactura,
  proveedorNombre,
  descripcionResumen = '',
}) {
  const num = String(numeroFacturaProveedor || numeroFactura || '').trim();
  const prov = String(proveedorNombre || '').trim();
  const desc = String(descripcionResumen || '').trim();

  const partes = [num, prov, desc].filter(Boolean);
  if (partes.length === 0) return '';
  let concepto = partes.join(SEP);
  if (concepto.length <= MAX_CONCEPTO) return concepto;

  // Prioridad: conservar nº factura; recortar descripción y luego proveedor.
  if (num) {
    const pref = num + (prov || desc ? SEP : '');
    let restante = MAX_CONCEPTO - pref.length;
    if (restante <= 0) return num.slice(0, MAX_CONCEPTO);
    const trozos = [];
    if (prov) {
      const p = prov.length <= restante ? prov : prov.slice(0, restante);
      trozos.push(p);
      restante -= p.length + (desc ? SEP.length : 0);
    }
    if (desc && restante > 0) {
      trozos.push(desc.slice(0, Math.max(0, restante)));
    }
    concepto = pref + trozos.join(SEP);
    return concepto.slice(0, MAX_CONCEPTO);
  }
  return concepto.slice(0, MAX_CONCEPTO);
}

/** Nombre FIT (máx 25 caracteres). */
export function truncarNombreFit(nombre) {
  const s = String(nombre ?? '').trim();
  return s.length <= 25 ? s : s.slice(0, 25);
}
