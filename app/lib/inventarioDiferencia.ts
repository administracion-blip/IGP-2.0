/**
 * Misma regla que api/lib/inventarios/diferencia.js.
 * El teórico es el copiado al abrir el conteo. Sin porcentaje guardado, no hay color.
 */

export type Semaforo = 'sin-umbral' | 'sin-contar' | 'ok' | 'fuera';

export function clasificarLinea(
  linea: { stockTeorico: number; stockReal: number | null },
  porcentaje: number | null,
): { semaforo: Semaforo; diferencia: number | null; porcentaje: number | null } {
  const teorico = Number(linea?.stockTeorico);
  const real = linea?.stockReal;
  const contado = real != null && Number.isFinite(Number(real));
  const diferencia = contado ? Number(real) - teorico : null;
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
