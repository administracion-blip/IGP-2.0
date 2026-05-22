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
 *   que el AuthContext limpie el token y redirija a login. La respuesta sigue
 *   propagándose al caller para que decida cómo mostrar el error.
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

  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, ...rest } = init;

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

    if (res.status === 401) {
      authEvents.emitUnauthorized();
    }

    return res;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
