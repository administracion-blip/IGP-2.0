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
import { vocabularioTranscripcion } from './matcher.js';

export const CONTEXTO_TRANSCRIPCION = 'Conteo de inventario de bar: nombre de producto y cantidad.';

/** Frases de ejemplo fijas: van delante del vocabulario para que el recorte de 1000 caracteres no se las lleve. */
export const EJEMPLOS_TRANSCRIPCION = 'Ejemplos: «Ballantines 10, 14»; «tres filas de diez cajas por 24».';

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
 * Contexto, ejemplos de frase y vocabulario (alias más usados, luego nombres cortos) hasta
 * MAX_PROMPT_TRANSCRIPCION caracteres. Solo se leen `nombre` de los productos y `texto`/`usos`
 * de los alias. Quien llama debe pasar la plantilla de este conteo, no el maestro global.
 *
 * @param {Iterable<{ productId: string, nombre: string, activo?: boolean }>} productos
 * @param {Iterable<{ texto: string, productId: string, usos?: number }>} [alias]
 * @returns {string}
 */
export function prepararPrompt(productos, alias = []) {
  const prefijo = `${CONTEXTO_TRANSCRIPCION} ${EJEMPLOS_TRANSCRIPCION}`;
  let prompt = prefijo;
  for (const termino of vocabularioTranscripcion(productos, alias)) {
    const siguiente = `${prompt}, ${termino}`;
    if (siguiente.length > MAX_PROMPT_TRANSCRIPCION) break;
    prompt = siguiente;
  }
  return prompt;
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
  return String(salida?.texto ?? '').trim();
}
