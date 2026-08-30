/**
 * Resumen IA de reunión (Fase 2E).
 *
 * Cuando el pipeline llega a `transcrita` / `resumiendo`: carga la transcripción,
 * llama a `chatCompletion` con la plantilla `reuniones_acta`, parsea el JSON,
 * descarta ítems sin cita y persiste resumen + PROPUESTA# + PUNTO#.
 */

import crypto from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { logger } from '../../logger.js';
import {
  chatCompletion as chatCompletionReal,
  iaDisponible,
  modeloInformes,
} from '../../ia/openaiClient.js';
import {
  FUENTE_REUNIONES_ACTA,
  componerSystemPrompt,
  plantillaDefault,
} from '../../ia/prompts.js';
import { listarPlantillas, plantillaCodigo } from '../../ia/promptsStore.js';
import {
  COBERTURAS_PUNTO,
  ESTADOS_REUNION,
  PK,
  SK,
  enLista,
} from '../tipos.js';

const ETIQUETA = 'reuniones-resumen';
const TIMEOUT_RESUMEN_MS = 180_000;
const S3_BUCKET = () => process.env.S3_BUCKET || 'igp-2.0-files';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function instanteIso() {
  return new Date().toISOString();
}

function normalizarNombre(valor) {
  return texto(valor)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

// ─── Inyección (tests) ───

/** @type {null | typeof chatCompletionReal} */
let chatCompletionInyectado = null;

/** @type {null | ((reunion: object) => Promise<string>)} */
let cargadorTranscripcionInyectado = null;

/** Sustituye chatCompletion (tests). Devuelve función que restaura. */
export function configurarChatCompletionResumen(fn) {
  const prev = chatCompletionInyectado;
  chatCompletionInyectado = fn;
  return () => {
    chatCompletionInyectado = prev;
  };
}

/** Sustituye la carga de transcripción (tests). Devuelve función que restaura. */
export function configurarCargadorTranscripcion(fn) {
  const prev = cargadorTranscripcionInyectado;
  cargadorTranscripcionInyectado = fn;
  return () => {
    cargadorTranscripcionInyectado = prev;
  };
}

function chatCompletionFn() {
  return chatCompletionInyectado || chatCompletionReal;
}

/** ¿Hay forma de llamar al modelo (clave real o mock de test)? */
export function resumenIaDisponible() {
  return Boolean(chatCompletionInyectado) || iaDisponible();
}

// ─── Modelo y plantilla ───

/**
 * Modelo para el acta: env `IA_REUNIONES_MODEL` → ajustes → modelo de informes.
 * @param {{ modelo_resumen?: string }} [ajustes]
 */
export function modeloResumenActa(ajustes = {}) {
  return (
    texto(process.env.IA_REUNIONES_MODEL) ||
    texto(ajustes.modelo_resumen) ||
    modeloInformes()
  );
}

async function resolverPlantillaActa() {
  try {
    const plantillas = await listarPlantillas(FUENTE_REUNIONES_ACTA);
    const def = plantillas.find((p) => p.esDefault);
    if (def && texto(def.instrucciones)) return def;
  } catch (err) {
    logger.warn({ err }, `[${ETIQUETA}] No se pudo leer Igp_IaPrompts; se usa plantilla de código`);
  }
  return plantillaCodigo(FUENTE_REUNIONES_ACTA) || {
    ...plantillaDefault(FUENTE_REUNIONES_ACTA),
    promptId: 'default',
  };
}

// ─── Transcripción ───

/**
 * Extrae texto plano del cuerpo S3 (JSON `{ texto }` de 2D, o texto crudo).
 * @param {string} cuerpo
 */
export function textoDesdeCuerpoTranscripcion(cuerpo) {
  const raw = String(cuerpo ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.texto === 'string' && parsed.texto.trim()) {
        return parsed.texto.trim();
      }
      if (typeof parsed?.transcript === 'string' && parsed.transcript.trim()) {
        return parsed.transcript.trim();
      }
    } catch {
      // no es JSON usable; se trata como texto plano
    }
  }
  return trimmed;
}

async function leerObjetoS3ComoTexto(key) {
  const r = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET(),
      Key: key,
    }),
  );
  if (!r.Body) return '';
  if (typeof r.Body.transformToString === 'function') {
    return r.Body.transformToString('utf-8');
  }
  // Fallback por si el mock no implementa transformToString
  const chunks = [];
  for await (const chunk of r.Body) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Carga el texto de la transcripción (inyección de test o GetObject S3).
 * @param {object} reunion
 */
