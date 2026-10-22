import pino from 'pino';

/**
 * Rutas que nunca se escriben en los logs. El log de acceso de pino-http
 * incluye las cabeceras de la petición: ahí viajan el JWT, las cookies, la
 * API key de integraciones y el secreto interno (X-Internal-Secret). Los campos
 * sueltos cubren objetos que se pasen al logger con credenciales (un nivel de
 * profundidad).
 */
export const RUTAS_REDACTADAS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-internal-secret"]',
  'req.headers["proxy-authorization"]',
  'req.query.token',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'headers["x-internal-secret"]',
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["x-internal-secret"]',
  // Las cabeceras de salida (internalSyncFetchHeaders) van con mayúsculas y la redacción las distingue.
  'headers.Authorization',
  'headers["X-Internal-Secret"]',
  '*.headers.Authorization',
  '*.headers["X-Internal-Secret"]',
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
  '*.headers["api-token"]',
];

export const CENSURA = '***';

export const OPCIONES_LOGGER = {
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: RUTAS_REDACTADAS, censor: CENSURA },
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

/** Redacta `?token=` del access log: el feed ICS lleva el secreto en la URL. */
export function redactarTokenEnUrl(url) {
  if (typeof url !== 'string' || !/[?&]token=/i.test(url)) return url;
  return url.replace(/([?&]token=)[^&]*/gi, `$1${CENSURA}`);
}

/** Opciones de pino-http del API; server.js y los tests usan esta misma función. */
export function opcionesLogHttp(loggerBase = logger) {
  return {
    logger: loggerBase,
    serializers: {
      req(req) {
        // pino-http pasa un wrapper con `url` / `raw`; no asumir IncomingMessage puro.
        const base =
          req.raw && typeof req.raw === 'object'
            ? pino.stdSerializers.req(req.raw)
            : { method: req.method, url: req.url };
        return {
          ...base,
          id: req.id,
          url: redactarTokenEnUrl(base.url || req.url || ''),
        };
      },
    },
  };
}
