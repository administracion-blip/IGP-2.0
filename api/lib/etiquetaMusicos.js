/** Normaliza etiqueta para comparar (sin acentos, minúsculas). */
export function normalizarEtiquetaStr(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * @param {unknown} etiquetas — array de strings o string
 * @returns {boolean}
 */
export function empresaTieneEtiquetaMusicos(etiquetas) {
  const arr = Array.isArray(etiquetas)
    ? etiquetas
    : etiquetas != null && String(etiquetas).trim() !== ''
      ? [String(etiquetas)]
      : [];
  return arr.some((e) => normalizarEtiquetaStr(e) === 'musicos');
}
