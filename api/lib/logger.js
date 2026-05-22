import pino from 'pino';

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
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});
