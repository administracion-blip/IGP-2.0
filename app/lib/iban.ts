/**
 * Limpieza y validación de IBAN en frontend.
 *
 * DUPLICACIÓN CONSCIENTE de `api/lib/remesas/iban.js`: no hay código compartido
 * entre la API (`api/`, JS ES modules) y la app (`app/`, TypeScript), y la
 * pantalla tiene que decidir con el mismo criterio que la remesa. Si tocas uno
 * de los dos ficheros, mira el otro.
 *
 * El algoritmo es el estándar ISO 13616 (módulo 97) y no cambia, así que el
 * riesgo de divergencia es bajo; la lista de países SEPA sí puede crecer.
 */

/** Países SEPA (v1: solo transferencias SEPA). */
const PAISES_SEPA = new Set([
  'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB',
  'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL',
  'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM', 'VA',
]);

/** Normaliza IBAN: sin espacios, mayúsculas. */
export function normalizarIban(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Limpieza tolerante para IBAN tecleados a mano: además de espacios, quita
 * guiones, puntos y demás separadores, y el prefijo «IBAN» pegado delante.
 * En el maestro de empresas hay cuentas guardadas como «ES62-2100-…» o
 * «IBANES80…» que son válidas en cuanto se limpian.
 */
export function limpiarIban(raw: unknown): string {
  return normalizarIban(raw)
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^IBAN(?=[A-Z]{2}\d)/, '');
}

export type ResultadoIban = {
  valido: boolean;
  iban: string;
  motivo?: string;
};

/** Valida IBAN (ISO 13616, módulo 97) y comprueba que el país es SEPA. */
export function validarIban(raw: unknown): ResultadoIban {
  const iban = normalizarIban(raw);
  if (!iban) return { valido: false, iban: '', motivo: 'IBAN vacío' };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) {
    return { valido: false, iban, motivo: 'Formato IBAN inválido' };
  }
  if (iban.length < 15 || iban.length > 34) {
    return { valido: false, iban, motivo: 'Longitud IBAN inválida' };
  }
  const pais = iban.slice(0, 2);
  if (!PAISES_SEPA.has(pais)) {
    return { valido: false, iban, motivo: `IBAN no SEPA (${pais})` };
  }
  const reordenado = iban.slice(4) + iban.slice(0, 4);
  let resto = 0;
  for (const ch of reordenado) {
    const expandido = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digito of expandido) {
      resto = (resto * 10 + Number(digito)) % 97;
    }
  }
  if (resto !== 1) {
    return { valido: false, iban, motivo: 'Dígitos de control IBAN incorrectos' };
  }
  return { valido: true, iban };
}
