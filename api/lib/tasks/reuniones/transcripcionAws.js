/**
 * Adaptador STT — Amazon Transcribe (Fase 2D).
 *
 * Proveedor provisional (D-33 / A-02): misma cuenta AWS del ERP. Sustituible
 * por otro adaptador con la misma interfaz (`iniciar` / `consultar`).
 *
 * Vocabulario custom de Transcribe requiere un Vocabulary gestionado en la
 * cuenta; en v1 no se crea al vuelo. Opcional: `TRANSCRIBE_VOCABULARY_NAME`
 * (nombre ya existente). La lista de términos del orden del día se recibe y se
 * registra en logs; el tick la guarda en `vocabulario_esperado` si se persiste.
 */

import crypto from 'node:crypto';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '../../logger.js';
import { prefijoAudioReunion } from './audio.js';

const ETIQUETA = 'reuniones-stt-aws';
const ID_PROVEEDOR = 'aws_transcribe';

const REGION = () => process.env.AWS_REGION || 'eu-west-3';
const BUCKET = () => process.env.S3_BUCKET || 'igp-2.0-files';
const IDIOMA = () => process.env.TRANSCRIPCION_IDIOMA || 'es-ES';

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

/**
 * JobName válido para Transcribe: `[0-9a-zA-Z._-]+`, máx. 200.
 * Prefijo `igp-reu-` + id sanitizado + sufijo aleatorio.
 */
