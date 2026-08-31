/**
 * Importar transcripción en texto (salta STT).
 *
 * Escribe `transcripcion.json` en S3 y deja `pipeline_estado = transcrita`
 * para que el tick genere el resumen. No exige aviso de grabación ni llama
 * al modelo en el mismo request.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { PK, SK } from '../tipos.js';
import { ACCIONES, registrarActividad } from '../actividad.js';
import { cargarParaGestionar } from '../reuniones.js';
import { pipelineYaIniciado } from './audio.js';
import { hashTexto } from './hashTexto.js';
import { claveTranscripcionReunion } from './transcripcionAws.js';

const ENTIDAD = 'reunion';
const MAX_CHARS = 500_000;
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });

/**
 * Condición del Update coherente con `pipelineYaIniciado`: falla si otra
 * petición ya dejó transcripción, job STT, audio presente o pipeline en vuelo.
 */
const CONDICION_IMPORT_LIBRE = [
  'attribute_exists(PK)',
  'attribute_not_exists(transcripcion_s3_key)',
  'attribute_not_exists(transcripcion_job_id)',
  '(attribute_not_exists(audio_estado) OR audio_estado <> :audioPresente)',
  '(attribute_not_exists(pipeline_estado) OR (pipeline_estado <> :pe1 AND pipeline_estado <> :pe2 AND pipeline_estado <> :pe3 AND pipeline_estado <> :pe4))',
].join(' AND ');

/**
 * Salidas a S3 (inyectable en tests).
 */
export const almacenTranscripcion = {
  putJson: async ({ key, body }) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/json; charset=utf-8',
      }),
    );
  },
};

/** Sustituye parte del almacén y devuelve la función que lo restaura. */
export function configurarAlmacenTranscripcion(parcial = {}) {
  const previo = { ...almacenTranscripcion };
  Object.assign(almacenTranscripcion, parcial);
  return () => Object.assign(almacenTranscripcion, previo);
}

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function rechazar(status, error) {
  return { ok: false, status, error };
}

function autorDe(ctx) {
  return { id_usuario: ctx?.idUsuario, Nombre: ctx?.nombre };
}

function snapshotPipeline(reunion, id) {
  return {
    id_reunion: id,
    origen_audio: reunion.origen_audio || null,
    audio_estado: reunion.audio_estado || null,
    audio_s3_key: reunion.audio_s3_key || null,
    pipeline_estado: reunion.pipeline_estado || null,
    pipeline_desde: reunion.pipeline_desde || null,
    transcripcion_s3_key: reunion.transcripcion_s3_key || null,
    transcripcion_hash: reunion.transcripcion_hash || null,
    transcripcion_job_id: reunion.transcripcion_job_id || null,
  };
}

function esErrorCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

async function leerMeta(id) {
  const res = await docClient.send(
    new GetCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(id), SK: SK.meta },
    }),
  );
  return res.Item || null;
}

/**
 * Importa texto como transcripción y deja la reunión en `transcrita`.
 *
 * @param {{ ctx: object, idReunion: string, texto?: string }} opts
 * @returns {Promise<{ ok: true, ya_iniciado: boolean, reunion: object } | { ok: false, status: number, error: string }>}
 */
export async function importarTranscripcionReunion({ ctx, idReunion, texto: textoBruto } = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const id = texto(idReunion);
  const reunion = cargado.reunion;

  const plano = texto(textoBruto);
  if (!plano) {
    return rechazar(400, 'El texto de la transcripción no puede estar vacío');
  }
  if (plano.length > MAX_CHARS) {
    return rechazar(
      400,
      `La transcripción supera el máximo de ${MAX_CHARS} caracteres`,
    );
  }

  if (pipelineYaIniciado(reunion)) {
    return {
      ok: true,
      ya_iniciado: true,
      reunion: snapshotPipeline(reunion, id),
    };
  }

  const instante = new Date().toISOString();
  const s3Key = claveTranscripcionReunion(id);
  const hash = hashTexto(plano);
  const cuerpo = JSON.stringify({
    texto: plano,
    origen: 'importada',
    generado_en: instante,
  });

  await almacenTranscripcion.putJson({ key: s3Key, body: cuerpo });

  const sets = [
    'origen_audio = :origen',
    'transcripcion_s3_key = :tkey',
    'transcripcion_hash = :thash',
    'pipeline_estado = :pestado',
    'pipeline_desde = :pdesde',
    'actualizado_en = :act',
  ];
  const values = {
    ':origen': 'transcripcion_importada',
    ':tkey': s3Key,
    ':thash': hash,
    ':pestado': 'transcrita',
    ':pdesde': instante,
    ':act': instante,
    // Condición coherente con pipelineYaIniciado
    ':audioPresente': 'presente',
    ':pe1': 'audio_pendiente',
    ':pe2': 'transcribiendo',
    ':pe3': 'transcrita',
    ':pe4': 'resumiendo',
  };
  const names = {};

  // Como en presign: congelar orden del día al iniciar captura/pipeline.
  if (!texto(reunion.orden_del_dia_congelado)) {
    sets.push('#odc = :odc', 'orden_del_dia_congelado_en = :odce');
    names['#odc'] = 'orden_del_dia_congelado';
    values[':odc'] = texto(reunion.orden_del_dia) || '';
    values[':odce'] = instante;
  }

  // Sin audio presente: quitar clave huérfana de un presign previo.
  const removes = ['pipeline_error', 'pipeline_error_fase'];
  if (texto(reunion.audio_estado) !== 'presente') {
    removes.push('audio_s3_key');
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.reuniones,
        Key: { PK: PK.reunion(id), SK: SK.meta },
        UpdateExpression: `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`,
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ConditionExpression: CONDICION_IMPORT_LIBRE,
      }),
    );
  } catch (err) {
    if (!esErrorCondicion(err)) throw err;
    // Carrera: otra petición ya inició el pipeline. Idempotente.
    const actual = (await leerMeta(id)) || {};
    return {
      ok: true,
      ya_iniciado: true,
      reunion: snapshotPipeline(actual, id),
    };
  }

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: id,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: {
      pipeline_estado: 'transcrita',
      origen_audio: 'transcripcion_importada',
      transcripcion_s3_key: s3Key,
    },
  });

  return {
    ok: true,
    ya_iniciado: false,
    reunion: {
      id_reunion: id,
      origen_audio: 'transcripcion_importada',
      audio_estado: reunion.audio_estado || null,
      audio_s3_key: null,
      pipeline_estado: 'transcrita',
      pipeline_desde: instante,
      transcripcion_s3_key: s3Key,
      transcripcion_hash: hash,
      transcripcion_job_id: null,
    },
  };
}
