/**
 * Ajustes de IA (informes, dictado, lectura de fotos y OCR de facturas).
 *
 * Un único item en `Igp_Ajustes` (PK='IA', SK='CONFIG'). El modelo de cada uso
 * se resuelve así: valor guardado → variable de entorno actual → constante.
 * Así, un despliegue sin nada guardado sigue usando el modelo de siempre.
 * Solo quien tiene `ia.ajustes` puede cambiarlos.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { chatCompletion, iaDisponible, transcribirAudio } from './openaiClient.js';

const PK = 'IA';
const SK = 'CONFIG';

/** Modelos de chat ofrecidos en los desplegables. */
export const MODELOS_SUGERIDOS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];

/** Modelos de transcripción. No sirven para una llamada de chat. */
export const MODELOS_TRANSCRIPCION = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];

export const AVISO_DICTADO = 'El dictado no está disponible ahora, cuenta a mano';
export const AVISO_LECTURA = 'No se ha podido leer la foto';
export const AVISO_OCR = 'No se ha podido leer la factura con IA. Complétala a mano.';
export const AVISO_INFORME = 'No se pudo generar el informe';

/**
 * Cada uso: campo guardado, variable de entorno (si existe) y defecto del código.
 * `tipo` distingue la prueba mínima (chat o un audio corto).
 */
export const USOS_MODELO = {
  informes: { campo: 'modelo', env: 'IA_INFORMES_MODEL', defecto: 'gpt-4o-mini', tipo: 'chat', aviso: AVISO_INFORME },
  transcripcion: { campo: 'modeloTranscripcion', env: 'OPENAI_TRANSCRIBE_MODEL', defecto: 'gpt-4o-mini-transcribe', tipo: 'transcripcion', aviso: AVISO_DICTADO },
  interpretacion: { campo: 'modeloInterpretacion', env: null, defecto: 'gpt-4o-mini', tipo: 'chat', aviso: AVISO_DICTADO },
  lectura: { campo: 'modeloLectura', env: 'IA_INVENTARIO_MODEL', defecto: 'gpt-4o', tipo: 'chat', aviso: AVISO_LECTURA },
  ocr: { campo: 'modeloOcr', env: 'OCR_IA_MODEL', defecto: 'gpt-4o-mini', tipo: 'chat', aviso: AVISO_OCR },
};

const CAMPOS_MODELO = Object.values(USOS_MODELO).map((u) => u.campo);

function clampNum(valor, min, max, porDefecto) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, n));
}

/** Variable de entorno si tiene texto; si no, la constante del código. */
export function modeloDeEntorno(env, defecto) {
  if (!env) return defecto;
  const m = process.env[env];
  return m && String(m).trim() ? String(m).trim() : defecto;
}

function textoModelo(valor) {
  if (typeof valor !== 'string') return '';
  return valor.trim().replace(/[\r\n]/g, '').slice(0, 60);
}

/** Valores por defecto: variable de entorno actual y, si no hay, la constante. */
export function ajustesPorDefecto() {
  const modelos = {};
  for (const uso of Object.values(USOS_MODELO)) {
    modelos[uso.campo] = modeloDeEntorno(uso.env, uso.defecto);
  }
  return {
    ...modelos,
    temperatura: clampNum(process.env.IA_INFORMES_TEMPERATURA, 0, 1, 0.2),
    maxEjecucionesHora: Math.trunc(clampNum(process.env.IA_MAX_EJECUCIONES_HORA, 1, 100, 10)),
    maxDatosJsonChars: Math.trunc(clampNum(process.env.IA_MAX_DATOS_JSON_CHARS, 1000, 200000, 60000)),
  };
}

