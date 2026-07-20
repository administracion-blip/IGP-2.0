import { fechaEmisionFacturaAIso } from '../utils/formatFecha';

/** Trimestre fiscal según fecha de emisión (mes 1-3 → T1, etc.). */
export function trimestreDesdeFechaEmision(
  raw: string | undefined | null,
): { anio: number; trimestre: number } | null {
  const iso = fechaEmisionFacturaAIso(String(raw ?? '').trim());
  if (!iso) return null;
  const anio = parseInt(iso.slice(0, 4), 10);
  const mes = parseInt(iso.slice(5, 7), 10);
  if (!anio || mes < 1 || mes > 12) return null;
  return { anio, trimestre: Math.floor((mes - 1) / 3) + 1 };
}

export function textoTrimestreFactura(raw: string | undefined | null): string {
  const t = trimestreDesdeFechaEmision(raw);
  if (!t) return '—';
  return `T${t.trimestre} ${t.anio}`;
}

/** Segmento seguro para nombres de fichero (sin espacios ni caracteres inválidos). */
export function sanitizarSegmentoIdDocumento(s: string | undefined | null): string {
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

export type IdDocumentoFacturaRecibidaInput = {
  /** En facturas IN: empresa del grupo (emisor_nombre). */
  empresaNombre?: string | null;
  fechaEmision?: string | null;
  /** Proveedor / emisor comercial del documento (empresa_nombre en IN). */
  proveedorNombre?: string | null;
  numeroFacturaProveedor?: string | null;
};

/**
 * Identificador virtual para facturas recibidas: empresa + fecha + trimestre + proveedor + nº factura proveedor.
 * Pensado para renombrar PDFs y copiar/pegar desde el detalle.
 */
export function buildIdDocumentoFacturaRecibida(input: IdDocumentoFacturaRecibidaInput): string {
  const empresa = sanitizarSegmentoIdDocumento(input.empresaNombre) || 'sin_empresa';
  const iso = fechaEmisionFacturaAIso(String(input.fechaEmision ?? '').trim());
  const fecha = iso || 'sin_fecha';
  const t = trimestreDesdeFechaEmision(input.fechaEmision);
  const tri = t ? `T${t.trimestre}-${t.anio}` : 'sin_trimestre';
  const proveedor = sanitizarSegmentoIdDocumento(input.proveedorNombre) || 'sin_proveedor';
  const num = sanitizarSegmentoIdDocumento(input.numeroFacturaProveedor) || 'sin_numero';
  return `${empresa}_${fecha}_${tri}_${proveedor}_${num}`;
}

export function extensionAdjuntoFactura(nombre?: string | null, tipo?: string | null): string {
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

export function nombreFicheroAdjuntoFacturaRecibida(
  input: IdDocumentoFacturaRecibidaInput,
  adj: { nombre?: string | null; tipo?: string | null },
  indice = 0,
): string {
  const base = buildIdDocumentoFacturaRecibida(input);
  const ext = extensionAdjuntoFactura(adj.nombre, adj.tipo);
  const suf = indice > 0 ? `_${indice + 1}` : '';
  return `${base}${suf}${ext}`;
}
