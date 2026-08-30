/**
 * Cliente HTTP común para OpenAI (chat/completions).
 *
 * Extraído del patrón `fetch` de `ocrEnriquecerIa.js` para reutilizarlo desde
 * el framework de Informes IA. No usa el SDK de openai (llamada directa).
 *
 * Envs:
 * - OPENAI_API_KEY: clave (misma que usa OCR).
 * - IA_INFORMES_MODEL: modelo para informes (default gpt-4o-mini). Independiente
 *   de OCR_IA_MODEL para no interferir con el OCR.
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function iaDisponible() {
  const k = process.env.OPENAI_API_KEY;
  return Boolean(k && String(k).trim() !== '');
}

export function modeloInformes() {
  return process.env.IA_INFORMES_MODEL || 'gpt-4o-mini';
}

/**
 * Llama a chat/completions y devuelve el texto y el uso de tokens.
 *
 * Ampliaciones aditivas (D-29 / actas): `responseFormat` y `maxTokens` son
 * opcionales; si no se pasan, el cuerpo es idéntico al histórico (OCR/informes).
 * Las actas de reunión pueden subir `timeoutMs` (p. ej. 300_000) porque una
 * transcripción larga supera los 90 s por defecto.
 *
 * @param {object} opts
 * @param {string} opts.system - mensaje de sistema.
 * @param {string} opts.user - mensaje de usuario.
 * @param {number} [opts.temperature=0.2]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs=90000] — actas: pasar valor alto si hace falta.
 * @param {string | { type: string } | object} [opts.responseFormat] — p. ej.
 *   `'json_object'` o `{ type: 'json_object' }` → `response_format` de la API.
 * @param {number} [opts.maxTokens] — se envía como `max_tokens` si es finito.
 * @returns {Promise<{ text: string, model: string, usage: { prompt: number, completion: number } }>}
 */
export async function chatCompletion({
  system,
  user,
  temperature = 0.2,
  model,
  timeoutMs = 90000,
  responseFormat,
  maxTokens,
} = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || String(apiKey).trim() === '') {
    throw new Error('OPENAI_API_KEY no configurada');
  }
  const usedModel = model || modeloInformes();

  const body = {
    model: usedModel,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (responseFormat != null) {
    body.response_format =
      typeof responseFormat === 'string' ? { type: responseFormat } : responseFormat;
  }
  if (maxTokens != null && Number.isFinite(Number(maxTokens))) {
    body.max_tokens = Number(maxTokens);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new Error('Respuesta OpenAI vacía');
  }

  return {
    text: text.trim(),
    model: usedModel,
    usage: {
      prompt: Number(data?.usage?.prompt_tokens) || 0,
      completion: Number(data?.usage?.completion_tokens) || 0,
    },
  };
}
