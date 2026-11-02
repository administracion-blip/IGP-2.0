/**
 * Líneas del conteo que aún no tienen cantidad.
 * Sin contar solo si `stockReal` es null o undefined: el cero ya está contado.
 * No mira el stock teórico ni las botellas abiertas, y no modifica el array.
 */
export function productosSinContar<T extends { stockReal: number | null | undefined }>(
  lineas: readonly T[],
): T[] {
  return lineas.filter((linea) => linea.stockReal == null);
}
