/**
 * Wrapper centralizado para llamadas al API Express.
 * Adjunta automáticamente el token Bearer y prefija con API_BASE_URL para que
 * las pantallas pasen rutas relativas tipo '/api/...'.
 *
 * Para `FormData` NO se fuerza Content-Type: fetch lo calcula con su boundary.
 * El caller puede sobreescribir cualquier header pasándolo en init.headers.
 */
import { API_BASE_URL } from './apiBaseUrl';
import { getToken } from './authToken';

export async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getToken();
  const isFormData =
    typeof FormData !== 'undefined' && init.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...((init.headers as Record<string, string>) || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}
