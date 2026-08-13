/**
 * Cálculos puros del módulo Bonus RRHH (desviación, base fondo, %).
 * IVA fijo 10 % sobre Gross (no IVA por producto de campañas).
 *
 * Reglas de negocio:
 * - El % del fondo común se aplica solo sobre la desviación s/IVA.
 * - Los incentivos se pagan siempre, independientes de la desviación.
 * - Total a pagar = incentivos + fondo.
 */

export const IVA_FACTOR = 1.10;

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Gross → neto con IVA fijo 10 %. */
export function sinIva(gross) {
  return round2((Number(gross) || 0) / IVA_FACTOR);
}

/** Desviación positiva con IVA: max(0, real − obj). */
export function desvGross(real, obj) {
  return round2(Math.max(0, (Number(real) || 0) - (Number(obj) || 0)));
}

/** Desviación positiva sin IVA a partir de la desv Gross. */
export function desvSinIvaFromGross(desvGrossVal) {
  return sinIva(desvGrossVal);
}

/**
 * Base del fondo común = desviación s/IVA (sin restar incentivos).
 * Los incentivos no entran en esta base: se pagan aparte.
 */
export function baseFondo(desvSinIva) {
  return round2(Number(desvSinIva) || 0);
}

/** Fondo a repartir = max(0, base) × (pct / 100). */
export function fondoComun(base, pct) {
  const b = Number(base) || 0;
  const p = Number(pct) || 0;
  return round2(Math.max(0, b) * (p / 100));
}

/** Total a pagar = incentivos (siempre) + fondo común (% sobre desv). */
export function totalBonus(incentivos, fondo) {
  return round2((Number(incentivos) || 0) + (Number(fondo) || 0));
}

/**
 * % efectivo del local: override local si no es null/undefined; si no, global.
 * null/undefined local → global. 0 local es válido (override a 0).
 */
export function pctEfectivo(pctLocal, pctGlobal) {
  if (pctLocal != null && pctLocal !== '') {
    return Number(pctLocal);
  }
  return Number(pctGlobal) || 0;
}
