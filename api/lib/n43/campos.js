/**
 * Lectura de campos de un registro Norma 43.
 *
 * Las posiciones se expresan como en el cuaderno del AEB: 1-indexadas y con
 * ambos extremos incluidos.
 */

/** Longitud fija de un registro Norma 43. */
export const LARGO_REGISTRO = 80;

/**
 * Extrae el tramo [desde, hasta] (1-indexado, inclusive) de un registro.
 * @param {string} registro
 * @param {number} desde
 * @param {number} hasta
 * @returns {string}
 */
export function campo(registro, desde, hasta) {
  return String(registro ?? '').slice(desde - 1, hasta);
}

/**
 * Rellena por la derecha hasta 80 caracteres: casi todos los emisores hacen
 * `trim` de los espacios finales y las líneas llegan cortas.
 * @param {string} linea
 * @returns {string}
 */
export function rellenarRegistro(linea) {
  const s = String(linea ?? '');
  return s.length >= LARGO_REGISTRO ? s : s.padEnd(LARGO_REGISTRO, ' ');
}

/**
 * Texto legible: espacios colapsados y sin espacios en los extremos.
 * @param {string} raw
 * @returns {string}
 */
export function limpiarTexto(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

/**
 * Fecha AAMMDD a ISO `YYYY-MM-DD`.
 * @param {string} raw
 * @returns {{ ok: boolean, iso: string, motivo?: string }}
 */
export function parsearFechaAammdd(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{6}$/.test(s)) {
    return { ok: false, iso: '', motivo: `Fecha "${s}" no tiene formato AAMMDD` };
  }
  const aa = Number(s.slice(0, 2));
  const mes = Number(s.slice(2, 4));
  const dia = Number(s.slice(4, 6));
  // Ventana de siglo del cuaderno: 00–79 son 20xx y 80–99 son 19xx.
  const anio = aa <= 79 ? 2000 + aa : 1900 + aa;
  if (mes < 1 || mes > 12) {
    return { ok: false, iso: '', motivo: `Mes inválido en la fecha "${s}"` };
  }
  const diasDelMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  if (dia < 1 || dia > diasDelMes) {
    return { ok: false, iso: '', motivo: `Día inválido en la fecha "${s}"` };
  }
  return { ok: true, iso: `${anio}-${dosDigitos(mes)}-${dosDigitos(dia)}` };
}

/**
 * Importe de 14 dígitos sin signo ni separador (los 2 últimos son decimales).
 * Se devuelve en céntimos para que las sumas de cuadre sean enteras.
 * @param {string} raw
 * @returns {{ ok: boolean, centimos: number, motivo?: string }}
 */
export function parsearImporteCentimos(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,14}$/.test(s)) {
    return { ok: false, centimos: 0, motivo: `Importe "${s}" no es numérico` };
  }
  return { ok: true, centimos: Number(s) };
}

/**
 * Clave debe/haber: 1 = debe (negativo), 2 = haber (positivo).
 * @param {string} raw
 * @returns {{ ok: boolean, clave: string, signo: 'D'|'H'|'', factor: number, motivo?: string }}
 */
export function parsearClaveSigno(raw) {
  const c = String(raw ?? '').trim();
  if (c === '1') return { ok: true, clave: '1', signo: 'D', factor: -1 };
  if (c === '2') return { ok: true, clave: '2', signo: 'H', factor: 1 };
  return { ok: false, clave: c, signo: '', factor: 0, motivo: `Clave debe/haber inválida ("${c}")` };
}

/**
 * Céntimos con signo. Evita el `-0`, que rompe comparaciones estrictas.
 * @param {number} centimos
 * @param {number} factor
 * @returns {number}
 */
export function aplicarSigno(centimos, factor) {
  const n = Number(centimos) || 0;
  return n === 0 ? 0 : n * factor;
}

/**
 * Céntimos a euros como número (la división se hace una sola vez, al final).
 * @param {number} centimos
 * @returns {number}
 */
export function centimosAEuros(centimos) {
  const n = Number(centimos) || 0;
  return n === 0 ? 0 : n / 100;
}
