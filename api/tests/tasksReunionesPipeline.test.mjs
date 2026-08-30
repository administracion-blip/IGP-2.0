/**
 * Fase 2B — poller del pipeline de reuniones.
 *
 * - Sin Enabled → no-op.
 * - Con reunión `audio_pendiente` y sin proveedor → omite (no inventa texto).
 * - Con stub de test inyectado → avanza a `transcrita`.
 * - Nunca Scan sobre Igp_Reuniones (solo Query a Pipeline-index).
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-pipeline';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const {
  ejecutarTickPipeline,
  configurarProveedorStt,
  crearProveedorSttStubTest,
  PIPELINE_AJUSTE_PK,
  PIPELINE_AJUSTE_SK,
  IDX_PIPELINE,
} = await import('../lib/tasks/reuniones/pipelineTick.js');
const { PK, SK } = await import('../lib/tasks/tipos.js');

let restaurarStt = null;

after(() => {
  restaurarStt?.();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.reuniones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'fecha' },
      'Pipeline-index': { hashKey: 'pipeline_estado', rangeKey: 'pipeline_desde' },
    },
  });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

function sembrarReunion(db, { id, pipeline_estado, pipeline_desde, extras = {} }) {
  const ahora = pipeline_desde || new Date().toISOString();
  db.sembrar(tables.reuniones, {
    PK: PK.reunion(id),
    SK: SK.meta,
    id_reunion: id,
    titulo: `Reunión ${id}`,
    gsi_listado: 'REU',
    fecha: '2026-08-30',
    pipeline_estado,
    pipeline_desde: ahora,
    audio_estado: 'presente',
    audio_s3_key: `tasks/reuniones/${id}/audio.mp3`,
    ...extras,
  });
}

function scansSobreReuniones(db) {
  return db.operaciones.filter(
    (op) => op.tipo === 'ScanCommand' && op.tabla === tables.reuniones,
  );
}

function queriesPipeline(db) {
  return db.operaciones.filter(
    (op) =>
      op.tipo === 'QueryCommand' &&
      op.tabla === tables.reuniones,
  );
}

test('tick sin Enabled no hace nada', async () => {
  const db = montar();
  sembrarReunion(db, {
    id: 'r-off',
    pipeline_estado: 'audio_pendiente',
    pipeline_desde: '2026-08-30T10:00:00.000Z',
  });

  const r = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.motivo, 'desactivado');
  assert.equal(r.procesadas, 0);

  const item = db.obtener(tables.reuniones, { PK: PK.reunion('r-off'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'audio_pendiente');
  assert.equal(scansSobreReuniones(db).length, 0);
});

test('tick con Enabled y audio_pendiente sin proveedor: omite y no inventa transcripción', async () => {
  const db = montar();
  db.sembrar(tables.ajustes, {
    PK: PIPELINE_AJUSTE_PK,
    SK: PIPELINE_AJUSTE_SK,
    Enabled: true,
    max_intentos: 3,
    // sin proveedor / stub vacío
    proveedor_transcripcion: 'stub',
  });
  sembrarReunion(db, {
    id: 'r-espera',
    pipeline_estado: 'audio_pendiente',
    pipeline_desde: '2026-08-30T10:00:00.000Z',
  });

  // Asegurar que no hay inyección de stub de test.
  restaurarStt?.();
  restaurarStt = configurarProveedorStt(null);

  const r = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.procesadas, 0);
  assert.ok(r.omitidas >= 1);

  const item = db.obtener(tables.reuniones, { PK: PK.reunion('r-espera'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'audio_pendiente');
  assert.equal(item.transcripcion_job_id, undefined);
  assert.equal(item.transcripcion_hash, undefined);
  assert.equal(scansSobreReuniones(db).length, 0);
  assert.ok(
    queriesPipeline(db).length >= 1,
    'debe consultar Pipeline-index',
  );
});

test('tick con stub de test: audio_pendiente → transcrita (sin Scan)', async () => {
  const db = montar();
  db.sembrar(tables.ajustes, {
    PK: PIPELINE_AJUSTE_PK,
    SK: PIPELINE_AJUSTE_SK,
    Enabled: true,
    max_intentos: 3,
  });
  sembrarReunion(db, {
    id: 'r-stub',
    pipeline_estado: 'audio_pendiente',
    pipeline_desde: '2026-08-30T10:00:00.000Z',
  });

  restaurarStt?.();
  restaurarStt = configurarProveedorStt(
    crearProveedorSttStubTest({ textoTranscripcion: 'Hola desde el stub de test.' }),
  );

  // Una pasada puede encadenar audio_pendiente → transcribiendo → transcrita
  // (reconsulta cada estado del índice en el mismo tick).
  const r = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r.ok, true);
  assert.ok(r.procesadas >= 1);

  const item = db.obtener(tables.reuniones, { PK: PK.reunion('r-stub'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'transcrita');
  assert.ok(item.transcripcion_job_id);
  assert.ok(item.transcripcion_hash);
  assert.ok(String(item.transcripcion_s3_key).includes('transcripcion.json'));

  assert.equal(scansSobreReuniones(db).length, 0, 'nunca Scan sobre reuniones');
  assert.ok(queriesPipeline(db).length >= 1);
});

test('fallos repetidos de iniciar alcanzan max_intentos y pasan a error', async () => {
  const db = montar();
  db.sembrar(tables.ajustes, {
    PK: PIPELINE_AJUSTE_PK,
    SK: PIPELINE_AJUSTE_SK,
    Enabled: true,
    max_intentos: 2,
  });
  sembrarReunion(db, {
    id: 'r-tope',
    pipeline_estado: 'audio_pendiente',
    pipeline_desde: '2026-08-30T10:00:00.000Z',
  });

  restaurarStt?.();
  restaurarStt = configurarProveedorStt({
    id: 'stub_fail',
    async iniciar() {
      throw new Error('STT caído a propósito');
    },
    async consultar() {
      return { estado: 'en_curso' };
    },
  });

  // 1.er fallo: intentos=1, sigue en audio_pendiente (reintentable)
  const r1 = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r1.ok, true);
  let item = db.obtener(tables.reuniones, { PK: PK.reunion('r-tope'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'audio_pendiente');
  assert.equal(item.intentos, 1);
  assert.equal(item.pipeline_error_fase, 'transcripcion');
  assert.match(String(item.pipeline_error), /STT caído/);

  // 2.º fallo: intentos=2 >= max → error definitivo
  const r2 = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r2.ok, true);
  item = db.obtener(tables.reuniones, { PK: PK.reunion('r-tope'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'error');
  assert.equal(item.intentos, 2);
  assert.equal(item.pipeline_error_fase, 'transcripcion');

  // 3.er tick: error no se reintenta automáticamente
  const r3 = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r3.ok, true);
  assert.equal(r3.procesadas, 0);
  item = db.obtener(tables.reuniones, { PK: PK.reunion('r-tope'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'error');
  assert.equal(item.intentos, 2);
});

test('excepción en consultar incrementa intentos y llega a error', async () => {
  const db = montar();
  db.sembrar(tables.ajustes, {
    PK: PIPELINE_AJUSTE_PK,
    SK: PIPELINE_AJUSTE_SK,
    Enabled: true,
    max_intentos: 2,
  });
  sembrarReunion(db, {
    id: 'r-consulta',
    pipeline_estado: 'transcribiendo',
    pipeline_desde: '2026-08-30T10:00:00.000Z',
    extras: { transcripcion_job_id: 'job-1', intentos: 0 },
  });

  restaurarStt?.();
  restaurarStt = configurarProveedorStt({
    id: 'stub_fail_consulta',
    async iniciar() {
      return { jobId: 'no-usado' };
    },
    async consultar() {
      throw new Error('timeout del proveedor');
    },
  });

  await ejecutarTickPipeline({ origen: 'test' });
  let item = db.obtener(tables.reuniones, { PK: PK.reunion('r-consulta'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'transcribiendo');
  assert.equal(item.intentos, 1);

  await ejecutarTickPipeline({ origen: 'test' });
  item = db.obtener(tables.reuniones, { PK: PK.reunion('r-consulta'), SK: SK.meta });
  assert.equal(item.pipeline_estado, 'error');
  assert.equal(item.intentos, 2);
  assert.equal(item.pipeline_error_fase, 'transcripcion');
  assert.match(String(item.pipeline_error), /timeout/);
});

test('chatCompletion acepta responseFormat y maxTokens sin romper defaults', async () => {
  const { chatCompletion } = await import('../lib/ia/openaiClient.js');
  const { plantillaDefault, FUENTE_REUNIONES_ACTA } = await import('../lib/ia/prompts.js');

  const plantilla = plantillaDefault(FUENTE_REUNIONES_ACTA);
  assert.ok(plantilla.instrucciones.includes('acuerdos'));
  assert.ok(plantilla.instrucciones.includes('cita'));

  // Sin API key: falla igual que antes (no rompe la firma).
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(
    () =>
      chatCompletion({
        system: 'sys',
        user: 'usr',
        responseFormat: 'json_object',
        maxTokens: 100,
        timeoutMs: 1000,
      }),
    /OPENAI_API_KEY/,
  );
  if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
});

test('constante IDX_PIPELINE es Pipeline-index', () => {
  assert.equal(IDX_PIPELINE, 'Pipeline-index');
});
