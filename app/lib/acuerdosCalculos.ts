/** Cálculos de aportación volumen en acuerdos (sin imagen). */

export type DetalleAportacionLike = {
  Cantidad?: number;
  Compradas?: number;
  Aportacion?: number;
  Rappel?: number;
  DescuentoExtra?: number;
};

export function aportacionUnitaria(d: DetalleAportacionLike): number {
  const ap = Number(d.Aportacion) || 0;
  const ra = Number(d.Rappel) || 0;
  const de = Number(d.DescuentoExtra) || 0;
  return Math.round((ap + ra + de) * 100) / 100;
}

export function aportacionGeneradaLinea(d: DetalleAportacionLike): number {
  const compradas = Number(d.Compradas) || 0;
  return Math.round(compradas * aportacionUnitaria(d) * 100) / 100;
}

export function aportacionVolumenGeneradaTotal(detalles: DetalleAportacionLike[]): number {
  return Math.round(detalles.reduce((s, d) => s + aportacionGeneradaLinea(d), 0) * 100) / 100;
}
