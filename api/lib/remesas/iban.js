/** Países SEPA (v1: solo transferencias SEPA). */
const SEPA_COUNTRY_CODES = new Set([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB',
  'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL',
  'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM', 'VA',
]);

/**
 * Normaliza IBAN: sin espacios, mayúsculas.
 * @param {string} raw
 * @returns {string}
 */
export function normalizarIban(raw) {
  return String(raw ?? '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Valida IBAN (ISO 13616, módulo 97).
 * @param {string} raw
 * @returns {{ valido: boolean, iban: string, motivo?: string }}
 */
export function validarIban(raw) {
  const iban = normalizarIban(raw);
  if (!iban) return { valido: false, iban: '', motivo: 'IBAN vacío' };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) {
    return { valido: false, iban, motivo: 'Formato IBAN inválido' };
  }
  if (iban.length < 15 || iban.length > 34) {
    return { valido: false, iban, motivo: 'Longitud IBAN inválida' };
  }
  const pais = iban.slice(0, 2);
  if (!SEPA_COUNTRY_CODES.has(pais)) {
    return { valido: false, iban, motivo: `IBAN no SEPA (${pais})` };
  }
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const expanded = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of expanded) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  if (remainder !== 1) {
    return { valido: false, iban, motivo: 'Dígitos de control IBAN incorrectos' };
  }
  return { valido: true, iban };
}
