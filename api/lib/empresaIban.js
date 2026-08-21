/**
 * IBAN de empresa: accesor único.
 *
 * Las cuentas bancarias de una empresa viven en `Igp_BankAccounts` (N cuentas
 * por empresa) y la cuenta predeterminada es un puntero en la ficha de la
 * empresa (`igp_Empresas.IbanPredeterminado`), no un flag en la cuenta.
 *
 * Este módulo es el accesor único que debe sustituir a cualquier lectura
 * directa de `item.Iban` (remesas, facturación, PDFs, N43…). Mientras dure la
 * fase *expand*, el puntero y el campo viejo se escriben en paralelo, así que
 * ambos valen; el fallback a `Iban`/`iban` es **temporal** y desaparecerá en la
 * fase *contract*, cuando se borren los campos `Iban` e `IbanAlternativo`.
 */

import { limpiarIban } from './remesas/iban.js';

/**
 * IBAN de la cuenta predeterminada de una empresa, normalizado.
 * @param {Record<string, unknown>|null|undefined} empresaItem - ítem de `igp_Empresas`
 * @returns {string} IBAN en mayúsculas y sin espacios, o '' si la empresa no tiene ninguno
 */
export function ibanPredeterminadoDeEmpresa(empresaItem) {
  const item = empresaItem && typeof empresaItem === 'object' ? empresaItem : {};
  // Limpieza tolerante: en el maestro hay IBAN tecleados con guiones.
  return limpiarIban(item.IbanPredeterminado || item.Iban || item.iban || '');
}
