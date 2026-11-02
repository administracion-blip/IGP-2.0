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
 * - OPENAI_TRANSCRIBE_MODEL: modelo de transcribirAudio (default gpt-4o-mini-transcribe).
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TRANSCRIPCION_URL = 'https://api.openai.com/v1/audio/transcriptions';

export const MENSAJE_TRANSCRIPCION_NO_CONFIGURADA = 'La transcripción no está configurada.';
export const MENSAJE_TRANSCRIPCION_FALLIDA = 'No se ha podido transcribir el audio. Inténtalo de nuevo.';
/** whisper-1 solo usa ~224 tokens de prompt; los gpt-4o-*-transcribe aceptan más. Conservador. */
export const MAX_PROMPT_TRANSCRIPCION = 1000;

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
 * @param {string} opts.user - mensaje de usuario. Si no hay `imagenes`, viaja como texto.
 * @param {Array<{ url: string }>} [opts.imagenes] — si viene con elementos, el
 *   usuario pasa a ser texto + imágenes. Si se omite, el cuerpo no cambia.
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
  imagenes,
} = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || String(apiKey).trim() === '') {
    throw new Error('OPENAI_API_KEY no configurada');
  }
  const usedModel = model || modeloInformes();

  const contenidoUsuario = Array.isArray(imagenes) && imagenes.length > 0
    ? [
      { type: 'text', text: user },
      ...imagenes.map((img) => ({ type: 'image_url', image_url: { url: img.url } })),
    ]
    : user;

  const body = {
    model: usedModel,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: contenidoUsuario },
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

/** Env OPENAI_TRANSCRIBE_MODEL (opcional); por defecto gpt-4o-mini-transcribe. */
export function modeloTranscripcion() {
  const m = process.env.OPENAI_TRANSCRIBE_MODEL;
  return m && String(m).trim() ? String(m).trim() : 'gpt-4o-mini-transcribe';
}

/**
 * Error publicable (`expose`): el mensaje es español y seguro; `detalle` solo va al log y nunca
 * lleva el audio.
 */
function errorTranscripcion(status, mensaje, detalle) {
  return Object.assign(new Error(mensaje), { status, expose: true, ...(detalle && { detalle }) });
}

/**
 * Transcribe un audio con audio/transcriptions (multipart con fetch/FormData/Blob nativos).
 * El buffer solo viaja a OpenAI: no se guarda ni se registra.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {object} [opts]
 * @param {string} [opts.nombre='audio.webm'] — la API deduce el formato por la extensión.
 * @param {string} [opts.tipo='audio/webm']
 * @param {string} [opts.prompt] — vocabulario; se recorta a MAX_PROMPT_TRANSCRIPCION caracteres.
 * @param {string} [opts.idioma='es']
 * @param {string} [opts.modelo] — por defecto modeloTranscripcion().
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<{ texto: string }>}
 * @throws 503 sin OPENAI_API_KEY; 502 si la API falla, no responde a tiempo o responde mal.
 */
export async function transcribirAudio(buffer, {
  nombre = 'audio.webm',
  tipo = 'audio/webm',
  prompt,
  idioma = 'es',
  modelo,
  timeoutMs = 60000,
} = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || String(apiKey).trim() === '') {
    throw errorTranscripcion(503, MENSAJE_TRANSCRIPCION_NO_CONFIGURADA);
  }
  if (!buffer || !buffer.length) throw errorTranscripcion(400, 'No se recibió audio.');

  // El Blob copia el buffer y se crea antes de cualquier await: quien llama puede soltar su
  // referencia en cuanto recibe la promesa (transcripcion.js lo hace).
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: tipo }), nombre);
  form.append('model', modelo || modeloTranscripcion());
  if (idioma) form.append('language', idioma);
  const textoPrompt = String(prompt ?? '').trim().slice(0, MAX_PROMPT_TRANSCRIPCION);
  if (textoPrompt) form.append('prompt', textoPrompt);
  form.append('response_format', 'json');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(OPENAI_TRANSCRIPCION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      const detalle = controller.signal.aborted ? `timeout ${timeoutMs} ms` : `red: ${err?.message || err}`;
      throw errorTranscripcion(502, MENSAJE_TRANSCRIPCION_FALLIDA, detalle);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw errorTranscripcion(502, MENSAJE_TRANSCRIPCION_FALLIDA, `OpenAI HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw errorTranscripcion(502, MENSAJE_TRANSCRIPCION_FALLIDA, 'respuesta de OpenAI no es JSON');
    }
    return { texto: typeof data?.text === 'string' ? data.text.trim() : '' };
  } finally {
    clearTimeout(timeout);
  }
}