export function nombreJobTranscribe(idReunion) {
  const id = texto(idReunion)
    .replace(/[^0-9a-zA-Z._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  const sufijo = crypto.randomBytes(4).toString('hex');
  const base = `igp-reu-${id || 'x'}-${sufijo}`;
  return base.slice(0, 200);
}

function numeroHablante(label) {
  const n = Number(String(label || '').replace(/\D/g, ''));
  return Number.isFinite(n) ? n + 1 : 1;
}

function transcriptPlano(results) {
  const planos = Array.isArray(results?.transcripts) ? results.transcripts : [];
  return planos
    .map((t) => texto(t?.transcript))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Aplana el JSON de Transcribe a texto con hablantes (`Hablante N: …`).
 * Si no hay speaker labels, usa el transcript plano.
 */
export function aplanarTranscripcionAws(payload) {
  const results = payload?.results;
  if (!results || typeof results !== 'object') return '';

  const items = Array.isArray(results.items) ? results.items : [];
  const labels = results.speaker_labels;
  const segmentos = Array.isArray(labels?.segments) ? labels.segments : [];

  // Mapa start_time → speaker_label desde segmentos (API clásica).
  const speakerPorInicio = new Map();
  for (const seg of segmentos) {
    const spk = texto(seg.speaker_label);
    for (const si of seg.items || []) {
      const st = texto(si.start_time);
      if (st && spk) speakerPorInicio.set(st, spk);
    }
  }

  const lineas = [];
  let hablanteActual = null;
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    lineas.push(`Hablante ${numeroHablante(hablanteActual)}: ${buffer.join(' ')}`);
    buffer = [];
  };

  let huboPronunciacion = false;
  for (const it of items) {
    const content = texto(it?.alternatives?.[0]?.content);
    if (!content) continue;

    if (it.type === 'punctuation') {
      if (buffer.length) buffer[buffer.length - 1] += content;
      continue;
    }
    if (it.type && it.type !== 'pronunciation') continue;
    huboPronunciacion = true;

    const spk =
      texto(it.speaker_label) ||
      speakerPorInicio.get(texto(it.start_time)) ||
      hablanteActual ||
      'spk_0';

    if (hablanteActual != null && spk !== hablanteActual) flush();
    hablanteActual = spk;
    buffer.push(content);
  }
  flush();

  if (huboPronunciacion && lineas.length) return lineas.join('\n').trim();
  return transcriptPlano(results);
}

export function claveTranscripcionReunion(idReunion) {
  return `${prefijoAudioReunion(idReunion)}transcripcion.json`;
}

/**
 * @param {{
 *   client?: import('@aws-sdk/client-transcribe').TranscribeClient,
 *   s3?: import('@aws-sdk/client-s3').S3Client,
 *   fetchFn?: typeof fetch,
 *   bucket?: string,
 * }} [deps]
 */
export function crearProveedorSttAws(deps = {}) {
  const client =
    deps.client ||
    new TranscribeClient({ region: REGION() });
  const s3 = deps.s3 || new S3Client({ region: REGION() });
  const fetchFn = deps.fetchFn || globalThis.fetch.bind(globalThis);
  const bucket = texto(deps.bucket) || BUCKET();

  return {
    id: ID_PROVEEDOR,

    /**
     * @param {{ idReunion: string, audioS3Key: string, vocabulario?: string[] }} ctx
     * @returns {Promise<{ jobId: string }>}
     */
    async iniciar({ idReunion, audioS3Key, vocabulario }) {
      const key = texto(audioS3Key);
      if (!key) throw new Error('Falta audioS3Key para iniciar Transcribe');

      const jobName = nombreJobTranscribe(idReunion);
      const mediaUri = `s3://${bucket}/${key}`;

      const maxSpeakersRaw = Number(process.env.TRANSCRIBE_MAX_SPEAKERS);
      const maxSpeakers =
        Number.isFinite(maxSpeakersRaw) && maxSpeakersRaw >= 2 && maxSpeakersRaw <= 10
          ? Math.floor(maxSpeakersRaw)
          : 10;

      const settings = {
        ShowSpeakerLabels: true,
        MaxSpeakerLabels: maxSpeakers,
      };

      const vocabName = texto(process.env.TRANSCRIBE_VOCABULARY_NAME);
      if (vocabName) {
        settings.VocabularyName = vocabName;
      }

      const terminos = Array.isArray(vocabulario)
        ? vocabulario.map((t) => texto(t)).filter(Boolean)
        : [];
      if (terminos.length) {
        logger.debug(
          { id_reunion: idReunion, terminos: terminos.length },
          `[${ETIQUETA}] Vocabulario del orden del día recibido ` +
            `(v1: no se crea Vocabulary al vuelo; opcional TRANSCRIBE_VOCABULARY_NAME)`,
        );
      }

      await client.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: IDIOMA(),
          Media: { MediaFileUri: mediaUri },
          MediaFormat: inferirFormatoMedia(key),
          Settings: settings,
        }),
      );

      return { jobId: jobName };
    },

    /**
     * @param {{ idReunion: string, jobId: string, audioS3Key?: string }} ctx
     */
    async consultar({ idReunion, jobId }) {
      const name = texto(jobId);
      if (!name) {
        return { estado: 'error', mensaje: 'Falta jobId de Transcribe' };
      }

      let job;
      try {
        const r = await client.send(
          new GetTranscriptionJobCommand({ TranscriptionJobName: name }),
        );
        job = r.TranscriptionJob;
      } catch (err) {
        const code = err?.name || err?.Code || '';
        if (code === 'BadRequestException' || code === 'NotFoundException') {
          return {
            estado: 'error',
            mensaje: `Job de Transcribe no encontrado: ${name}`,
          };
        }
        throw err;
      }

      const status = texto(job?.TranscriptionJobStatus).toUpperCase();

      if (status === 'QUEUED' || status === 'IN_PROGRESS') {
        return { estado: 'en_curso' };
      }

      if (status === 'FAILED') {
        return {
          estado: 'error',
          mensaje: texto(job?.FailureReason) || 'Transcribe falló sin motivo',
        };
      }

      if (status !== 'COMPLETED') {
        return {
          estado: 'error',
          mensaje: `Estado de Transcribe desconocido: ${status || 'vacío'}`,
        };
      }

      const uri = texto(job?.Transcript?.TranscriptFileUri);
      if (!uri) {
        return { estado: 'error', mensaje: 'Transcribe completó sin TranscriptFileUri' };
      }

      const res = await fetchFn(uri);
      if (!res.ok) {
        return {
          estado: 'error',
          mensaje: `No se pudo descargar la transcripción (${res.status})`,
        };
      }
      const payload = await res.json();
      const textoPlano = aplanarTranscripcionAws(payload);
      if (!textoPlano) {
        return { estado: 'error', mensaje: 'Transcripción vacía tras aplanar' };
      }

      const s3Key = claveTranscripcionReunion(idReunion);
      const cuerpo = JSON.stringify(
        {
          proveedor: ID_PROVEEDOR,
          job_id: name,
          idioma: IDIOMA(),
          texto: textoPlano,
          crudo: payload,
          generado_en: new Date().toISOString(),
        },
        null,
        0,
      );

      const putParams = {
        Bucket: bucket,
        Key: s3Key,
        Body: cuerpo,
        ContentType: 'application/json; charset=utf-8',
      };

      let ultimoPutErr = null;
      for (let intento = 0; intento < 2; intento += 1) {
        try {
          await s3.send(new PutObjectCommand(putParams));
          ultimoPutErr = null;
          break;
        } catch (err) {
          ultimoPutErr = err;
          logger.warn(
            { err, id_reunion: idReunion, s3Key, intento: intento + 1 },
            `[${ETIQUETA}] Fallo PutObject de transcripcion.json`,
          );
        }
      }
      if (ultimoPutErr) {
        return {
          estado: 'error',
          mensaje:
            texto(ultimoPutErr?.message) ||
            'No se pudo guardar la transcripción en S3',
        };
      }

      return { estado: 'completada', texto: textoPlano, s3Key };
    },
  };
}

/** Extensión → MediaFormat de Transcribe (opcional pero ayuda). */
function inferirFormatoMedia(audioS3Key) {
  const ext = texto(audioS3Key).split('.').pop()?.toLowerCase();
  const mapa = {
    mp3: 'mp3',
    mp4: 'mp4',
    m4a: 'mp4',
    wav: 'wav',
    flac: 'flac',
    ogg: 'ogg',
    opus: 'ogg',
    amr: 'amr',
    webm: 'webm',
  };
  return mapa[ext] || undefined;
}
