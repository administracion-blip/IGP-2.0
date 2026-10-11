/**
 * Cuenta ordenante de una remesa: la cuenta desde la que sale el dinero.
 *
 * Solo vale una cuenta registrada de la sociedad ordenante en el maestro: la
 * predeterminada o la alternativa de su ficha (`igp_Empresas`) o una de sus
 * cuentas activas en `Igp_BankAccounts`. Cualquier otro IBAN, aunque sea válido,
 * se rechaza.
 */

import { limpiarIban } from './iban.js';
import { ibanPredeterminadoDeEmpresa } from '../empresaIban.js';
import { listarCuentasDeEmpresa } from '../dynamo/bankAccounts.js';

/**
 * @param {string} iban
 * @param {Record<string, unknown>|null|undefined} empresaItem - ficha de la sociedad ordenante
 * @param {string} sociedadId
 * @returns {Promise<boolean>}
 */
export async function esCuentaDeSociedad(iban, empresaItem, sociedadId) {
  const objetivo = limpiarIban(iban);
  if (!objetivo || !empresaItem) return false;
  const deLaFicha = [
    ibanPredeterminadoDeEmpresa(empresaItem),
    limpiarIban(empresaItem.IbanAlternativo ?? empresaItem.ibanAlternativo ?? ''),
  ];
  if (deLaFicha.includes(objetivo)) return true;
  const cuentas = await listarCuentasDeEmpresa(sociedadId);
  return cuentas.some((c) => c?.activa !== false && limpiarIban(c?.iban) === objetivo);
}
