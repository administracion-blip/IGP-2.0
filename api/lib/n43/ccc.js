/**
 * CCC e IBAN a partir de la cabecera (registro 11) de un fichero Norma 43.
 */

import { validarIban } from '../remesas/iban.js';

/** Pesos del dígito de control del CCC español (módulo 11). */
const PESOS = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];

/**
 * Dígito de control de un grupo de 10 dígitos: suma ponderada módulo 11, con
 * las dos excepciones del algoritmo (10 → 1 y 11 → 0).
 * @param {string} diezDigitos
 * @returns {number}
 */
function digitoControl(diezDigitos) {
  let suma = 0;
  for (let i = 0; i < PESOS.length; i += 1) {
    suma += Number(diezDigitos[i]) * PESOS[i];
  }
  const dc = 11 - (suma % 11);
  if (dc === 11) return 0;
  if (dc === 10) return 1;
  return dc;
}

/**
 * Los dos dígitos de control del CCC. El registro 11 solo trae 18 dígitos
 * (entidad + oficina + cuenta), así que los DC hay que recalcularlos: el
 * primero sobre entidad+oficina rellenado a 10 con dos ceros por la izquierda,
 * y el segundo sobre el número de cuenta.
 * @param {{ entidad: string, oficina: string, numeroCuenta: string }} partes
 * @returns {string}
 */
export function digitosControlCcc({ entidad, oficina, numeroCuenta }) {
  const dc1 = digitoControl(`00${entidad}${oficina}`);
  const dc2 = digitoControl(String(numeroCuenta));
  return `${dc1}${dc2}`;
}

/**
 * CCC de 20 dígitos: entidad(4) + oficina(4) + DC(2) + cuenta(10).
 * @param {{ entidad: string, oficina: string, numeroCuenta: string }} partes
 * @returns {{ ok: boolean, ccc: string, motivo?: string }}
 */
export function construirCcc({ entidad, oficina, numeroCuenta }) {
  const e = String(entidad ?? '').trim();
  const o = String(oficina ?? '').trim();
  const c = String(numeroCuenta ?? '').trim();
  if (!/^\d{4}$/.test(e)) return { ok: false, ccc: '', motivo: `Entidad "${e}" no válida` };
  if (!/^\d{4}$/.test(o)) return { ok: false, ccc: '', motivo: `Oficina "${o}" no válida` };
  if (!/^\d{10}$/.test(c)) return { ok: false, ccc: '', motivo: `Número de cuenta "${c}" no válido` };
  const dc = digitosControlCcc({ entidad: e, oficina: o, numeroCuenta: c });
  return { ok: true, ccc: `${e}${o}${dc}${c}` };
}

/**
 * IBAN español a partir del CCC (ISO 13616, módulo 97).
 * @param {string} ccc 20 dígitos
 * @returns {string}
 */
export function cccAIbanEspanol(ccc) {
  const base = `${String(ccc)}ES00`;
  let resto = 0;
  for (const ch of base) {
    const expandido = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digito of expandido) {
      resto = (resto * 10 + Number(digito)) % 97;
    }
  }
  const dc = 98 - resto;
  return `ES${String(dc).padStart(2, '0')}${ccc}`;
}

/**
 * IBAN de la cuenta de un registro 11. Si el IBAN construido no valida, se
 * devuelve vacío para que el llamante avise en lugar de dar por buena una
 * cuenta inventada.
 * @param {{ entidad: string, oficina: string, numeroCuenta: string }} partes
 * @returns {{ iban: string, ccc: string, valido: boolean, motivo?: string }}
 */
export function construirIbanN43({ entidad, oficina, numeroCuenta }) {
  const ccc = construirCcc({ entidad, oficina, numeroCuenta });
  if (!ccc.ok) return { iban: '', ccc: '', valido: false, motivo: ccc.motivo };
  const candidato = cccAIbanEspanol(ccc.ccc);
  const validacion = validarIban(candidato);
  if (!validacion.valido) {
    return { iban: '', ccc: ccc.ccc, valido: false, motivo: validacion.motivo };
  }
  return { iban: validacion.iban, ccc: ccc.ccc, valido: true };
}
