/**
 * Arranque del pipeline de audio (Fase 2A).
 *
 * `procesar` confirma que el objeto está en S3 y marca la reunión para el
 * poller (`pipeline_estado = audio_pendiente`). **No llama a ningún proveedor
 * de transcripción**: el STT y el tick del poller son entregas 2B/2D.
 *
 * Idempotente: si ya hay `transcripcion_job_id` o el pipeline está en vuelo
 * coherente, no vuelve a arrancar.
 */

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { PK, SK } from '../tipos.js';
import { ACCIONES, registrarActividad } from '../actividad.js';
import { cargarParaGestionar } from '../reuniones.js';
import {
  cabeceraAudio,
  prefijoAudioReunion,
  pipelineYaIniciado,
  MAX_BYTES_AUDIO,
} from './audio.js';

export { pipelineYaIniciado };

const ENTIDAD = 'reunion';

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function rechazar(status, error) {
  return { ok: false, status, error };
}

function autorDe(ctx) {
  return { id_usuario: ctx?.idUsuario, Nombre: ctx?.nombre };
}

/** La clave debe ser `…/reuniones/<id>/audio.<ext>` de esta reunión. */
function claveAudioDeReunion(idReunion, key) {
  const k = texto(key);
  const prefijo = prefijoAudioReunion(idReunion);
  if (!k.startsWith(prefijo)) return false;
  const resto = k.slice(prefijo.length);
  return /^audio\.[a-z0-9]+$/i.test(resto);
}

/**
 * Confirma el audio en S3 y deja la reunión en `audio_pendiente` para el poller.
 *
 * Stub 2A: no lanza job de STT externo. Solo escribe META.
 * El poller (2B, `pipelineTick.js`) retoma desde `audio_pendiente`.
 *
 * Cuerpo opcional: `{ s3_key?, duracion_seg? }`. Sin `s3_key` usa el guardado
 * en META al hacer presign.
 *
 * @returns {Promise<{ ok: true, reunion: object, ya_iniciado: boolean } | { ok: false, status: number, error: string }>}
 */
export async function procesarAudioReunion({ ctx, idReunion, s3Key, duracionSeg } = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const id = texto(idReunion);
  const reunion = cargado.reunion;

  if (pipelineYaIniciado(reunion)) {
    return {
      ok: true,
      ya_iniciado: true,
      reunion: {
        id_reunion: id,
        origen_audio: reunion.origen_audio || null,
        audio_estado: reunion.audio_estado || null,
        audio_s3_key: reunion.audio_s3_key || null,
        audio_tamano: reunion.audio_tamano ?? null,
        duracion_seg: reunion.duracion_seg ?? null,
        pipeline_estado: reunion.pipeline_estado || null,
        pipeline_desde: reunion.pipeline_desde || null,
        transcripcion_job_id: reunion.transcripcion_job_id || null,
      },
    };
  }

  const key = texto(s3Key) || texto(reunion.audio_s3_key);
  if (!key) {
    return rechazar(409, 'No hay audio pendiente de procesar: pide primero la URL de subida');
  }
  if (!claveAudioDeReunion(id, key)) {
    return rechazar(400, 'La ruta del audio no corresponde a esta reunión');
  }

  const cabecera = await cabeceraAudio({ key });
  if (!cabecera) {
    return rechazar(409, 'El audio no está en el almacén todavía');
  }
  if (!Number.isFinite(cabecera.tamano) || cabecera.tamano <= 0) {
    return rechazar(409, 'El audio subido está vacío o incompleto');
  }
  if (cabecera.tamano > MAX_BYTES_AUDIO) {
    return rechazar(400, 'El audio subido supera el tamaño máximo permitido');
  }

  const instante = new Date().toISOString();
  const duracion = duracionSeg != null ? Number(duracionSeg) : Number(reunion.duracion_seg);
  const tieneDuracion = Number.isFinite(duracion) && duracion > 0;

  const sets = [
    'origen_audio = :origen',
    'audio_estado = :aestado',
    'audio_s3_key = :key',
    'audio_tamano = :tam',
    'pipeline_estado = :pestado',
    'pipeline_desde = :pdesde',
    'actualizado_en = :act',
  ];
  const values = {
    ':origen': 'subida',
    ':aestado': 'presente',
    ':key': key,
    ':tam': cabecera.tamano,
    ':pestado': 'audio_pendiente',
    ':pdesde': instante,
    ':act': instante,
  };

  if (tieneDuracion) {
    sets.push('duracion_seg = :dur');
    values[':dur'] = Math.round(duracion);
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(id), SK: SK.meta },
      UpdateExpression: `SET ${sets.join(', ')} REMOVE pipeline_error, pipeline_error_fase`,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: id,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: {
      // Stub 2A: marcado para el poller; sin llamada a STT (entregas 2B/2D).
      pipeline_estado: 'audio_pendiente',
      origen_audio: 'subida',
      audio_s3_key: key,
      audio_tamano: cabecera.tamano,
    },
  });

  return {
    ok: true,
    ya_iniciado: false,
    reunion: {
      id_reunion: id,
      origen_audio: 'subida',
      audio_estado: 'presente',
      audio_s3_key: key,
      audio_tamano: cabecera.tamano,
      duracion_seg: tieneDuracion ? Math.round(duracion) : reunion.duracion_seg ?? null,
      pipeline_estado: 'audio_pendiente',
      pipeline_desde: instante,
      transcripcion_job_id: null,
    },
  };
}
