/**
 * Firma PNG de entrega: data URL o base64 crudo (mismo criterio que cashflow).
 */

export function bufferFirmaBase64(firmaBase64) {
  if (firmaBase64 == null || firmaBase64 === '') return null;
  const raw = String(firmaBase64).replace(/^data:image\/png;base64,/, '');
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length ? buf : null;
}
