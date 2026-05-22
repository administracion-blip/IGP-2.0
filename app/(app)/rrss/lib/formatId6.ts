/**
 * Normaliza un id_local a 6 dígitos con padding (`'5'` → `'000005'`).
 *
 * Réplica del helper que existe en `api/routes/marketing.js`. El backend
 * normaliza ambos lados antes de comparar, así que técnicamente el frontend
 * podría enviar el id en bruto. Pero `igp_Locales` siempre devuelve los ids
 * con padding (`'000005'`) y `igp_usuarios.Local` los guarda tal cual los
 * introdujo el admin (puede ser `'5'`, `'000005'`, etc.). Para que las
 * comparaciones en el frontend (preselección de dropdowns, validación de
 * pertenencia) cuadren, normalizamos siempre con este helper.
 */
export function formatId6(val: string | number | undefined | null): string {
  if (val == null || val === '') return '';
  const s = String(val).replace(/^0+/, '') || '0';
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return '';
  return String(n).padStart(6, '0');
}
