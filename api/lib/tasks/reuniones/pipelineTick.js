/**
 * Poller del pipeline de reuniones (Fase 2B–2E).
 *
 * `POST /api/reuniones/pipeline/tick` consulta `Pipeline-index` (nunca Scan) y
 * avanza cada reunión según su `pipeline_estado`. Con `TRANSCRIPCION_PROVEEDOR=aws`
 * (u alias) usa Amazon Transcribe (2D / D-33). Sin proveedor las de
 * `audio_pendiente` se omiten. En `transcrita` / `resumiendo` genera el acta
 * con `chatCompletion` (2E) y deja la reunión en `acta_borrador`.
 *
 * Cerrojo global: `Igp_Ajustes` PK `reuniones` / SK `cerrojo_pipeline`.
 * Config: PK `reuniones` / SK `pipeline` (`Enabled`, `max_intentos`, …).
 */

import crypto from 'node:crypto';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { logger } from '../../logger.js';
import { crearCerrojo } from '../../facturacion/facturacionPeriodica.js';
import { PK, SK } from '../tipos.js';
import { hashTexto } from './hashTexto.js';
import { crearProveedorSttAws } from './transcripcionAws.js';
import { procesarResumenReunion } from './resumenActa.js';

export const PIPELINE_AJUSTE_PK = 'reuniones';
export const PIPELINE_AJUSTE_SK = 'pipeline';
export const PIPELINE_CERROJO_SK = 'cerrojo_pipeline';

export const IDX_PIPELINE = 'Pipeline-index';

/** Estados que el tick consulta. `error` no se reintenta automáticamente (2B). */
export const ESTADOS_EN_VUELO = Object.freeze([
  'audio_pendiente',
  'transcribiendo',
  'transcrita',
  'resumiendo',
]);

const ETIQUETA = 'reuniones-pipeline';
const MAX_INTENTOS_DEFECTO = 3;

const cerrojo = crearCerrojo({
  pk: PIPELINE_AJUSTE_PK,
  sk: PIPELINE_CERROJO_SK,
  etiqueta: ETIQUETA,
  mensajeOcupado: (desde) => `Ya hay una pasada del pipeline de reuniones en curso${desde}.`,
});

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function instanteIso() {
  return new Date().toISOString();
}

// ─── Proveedor STT (stub 2B; real en 2D) ───

/**
 * Adaptador inyectable. Por defecto `null` → se resuelve desde env/ajustes.
 * Solo los tests deben inyectar un adaptador que invente texto.
 * @type {null | {
 *   id: string,
 *   iniciar: (ctx: object) => Promise<{ jobId: string }>,
 *   consultar: (ctx: object) => Promise<
 *     | { estado: 'en_curso' }
 *     | { estado: 'completada', texto: string, s3Key: string }
 *     | { estado: 'error', mensaje: string }
 *   >,
 * }}
 */
let proveedorSttInyectado = null;

/** Sustituye el proveedor STT (tests). Devuelve función que restaura. */
export function configurarProveedorStt(adaptador) {
  const prev = proveedorSttInyectado;
  proveedorSttInyectado = adaptador;
  return () => {
    proveedorSttInyectado = prev;
  };
}

/**
 * Adaptador de prueba: marca `transcribiendo` → `transcrita` con texto fake.
 * Solo activo cuando el test lo inyecta (o env `REUNIONES_STT_STUB=1` vía factory).
 */
export function crearProveedorSttStubTest({ textoTranscripcion } = {}) {
  const textoFake =
    texto(textoTranscripcion) ||
    'Transcripción de prueba (stub). Hablante 1: Buenas. Hablante 2: De acuerdo.';
  return {
    id: 'stub_test',
    async iniciar({ idReunion }) {
      return { jobId: `stub-test-${texto(idReunion) || crypto.randomUUID()}` };
    },
    async consultar({ idReunion }) {
      const id = texto(idReunion) || 'stub';
      return {
        estado: 'completada',
        texto: textoFake,
        s3Key: `tasks/reuniones/${id}/transcripcion.json`,
      };
    },
  };
}

/**
 * Extrae términos útiles del orden del día congelado (v1):
 * palabras capitalizadas o de más de 3 letras, sin duplicados.
 * @param {string} orden
 * @returns {string[]}
 */