export async function cargarTextoTranscripcion(reunion) {
  if (cargadorTranscripcionInyectado) {
    return texto(await cargadorTranscripcionInyectado(reunion));
  }
  const key = texto(reunion.transcripcion_s3_key);
  if (!key) {
    throw new Error('La reunión no tiene transcripcion_s3_key');
  }
  const cuerpo = await leerObjetoS3ComoTexto(key);
  const plano = textoDesdeCuerpoTranscripcion(cuerpo);
  if (!plano) {
    throw new Error('Transcripción vacía en S3');
  }
  return plano;
}

// ─── Parseo tolerante ───

/**
 * Intenta obtener un objeto JSON del texto del modelo (cercas markdown, ruido).
 * @param {string} raw
 * @returns {object | null}
 */
export function parsearActaJson(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;

  // Quitar cercas ```json … ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const intentar = (candidato) => {
    try {
      const v = JSON.parse(candidato);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };

  const directo = intentar(s);
  if (directo) return directo;

  const ini = s.indexOf('{');
  const fin = s.lastIndexOf('}');
  if (ini >= 0 && fin > ini) {
    return intentar(s.slice(ini, fin + 1));
  }
  return null;
}

function coberturaValida(valor) {
  const c = texto(valor).toLowerCase();
  if (enLista(COBERTURAS_PUNTO, c)) return c;
  if (c === 'no tratado' || c === 'no-tratado') return 'no_tratado';
  return null;
}

/**
 * Filtra acuerdos/tareas sin cita y normaliza la forma intermedia.
 * @param {object} acta
 */
export function normalizarActaParseada(acta) {
  const resumen = texto(acta?.resumen);
  const acuerdos = [];
  for (const a of Array.isArray(acta?.acuerdos) ? acta.acuerdos : []) {
    const cita = texto(a?.cita);
    const t = texto(a?.texto);
    if (!cita || !t) continue;
    acuerdos.push({
      texto: t,
      cita,
      responsable_sugerido: texto(a?.responsable_sugerido),
      fecha_sugerida: texto(a?.fecha_sugerida),
      confianza: Number.isFinite(Number(a?.confianza)) ? Number(a.confianza) : undefined,
    });
  }

  const tareas = [];
  for (const t of Array.isArray(acta?.tareas_propuestas) ? acta.tareas_propuestas : []) {
    const cita = texto(t?.cita);
    const titulo = texto(t?.titulo);
    if (!cita || !titulo) continue;
    tareas.push({
      titulo,
      descripcion: texto(t?.descripcion),
      cita,
      responsable_sugerido: texto(t?.responsable_sugerido),
      fecha_sugerida: texto(t?.fecha_sugerida),
      confianza: Number.isFinite(Number(t?.confianza)) ? Number(t.confianza) : undefined,
    });
  }

  const cobertura = [];
  for (const c of Array.isArray(acta?.cobertura) ? acta.cobertura : []) {
    const punto = texto(c?.punto);
    const estado = coberturaValida(c?.estado || c?.cobertura);
    if (!punto || !estado) continue;
    cobertura.push({
      punto,
      estado,
      cita: texto(c?.cita),
    });
  }

  const emergentes = [];
  for (const e of Array.isArray(acta?.emergentes) ? acta.emergentes : []) {
    const tema = texto(e?.tema || e?.texto || e?.punto);
    if (!tema) continue;
    emergentes.push({
      tema,
      cita: texto(e?.cita),
    });
  }

  return { resumen, acuerdos, tareas, cobertura, emergentes };
}

function idUsuarioPorNombre(asistentes, nombreSugerido) {
  const clave = normalizarNombre(nombreSugerido);
  if (!clave) return '';
  for (const a of asistentes) {
    if (normalizarNombre(a?.nombre) === clave) return texto(a?.usuario_id);
  }
  // Coincidencia parcial (nombre contenido)
  for (const a of asistentes) {
    const n = normalizarNombre(a?.nombre);
    if (n && (n.includes(clave) || clave.includes(n))) return texto(a?.usuario_id);
  }
  return '';
}

function fechaSugeridaOVacia(valor) {
  const f = texto(valor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
  return '';
}

async function leerAsistentes(idReunion) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: {
          ':pk': PK.reunion(idReunion),
          ':p': 'ASIST#',
        },
        ExclusiveStartKey,
      }),
    );
    for (const it of r.Items || []) items.push(it);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * ¿Ya hay resumen generado para este `transcripcion_hash`?
 * @param {object} reunion
 */
