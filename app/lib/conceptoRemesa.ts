const SEP = ' · ';
const MAX_CONCEPTO = 140;

/** Texto de observaciones recortado para el concepto remesa (máx 80 por defecto). */
export function resumenDescripcionFactura(
  lineas: { descripcion?: string }[] | undefined | null,
  observaciones: string | undefined | null,
  maxLen = 80,
): string {
  void lineas;
  const base = String(observaciones ?? '').trim().replace(/\s+/g, ' ');
  if (!base) return '';
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen).trim();
}

export type BuildConceptoRemesaInput = {
  numeroFacturaProveedor?: string | null;
  numeroFactura?: string | null;
  proveedorNombre?: string | null;
  observaciones?: string | null;
};

/**
 * Concepto FIT remesa: nº factura proveedor · proveedor · observaciones (máx 140).
 */
export function buildConceptoRemesaFacturaRecibida(input: BuildConceptoRemesaInput): string {
  const descripcionResumen = resumenDescripcionFactura(null, input.observaciones);
  return buildConceptoRemesa({
    numeroFacturaProveedor: input.numeroFacturaProveedor,
    numeroFactura: input.numeroFactura,
    proveedorNombre: input.proveedorNombre,
    descripcionResumen,
  });
}

export function buildConceptoRemesa({
  numeroFacturaProveedor,
  numeroFactura,
  proveedorNombre,
  descripcionResumen = '',
}: {
  numeroFacturaProveedor?: string | null;
  numeroFactura?: string | null;
  proveedorNombre?: string | null;
  descripcionResumen?: string;
}): string {
  const num = String(numeroFacturaProveedor || numeroFactura || '').trim();
  const prov = String(proveedorNombre || '').trim();
  const desc = String(descripcionResumen || '').trim();

  const partes = [num, prov, desc].filter(Boolean);
  if (partes.length === 0) return '';
  let concepto = partes.join(SEP);
  if (concepto.length <= MAX_CONCEPTO) return concepto;

  if (num) {
    const pref = num + (prov || desc ? SEP : '');
    let restante = MAX_CONCEPTO - pref.length;
    if (restante <= 0) return num.slice(0, MAX_CONCEPTO);
    const trozos: string[] = [];
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
