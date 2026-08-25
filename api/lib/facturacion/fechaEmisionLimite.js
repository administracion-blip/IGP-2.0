import { fechaEmisionFacturaAIso } from './idDocumento.js';

export const DIAS_MARGEN_FUTURO_FECHA_EMISION = 7;

export const MSG_FECHA_EMISION_DEMASIADO_FUTURA =
  'La fecha de la factura no puede ser más de 7 días posterior a hoy';

/** Hoy en UTC como yyyy-mm-dd (mismo criterio que el resto de facturación). */
export function hoyIsoUtc(ref) {
  const d = ref == null ? new Date() : ref instanceof Date ? ref : new Date(ref);
  return d.toISOString().slice(0, 10);
}

function addDaysIso(isoYmd, days) {
  const [y, m, d] = isoYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Si fecha_emision es parseable y supera hoy + margen → mensaje de error.
 * Sin fecha parseable → null (otros validadores ya exigen la fecha).
 */
export function errorFechaEmisionDemasiadoFutura(fechaEmision, opts = {}) {
  const iso = fechaEmisionFacturaAIso(fechaEmision);
  if (!iso) return null;

  const hoy = opts.hoy ?? hoyIsoUtc();
  const margenDias =
    opts.margenDias != null ? Number(opts.margenDias) : DIAS_MARGEN_FUTURO_FECHA_EMISION;
  const limite = addDaysIso(hoy, margenDias);

  if (iso > limite) return MSG_FECHA_EMISION_DEMASIADO_FUTURA;
  return null;
}
