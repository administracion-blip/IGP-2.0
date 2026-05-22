import { logger } from '../lib/logger.js';

/**
 * Mapeo de errores conocidos del AWS SDK v3 (DynamoDB / S3) a códigos HTTP.
 *
 * Los nombres `name` los expone el SDK v3 directamente en el error
 * (`err.name === 'ResourceNotFoundException'`, etc.).
 */
const AWS_ERROR_MAP = {
  ResourceNotFoundException: { status: 404, code: 'AWS_RESOURCE_NOT_FOUND' },
  ProvisionedThroughputExceededException: { status: 429, code: 'AWS_THROUGHPUT_EXCEEDED' },
  ConditionalCheckFailedException: { status: 409, code: 'AWS_CONDITIONAL_CHECK_FAILED' },
  ThrottlingException: { status: 429, code: 'AWS_THROTTLING' },
  ValidationException: { status: 400, code: 'AWS_VALIDATION' },
};

/**
 * Middleware central de errores Express.
 *
 * Convenciones de uso desde los handlers:
 * - Para errores de validación o de negocio, lanza `Error` con `err.status` y
 *   opcionalmente `err.code`. Ejemplo: `const e = new Error('X'); e.status = 400; throw e;`.
 * - Para el resto, simplemente `next(err)` (o `throw` si Express tiene
 *   `express-async-errors` o el handler está envuelto en `try/catch`).
 *
 * Formato de respuesta uniforme: `{ error: string, code?: string }`.
 *
 * Debe registrarse en `server.js` DESPUÉS de todos los routers y ANTES de
 * `app.listen`. Express requiere los 4 parámetros (err, req, res, next) para
 * detectarlo como middleware de error.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const log = req?.log || logger;

  if (res.headersSent) {
    log.error({ err }, 'Error tras enviar headers; delegando a Express');
    return _next(err);
  }

  // Errores conocidos del SDK de AWS
  const awsMatch = err?.name && AWS_ERROR_MAP[err.name];
  if (awsMatch) {
    log.warn(
      { err, awsName: err.name, status: awsMatch.status },
      `[errorHandler] AWS ${err.name}`,
    );
    return res
      .status(awsMatch.status)
      .json({ error: err.message || err.name, code: awsMatch.code });
  }

  // Errores aplicativos con `status` (lanzados por nosotros desde handlers)
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 600) {
    log.warn({ err, status: err.status }, '[errorHandler] error aplicativo');
    return res
      .status(err.status)
      .json({ error: err.message || 'Error', ...(err.code ? { code: err.code } : {}) });
  }

  // Errores no controlados (5xx)
  log.error({ err }, '[errorHandler] error no controlado');
  return res.status(500).json({ error: err?.message || 'Error interno del servidor' });
}
