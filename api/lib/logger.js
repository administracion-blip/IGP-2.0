import pino from 'pino';

/**
 * Rutas que nunca se escriben en los logs. El log de acceso de pino-http
 * incluye las cabeceras de la petición: ahí viajan el JWT, las cookies y la
 * API key de integraciones. Los campos sueltos cubren objetos que se pasen
 * al logger con credenciales (un nivel de profundidad).
 */
export const RUTAS_REDACTADAS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'password',
  'token',
  'apiKey',
  'api_key',
  'secret',
  '*.password',
  '*.Password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.api_key',
  '*.secret',
  '*.authorization',
];

export const OPCIONES_LOGGER = {
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: RUTAS_REDACTADAS, censor: '[Redacted]' },
};

/**
 * Logger central del API.
 *
 * Usa siempre este logger en lugar de console.* para tener:
 * - Nivel configurable por LOG_LEVEL (default 'info').
 * - Formato JSON estructurado (filtrable / agregable en producción).
 * - Correlación por request a través de pino-http (req.log).
 *
 * En desarrollo, si quieres salida legible, instala `pino-pretty` y arranca
 * el API con `LOG_LEVEL=debug node server.js | pino-pretty`.
 */
export const logger = pino(OPCIONES_LOGGER);
