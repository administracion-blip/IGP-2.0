/**
 * Transcripción del audio del dictado (fase 5). El audio solo viaja al modelo: no se guarda en S3
 * ni en disco ni se registra. Como vocabulario se mandan SOLO nombres de productos y alias, nunca
 * stock (teórico ni contado) ni cantidades.
 */

import {
  MAX_PROMPT_TRANSCRIPCION,
  MENSAJE_TRANSCRIPCION_FALLIDA,
  transcribirAudio,
} from '../../ia/openaiClient.js';
import { normalizarTexto, vocabularioTranscripcion } from './matcher.js';

export const CONTEXTO_TRANSCRIPCION = 'Conteo de inventario de bar: nombre de producto y cantidad.';

/**
 * Ecos del prompt que el modelo devuelve cuando el trozo es silencio. Un conteo real
 * («Ballantines 10, 14» o «tres filas de diez cajas por 24» a solas) no está aquí.
 */
const ECOS_PROMPT = [
  'conteo de inventario de bar',
  'nombre de producto y cantidad',
  'ejemplos ballantines 10 14',
  'ejemplos tres filas de diez cajas por 24',
  'ballantines 10 14 tres filas de diez cajas por 24',
];

const RELLENO = new Set(['eh', 'ah', 'mm', 'mmm', 'hmm', 'em', 'um', 'mhm', 'aja']);

let transcribirFn = transcribirAudio;

/** En pruebas se sustituye la llamada al modelo. Devuelve la función que restaura. */
export function configurarTranscripcion(fn) {
  const previa = transcribirFn;
  transcribirFn = fn || transcribirAudio;
  return () => { transcribirFn = previa; };
}

export function restablecerTranscripcion() {
  transcribirFn = transcribirAudio;
}

/**
 * Contexto y vocabulario (alias más usados, luego nombres cortos) hasta
 * MAX_PROMPT_TRANSCRIPCION caracteres. Sin frases de ejemplo: el modelo las devolvía en los
 * silencios. Solo se leen `nombre` de los productos y `texto`/`usos` de los alias. Quien llama
 * debe pasar la plantilla de este conteo, no el maestro global.
 *
 * @param {Iterable<{ productId: string, nombre: string, activo?: boolean }>} productos
 * @param {Iterable<{ texto: string, productId: string, usos?: number }>} [alias]
 * @returns {string}
 */
export function prepararPrompt(productos, alias = []) {
  let prompt = CONTEXTO_TRANSCRIPCION;
  for (const termino of vocabularioTranscripcion(productos, alias)) {
    const siguiente = `${prompt}, ${termino}`;
    if (siguiente.length > MAX_PROMPT_TRANSCRIPCION) break;
    prompt = siguiente;
  }
  return prompt;
}

/**
 * true si la transcripción no debe crear líneas: vacía o casi vacía, eco del prompt
 * (el texto coincide con él o lo contiene) o eco de sus ejemplos juntos.
 *
 * @param {unknown} texto
 * @param {string} [prompt]
 * @returns {boolean}
 */
export function transcripcionInservible(texto, prompt = '') {
  const t = normalizarTexto(texto);
  if (!t || t.length < 2) return true;
  const tokens = t.split(' ').filter(Boolean);
  if (tokens.length > 0 && tokens.every((p) => RELLENO.has(p))) return true;
  if (ECOS_PROMPT.some((f) => t.includes(f))) return true;
  const p = normalizarTexto(prompt);
  if (p && (t === p || t.includes(p))) return true;
  return false;
}

/**
 * Transcribe el fichero ya validado (perfil 'audio'). El nombre enviado es genérico con la
 * extensión del tipo detectado: el nombre original del cliente no sale del servidor.
 * Deja `file.buffer` a null en cuanto el transcriptor ha tomado el audio.
 *
 * @param {{ buffer: Buffer, mimetype: string, extDetectada?: string }} file
 * @param {{ productos?: Iterable<object>, alias?: Iterable<object> }} [ctx]
 * @returns {Promise<string>} texto recortado ('' si no se entendió nada).
 * @throws 503 sin configurar; 502 en cualquier otro fallo (mensaje en español).
 */
export async function transcribir(file, { productos = [], alias = [] } = {}) {
  const prompt = prepararPrompt(productos, alias);
  let salida;
  try {
    // transcribirAudio crea el Blob (una copia) antes de su primer await: en cuanto vuelve la
    // promesa se suelta el buffer de multer para no tener el audio dos veces en memoria.
    const enCurso = transcribirFn(file.buffer, {
      nombre: `audio.${file.extDetectada || 'webm'}`,
      tipo: file.mimetype,
      prompt,
      idioma: 'es',
    });
    file.buffer = null;
    salida = await enCurso;
  } catch (err) {
    if (err?.expose && (err.status === 502 || err.status === 503)) throw err;
    throw Object.assign(new Error(MENSAJE_TRANSCRIPCION_FALLIDA), {
      status: 502,
      expose: true,
      detalle: String(err?.message || err).slice(0, 500),
    });
  }
  const texto = String(salida?.texto ?? '').trim();
  if (transcripcionInservible(texto, prompt)) return '';
  return texto;
}
