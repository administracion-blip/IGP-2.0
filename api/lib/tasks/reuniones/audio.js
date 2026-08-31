/**
 * Captura de audio por subida (Fase 2A).
 *
 * El fichero **no pasa por la API**: URL prefirmada de `PUT` (mismo criterio que
 * `api/lib/tasks/adjuntos.js`). Sin firmar `ServerSideEncryption` en la URL del
 * navegador: el cifrado en reposo lo aplica el bucket por defecto.
 *
 * Precondición: aviso de grabación aceptado (`aviso_grabacion`). Al firmar se
 * congela el orden del día si aún no había copia (D-20 / Fase 2).
 *
 * Clave: `tasks/reuniones/<id_reunion>/audio.<ext>`.
 */

import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { PK, SK } from '../tipos.js';
import { cargarParaGestionar } from '../reuniones.js';

const PREFIJO_S3 = process.env.TASKS_S3_PREFIX || 'tasks';
const SEGUNDOS_SUBIDA = 300;

const MAX_AUDIO_MB = Math.max(1, Number(process.env.REUNIONES_MAX_AUDIO_MB) || 500);
export const MAX_BYTES_AUDIO = MAX_AUDIO_MB * 1024 * 1024;

/**
 * Tipos admitidos y extensiones. Se validan las dos: el MIME declarado y la
 * extensión del nombre (o la implícita del tipo).
 */
export const TIPOS_AUDIO = Object.freeze({
  'audio/mpeg': ['.mp3'],
  'audio/mp3': ['.mp3'],
  'audio/mp4': ['.m4a', '.mp4'],
  'audio/x-m4a': ['.m4a'],
  'audio/m4a': ['.m4a'],
  'audio/wav': ['.wav'],
  'audio/wave': ['.wav'],
  'audio/x-wav': ['.wav'],
  'audio/ogg': ['.ogg', '.opus'],
  'audio/opus': ['.opus'],
  'audio/webm': ['.webm'],
  'audio/flac': ['.flac'],
  'video/webm': ['.webm'],
});

// ─── Almacén inyectable ───

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';

/**
 * Salidas a S3 en un solo sitio (tests). La URL de subida **no** firma SSE.
 */
export const almacenAudio = {
  urlSubida: ({ key, contentType }) =>
    getSignedUrl(s3, new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType }), {
      expiresIn: SEGUNDOS_SUBIDA,
    }),
  /** Metadatos del objeto, o `null` si no está. */
  cabecera: async ({ key }) => {
    try {
      const r = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      return {
        tamano: Number(r.ContentLength) || 0,
        contentType: r.ContentType || '',
      };
    } catch (err) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  },
};

/** Sustituye parte del almacén y devuelve la función que lo restaura. */
export function configurarAlmacenAudio(parcial = {}) {
  const previo = { ...almacenAudio };
  Object.assign(almacenAudio, parcial);
  return () => Object.assign(almacenAudio, previo);
}

// ─── Utilidades ───

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function rechazar(status, error) {
  return { ok: false, status, error };
}

export function prefijoAudioReunion(idReunion) {
  return `${PREFIJO_S3}/reuniones/${texto(idReunion)}/`;
}

/** Clave canónica del audio: `tasks/reuniones/<id>/audio.<ext>`. */
export function claveAudioReunion(idReunion, extension) {
  const ext = texto(extension).toLowerCase();
  const conPunto = ext.startsWith('.') ? ext : `.${ext}`;
  return `${prefijoAudioReunion(idReunion)}audio${conPunto}`;
}

/**
 * Aviso aceptado: hace falta `aceptado_por` y `aceptado_en` (lo escribe
 * `registrarAvisoGrabacion` al aceptar).
 */
export function avisoGrabacionAceptado(reunion) {
  const aviso = reunion?.aviso_grabacion;
  if (!aviso || typeof aviso !== 'object') return false;
  return !!(texto(aviso.aceptado_por) && texto(aviso.aceptado_en));
}

/**
 * @returns {{ ok: true, contentType: string, extension: string } | { ok: false, error: string }}
 */
