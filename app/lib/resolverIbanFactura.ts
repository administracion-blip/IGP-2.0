import { getEmpresaFromCatalog, type EmpresaConTipoRecibo } from '../utils/empresaTipoRecibo';

export type FacturaRefIban = {
  empresa_iban?: string | null;
  empresa_iban_alternativo?: string | null;
  empresa_id?: string | null;
  empresa_cif?: string | null;
};

function normalizarIban(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, '').toUpperCase();
}

function ibanDeRegistro(item: Record<string, unknown> | EmpresaConTipoRecibo | undefined): string {
  if (!item) return '';
  const e = item as Record<string, unknown>;
  return normalizarIban(e.Iban ?? e.iban);
}

function ibanAltDeRegistro(item: Record<string, unknown> | EmpresaConTipoRecibo | undefined): string {
  if (!item) return '';
  const e = item as Record<string, unknown>;
  return normalizarIban(e.IbanAlternativo ?? e.ibanAlternativo);
}

/**
 * IBAN del beneficiario para pantallas de pago/cobro.
 * Prioriza lo guardado en la factura y, si falta, el maestro de empresas (id o CIF),
 * igual que las remesas en backend.
 */
export function resolverIbanBeneficiarioFactura(
  factura: FacturaRefIban,
  empresas: EmpresaConTipoRecibo[] | null | undefined,
): { iban: string; ibanAlternativo: string } {
  const emp = getEmpresaFromCatalog(empresas, factura.empresa_id, factura.empresa_cif);
  const candidatos = [
    normalizarIban(factura.empresa_iban),
    normalizarIban(factura.empresa_iban_alternativo),
    ibanDeRegistro(emp),
    ibanAltDeRegistro(emp),
  ].filter(Boolean);

  const iban = candidatos[0] ?? '';
  const ibanAlternativo = candidatos.find((c, i) => i > 0 && c !== iban) ?? '';
  return { iban, ibanAlternativo };
}
