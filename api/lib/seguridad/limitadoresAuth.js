/**
 * Limitadores de intentos de las rutas públicas de autenticación. Se montan en
 * `server.js` antes de `authRouter`. Cuentan por IP (`req.ip`): detrás de un
 * proxy hace falta `trust proxy` o todos los clientes comparten contador.
 */
import rateLimit from 'express-rate-limit';

function entero(valor, defecto) {
  const n = parseInt(valor || '', 10);
  return Number.isFinite(n) && n > 0 ? n : defecto;
}

export function crearLimitadoresAuth(env = process.env) {
  const comun = { standardHeaders: true, legacyHeaders: false };
  return {
    login: rateLimit({
      ...comun,
      windowMs: entero(env.RATE_LIMIT_LOGIN_WINDOW_MS, 900000),
      max: entero(env.RATE_LIMIT_LOGIN_MAX, 15),
      message: { error: 'Demasiados intentos de login. Inténtalo de nuevo más tarde.' },
    }),
    // Más restrictivo que el login: evita usarlo para spam de correos o enumeración.
    forgotPassword: rateLimit({
      ...comun,
      windowMs: entero(env.RATE_LIMIT_FORGOT_WINDOW_MS, 900000),
      max: entero(env.RATE_LIMIT_FORGOT_MAX, 5),
      message: { error: 'Demasiadas solicitudes de recuperación. Inténtalo de nuevo más tarde.' },
    }),
    resetPassword: rateLimit({
      ...comun,
      windowMs: entero(env.RATE_LIMIT_RESET_WINDOW_MS, 900000),
      max: entero(env.RATE_LIMIT_RESET_MAX, 10),
      message: { error: 'Demasiados intentos de restablecer la contraseña. Inténtalo de nuevo más tarde.' },
    }),
  };
}
