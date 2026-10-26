/**
 * Compara el stock contado con el teórico copiado al abrir el conteo.
 * El contado es las enteras más la botella abierta: es lo que viaja a Ágora.
 * No lee Ágora. El porcentaje lo elige quien revisa; si no hay, no hay color.
 *
 * @param {{ stockTeorico: number, stockReal: number | null, botellasAbiertas?: number }} linea
 * @param {number | null} porcentaje  Diferencia aceptable, en %. `null` = sin definir.
 * @returns {{ semaforo: 'sin-umbral' | 'sin-contar' | 'ok' | 'fuera', diferencia: number | null, porcentaje: number | null }}
 */

/** Enteras más botella abierta. `null` si no se ha contado nada. */
export function stockContado(linea) {
  const abiertaRaw = Number(linea?.botellasAbiertas);
  const abierta = Number.isFinite(abiertaRaw) ? abiertaRaw : 0;
  const raw = linea?.stockReal;
  const hayEnteras = raw != null && raw !== '' && Number.isFinite(Number(raw));
  if (!hayEnteras && abierta === 0) return null;
  const enteras = hayEnteras ? Number(raw) : 0;
  return Math.round((enteras + abierta) * 10000) / 10000;
}

export function clasificarLinea(linea, porcentaje) {
  const teorico = Number(linea?.stockTeorico);
  const real = stockContado(linea);
  const contado = real != null;
  const diferencia = contado ? real - teorico : null;
  let pct = null;
  if (diferencia != null && teorico !== 0) {
    pct = (Math.abs(diferencia) / teorico) * 100;
  }

  const umbralDefinido = typeof porcentaje === 'number' && Number.isFinite(porcentaje);
  if (!umbralDefinido) {
    return { semaforo: 'sin-umbral', diferencia, porcentaje: pct };
  }
  if (!contado) {
    return { semaforo: 'sin-contar', diferencia: null, porcentaje: null };
  }
  const dentro = teorico === 0
    ? diferencia === 0
    : Math.abs(diferencia) <= (porcentaje / 100) * teorico;
  return { semaforo: dentro ? 'ok' : 'fuera', diferencia, porcentaje: pct };
}
