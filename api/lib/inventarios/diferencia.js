/**
 * Compara el stock real con el teórico copiado al abrir el conteo.
 * No lee Ágora. El porcentaje lo elige quien revisa; si no hay, no hay color.
 *
 * @param {{ stockTeorico: number, stockReal: number | null }} linea
 * @param {number | null} porcentaje  Diferencia aceptable, en %. `null` = sin definir.
 * @returns {{ semaforo: 'sin-umbral' | 'sin-contar' | 'ok' | 'fuera', diferencia: number | null, porcentaje: number | null }}
 */
export function clasificarLinea(linea, porcentaje) {
  const teorico = Number(linea?.stockTeorico);
  const real = linea?.stockReal;
  const contado = real != null && real !== '' && Number.isFinite(Number(real));
  const diferencia = contado ? Number(real) - teorico : null;
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