/** Devuelve los ajustes efectivos (guardados sobre los por defecto). */
export async function getAjustesIa() {
  const base = ajustesPorDefecto();
  try {
    const r = await docClient.send(new GetCommand({ TableName: tables.ajustes, Key: { PK, SK } }));
    if (!r.Item) return base;
    const modelos = {};
    for (const campo of CAMPOS_MODELO) {
      const guardado = textoModelo(r.Item[campo]);
      modelos[campo] = guardado || base[campo];
    }
    return {
      ...modelos,
      temperatura: clampNum(r.Item.temperatura, 0, 1, base.temperatura),
      maxEjecucionesHora: Math.trunc(clampNum(r.Item.maxEjecucionesHora, 1, 100, base.maxEjecucionesHora)),
      maxDatosJsonChars: Math.trunc(clampNum(r.Item.maxDatosJsonChars, 1000, 200000, base.maxDatosJsonChars)),
    };
  } catch (err) {
    // Un corte de lectura no es «no hay nada guardado»: si devolviéramos los
    // defectos, un guardado los pisaría y un dictado podría tirar el audio.
    console.warn('[ia/ajustes] No se pudieron leer los ajustes:', err.message || err);
    throw err;
  }
}

/**
 * Guarda ajustes (valida y normaliza). Solo persiste campos conocidos.
 * @param {object} patch
 * @param {object} user
 */
export async function guardarAjustesIa(patch = {}, user) {
  const actuales = await getAjustesIa();
  const modelos = {};
  for (const campo of CAMPOS_MODELO) {
    const pedido = textoModelo(patch[campo]);
    modelos[campo] = pedido || actuales[campo];
  }
  const nuevo = {
    ...modelos,
    temperatura: patch.temperatura != null ? clampNum(patch.temperatura, 0, 1, actuales.temperatura) : actuales.temperatura,
    maxEjecucionesHora: patch.maxEjecucionesHora != null
      ? Math.trunc(clampNum(patch.maxEjecucionesHora, 1, 100, actuales.maxEjecucionesHora))
      : actuales.maxEjecucionesHora,
    maxDatosJsonChars: patch.maxDatosJsonChars != null
      ? Math.trunc(clampNum(patch.maxDatosJsonChars, 1000, 200000, actuales.maxDatosJsonChars))
      : actuales.maxDatosJsonChars,
  };
  await docClient.send(new PutCommand({
    TableName: tables.ajustes,
    Item: {
      PK,
      SK,
      ...nuevo,
      actualizadoEn: new Date().toISOString(),
      actualizadoPor: String(user?.Nombre ?? user?.email ?? user?.id_usuario ?? ''),
    },
  }));
  return nuevo;
}

/** WAV PCM mínimo (0,1 s de silencio) para probar un modelo de transcripción. */
function wavDePrueba() {
  const muestras = 1600;
  const datos = muestras * 2;
  const buf = Buffer.alloc(44 + datos);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + datos, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(datos, 40);
  return buf;
}

/**
 * Llama al modelo elegido sin guardarlo. Si no responde, aviso en español
 * (el detalle técnico solo va al log).
 *
 * @param {string} uso
 * @param {string} modelo
 * @returns {Promise<{ ok: true } | { ok: false, aviso: string }>}
 */
export async function probarModeloIa(uso, modelo) {
  const def = USOS_MODELO[uso];
  if (!def) {
    throw Object.assign(new Error('Uso de IA desconocido'), { status: 400, expose: true });
  }
  const nombre = textoModelo(modelo);
  if (!nombre) {
    throw Object.assign(new Error('Indica un modelo'), { status: 400, expose: true });
  }
  if (!iaDisponible()) return { ok: false, aviso: def.aviso };
  try {
    if (def.tipo === 'transcripcion') {
      await transcribirAudio(wavDePrueba(), {
        nombre: 'prueba.wav',
        tipo: 'audio/wav',
        modelo: nombre,
        idioma: 'es',
        timeoutMs: 20000,
      });
    } else {
      await chatCompletion({
        system: 'Responde únicamente ok.',
        user: 'ok',
        model: nombre,
        temperature: 0,
        maxTokens: 16,
        timeoutMs: 20000,
      });
    }
    return { ok: true };
  } catch (err) {
    console.warn('[ia/probar]', uso, err?.detalle || err?.message || err);
    return { ok: false, aviso: def.aviso };
  }
}
