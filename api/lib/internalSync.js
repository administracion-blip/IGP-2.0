/**
 * Autenticación de llamadas internas (scheduler, scripts) a endpoints que también
 * usan JWT desde la app. Cabecera X-Internal-Secret debe coincidir con INTERNAL_SYNC_SECRET.
 */

/** POST exactos permitidos con secreto interno (sin query string en la clave). */
export const INTERNAL_SYNC_POST_PATHS = new Set([
  '/api/agora/products/sync',
  '/api/agora/purchases/sync',
  '/api/agora/closeouts/sync',
  '/api/agora/closeouts/full-sync',
  '/api/agora/warehouses/sync',
  '/api/facturacion/check-vencimientos',
  '/api/facturacion/enviar-recordatorios',
]);

export function normalizeApiPathname(req) {
  const raw = req.originalUrl || req.url || '';
  const path = raw.split('?')[0].replace(/\/+$/, '') || '/';
  return path;
}

/** Headers para fetch desde el mismo proceso Node hacia la API (scheduler, scripts). */
export function internalSyncFetchHeaders(base = {}) {
  const h = { 'Content-Type': 'application/json', ...base };
  const s = process.env.INTERNAL_SYNC_SECRET;
  if (s) h['X-Internal-Secret'] = s;
  return h;
}