export function resumenYaGeneradoParaHash(reunion) {
  const hash = texto(reunion.transcripcion_hash);
  if (!hash) return false;
  if (!texto(reunion.resumen)) return false;
  const marcado = texto(reunion.resumen_hash);
  // Si aún no se escribió resumen_hash (carrera parcial), el resumen + mismo hash basta.
  if (marcado) return marcado === hash;
  return true;
}

/**
 * Persiste el resultado del acta y limpia el pipeline (atributo disperso).
 */
async function persistirActaOk(idReunion, reunion, { acta, usage, modelo, hash }) {
  const ahora = instanteIso();
  const asistentes = await leerAsistentes(idReunion);
  const pk = PK.reunion(idReunion);

  const propuestas = [];

  for (const a of acta.acuerdos) {
    const id = crypto.randomUUID();
    propuestas.push({
      PK: pk,
      SK: SK.propuesta(id),
      id_propuesta: id,
      tipo: 'acuerdo',
      titulo: a.texto,
      descripcion: a.texto,
      cita: a.cita,
      responsable_sugerido_id: idUsuarioPorNombre(asistentes, a.responsable_sugerido),
      fecha_limite_sugerida: fechaSugeridaOVacia(a.fecha_sugerida),
      ...(a.confianza != null ? { confianza: a.confianza } : {}),
      propuesta_estado: 'pendiente',
      creado_en: ahora,
    });
  }

  for (const t of acta.tareas) {
    const id = crypto.randomUUID();
    propuestas.push({
      PK: pk,
      SK: SK.propuesta(id),
      id_propuesta: id,
      tipo: 'tarea',
      titulo: t.titulo,
      descripcion: t.descripcion,
      cita: t.cita,
      responsable_sugerido_id: idUsuarioPorNombre(asistentes, t.responsable_sugerido),
      fecha_limite_sugerida: fechaSugeridaOVacia(t.fecha_sugerida),
      ...(t.confianza != null ? { confianza: t.confianza } : {}),
      propuesta_estado: 'pendiente',
      creado_en: ahora,
    });
  }

  const puntos = [];
  let orden = 1;
  for (const c of acta.cobertura) {
    const aplazado = c.estado === 'no_tratado';
    puntos.push({
      PK: pk,
      SK: SK.punto(orden),
      texto_punto: c.punto,
      origen: 'previsto',
      cobertura: c.estado,
      cita: c.cita || '',
      aplazado,
      candidato_siguiente: aplazado,
      creado_en: ahora,
    });
    orden += 1;
  }
  for (const e of acta.emergentes) {
    puntos.push({
      PK: pk,
      SK: SK.punto(orden),
      texto_punto: e.tema,
      origen: 'emergente',
      cobertura: 'tratado',
      cita: e.cita || '',
      aplazado: false,
      candidato_siguiente: false,
      creado_en: ahora,
    });
    orden += 1;
  }

  for (const item of [...propuestas, ...puntos]) {
    await docClient.send(new PutCommand({ TableName: tables.reuniones, Item: item }));
  }

  const costePrevio =
    reunion.coste_ia && typeof reunion.coste_ia === 'object' ? { ...reunion.coste_ia } : {};
  const coste_ia = {
    ...costePrevio,
    tokens_entrada: Number(usage?.prompt) || 0,
    tokens_salida: Number(usage?.completion) || 0,
    modelo_resumen: texto(modelo) || undefined,
  };

  const estadoActual = texto(reunion.estado);
  const sets = [
    'resumen = :res',
    'resumen_hash = :rhash',
    'coste_ia = :coste',
    'actualizado_en = :act',
  ];
  const valores = {
    ':res': acta.resumen || '(Sin resumen)',
    ':rhash': hash,
    ':coste': coste_ia,
    ':act': ahora,
  };

  // No degradar acta_validada; subir a acta_borrador si aún no está.
  if (estadoActual !== 'acta_borrador' && estadoActual !== 'acta_validada') {
    if (enLista(ESTADOS_REUNION, 'acta_borrador')) {
      sets.push('estado = :est');
      valores[':est'] = 'acta_borrador';
    }
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: pk, SK: SK.meta },
      UpdateExpression:
        `SET ${sets.join(', ')} REMOVE pipeline_estado, pipeline_desde, pipeline_error, pipeline_error_fase`,
      ExpressionAttributeValues: valores,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );

  return {
    propuestas: propuestas.length,
    puntos: puntos.length,
  };
}

/**
 * Solo cierra el pipeline cuando el resumen ya existía para este hash (idempotencia).
 */
