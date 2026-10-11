import crypto from 'crypto';
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

const MENSAJES_MULTER = {
  LIMIT_FILE_SIZE: 'El archivo supera el tamaño máximo permitido',
  LIMIT_FILE_COUNT: 'Demasiados archivos en la misma subida',
  LIMIT_UNEXPECTED_FILE: 'Campo de archivo no esperado o demasiados archivos',
};

function shortErrorId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Middleware central de errores Express.
 *
 * Convenciones de uso desde los handlers:
 * - Para errores de validación o de negocio, lanza `Error` con `err.status` y
 *   opcionalmente `err.code`. Ejemplo: `const e = new Error('X'); e.status = 400; throw e;`.
 * - Para el resto, simplemente `next(err)` (o `throw` si Express tiene
 *   `express-async-errors` o el handler está envuelto en `try/catch`).
 *
 * Formato de respuesta uniforme: `{ error: string, code?: string, errorId?: string }`.
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

  // Multer (tamaño / tipo rechazado vía fileFilter sin status) → 400
  if (err?.name === 'MulterError') {
    log.warn({ err }, '[errorHandler] MulterError');
    return res.status(400).json({ error: MENSAJES_MULTER[err.code] || 'Archivo no válido' });
  }

  // Errores conocidos del SDK de AWS
  const awsMatch = err?.name && AWS_ERROR_MAP[err.name];
  if (awsMatch) {
    log.warn(
      { err, awsName: err.name, status: awsMatch.status },
      `[errorHandler] AWS ${err.name}`,
    );
    // [SEC S-12/S-19] El texto de AWS lleva tablas, ARNs y claves: nunca al cliente
    return res
      .status(awsMatch.status)
      .json({ error: 'Error de servicio externo', code: awsMatch.code });
  }

  // Errores aplicativos con `status` (lanzados por nosotros desde handlers)
  // Incluye 4xx de negocio: se mantiene err.message (no se oculta en prod).
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 600) {
    if (err.status >= 500) {
      // [SEC S-12] 5xx controlados en prod: mensaje genérico + errorId
      const errorId = shortErrorId();
      log.error({ err, errorId, status: err.status }, '[errorHandler] error aplicativo 5xx');
      return res.status(err.status).json({
        error: 'Error interno del servidor',
        errorId,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    log.warn({ err, status: err.status }, '[errorHandler] error aplicativo');
    return res
      .status(err.status)
      .json({ error: err.message || 'Error', ...(err.code ? { code: err.code } : {}) });
  }

  // Errores no controlados (5xx) [SEC S-12/S-19]: también en desarrollo, el detalle va al log
  const errorId = shortErrorId();
  log.error({ err, errorId }, '[errorHandler] error no controlado');
  return res.status(500).json({ error: 'Error interno del servidor', errorId });
}
