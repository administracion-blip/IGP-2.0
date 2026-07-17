/**
 * Ajustes editables del framework de Informes IA.
 *
 * Se guardan como un único item en la tabla genérica `Igp_Ajustes`
 * (PK='IA', SK='CONFIG'). Permite a un administrador cambiar modelo,
 * temperatura y límites sin tocar `.env`. Si no hay item guardado, se usan
 * los valores por defecto (env o constantes de código).
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { modeloInformes } from './openaiClient.js';

const PK = 'IA';
const SK = 'CONFIG';

/** Modelos ofrecidos en el desplegable de la UI (se permite además texto libre validado). */
export const MODELOS_SUGERIDOS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];

function clampNum(valor, min, max, porDefecto) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, n));
}

/** Valores por defecto (fallback a env, luego a constante). */
export function ajustesPorDefecto() {
  return {
    modelo: modeloInformes(),
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
    return {
      modelo: typeof r.Item.modelo === 'string' && r.Item.modelo.trim() ? r.Item.modelo.trim() : base.modelo,
      temperatura: clampNum(r.Item.temperatura, 0, 1, base.temperatura),
      maxEjecucionesHora: Math.trunc(clampNum(r.Item.maxEjecucionesHora, 1, 100, base.maxEjecucionesHora)),
      maxDatosJsonChars: Math.trunc(clampNum(r.Item.maxDatosJsonChars, 1000, 200000, base.maxDatosJsonChars)),
    };
  } catch (err) {
    console.warn('[ia/ajustes] No se pudieron leer los ajustes, usando defaults:', err.message || err);
    return base;
  }
}

/**
 * Guarda ajustes (valida y normaliza). Solo persiste campos conocidos.
 * @param {object} patch
 * @param {object} user
 */
export async function guardarAjustesIa(patch = {}, user) {
  const actuales = await getAjustesIa();
  const nuevo = {
    modelo: typeof patch.modelo === 'string' && patch.modelo.trim()
      ? patch.modelo.trim().slice(0, 60)
      : actuales.modelo,
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
