/**
 * Campos virtuales de fecha para actuaciones (respuesta API; no persistir).
 * Días/meses en mayúsculas ASCII sin tildes.
 */

const DIAS_SEMANA_ES = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];
const MESES_ES = [
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
];

/**
 * @param {string} fechaIso YYYY-MM-DD
 * @returns {{ fecha_dia_semana: string, fecha_dia_numero: string, fecha_mes: string }}
 */
export function camposFechaVirtuales(fechaIso) {
  const vacios = { fecha_dia_semana: '', fecha_dia_numero: '', fecha_mes: '' };
  const s = String(fechaIso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return vacios;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return vacios;
  return {
    fecha_dia_semana: DIAS_SEMANA_ES[d.getUTCDay()],
    fecha_dia_numero: String(d.getUTCDate()),
    fecha_mes: MESES_ES[d.getUTCMonth()],
  };
}
