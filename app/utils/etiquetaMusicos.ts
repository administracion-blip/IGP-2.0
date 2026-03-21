/** Misma lógica que `api/lib/etiquetaMusicos.js` (etiqueta "musicos", sin distinguir mayúsculas). */

function normalizarEtiquetaStr(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * @param etiquetas — array de strings o string (campo Etiqueta de empresa)
 */
export function empresaTieneEtiquetaMusicos(etiquetas: unknown): boolean {
  const arr = Array.isArray(etiquetas)
    ? etiquetas
    : etiquetas != null && String(etiquetas).trim() !== ''
      ? [String(etiquetas)]
      : [];
  return arr.some((e) => normalizarEtiquetaStr(e) === 'musicos');
}