async function cerrarPipelineIdempotente(idReunion, reunion) {
  const ahora = instanteIso();
  const estadoActual = texto(reunion.estado);
  const sets = ['actualizado_en = :act'];
  const valores = { ':act': ahora };

  if (!texto(reunion.resumen_hash) && texto(reunion.transcripcion_hash)) {
    sets.push('resumen_hash = :rhash');
    valores[':rhash'] = texto(reunion.transcripcion_hash);
  }
  if (estadoActual !== 'acta_borrador' && estadoActual !== 'acta_validada') {
    sets.push('estado = :est');
    valores[':est'] = 'acta_borrador';
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(idReunion), SK: SK.meta },
      UpdateExpression: `SET ${sets.join(', ')} REMOVE pipeline_estado, pipeline_desde, pipeline_error, pipeline_error_fase`,
      ExpressionAttributeValues: valores,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

/**
 * Paso de resumen para una reunión en `transcrita` o `resumiendo`.
 *
 * @param {object} reunion
 * @param {{ ajustes: object, marcarEstado: Function, registrarFallo: Function }} deps
 * @returns {Promise<'procesada' | 'omitida' | 'error'>}
 */
export async function procesarResumenReunion(reunion, { ajustes, marcarEstado, registrarFallo }) {
  const id = texto(reunion.id_reunion);
  if (!id) return 'omitida';

  const intentos = Number(reunion.intentos) || 0;
  const hash = texto(reunion.transcripcion_hash);

  // Idempotencia: ya hay acta para este hash → no volver a pagar.
  if (resumenYaGeneradoParaHash(reunion)) {
    await cerrarPipelineIdempotente(id, reunion);
    logger.info(
      { id_reunion: id, transcripcion_hash: hash },
      `[${ETIQUETA}] Resumen ya generado para este hash; se cierra pipeline sin llamar al modelo`,
    );
    return 'procesada';
  }

  if (!resumenIaDisponible()) {
    logger.debug(
      { id_reunion: id },
      `[${ETIQUETA}] Sin OPENAI_API_KEY ni mock; se omite el resumen`,
    );
    return 'omitida';
  }

  // Pasar a resumiendo (idempotente si ya lo está).
  if (texto(reunion.pipeline_estado) !== 'resumiendo') {
    await marcarEstado(id, {
      estado: 'resumiendo',
      remove: ['pipeline_error', 'pipeline_error_fase'],
    });
  }

  try {
    const transcripcion = await cargarTextoTranscripcion(reunion);
    const asistentes = await leerAsistentes(id);
    const nombresAsistentes = asistentes
      .map((a) => texto(a.nombre))
      .filter(Boolean);

    const plantilla = await resolverPlantillaActa();
    const system = componerSystemPrompt(plantilla.instrucciones);
    const user = JSON.stringify({
      orden_del_dia_congelado: texto(reunion.orden_del_dia_congelado) || texto(reunion.orden_del_dia),
      asistentes: nombresAsistentes,
      transcripcion,
    });

    const modelo = modeloResumenActa(ajustes);
    const salida = await chatCompletionFn()({
      system,
      user,
      model: modelo,
      temperature: 0.2,
      timeoutMs: TIMEOUT_RESUMEN_MS,
      responseFormat: { type: 'json_object' },
    });

    const parsed = parsearActaJson(salida.text);
    if (!parsed) {
      throw new Error('JSON de acta inválido o no parseable');
    }
    const acta = normalizarActaParseada(parsed);
    if (!acta.resumen && acta.acuerdos.length === 0 && acta.tareas.length === 0) {
      // Parseó pero vacío de contenido útil: tratar como fallo de calidad.
      throw new Error('El modelo no devolvió resumen ni propuestas con cita');
    }

    // Releer META por si el estado de negocio cambió; usar el ítem en memoria + hash.
    await persistirActaOk(id, reunion, {
      acta,
      usage: salida.usage,
      modelo: salida.model || modelo,
      hash: hash || texto(reunion.transcripcion_hash),
    });

    logger.info(
      {
        id_reunion: id,
        acuerdos: acta.acuerdos.length,
        tareas: acta.tareas.length,
        puntos: acta.cobertura.length + acta.emergentes.length,
      },
      `[${ETIQUETA}] Acta generada; pipeline cerrado`,
    );
    return 'procesada';
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error({ err, id_reunion: id }, `[${ETIQUETA}] Fallo en resumen`);
    await registrarFallo(id, {
      intentos,
      maxIntentos: ajustes.max_intentos,
      mensaje: msg,
      fase: 'resumen',
    });
    return 'error';
  }
}
