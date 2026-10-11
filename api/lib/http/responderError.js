import crypto from 'crypto';
import { logger } from '../logger.js';

/**
 * Respuesta de error única para los catch de los routers.
 *
 * - 4xx explícito (`err.status` / `err.statusCode` entre 400 y 499, puesto por
 *   nuestro código): se conserva el status y el mensaje (son mensajes de negocio
 *   en español). `err.expose === false` lo fuerza a genérico; `err.expose === true`
 *   publica también el mensaje de un 5xx redactado por nosotros (sin datos de AWS/Ágora).
 * - Todo lo demás (5xx, errores de AWS/Dynamo/S3/Ágora, TypeError…): se registra
 *   completo en el log y al cliente solo le llega `mensaje` + `errorId`.
 *
 * Los errores del SDK de AWS no traen `status`/`statusCode` (usan `$metadata`),
 * así que nunca se tratan como 4xx intencionados.
 */

export const MENSAJE_GENERICO = 'Error interno del servidor';
export const MENSAJE_AGORA_4XX = 'Ágora rechazó la operación';

function statusExplicito(err) {
  if (!err || typeof err !== 'object' || err.$metadata) return null;
  const s = Number(err.status ?? err.statusCode);
  return Number.isInteger(s) && s >= 400 && s < 600 ? s : null;
}

/** `throw new Error('…')` de nuestras validaciones (ni AWS, ni TypeError, ni red). */
function esErrorPropioSinStatus(err) {
  if (!(err instanceof Error) || err.name !== 'Error' || err.$metadata || err.cause || err.syscall) return false;
  return !(typeof err.code === 'string' && /^(E[A-Z0-9]+|ERR_[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/.test(err.code));
}

/**
 * Status + mensaje que puede ver el cliente para `err`.
 * `statusPorDefecto` (4xx) es para catch de validación cuyo lib lanza `new Error('…')`
 * sin status: ese mensaje se conserva; cualquier otro error sigue siendo genérico.
 */
export function errorPublico(err, mensaje = MENSAJE_GENERICO, { statusPorDefecto } = {}) {
  let status = statusExplicito(err);
  if (!status && statusPorDefecto >= 400 && statusPorDefecto < 500 && esErrorPropioSinStatus(err)) {
    status = statusPorDefecto;
  }
  const exponer = status && (status < 500 ? err.expose !== false : err.expose === true);
  if (exponer && typeof err.message === 'string' && err.message) {
    return { status, error: err.message, publico: true };
  }
  const agora = Number(err?.agoraStatus);
  if (agora >= 400 && agora < 500) {
    return { status: status || 502, error: MENSAJE_AGORA_4XX, publico: false };
  }
  return { status: status || 500, error: mensaje || MENSAJE_GENERICO, publico: false };
}

/** Solo el texto seguro (para listas de errores dentro de respuestas 200). */
export function mensajeSeguro(err, mensaje = MENSAJE_GENERICO, opts) {
  return errorPublico(err, mensaje, opts).error;
}

/**
 * @param {import('express').Response} res
 * @param {unknown} err
 * @param {{ mensaje?: string, contexto?: string, status?: number, statusPorDefecto?: number, extra?: object }} [opts]
 *   `status` fuerza el código cuando el error no es un 4xx intencionado (p. ej. 502 de Ágora).
 */
export function responderError(res, err, { mensaje, contexto, status: statusForzado, statusPorDefecto, extra } = {}) {
  const req = res.req;
  const log = req?.log?.error ? req.log : logger;
  const pub = errorPublico(err, mensaje, { statusPorDefecto });
  const status = pub.publico ? pub.status : (statusForzado || pub.status);
  const ctx = contexto || (req ? `${req.method} ${req.baseUrl || ''}${req.path || ''}` : 'api');

  if (pub.publico) {
    log.warn?.({ err, status, contexto: ctx }, `[${ctx}] ${status}`);
    const code = typeof err.code === 'string' && /^[A-Za-z0-9_.-]{2,64}$/.test(err.code) ? err.code : undefined;
    return res.status(status).json({ error: pub.error, ...(code && { code }), ...extra });
  }

  const errorId = crypto.randomBytes(6).toString('hex');
  log.error({ err, errorId, status, contexto: ctx }, `[${ctx}] error ${status}`);
  if (res.headersSent) return res;
  return res.status(status).json({ error: pub.error, errorId, ...extra });
}
