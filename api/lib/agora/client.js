/**
 * Cliente HTTP para el API de exportación de Ágora.
 * - Timeout configurable
 * - 2 reintentos ante 5xx o error de red
 * - Logs sin imprimir el token
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

/**
 * Fetch con timeout y reintentos.
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ timeoutMs?: number }} opts
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Llama al endpoint de exportación de cierres de sistema de Ágora.
 * @param {string} businessDay - YYYY-MM-DD
 * @param {number[]} [workplaces] - opcional; si no se pasa, no se envía el param (exporta todos)
 * @returns {Promise<{ SystemCloseOuts?: Array<AgoraCloseOut> }>}
 */
export async function exportSystemCloseOuts(businessDay, workplaces = null) {
  const baseUrl = (process.env.AGORA_BASE_URL || process.env.AGORA_API_BASE_URL || '').replace(/\/$/, '');
  const token = process.env.AGORA_API_TOKEN || '';
  if (!baseUrl || !token) {
    throw new Error('AGORA_BASE_URL (o AGORA_API_BASE_URL) y AGORA_API_TOKEN son obligatorios');
  }

  const params = new URLSearchParams();
  params.set('filter', 'SystemCloseOuts');
  params.set('business-day', businessDay);
  if (workplaces != null && Array.isArray(workplaces) && workplaces.length > 0) {
    params.set('workplaces', workplaces.join(','));
  }
  const url = `${baseUrl}/api/export/?${params.toString()}`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[agora] Reintento ${attempt}/${MAX_RETRIES} para SystemCloseOuts business-day=${businessDay}`);
      }
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Api-Token': token,
          Accept: 'application/json',
        },
      });

      if (res.status >= 500) {
        throw new Error(`Ágora respondió ${res.status}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ágora ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json();
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) continue;
      break;
    }
  }
  throw lastError;
}
