/**
 * Interpretación de apoyo del dictado. Solo se consulta cuando las reglas dudan, fallan o la frase
 * es un cálculo o una continuación. La respuesta rellena la línea pendiente: no confirma ni aplica.
 * El modelo solo ve id y nombre de la plantilla de este conteo. Nunca stock.
 */

import { chatCompletion } from '../../ia/openaiClient.js';
import { normalizarTexto } from './matcher.js';

const MODELO = 'gpt-4o-mini';
const MAX_CANTIDAD = 100000;
const TIMEOUT_MS = 15000;

const SISTEMA = [
  'Eres el intérprete de un conteo de inventario de bar.',
  'Responde solo un JSON con las claves productId, cantidad y modo.',
  'productId tiene que ser un id de la lista, o null si no está claro cuál es. No inventes productos.',
  'Si hay varios productos de la misma marca y la frase no dice cuál, productId es null.',
  'cantidad es el número de unidades. Resuelve la cuenta dicha: «tres filas de diez cajas por 24» = 720.',
  'Si la frase continúa la anterior («multiplícalo por 24»), usa la frase anterior para el producto y la cuenta.',
  'modo es sumar, reemplazar o borrar. Si no piden corregir ni borrar, usa sumar.',
].join(' ');

let interpretarFn = null;

/** En pruebas se sustituye la llamada al modelo. Devuelve la función que restaura. */
export function configurarInterpretacionIa(fn) {
  const previa = interpretarFn;
  interpretarFn = fn || null;
  return () => { interpretarFn = previa; };
}

export function restablecerInterpretacionIa() {
  interpretarFn = null;
}

function enPrueba() {
  return process.env.NODE_TEST_CONTEXT != null || process.env.npm_lifecycle_event === 'test';
}

/** La frase sigue a la anterior («multiplícalo por 24») en vez de nombrar un producto nuevo. */
export function esContinuacion(orden) {
  const t = normalizarTexto(`${orden?.textoProducto || ''} ${orden?.textoOriginal || ''}`);
  return t.split(' ').some((p) => p.startsWith('multiplica'));
}

const MOTIVOS_DUDA = new Set([
  'sin_coincidencia', 'aproximado', 'nombre_ambiguo', 'sin_cantidad',
  'revisar_texto', 'generico', 'confianza_baja', 'falta_formato', 'calculo',
]);

/**
 * Cuándo pedir la propuesta. Una marca ambigua en la plantilla no se desempata aquí.
 * Un acierto limpio de las reglas (producto elegido y sin motivo de duda) tampoco.
 *
 * @param {{ orden?: object, productId?: string|null, motivos?: string[] }} ctx
 * @returns {boolean}
 */
export function debeConsultarIa({ orden, productId, motivos = [] } = {}) {
  if (!orden || orden.tipo === 'pausa' || orden.tipo === 'sigue') return false;
  if (motivos.includes('marca_ambigua')) return false;
  if (esContinuacion(orden)) return true;
  if (orden.calculo || motivos.includes('calculo') || motivos.includes('falta_formato') || motivos.includes('revisar_texto')) {
    return true;
  }
  if (!orden.textoProducto) return false;
  if (productId == null) return true;
  return motivos.some((m) => MOTIVOS_DUDA.has(m));
}

/** Solo id y nombre. Cualquier otro campo (stock teórico o contado) no sale de aquí. */
export function listaCerrada(productos) {
  const out = [];
  const vistos = new Set();
  for (const p of productos || []) {
    const productId = String(p?.productId ?? '').trim();
    const nombre = String(p?.nombre ?? '').trim();
    if (!productId || !nombre || vistos.has(productId)) continue;
    vistos.add(productId);
    out.push({ productId, nombre: nombre.slice(0, 200) });
  }
  return out;
}

export function mensajeUsuario({ texto, anterior, productos }) {
  const lineas = (productos || []).map((p) => `${p.productId}\t${p.nombre}`);
  const previa = anterior ? `\nFrase anterior: ${String(anterior).slice(0, 500)}` : '';
  return `Lista de productos de este conteo (id y nombre):\n${lineas.join('\n')}\n\nFrase: ${String(texto || '').slice(0, 2000)}${previa}`;
}

function validar(raw, lista) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const ids = new Map(lista.map((p) => [p.productId, p.nombre]));
  let productId = obj.productId == null || obj.productId === '' ? null : String(obj.productId).trim();
  if (productId && !ids.has(productId)) productId = null;
  let cantidad = null;
  if (obj.cantidad != null && obj.cantidad !== '') {
    const n = typeof obj.cantidad === 'number' ? obj.cantidad : Number(String(obj.cantidad).trim().replace(',', '.'));
    if (typeof obj.cantidad !== 'boolean' && Number.isFinite(n) && n >= 0 && n <= MAX_CANTIDAD) {
      cantidad = Math.round(n * 10000) / 10000;
    }
  }
  const modo = ['sumar', 'reemplazar', 'borrar'].includes(obj.modo) ? obj.modo : null;
  if (!productId && cantidad == null && !modo) return null;
  return { productId, nombre: productId ? ids.get(productId) : null, cantidad, modo };
}

async function llamarModelo(mensaje) {
  const { text } = await chatCompletion({
    system: SISTEMA,
    user: mensaje,
    model: MODELO,
    temperature: 0,
    timeoutMs: TIMEOUT_MS,
    maxTokens: 200,
    responseFormat: 'json_object',
  });
  return text;
}

/**
 * Pide una propuesta. null si no hay lista, el modelo falla o el JSON no aporta nada usable.
 * Un productId que no está en la lista se descarta; la cantidad y el modo, si valen, se conservan.
 *
 * @param {{ texto: string, anterior?: string|null, productos: Array<{ productId: string, nombre: string }> }} ctx
 * @returns {Promise<{ productId: string|null, nombre: string|null, cantidad: number|null, modo: string|null }|null>}
 */
export async function proponerInterpretacion({ texto, anterior = null, productos } = {}) {
  const lista = listaCerrada(productos);
  if (!String(texto || '').trim() || lista.length === 0) return null;
  const mensaje = mensajeUsuario({ texto, anterior, productos: lista });
  try {
    const fn = interpretarFn;
    if (!fn) {
      if (enPrueba()) return null;
      return validar(await llamarModelo(mensaje), lista);
    }
    return validar(await fn({ texto, anterior, productos: lista, mensaje }), lista);
  } catch {
    return null;
  }
}
