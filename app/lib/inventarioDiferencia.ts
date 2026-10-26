/**
 * Misma regla que api/lib/inventarios/diferencia.js.
 * El contado es las enteras más la botella abierta. Sin porcentaje guardado, no hay color.
 */

export type Semaforo = 'sin-umbral' | 'sin-contar' | 'ok' | 'fuera';

/** Enteras más botella abierta. `null` si no se ha contado nada. */
export function stockContado(linea: {
  stockReal: number | null;
  botellasAbiertas?: number;
}): number | null {
  const abiertaRaw = Number(linea?.botellasAbiertas);
  const abierta = Number.isFinite(abiertaRaw) ? abiertaRaw : 0;
  const raw = linea?.stockReal;
  const hayEnteras = raw != null && Number.isFinite(Number(raw));
  if (!hayEnteras && abierta === 0) return null;
  const enteras = hayEnteras ? Number(raw) : 0;
  return Math.round((enteras + abierta) * 10000) / 10000;
}

export function clasificarLinea(
  linea: { stockTeorico: number; stockReal: number | null; botellasAbiertas?: number },
  porcentaje: number | null,
): { semaforo: Semaforo; diferencia: number | null; porcentaje: number | null } {
  const teorico = Number(linea?.stockTeorico);
  const real = stockContado(linea);
  const contado = real != null;
  const diferencia = contado ? real - teorico : null;
  let pct: number | null = null;
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
    : Math.abs(diferencia as number) <= (porcentaje / 100) * teorico;
  return { semaforo: dentro ? 'ok' : 'fuera', diferencia, porcentaje: pct };
}
