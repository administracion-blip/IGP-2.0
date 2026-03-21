/**
 * Normaliza una firma a data URL PNG o null.
 */
export function normalizeSignatureDataUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (v === '') return null;
  if (v.startsWith('data:image/')) return v;
  return `data:image/png;base64,${v}`;
}
