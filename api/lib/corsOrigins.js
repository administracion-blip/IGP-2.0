/**
 * Lista blanca de orígenes del navegador (CORS). La usa `server.js` para CORS y
 * `routes/auth.js` para decidir si el `Origin` de la petición sirve como base
 * del enlace de recuperación de contraseña.
 */

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:8084',
  'http://127.0.0.1:8084',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
];

export function origenesDeEntorno(env = process.env) {
  return (env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/** En producción solo `CORS_ALLOWED_ORIGINS`; en desarrollo, además, los locales. */
export function origenesPermitidos(env = process.env) {
  const deEntorno = origenesDeEntorno(env);
  return new Set(env.NODE_ENV === 'production' ? deEntorno : [...DEFAULT_DEV_ORIGINS, ...deEntorno]);
}
