import { logger } from './logger.js';

/**
 * Validación estricta de variables de entorno al arranque.
 *
 * REQUIRED: variables sin las que el API no debe iniciar. Su ausencia provoca
 * `process.exit(1)` con un log de error que las enumera todas a la vez.
 *
 * RECOMMENDED: variables con fallback razonable o solo necesarias para ciertas
 * funciones (envío de email, presigned URLs, CORS en producción). Su ausencia
 * solo emite un warning para no bloquear el arranque en entornos parciales.
 *
 * Nota: las variables de tabla DynamoDB (`DDB_*`) tienen fallback en
 * `lib/db.js` y no se incluyen aquí.
 */
const REQUIRED = ['JWT_SECRET', 'AWS_REGION', 'INTERNAL_SYNC_SECRET'];

const RECOMMENDED = [
  'S3_BUCKET',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'CORS_ALLOWED_ORIGINS',
];

export function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.error(
      { missing },
      'Variables de entorno requeridas no definidas. Abortando.',
    );
    process.exit(1);
  }

  const missingRecommended = RECOMMENDED.filter((k) => !process.env[k]);
  if (missingRecommended.length) {
    logger.warn(
      { missing: missingRecommended },
      'Variables de entorno recomendadas no definidas',
    );
  }
}
