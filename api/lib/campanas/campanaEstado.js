/**
 * Estado efectivo de campañas de incentivo por producto.
 * Deriva el estado del calendario (fechaInicio/fechaFin) y archivado manual o por antigüedad.
 */

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

export const DIAS_AUTO_ARCHIVAR = parseInt(process.env.CAMPANAS_DIAS_AUTO_ARCHIVAR || '60', 10) || 60;

export function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

export function diasDesde(fechaIso, hoy = hoyIso()) {
  if (!RE_FECHA.test(fechaIso) || !RE_FECHA.test(hoy)) return 0;
  const d0 = new Date(`${fechaIso}T12:00:00`).getTime();
  const d1 = new Date(`${hoy}T12:00:00`).getTime();
  return Math.round((d1 - d0) / (24 * 60 * 60 * 1000));
}

/**
 * @param {object} campana
 * @param {string} [hoy] YYYY-MM-DD
 * @returns {'Borrador'|'Activa'|'Finalizada'|'Bonificada'|'Archivada'}
 */
export function estadoEfectivo(campana, hoy = hoyIso()) {
  if (campana?.archivadaManual === true) return 'Archivada';
  // Compatibilidad campañas archivadas antes del modelo automático
  if (String(campana?.estado || '') === 'Archivada' && campana?.archivadaManual !== false) {
    return 'Archivada';
  }

  const fechaInicio = String(campana?.fechaInicio || '').trim();
  const fechaFin = String(campana?.fechaFin || '').trim();
  if (!RE_FECHA.test(fechaInicio) || !RE_FECHA.test(fechaFin)) return 'Borrador';

  if (hoy > fechaFin) {
    if (campana?.bonificadaEn) {
      if (campana?.archivadaManual === true) return 'Archivada';
      if (diasDesde(String(campana.bonificadaEn).slice(0, 10), hoy) >= DIAS_AUTO_ARCHIVAR) {
        return 'Archivada';
      }
      return 'Bonificada';
    }
    return 'Finalizada';
  }
  if (hoy >= fechaInicio) return 'Activa';
  return 'Borrador';
}

/** Estados en los que se permite borrar la campaña (no Bonificada: archivar antes). */
export function campanaSePuedeBorrar(campana, hoy = hoyIso()) {
  const estado = estadoEfectivo(campana, hoy);
  return ['Borrador', 'Activa', 'Finalizada', 'Archivada'].includes(estado);
}

export function campanaEnriquecida(campana, hoy = hoyIso()) {
  if (!campana || typeof campana !== 'object') return campana;
  return {
    ...campana,
    estado: estadoEfectivo(campana, hoy),
  };
}
