/**
 * Wrapper centralizado para llamadas al API Express.
 *
 * Funcionalidad:
 * - Adjunta automáticamente el token Bearer si existe.
 * - Prefija la ruta con `API_BASE_URL` (los callers pasan rutas relativas tipo '/api/...').
 * - Para `FormData` no fuerza Content-Type: fetch lo calcula con su boundary.
 * - Aplica un timeout por defecto (`DEFAULT_TIMEOUT_MS`) usando AbortController.
 *   Se puede sobreescribir por llamada con `init.timeoutMs`, deshabilitar con
 *   `timeoutMs: 0`, o coordinar con un `signal` externo (se respeta el primero
 *   que aborte).
 * - Cuando el backend responde 401 emite `authEvents.emitUnauthorized()` para
 *   que el AuthContext limpie el token y redirija a login, **salvo** que la
 *   llamada pase `skipUnauthorizedEmit: true` (p. ej. la campana: un fallo
 *   puntual del contador no debe tumbar toda la sesión).
 *   La respuesta sigue propagándose al caller para que decida cómo mostrar el error.
 */
import { API_BASE_URL } from './apiBaseUrl';
import { getToken } from './authToken';
import { authEvents } from './authEvents';

export const DEFAULT_TIMEOUT_MS = 30000;

export type ApiFetchInit = RequestInit & {
  /**
   * Timeout en milisegundos para la petición. Por defecto `DEFAULT_TIMEOUT_MS`.
   * Pasa `0` para desactivarlo (útil para descargas largas o long polling).
   */
  timeoutMs?: number;
  /**
   * Si es true, un 401 no dispara el logout global. Úsalo solo en lecturas
   * auxiliares (campana, badges) donde el fallo no implica sesión inválida.
   */
  skipUnauthorizedEmit?: boolean;
};

export async function apiFetch(
  path: string,
  init: ApiFetchInit = {}
): Promise<Response> {
  const token = await getToken();
  const isFormData =
    typeof FormData !== 'undefined' && init.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...((init.headers as Record<string, string>) || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: externalSignal,
    skipUnauthorizedEmit = false,
    ...rest
  } = init;

  const controller =
    timeoutMs > 0 || externalSignal ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (controller) {
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }
  }

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (res.status === 401 && !skipUnauthorizedEmit) {
      authEvents.emitUnauthorized();
    }

    return await conReferenciaEnError5xx(res);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const LONGITUD_REF_ERROR = 8;

/**
 * Añade `(ref. xxxxxxxx)` al mensaje con los primeros caracteres del `errorId`
 * que el backend registra en el log, para que soporte localice el fallo.
 * Idempotente: no duplica la referencia si ya está.
 */
export function mensajeConReferencia(mensaje: string, errorId: unknown): string {
  if (typeof errorId !== 'string' || !errorId.trim()) return mensaje;
  const sufijo = `(ref. ${errorId.trim().slice(0, LONGITUD_REF_ERROR)})`;
  return mensaje.includes(sufijo) ? mensaje : `${mensaje} ${sufijo}`;
}

/**
 * Los 5xx del backend llegan como `{ error, errorId }`. Casi todas las pantallas
 * muestran `data.error` tal cual, así que la referencia se incrusta en `error`
 * aquí y llega a todas sin tocarlas. El resto de respuestas se devuelven intactas.
 */
async function conReferenciaEnError5xx(res: Response): Promise<Response> {
  if (res.status < 500) return res;
  if (!(res.headers.get('content-type') || '').includes('application/json')) return res;
  let data: unknown;
  try {
    data = await res.clone().json();
  } catch {
    return res;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res;
  const body = data as Record<string, unknown>;
  if (typeof body.errorId !== 'string' || !body.errorId.trim()) return res;
  const base =
    typeof body.error === 'string' && body.error ? body.error : 'Error interno del servidor';
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(
    JSON.stringify({ ...body, error: mensajeConReferencia(base, body.errorId) }),
    { status: res.status, statusText: res.statusText, headers }
  );
}

/**
 * Extrae un mensaje legible de un valor `unknown` lanzado en `catch`.
 * Patrón estándar TS para evitar `catch (e: any)` y aun así renderizar algo
 * útil al usuario. Si `e` no es Error ni string ni objeto con `.message`,
 * devuelve `fallback` (o 'Error desconocido').
 */
export function errorMessage(e: unknown, fallback = 'Error desconocido'): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === 'string') return e || fallback;
  if (e && typeof e === 'object' && 'message' in e) {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}
