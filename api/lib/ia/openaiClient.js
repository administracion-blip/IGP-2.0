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
 * @param {object} opts
 * @param {string} opts.system - mensaje de sistema.
 * @param {string} opts.user - mensaje de usuario.
 * @param {number} [opts.temperature=0.2]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs=90000]
 * @returns {Promise<{ text: string, model: string, usage: { prompt: number, completion: number } }>}
 */
export async function chatCompletion({ system, user, temperature = 0.2, model, timeoutMs = 90000 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || String(apiKey).trim() === '') {
    throw new Error('OPENAI_API_KEY no configurada');
  }
  const usedModel = model || modeloInformes();

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
      body: JSON.stringify({
        model: usedModel,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
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
