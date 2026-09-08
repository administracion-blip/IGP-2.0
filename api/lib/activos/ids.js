/**
 * Identificadores de activos: UUID opaco, etiqueta legible y dígito Luhn.
 *
 * Luhn es un algoritmo público (el de las tarjetas). No hay semilla ni secreto:
 * solo detecta un tecleo mal puesto. El correlativo lo reserva el contador
 * atómico; esta capa solo formatea.
 */

import crypto from 'node:crypto';

const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RE_PREFIJO = /^[A-Z][A-Z0-9]{1,5}$/;
const RE_ETIQUETA = /^([A-Z][A-Z0-9]{1,5})-(\d+)$/;

export function nuevoId() {
  return crypto.randomUUID();
}

export function esUuid(valor) {
  return RE_UUID.test(String(valor || '').trim());
}

export function normalizarPrefijo(valor) {
  return String(valor || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function prefijoValido(valor) {
  return RE_PREFIJO.test(normalizarPrefijo(valor));
}

/**
 * Dígito de control Luhn del cuerpo numérico (sin el propio dígito).
 * Recorre de derecha a izquierda y dobla las posiciones impares (1, 3, …).
 */
export function digitoLuhn(cuerpo) {
  const digits = String(cuerpo || '').replace(/\D/g, '');
  if (!digits) throw new Error('El cuerpo de la etiqueta no tiene dígitos');
  let suma = 0;
  let doblar = true;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (doblar) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    suma += n;
    doblar = !doblar;
  }
  return (10 - (suma % 10)) % 10;
}

/** ¿La cadena numérica (cuerpo + dígito) cumple Luhn? */
export function luhnValido(numero) {
  const digits = String(numero || '').replace(/\D/g, '');
  if (digits.length < 2) return false;
  const cuerpo = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  return digitoLuhn(cuerpo) === check;
}

export function formatearEtiqueta(prefijo, correlativo, digitos = 4) {
  const pre = normalizarPrefijo(prefijo);
  if (!prefijoValido(pre)) {
    throw new Error('El prefijo de etiqueta no es válido');
  }
  const n = Number(correlativo);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('El correlativo de etiqueta debe ser un entero positivo');
  }
  const ancho = Number(digitos);
  const pad = Number.isInteger(ancho) && ancho >= 3 && ancho <= 8 ? ancho : 4;
  const cuerpo = String(n).padStart(pad, '0');
  if (cuerpo.length > pad) {
    throw new Error(`El correlativo no cabe en ${pad} dígitos`);
  }
  return `${pre}-${cuerpo}${digitoLuhn(cuerpo)}`;
}

export function parsearEtiqueta(valor) {
  const raw = String(valor || '').trim().toUpperCase();
  const m = RE_ETIQUETA.exec(raw);
  if (!m) return null;
  return { prefijo: m[1], cuerpoConCheck: m[2], etiqueta: `${m[1]}-${m[2]}` };
}

export function normalizarSerie(valor) {
  const s = String(valor || '').trim();
  return s ? s.toUpperCase() : '';
}