export function extraerVocabularioOrdenDia(orden) {
  const raw = texto(orden);
  if (!raw) return [];
  const vistos = new Set();
  const out = [];
  for (const token of raw.split(/[^\p{L}\p{N}]+/u)) {
    const t = texto(token);
    if (t.length < 2) continue;
    const capitalizada = /^[\p{Lu}]/u.test(t);
    if (!capitalizada && t.length <= 3) continue;
    const clave = t.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * ¿Hay un proveedor STT real (o stub de test) listo para avanzar?
 * Vacío / `stub` → no. `aws` / `transcribe` / … → Amazon Transcribe (D-33).
 */
export function resolverProveedorStt(ajustes = {}) {
  if (proveedorSttInyectado) return proveedorSttInyectado;

  const desdeAjustes = texto(ajustes.proveedor_transcripcion || ajustes.proveedor);
  const desdeEnv = texto(process.env.TRANSCRIPCION_PROVEEDOR);
  const nombre = (desdeAjustes || desdeEnv).toLowerCase();

  if (process.env.REUNIONES_STT_STUB === '1' || nombre === 'stub_test') {
    return crearProveedorSttStubTest();
  }

  // Sin proveedor, o marca explícita de stub/placeholder: no avanzar.
  if (!nombre || nombre === 'stub' || nombre === 'none' || nombre === 'ninguno') {
    return null;
  }

  if (
    nombre === 'aws' ||
    nombre === 'transcribe' ||
    nombre === 'amazon' ||
    nombre === 'aws_transcribe'
  ) {
    return crearProveedorSttAws();
  }

  logger.warn(
    { proveedor: nombre },
    `[${ETIQUETA}] Proveedor STT desconocido; no se avanza audio_pendiente`,
  );
  return null;
}

// ─── Configuración ───

/**
 * @returns {Promise<{
 *   enabled: boolean,
 *   max_intentos: number,
 *   proveedor_transcripcion: string,
 *   modelo_resumen: string,
 * }>}
 */
export async function leerAjustesPipeline() {
  const defecto = {
    enabled: false,
    max_intentos: MAX_INTENTOS_DEFECTO,
    proveedor_transcripcion: '',
    modelo_resumen: '',
  };
  let item = null;
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.ajustes,
        Key: { PK: PIPELINE_AJUSTE_PK, SK: PIPELINE_AJUSTE_SK },
      }),
    );
    item = r.Item || null;
  } catch (err) {
    logger.warn({ err }, `[${ETIQUETA}] No se pudieron leer los ajustes del pipeline`);
    return {
      ...defecto,
      enabled: process.env.REUNIONES_PIPELINE_ENABLED === 'true',
    };
  }

  const maxRaw = Number(item?.max_intentos);
  const max_intentos =
    Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : MAX_INTENTOS_DEFECTO;

  // Activa con Enabled en Ajustes o con env local (sin ítem / desarrollo).
  const enabled =
    item?.Enabled === true || process.env.REUNIONES_PIPELINE_ENABLED === 'true';

  return {
    enabled,
    max_intentos,
    proveedor_transcripcion: texto(
      item?.proveedor_transcripcion || item?.proveedor || process.env.TRANSCRIPCION_PROVEEDOR,
    ),
    modelo_resumen: texto(item?.modelo_resumen),
  };
}

// ─── Query Pipeline-index ───

