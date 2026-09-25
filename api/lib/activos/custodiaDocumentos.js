/**
 * Agrega actas firmadas a partir de eventos de entrega (puro, sin S3).
 * Una entrada por entrega_id; fecha = creado_en del evento.
 */

function texto(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Recoge eventos `entrega` con entrega_id y acta_s3_key (en `despues` o en la raíz).
 * Deduplica por entrega_id y ordena por fecha descendente.
 * @param {object[]} eventos
 * @returns {{ entrega_id: string, fecha: string, acta_s3_key: string }[]}
 */
export function agregarActasDesdeEventos(eventos) {
  const porId = new Map();
  for (const ev of eventos || []) {
    if (String(ev?.tipo || '') !== 'entrega') continue;
    const entregaId = texto(ev?.despues?.entrega_id || ev?.entrega_id);
    const key = texto(ev?.despues?.acta_s3_key || ev?.acta_s3_key);
    if (!entregaId || !key) continue;
    const fecha = ev?.creado_en || '';
    const prev = porId.get(entregaId);
    if (!prev || String(fecha) > String(prev.fecha)) {
      porId.set(entregaId, { entrega_id: entregaId, fecha, acta_s3_key: key });
    }
  }
  return [...porId.values()].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}
