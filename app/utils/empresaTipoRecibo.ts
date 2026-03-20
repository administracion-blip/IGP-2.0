/** Compatible con ítems de GET /api/empresas (Dynamo / front mapeado). */
export type EmpresaConTipoRecibo = {
  id_empresa?: string;
  tipoRecibo?: string;
  'Tipo de recibo'?: string;
};

/**
 * Lee «Tipo de recibo» desde una lista ya cargada (evita GET /empresas en cada modal).
 */
export function getTipoReciboFromEmpresasList(
  empresas: EmpresaConTipoRecibo[] | undefined | null,
  empresaId: string | undefined | null,
): string {
  const id = (empresaId ?? '').trim();
  if (!id || !empresas?.length) return '';
  const e = empresas.find((x) => String(x?.id_empresa ?? '').trim() === id);
  if (!e) return '';
  return String(e.tipoRecibo ?? e['Tipo de recibo'] ?? '').trim();
}