export function validarAudio({ nombre, contentType, tamano } = {}) {
  const tipo = texto(contentType).toLowerCase();
  const extensiones = TIPOS_AUDIO[tipo];
  if (!extensiones) {
    return { ok: false, error: `Tipo de audio no permitido: «${tipo || 'sin tipo'}»` };
  }

  const nombreBruto = texto(nombre);
  let extension = '';
  if (nombreBruto) {
    extension = path.extname(nombreBruto).toLowerCase();
    if (extension && !extensiones.includes(extension)) {
      return {
        ok: false,
        error: `La extensión «${extension}» no corresponde al tipo ${tipo}`,
      };
    }
  }
  if (!extension) extension = extensiones[0];

  const bytes = Number(tamano);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, error: 'Indica el tamaño del fichero de audio' };
  }
  if (bytes > MAX_BYTES_AUDIO) {
    return {
      ok: false,
      error: `El audio supera el máximo de ${MAX_AUDIO_MB} MB`,
    };
  }

  return { ok: true, contentType: tipo, extension };
}

/** Estados en los que el poller (o 2A) ya tiene trabajo en curso. */
const PIPELINE_EN_VUELO = Object.freeze([
  'audio_pendiente',
  'transcribiendo',
  'transcrita',
  'resumiendo',
]);

/**
 * ¿Ya hay captura/pipeline en marcha? Sirve para no re-presignar ni duplicar
 * el arranque de `procesar`.
 */
export function pipelineYaIniciado(reunion) {
  if (texto(reunion?.transcripcion_job_id)) return true;
  if (texto(reunion?.transcripcion_s3_key)) return true;
  if (texto(reunion?.audio_estado) === 'presente') return true;
  const estado = texto(reunion?.pipeline_estado);
  return PIPELINE_EN_VUELO.includes(estado);
}

/**
 * HeadObject del audio de la reunión (o `null` si no está).
 */
export async function cabeceraAudio({ key } = {}) {
  const k = texto(key);
  if (!k) return null;
  return almacenAudio.cabecera({ key: k });
}

/**
 * URL prefirmada de `PUT` para subir el audio.
 *
 * Exige aviso aceptado. Guarda la clave prevista en META (sin marcar el audio
 * como presente) y congela el orden del día si faltaba.
 * Si el pipeline ya arrancó o el audio está presente, responde 409 y no toca
 * `audio_s3_key`.
 *
 * @returns {Promise<{ ok: true, audio: object, reunion?: object } | { ok: false, status: number, error: string }>}
 */
export async function presignarAudioReunion({ ctx, idReunion, nombre, contentType, tamano } = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  if (!avisoGrabacionAceptado(cargado.reunion)) {
    return rechazar(
      409,
      'No se puede subir audio: falta el aviso de grabación aceptado',
    );
  }

  if (pipelineYaIniciado(cargado.reunion)) {
    return rechazar(
      409,
      'No se puede volver a subir audio: el procesado de esta reunión ya está en marcha',
    );
  }

  const validado = validarAudio({ nombre, contentType, tamano });
  if (!validado.ok) return rechazar(400, validado.error);

  const id = texto(idReunion);
  const key = claveAudioReunion(id, validado.extension);
  const url = await almacenAudio.urlSubida({ key, contentType: validado.contentType });
  const instante = new Date().toISOString();

  const sets = ['audio_s3_key = :key', 'actualizado_en = :act'];
  const values = { ':key': key, ':act': instante };
  const names = {};

  // D-20 / Fase 2: al iniciar la captura, congelar si aún no había copia.
  if (!texto(cargado.reunion.orden_del_dia_congelado)) {
    sets.push('#odc = :odc', 'orden_del_dia_congelado_en = :odce');
    names['#odc'] = 'orden_del_dia_congelado';
    values[':odc'] = texto(cargado.reunion.orden_del_dia) || '';
    values[':odce'] = instante;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(id), SK: SK.meta },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );

  return {
    ok: true,
    audio: {
      s3_key: key,
      content_type: validado.contentType,
      upload_url: url,
      expira_en_seg: SEGUNDOS_SUBIDA,
    },
  };
}