async function listarPorEstado(estado) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        IndexName: IDX_PIPELINE,
        KeyConditionExpression: 'pipeline_estado = :e',
        ExpressionAttributeValues: { ':e': estado },
        ExclusiveStartKey,
      }),
    );
    for (const it of r.Items || []) items.push(it);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function marcarEstado(idReunion, { estado, sets = {}, remove = [] }) {
  const ahora = instanteIso();
  const valores = { ':pestado': estado, ':pdesde': ahora, ':act': ahora };
  const partesSet = ['pipeline_estado = :pestado', 'pipeline_desde = :pdesde', 'actualizado_en = :act'];

  for (const [campo, valor] of Object.entries(sets)) {
    const ph = `:${campo.replace(/[^a-zA-Z0-9]/g, '_')}`;
    partesSet.push(`${campo} = ${ph}`);
    valores[ph] = valor;
  }

  let UpdateExpression = `SET ${partesSet.join(', ')}`;
  if (remove.length) {
    UpdateExpression += ` REMOVE ${remove.join(', ')}`;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(idReunion), SK: SK.meta },
      UpdateExpression,
      ExpressionAttributeValues: valores,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

async function marcarError(idReunion, { fase, mensaje, intentos }) {
  const ahora = instanteIso();
  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(idReunion), SK: SK.meta },
      UpdateExpression:
        'SET pipeline_estado = :e, pipeline_desde = :d, pipeline_error = :err, ' +
        'pipeline_error_fase = :fase, intentos = :int, actualizado_en = :act',
      ExpressionAttributeValues: {
        ':e': 'error',
        ':d': ahora,
        ':err': texto(mensaje).slice(0, 500) || 'Error en el pipeline',
        ':fase': fase,
        ':int': intentos,
        ':act': ahora,
      },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

/**
 * Persiste un fallo de pipeline: siempre incrementa `intentos`.
 * Si se agota el tope → `pipeline_estado = error` (sin más reintentos automáticos).
 * Conserva lo ya obtenido (p. ej. transcripción tras fallo de resumen).
 *
 * @param {string} idReunion
 * @param {{ intentos: number, maxIntentos: number, mensaje: string, fase?: string }} opts
 */
async function registrarFalloPipeline(idReunion, { intentos, maxIntentos, mensaje, fase = 'transcripcion' }) {
  const siguiente = intentos + 1;
  const faseNorm = texto(fase) || 'transcripcion';
  const msgDefecto =
    faseNorm === 'resumen' ? 'Error en el resumen' : 'Error en la transcripción';
  const msg = texto(mensaje).slice(0, 500) || msgDefecto;
  if (siguiente >= maxIntentos) {
    await marcarError(idReunion, { fase: faseNorm, mensaje: msg, intentos: siguiente });
    return;
  }
  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(idReunion), SK: SK.meta },
      UpdateExpression:
        'SET intentos = :int, pipeline_error = :err, pipeline_error_fase = :fase, actualizado_en = :act',
      ExpressionAttributeValues: {
        ':int': siguiente,
        ':err': msg,
        ':fase': faseNorm,
        ':act': instanteIso(),
      },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

/** Alias histórico (2B/2D); misma implementación. */
async function registrarFalloTranscripcion(idReunion, opts) {
  return registrarFalloPipeline(idReunion, { ...opts, fase: opts.fase || 'transcripcion' });
}

/**
 * Paso para una reunión en un estado concreto.
 * @returns {'procesada' | 'omitida' | 'error'}
 */
async function procesarReunion(reunion, { ajustes, proveedor }) {
  const id = texto(reunion.id_reunion);
  if (!id) return 'omitida';

  const estado = texto(reunion.pipeline_estado);
  const intentos = Number(reunion.intentos) || 0;

  if (estado === 'audio_pendiente') {
    if (!proveedor) {
      logger.debug(
        { id_reunion: id },
        `[${ETIQUETA}] audio_pendiente: esperando proveedor STT (A-02)`,
      );
      return 'omitida';
    }
    // Idempotencia: si ya hay job, no relanzar; pasar a transcribiendo si hace falta.
    if (texto(reunion.transcripcion_job_id)) {
      await marcarEstado(id, {
        estado: 'transcribiendo',
        sets: {
          transcripcion_proveedor: proveedor.id,
        },
      });
      return 'procesada';
    }
    try {
      const vocabulario = Array.isArray(reunion.vocabulario_esperado)
        ? reunion.vocabulario_esperado.map((t) => texto(t)).filter(Boolean)
        : extraerVocabularioOrdenDia(reunion.orden_del_dia_congelado);
      const { jobId } = await proveedor.iniciar({
        idReunion: id,
        audioS3Key: reunion.audio_s3_key,
        vocabulario,
      });
      if (!texto(jobId)) {
        throw new Error('El proveedor STT no devolvió jobId');
      }
      const sets = {
        transcripcion_job_id: texto(jobId),
        transcripcion_proveedor: proveedor.id,
        intentos: intentos + 1,
      };
      if (vocabulario.length) sets.vocabulario_esperado = vocabulario;
      await marcarEstado(id, {
        estado: 'transcribiendo',
        sets,
        remove: ['pipeline_error', 'pipeline_error_fase'],
      });
      return 'procesada';
    } catch (err) {
      const msg = err?.message || String(err);
      logger.error({ err, id_reunion: id }, `[${ETIQUETA}] Fallo al iniciar STT`);
      await registrarFalloTranscripcion(id, {
        intentos,
        maxIntentos: ajustes.max_intentos,
        mensaje: msg,
      });
      return 'error';
    }
  }

  if (estado === 'transcribiendo') {
    if (!proveedor) {
      logger.debug(
        { id_reunion: id },
        `[${ETIQUETA}] transcribiendo: sin proveedor STT; se espera`,
      );
      return 'omitida';
    }
    const jobId = texto(reunion.transcripcion_job_id);
    if (!jobId) {
      // Sin job: volver a audio_pendiente para que el siguiente tick lo arranque.
      await marcarEstado(id, { estado: 'audio_pendiente' });
      return 'procesada';
    }
    try {
      const r = await proveedor.consultar({
        idReunion: id,
        jobId,
        audioS3Key: reunion.audio_s3_key,
      });
      if (r.estado === 'en_curso') return 'omitida';
      if (r.estado === 'error') {
        const msg = texto(r.mensaje) || 'Transcripción fallida';
        await registrarFalloTranscripcion(id, {
          intentos,
          maxIntentos: ajustes.max_intentos,
          mensaje: msg,
        });
        return 'error';
      }
      // completada: exige s3Key real (el adaptador debe haber persistido en S3).
      const cuerpo = texto(r.texto);
      const s3Key = texto(r.s3Key);
      if (!s3Key) {
        await registrarFalloTranscripcion(id, {
          intentos,
          maxIntentos: ajustes.max_intentos,
          mensaje: 'Transcripción completada sin s3Key (no se inventa clave)',
        });
        return 'error';
      }
      if (!cuerpo) {
        await registrarFalloTranscripcion(id, {
          intentos,
          maxIntentos: ajustes.max_intentos,
          mensaje: 'Transcripción completada sin texto',
        });
        return 'error';
      }
      await marcarEstado(id, {
        estado: 'transcrita',
        sets: {
          transcripcion_s3_key: s3Key,
          transcripcion_hash: hashTexto(cuerpo),
        },
        remove: ['pipeline_error', 'pipeline_error_fase'],
      });
      return 'procesada';
    } catch (err) {
      const msg = err?.message || String(err);
      logger.error({ err, id_reunion: id }, `[${ETIQUETA}] Fallo al consultar STT`);
      await registrarFalloTranscripcion(id, {
        intentos,
        maxIntentos: ajustes.max_intentos,
        mensaje: msg,
      });
      return 'error';
    }
  }

  if (estado === 'transcrita' || estado === 'resumiendo') {
    return procesarResumenReunion(reunion, {
      ajustes,
      marcarEstado,
      registrarFallo: registrarFalloPipeline,
    });
  }

  return 'omitida';
}

/**
 * Una pasada del poller.
 *
 * @param {{ origen?: string }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   motivo?: string,
 *   procesadas: number,
 *   omitidas: number,
 *   errores?: Array<{ id_reunion: string, error: string }>,
 * }>}
 */
export async function ejecutarTickPipeline({ origen = 'programado' } = {}) {
  const vacio = { ok: true, procesadas: 0, omitidas: 0 };

  const ajustes = await leerAjustesPipeline();
  if (!ajustes.enabled) {
    return { ...vacio, motivo: 'desactivado' };
  }

  const ejecucion = crypto.randomUUID();
  const tomado = await cerrojo.adquirir(ejecucion, origen);
  if (!tomado.ok) {
    return { ...vacio, motivo: 'en_curso', ok: true };
  }

  const errores = [];
  let procesadas = 0;
  let omitidas = 0;
  /** Tras un fallo, no reconsultar la misma reunión en un estado posterior del mismo tick. */
  const omitirRestoTick = new Set();

  try {
    const proveedor = resolverProveedorStt(ajustes);

    for (const estado of ESTADOS_EN_VUELO) {
      let reuniones;
      try {
        reuniones = await listarPorEstado(estado);
      } catch (err) {
        logger.error({ err, estado }, `[${ETIQUETA}] Query Pipeline-index falló`);
        errores.push({ id_reunion: '*', error: `Query ${estado}: ${err?.message || err}` });
        continue;
      }

      for (const reunion of reuniones) {
        const idReu = texto(reunion.id_reunion) || '?';
        if (omitirRestoTick.has(idReu)) {
          omitidas += 1;
          continue;
        }
        try {
          const r = await procesarReunion(reunion, { ajustes, proveedor });
          if (r === 'procesada') procesadas += 1;
          else if (r === 'omitida') omitidas += 1;
          else {
            omitidas += 1;
            omitirRestoTick.add(idReu);
            errores.push({
              id_reunion: idReu,
              error: `paso ${estado}`,
            });
          }
        } catch (err) {
          omitidas += 1;
          omitirRestoTick.add(idReu);
          errores.push({
            id_reunion: idReu,
            error: err?.message || String(err),
          });
          logger.error(
            { err, id_reunion: reunion.id_reunion },
            `[${ETIQUETA}] Error procesando reunión`,
          );
        }
      }
    }

    const out = { ok: true, procesadas, omitidas };
    if (errores.length) out.errores = errores;
    return out;
  } finally {
    await cerrojo.liberar(ejecucion);
  }
}

/** Expone el cerrojo para tests (p. ej. simular pasada en curso). */
export function _cerrojoPipelineParaTests() {
  return cerrojo;
}
