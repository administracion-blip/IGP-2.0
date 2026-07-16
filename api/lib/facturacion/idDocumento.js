/** Fecha emisión de factura → yyyy-mm-dd (varios formatos en BD). */
export function fechaEmisionFacturaAIso(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const isoHead = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoHead) return isoHead[1];
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (slash) {
    const d = slash[1].padStart(2, '0');
    const mo = slash[2].padStart(2, '0');
    let y = slash[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo}-${d}`;
  }
  const dash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})$/);
  if (dash) {
    const d = dash[1].padStart(2, '0');
    const mo = dash[2].padStart(2, '0');
    let y = dash[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo}-${d}`;
  }
  return null;
}

export function trimestreDesdeFechaEmision(raw) {
  const iso = fechaEmisionFacturaAIso(raw);
  if (!iso) return null;
  const anio = parseInt(iso.slice(0, 4), 10);
  const mes = parseInt(iso.slice(5, 7), 10);
  if (!anio || mes < 1 || mes > 12) return null;
  return { anio, trimestre: Math.floor((mes - 1) / 3) + 1 };
}

export function sanitizarSegmentoIdDocumento(s) {
  return (
    String(s ?? '')
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || ''
  );
}

export function buildIdDocumentoFacturaRecibida(input) {
  const empresa = sanitizarSegmentoIdDocumento(input.empresaNombre) || 'sin_empresa';
  const iso = fechaEmisionFacturaAIso(input.fechaEmision);
  const fecha = iso || 'sin_fecha';
  const t = trimestreDesdeFechaEmision(input.fechaEmision);
  const tri = t ? `T${t.trimestre}-${t.anio}` : 'sin_trimestre';
  const num = sanitizarSegmentoIdDocumento(input.numeroFacturaProveedor) || 'sin_numero';
  return `${empresa}_${fecha}_${tri}_${num}`;
}

export function extensionAdjuntoFactura(nombre, tipo) {
  const fromNombre = String(nombre ?? '').match(/(\.[a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase();
  if (fromNombre) return fromNombre;
  const t = String(tipo ?? '').toLowerCase();
  if (t.includes('pdf')) return '.pdf';
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  return '.pdf';
}

export function nombreFicheroAdjuntoFacturaRecibida(factura, adj, indice = 0) {
  const base = buildIdDocumentoFacturaRecibida({
    empresaNombre: factura.emisor_nombre,
    fechaEmision: factura.fecha_emision,
    numeroFacturaProveedor: factura.numero_factura_proveedor,
  });
  const ext = extensionAdjuntoFactura(adj.nombre, adj.tipo);
  const suf = indice > 0 ? `_${indice + 1}` : '';
  return `${base}${suf}${ext}`;
}
