/**
 * Importación de Coupons (entradas) vía API HTTP de Ágora.
 * POST `${baseUrl}/api/import/` — cuerpo { Coupons: [...] }.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Valida que baseUrl sea http(s) parseable con hostname.
 * No bloquea IPs privadas: el POS Ágora suele estar en LAN/VPN del local.
 * @param {string} baseUrl
 * @returns {string} URL normalizada sin slash final
 */
export function validateAgoraBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) {
    const err = new Error('baseUrl de Ágora es obligatorio');
    err.status = 400;
    throw err;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    const err = new Error('baseUrl de Ágora no es una URL válida');
    err.status = 400;
    throw err;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const err = new Error('baseUrl de Ágora debe ser http o https');
    err.status = 400;
    throw err;
  }
  if (!url.hostname || url.hostname.includes(' ')) {
    const err = new Error('baseUrl de Ágora tiene un host no válido');
    err.status = 400;
    throw err;
  }
  // Evitar credenciales embebidas y userinfo raro
  if (url.username || url.password) {
    const err = new Error('baseUrl de Ágora no debe incluir usuario/contraseña');
    err.status = 400;
    throw err;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function isPresent(v) {
  return v != null && v !== '';
}

/**
 * Construye el objeto Coupon para Ágora.
 * Nunca incluye null ni cadenas vacías.
 * ValidUntil XOR (ValidFrom + ValidTo).
 *
 * @param {{
 *   settingsId: number|string,
 *   code: string,
 *   createdAt: string,
 *   validUntil?: string|null,
 *   validFrom?: string|null,
 *   validTo?: string|null,
 *   printAtPosId?: number|string|null,
 * }} input
 */
export function buildCouponPayload(input) {
  const settingsId = Number(input?.settingsId);
  if (!Number.isFinite(settingsId) || settingsId <= 0) {
    const err = new Error('SettingsId debe ser un número positivo');
    err.status = 400;
    throw err;
  }
  const code = String(input?.code || '').trim();
  if (!code) {
    const err = new Error('Code es obligatorio');
    err.status = 400;
    throw err;
  }
  const createdAt = String(input?.createdAt || '').trim();
  if (!createdAt) {
    const err = new Error('CreatedAt es obligatorio');
    err.status = 400;
    throw err;
  }

  const hasUntil = isPresent(input?.validUntil);
  const hasFrom = isPresent(input?.validFrom);
  const hasTo = isPresent(input?.validTo);

  if (hasUntil && (hasFrom || hasTo)) {
    const err = new Error('ValidUntil no se puede combinar con ValidFrom/ValidTo');
    err.status = 400;
    throw err;
  }
  if (hasFrom !== hasTo) {
    const err = new Error('ValidFrom y ValidTo deben indicarse juntos');
    err.status = 400;
    throw err;
  }

  /** @type {Record<string, string|number>} */
  const coupon = {
    SettingsId: settingsId,
    Code: code,
    CreatedAt: createdAt,
  };

  if (hasUntil) {
    coupon.ValidUntil = String(input.validUntil).trim();
  } else if (hasFrom && hasTo) {
    coupon.ValidFrom = String(input.validFrom).trim();
    coupon.ValidTo = String(input.validTo).trim();
  }

  if (isPresent(input?.printAtPosId)) {
    const posId = Number(input.printAtPosId);
    if (!Number.isFinite(posId) || posId <= 0) {
      const err = new Error('PrintAtPosId debe ser un número positivo');
      err.status = 400;
      throw err;
    }
    coupon.PrintAtPosId = posId;
  }

  return coupon;
}

/**
 * Importa coupons en Ágora.
 * @param {{ baseUrl: string, apiToken: string, coupons: object[] }} opts
 */
export async function importCoupons({ baseUrl, apiToken, coupons }) {
  const normalizedBase = validateAgoraBaseUrl(baseUrl);
  const token = String(apiToken || '').trim();
  if (!token) {
    const err = new Error('Api-Token de Ágora no configurado');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(coupons) || coupons.length === 0) {
    const err = new Error('Debe indicar al menos un coupon');
    err.status = 400;
    throw err;
  }

  const url = `${normalizedBase}/api/import/`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Api-Token': token,
        Accept: 'application/json; charset=utf-8',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ Coupons: coupons }),
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 500) };
      }
    }

    if (!res.ok) {
      const detail =
        (data && (data.message || data.error || data.Message)) ||
        (typeof text === 'string' ? text.slice(0, 300) : '');
      const err = new Error(`Ágora respondió ${res.status}${detail ? `: ${detail}` : ''}`);
      err.status = 502;
      err.agoraStatus = res.status;
      err.agoraBody = data;
      throw err;
    }

    return { ok: true, status: res.status, data };
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error('Timeout al importar coupons en Ágora');
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
