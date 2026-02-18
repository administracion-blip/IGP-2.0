/**
 * Cliente HTTP para el API de exportación de Ágora.
 * Guía del Integrador 8.1.6: /api/export/?business-day=YYYY-MM-DD&filter=PosCloseOuts,SystemCloseOuts
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

async function fetchWithTimeout(url, options = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...options.headers },
    });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/** Exporta cierres de sistema (SystemCloseOuts). */
export async function exportSystemCloseOuts(businessDay, workplaces = null) {
  const baseUrl = (process.env.AGORA_BASE_URL || process.env.AGORA_API_BASE_URL || '').replace(/\/$/, '');
  const token = process.env.AGORA_API_TOKEN || '';
  if (!baseUrl || !token) throw new Error('AGORA_BASE_URL y AGORA_API_TOKEN son obligatorios');

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
        console.log(`[agora] Reintento ${attempt}/${MAX_RETRIES} SystemCloseOuts business-day=${businessDay}`);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
      }
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { 'Api-Token': token },
      });
      if (res.status >= 500) throw new Error(`Ágora respondió ${res.status}`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ágora ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Exporta cierres de caja por TPV (PosCloseOuts). */
export async function exportPosCloseOuts(businessDay, workplaces = null) {
  const baseUrl = (process.env.AGORA_BASE_URL || process.env.AGORA_API_BASE_URL || '').replace(/\/$/, '');
  const token = process.env.AGORA_API_TOKEN || '';
  if (!baseUrl || !token) throw new Error('AGORA_BASE_URL y AGORA_API_TOKEN son obligatorios');

  const params = new URLSearchParams();
  params.set('filter', 'PosCloseOuts');
  params.set('business-day', businessDay);
  if (workplaces != null && Array.isArray(workplaces) && workplaces.length > 0) {
    params.set('workplaces', workplaces.join(','));
  }
  const url = `${baseUrl}/api/export/?${params.toString()}`;
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[agora] Reintento ${attempt}/${MAX_RETRIES} PosCloseOuts business-day=${businessDay}`);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
      }
      const res = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { 'Api-Token': token },
      });
      if (res.status >= 500) throw new Error(`Ágora respondió ${res.status}`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ágora ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
