/**
 * Fase 2D — adaptador Amazon Transcribe (cliente inyectable, sin AWS real).
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'igp-test-bucket';

const {
  crearProveedorSttAws,
  aplanarTranscripcionAws,
  nombreJobTranscribe,
  claveTranscripcionReunion,
} = await import('../lib/tasks/reuniones/transcripcionAws.js');
const {
  resolverProveedorStt,
  configurarProveedorStt,
  extraerVocabularioOrdenDia,
} = await import('../lib/tasks/reuniones/pipelineTick.js');

function mockTranscribeClient({ start, get }) {
  return {
    async send(cmd) {
      const name = cmd?.constructor?.name || '';
      if (name.includes('StartTranscription')) {
        return start(cmd.input);
      }
      if (name.includes('GetTranscription')) {
        return get(cmd.input);
      }
      throw new Error(`Comando Transcribe inesperado: ${name}`);
    },
  };
}

function mockS3({ put } = {}) {
  return {
    async send(cmd) {
      const name = cmd?.constructor?.name || '';
      if (name.includes('PutObject')) {
        return put ? put(cmd.input) : {};
      }
      throw new Error(`Comando S3 inesperado: ${name}`);
    },
  };
}

test('nombreJobTranscribe: prefijo y caracteres válidos', () => {
  const n = nombreJobTranscribe('reu/abc 123!');
  assert.match(n, /^igp-reu-/);
  assert.match(n, /^[0-9a-zA-Z._-]+$/);
  assert.ok(n.length <= 200);
});

test('extraerVocabularioOrdenDia: capitalizadas y >3 letras', () => {
  const v = extraerVocabularioOrdenDia(
    '1. Presupuesto Local Sol\n2. RRHH\n3. de la\n4. marketing',
  );
  assert.ok(v.includes('Presupuesto'));
  assert.ok(v.includes('Local'));
  assert.ok(v.includes('Sol'));
  assert.ok(v.includes('RRHH'));
  assert.ok(v.includes('marketing'));
  assert.ok(!v.includes('de'));
  assert.ok(!v.includes('la'));
});

test('aplanarTranscripcionAws con hablantes', () => {
  const texto = aplanarTranscripcionAws({
    results: {
      transcripts: [{ transcript: 'Hola mundo' }],
      speaker_labels: {
        speakers: 2,
        segments: [
          {
            speaker_label: 'spk_0',
            items: [{ start_time: '0.0' }, { start_time: '0.5' }],
          },
          {
            speaker_label: 'spk_1',
            items: [{ start_time: '1.0' }],
          },
        ],
      },
      items: [
        {
          type: 'pronunciation',
          start_time: '0.0',
          alternatives: [{ content: 'Hola' }],
        },
        {
          type: 'pronunciation',
          start_time: '0.5',
          alternatives: [{ content: 'mundo' }],
        },
        {
          type: 'pronunciation',
          start_time: '1.0',
          alternatives: [{ content: 'Adiós' }],
        },
      ],
    },
  });
  assert.match(texto, /Hablante 1: Hola mundo/);
  assert.match(texto, /Hablante 2: Adiós/);
});

test('iniciar → jobId; consultar COMPLETED → texto + s3Key', async () => {
  let startInput = null;
  const putados = [];
  const payload = {
    results: {
      transcripts: [{ transcript: 'Buenas tardes' }],
      items: [
        {
          type: 'pronunciation',
          start_time: '0.0',
          speaker_label: 'spk_0',
          alternatives: [{ content: 'Buenas' }],
        },
        {
          type: 'pronunciation',
          start_time: '0.4',
          speaker_label: 'spk_0',
          alternatives: [{ content: 'tardes' }],
        },
      ],
      speaker_labels: {
        segments: [
          {
            speaker_label: 'spk_0',
            items: [{ start_time: '0.0' }, { start_time: '0.4' }],
          },
        ],
      },
    },
  };

  const proveedor = crearProveedorSttAws({
    client: mockTranscribeClient({
      start: (input) => {
        startInput = input;
        return {};
      },
      get: () => ({
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: {
            TranscriptFileUri: 'https://example.test/transcript.json',
          },
        },
      }),
    }),
    s3: mockS3({
      put: (input) => {
        putados.push(input);
        return {};
      },
    }),
    fetchFn: async () => ({
      ok: true,
      async json() {
        return payload;
      },
    }),
    bucket: 'igp-test-bucket',
  });

  assert.equal(proveedor.id, 'aws_transcribe');

  const { jobId } = await proveedor.iniciar({
    idReunion: 'reu-1',
    audioS3Key: 'tasks/reuniones/reu-1/audio.mp3',
    vocabulario: ['LocalSol', 'Presupuesto'],
  });
  assert.ok(jobId);
  assert.equal(startInput.LanguageCode, 'es-ES');
  assert.equal(startInput.Media.MediaFileUri, 's3://igp-test-bucket/tasks/reuniones/reu-1/audio.mp3');
  assert.equal(startInput.Settings.ShowSpeakerLabels, true);
  assert.ok(startInput.Settings.MaxSpeakerLabels >= 2);

  const r = await proveedor.consultar({
    idReunion: 'reu-1',
    jobId,
    audioS3Key: 'tasks/reuniones/reu-1/audio.mp3',
  });
  assert.equal(r.estado, 'completada');
  assert.match(r.texto, /Buenas/);
  assert.equal(r.s3Key, claveTranscripcionReunion('reu-1'));
  assert.equal(putados.length, 1);
  assert.equal(putados[0].Key, r.s3Key);
  assert.match(String(putados[0].Body), /"texto"/);
});

test('consultar IN_PROGRESS → en_curso; FAILED → error', async () => {
  let status = 'IN_PROGRESS';
  const proveedor = crearProveedorSttAws({
    client: mockTranscribeClient({
      start: () => ({}),
      get: () => ({
        TranscriptionJob: {
          TranscriptionJobStatus: status,
          FailureReason: status === 'FAILED' ? 'Media format invalid' : undefined,
        },
      }),
    }),
    s3: mockS3(),
    fetchFn: async () => ({ ok: false, status: 500 }),
  });

  const curso = await proveedor.consultar({ idReunion: 'r', jobId: 'igp-reu-r-abc' });
  assert.equal(curso.estado, 'en_curso');

  status = 'FAILED';
  const fail = await proveedor.consultar({ idReunion: 'r', jobId: 'igp-reu-r-abc' });
  assert.equal(fail.estado, 'error');
  assert.match(fail.mensaje, /Media format|falló/i);
});

test('PutObject fallido (tras reintento) → error, no completada sin s3Key', async () => {
  let puts = 0;
  const proveedor = crearProveedorSttAws({
    client: mockTranscribeClient({
      start: () => ({}),
      get: () => ({
        TranscriptionJob: {
          TranscriptionJobStatus: 'COMPLETED',
          Transcript: { TranscriptFileUri: 'https://example.test/t.json' },
        },
      }),
    }),
    s3: mockS3({
      put: () => {
        puts += 1;
        throw new Error('AccessDenied PutObject');
      },
    }),
    fetchFn: async () => ({
      ok: true,
      async json() {
        return {
          results: {
            transcripts: [{ transcript: 'texto ok' }],
            items: [],
          },
        };
      },
    }),
  });

  const r = await proveedor.consultar({
    idReunion: 'reu-put',
    jobId: 'igp-reu-put-1',
  });
  assert.equal(r.estado, 'error');
  assert.match(r.mensaje, /AccessDenied|S3/i);
  assert.equal(r.s3Key, undefined);
  assert.equal(puts, 2, 'debe reintentar Put una vez (2 intentos)');
});

test('resolverProveedorStt reconoce aws / transcribe / amazon', () => {
  const prev = process.env.TRANSCRIPCION_PROVEEDOR;
  const restaurar = configurarProveedorStt(null);
  try {
    process.env.TRANSCRIPCION_PROVEEDOR = 'aws';
    const p = resolverProveedorStt({});
    assert.ok(p);
    assert.equal(p.id, 'aws_transcribe');

    process.env.TRANSCRIPCION_PROVEEDOR = 'transcribe';
    assert.equal(resolverProveedorStt({}).id, 'aws_transcribe');

    process.env.TRANSCRIPCION_PROVEEDOR = 'amazon';
    assert.equal(resolverProveedorStt({}).id, 'aws_transcribe');

    process.env.TRANSCRIPCION_PROVEEDOR = '';
    assert.equal(resolverProveedorStt({ proveedor_transcripcion: 'aws_transcribe' }).id, 'aws_transcribe');

    process.env.TRANSCRIPCION_PROVEEDOR = 'stub';
    assert.equal(resolverProveedorStt({}), null);
  } finally {
    if (prev === undefined) delete process.env.TRANSCRIPCION_PROVEEDOR;
    else process.env.TRANSCRIPCION_PROVEEDOR = prev;
    restaurar();
  }
});
