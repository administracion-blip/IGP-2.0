import { getEmpresaFromCatalog, type EmpresaConTipoRecibo } from '../utils/empresaTipoRecibo';
import { limpiarIban, validarIban } from './iban';

export type FacturaRefIban = {
  empresa_iban?: string | null;
  empresa_iban_alternativo?: string | null;
  empresa_id?: string | null;
  empresa_cif?: string | null;
};

/**
 * Cuenta predeterminada de una empresa del maestro. Las cuentas viven en su
 * propia tabla y la predeterminada es el puntero `IbanPredeterminado` de la
 * ficha, no un flag de la cuenta.
 *
 * El respaldo a `Iban` es **temporal**: mientras dure la transición el puntero y
 * el campo viejo se escriben en paralelo, y desaparecerá cuando se borren `Iban`
 * e `IbanAlternativo` del maestro.
 */
function ibanPredeterminadoDeEmpresa(empresa: EmpresaConTipoRecibo | undefined): string {
  if (!empresa) return '';
  return limpiarIban(empresa.IbanPredeterminado ?? empresa.Iban ?? empresa.iban);
}

function ibanAlternativoDeEmpresa(empresa: EmpresaConTipoRecibo | undefined): string {
  if (!empresa) return '';
  return limpiarIban(empresa.IbanAlternativo ?? empresa.ibanAlternativo);
}

/* ── Por qué el maestro manda sobre el IBAN congelado en la factura ──────────
 *
 * Parece un bug —lo normal es respetar el dato congelado del documento— pero es
 * deliberado: el dinero sale a la cuenta que la empresa tiene HOY, no a la que
 * tenía el día que se registró la factura. El maestro de empresas es la fuente
 * de verdad y se mantiene al día; si un proveedor cambia de banco, una factura
 * de hace seis meses debe pagarse igualmente en la cuenta nueva.
 *
 * El valor congelado no se descarta: queda como último recurso para que un hueco
 * en el maestro no deje sin datos de pago una factura que hoy se paga sin
 * problemas.
 *
 * Es la misma cascada que aplican las remesas en backend
 * (`api/lib/remesas/resolverDatos.js`), y gana el primer candidato que **valida**
 * —no el primero que no está vacío—, para que la pantalla no pueda mostrar un
 * IBAN distinto de aquel al que va a salir el dinero. En el maestro hay fichas
 * con basura en el campo (un BIC, el texto de una ciudad…): si la pantalla las
 * diera por buenas, el usuario copiaría una cuenta que la remesa descarta.
 *
 *   1. cuenta predeterminada actual de la empresa en el maestro,
 *   2. IBAN congelado en la factura,
 *   3. IBAN alternativo congelado en la factura,
 *   4. `IbanAlternativo` del maestro.
 */

/**
 * IBAN único del beneficiario para pantallas de pago/cobro. La empresa se busca
 * en el catálogo por id y, si no aparece, por CIF (hay facturas antiguas sin
 * `empresa_id`).
 *
 * Devuelve '' si ningún candidato es un IBAN SEPA válido: preferimos que la
 * pantalla diga que no hay cuenta antes que ofrecer una que no existe.
 */
export function resolverIbanBeneficiarioFactura(
  factura: FacturaRefIban,
  empresas: EmpresaConTipoRecibo[] | null | undefined,
): string {
  const emp = getEmpresaFromCatalog(empresas, factura.empresa_id, factura.empresa_cif);
  const candidatos = [
    ibanPredeterminadoDeEmpresa(emp),
    factura.empresa_iban,
    factura.empresa_iban_alternativo,
    ibanAlternativoDeEmpresa(emp),
  ];
  for (const raw of candidatos) {
    const res = validarIban(limpiarIban(raw ?? ''));
    if (res.valido) return res.iban;
  }
  return '';
}
