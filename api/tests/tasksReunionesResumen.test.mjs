/**
 * Fase 2E — resumen IA tras `transcrita`.
 *
 * - Reunión `transcrita` + mock de chatCompletion → `acta_borrador` + propuestas/puntos.
 * - JSON basura → `pipeline_error_fase = resumen` (conserva transcripción).
 * - Mismo `transcripcion_hash` con resumen → no re-llama al modelo.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-resumen';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const {
  ejecutarTickPipeline,
  PIPELINE_AJUSTE_PK,
  PIPELINE_AJUSTE_SK,
} = await import('../lib/tasks/reuniones/pipelineTick.js');
const {
  configurarChatCompletionResumen,
  configurarCargadorTranscripcion,
  parsearActaJson,
  normalizarActaParseada,
  textoDesdeCuerpoTranscripcion,
} = await import('../lib/tasks/reuniones/resumenActa.js');
const { PK, SK } = await import('../lib/tasks/tipos.js');

let restaurarChat = null;
let restaurarCarga = null;

after(() => {
  restaurarChat?.();
  restaurarCarga?.();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.reuniones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'fecha' },
      'Pipeline-index': { hashKey: 'pipeline_estado', rangeKey: 'pipeline_desde' },
      'Propuesta-Estado-index': { hashKey: 'propuesta_estado', rangeKey: 'creado_en' },
    },
  });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.iaPrompts, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

function activarPipeline(db) {
  db.sembrar(tables.ajustes, {
    PK: PIPELINE_AJUSTE_PK,
    SK: PIPELINE_AJUSTE_SK,
    Enabled: true,
    max_intentos: 3,
  });
}

function sembrarTranscrita(db, { id, hash = 'hash-abc', extras = {} }) {
  const ahora = '2026-08-30T11:00:00.000Z';
  db.sembrar(tables.reuniones, {
    PK: PK.reunion(id),
    SK: SK.meta,
    id_reunion: id,
    titulo: `Reunión ${id}`,
    gsi_listado: 'REU',
    fecha: '2026-08-30',
    estado: 'celebrada',
    pipeline_estado: 'transcrita',
    pipeline_desde: ahora,
    audio_estado: 'presente',
    orden_del_dia_congelado: '1. Presupuesto\n2. Personal',
    transcripcion_s3_key: `tasks/reuniones/${id}/transcripcion.json`,
    transcripcion_hash: hash,
    ...extras,
  });
  db.sembrar(tables.reuniones, {
    PK: PK.reunion(id),
    SK: SK.asistente('u-ana'),
    usuario_id: 'u-ana',
    nombre: 'Ana Pérez',
    asistio: true,
  });
}

const ACTA_OK = {
  resumen: 'Se habló del presupuesto y se acordó revisar personal.',
  acuerdos: [
    {
      texto: 'Revisar el presupuesto del local',
      cita: 'Ana: vamos a revisar el presupuesto la semana que viene',
      responsable_sugerido: 'Ana Pérez',
      fecha_sugerida: '2026-09-05',
    },
    {
      texto: 'Sin cita — debe descartarse',
      cita: '',
      responsable_sugerido: '',
    },
  ],
  tareas_propuestas: [
    {
      titulo: 'Preparar informe de personal',
      descripcion: 'Borrador para la próxima reunión',
      cita: 'Ana: preparo el informe de personal',
      responsable_sugerido: 'Ana Pérez',
      fecha_sugerida: '2026-09-10',
    },
  ],
  cobertura: [
    {
      punto: 'Presupuesto',
      estado: 'tratado',
      cita: 'hablamos del presupuesto',
    },
    {
      punto: 'Personal',
      estado: 'no_tratado',
      cita: '',
    },
  ],
  emergentes: [{ tema: 'Obra terraza', cita: 'también salió lo de la terraza' }],
};

test('parsearActaJson tolera cercas markdown', () => {
  const raw = '```json\n{"resumen":"hola","acuerdos":[]}\n```';
  const parsed = parsearActaJson(raw);
  assert.equal(parsed.resumen, 'hola');
});

test('normalizarActaParseada descarta sin cita', () => {
  const n = normalizarActaParseada(ACTA_OK);
  assert.equal(n.acuerdos.length, 1);
  assert.equal(n.tareas.length, 1);
  assert.equal(n.cobertura.length, 2);
});

test('textoDesdeCuerpoTranscripcion lee JSON de 2D', () => {
  const cuerpo = JSON.stringify({ texto: 'Hablante 1: Hola', proveedor: 'aws' });
  assert.equal(textoDesdeCuerpoTranscripcion(cuerpo), 'Hablante 1: Hola');
});

test('tick transcrita → acta_borrador con propuestas y puntos (mock IA)', async () => {
  const db = montar();
  activarPipeline(db);
  sembrarTranscrita(db, { id: 'r-resumen-ok' });

  let llamadasIa = 0;
  restaurarChat?.();
  restaurarChat = configurarChatCompletionResumen(async () => {
    llamadasIa += 1;
    return {
      text: JSON.stringify(ACTA_OK),
      model: 'gpt-test',
      usage: { prompt: 100, completion: 50 },
    };
  });
  restaurarCarga?.();
  restaurarCarga = configurarCargadorTranscripcion(async () => 'Ana: vamos a revisar el presupuesto');

  const r = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r.ok, true);
  assert.ok(r.procesadas >= 1);
  assert.equal(llamadasIa, 1);

  const meta = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-resumen-ok'),
    SK: SK.meta,
  });
  assert.equal(meta.estado, 'acta_borrador');
  assert.equal(meta.pipeline_estado, undefined);
  assert.equal(meta.pipeline_desde, undefined);
  assert.match(String(meta.resumen), /presupuesto/i);
  assert.equal(meta.resumen_hash, 'hash-abc');
  assert.equal(meta.coste_ia?.tokens_entrada, 100);
  assert.equal(meta.coste_ia?.tokens_salida, 50);
  // Transcripción conservada
  assert.ok(meta.transcripcion_s3_key);
  assert.equal(meta.transcripcion_hash, 'hash-abc');

  const items = db.listar(tables.reuniones).filter((it) => it.PK === PK.reunion('r-resumen-ok'));
  const propuestas = items.filter((it) => String(it.SK).startsWith('PROPUESTA#'));
  const puntos = items.filter((it) => String(it.SK).startsWith('PUNTO#'));

  assert.equal(propuestas.length, 2); // 1 acuerdo + 1 tarea (sin cita descartado)
  assert.ok(propuestas.every((p) => p.cita));
  assert.ok(propuestas.some((p) => p.tipo === 'acuerdo'));
  assert.ok(propuestas.some((p) => p.tipo === 'tarea'));
  assert.ok(propuestas.every((p) => p.propuesta_estado === 'pendiente'));
  assert.ok(propuestas.some((p) => p.responsable_sugerido_id === 'u-ana'));

  assert.ok(puntos.length >= 2);
  const aplazado = puntos.find((p) => p.cobertura === 'no_tratado');
  assert.ok(aplazado);
  assert.equal(aplazado.aplazado, true);
  assert.equal(aplazado.candidato_siguiente, true);
  assert.ok(puntos.some((p) => p.origen === 'emergente'));
});

test('JSON basura → error fase resumen y conserva transcripción', async () => {
  const db = montar();
  activarPipeline(db);
  sembrarTranscrita(db, { id: 'r-json-basura', extras: { intentos: 0 } });

  restaurarChat?.();
  restaurarChat = configurarChatCompletionResumen(async () => ({
    text: 'esto no es json {{{',
    model: 'gpt-test',
    usage: { prompt: 10, completion: 5 },
  }));
  restaurarCarga?.();
  restaurarCarga = configurarCargadorTranscripcion(async () => 'texto de prueba');

  // max_intentos=3 → primer fallo deja intentos=1 y sigue reintentable en resumiendo
  await ejecutarTickPipeline({ origen: 'test' });
  let meta = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-json-basura'),
    SK: SK.meta,
  });
  assert.equal(meta.pipeline_error_fase, 'resumen');
  assert.equal(meta.intentos, 1);
  assert.equal(meta.transcripcion_hash, 'hash-abc');
  assert.ok(meta.transcripcion_s3_key);
  // Tras marcar resumiendo + soft fail, sigue en vuelo (resumiendo)
  assert.equal(meta.pipeline_estado, 'resumiendo');

  // Agotar intentos
  db.sembrar(tables.ajustes, {
    PK: PIPELINE_AJUSTE_PK,
    SK: PIPELINE_AJUSTE_SK,
    Enabled: true,
    max_intentos: 2,
  });
  // intentos ya 1; siguiente ≥ 2 → error
  await ejecutarTickPipeline({ origen: 'test' });
  meta = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-json-basura'),
    SK: SK.meta,
  });
  assert.equal(meta.pipeline_estado, 'error');
  assert.equal(meta.pipeline_error_fase, 'resumen');
  assert.equal(meta.intentos, 2);
  assert.equal(meta.transcripcion_hash, 'hash-abc');
  assert.match(String(meta.pipeline_error), /JSON|parseable|inválido/i);
});

test('mismo hash con resumen ya generado: no re-llama al modelo', async () => {
  const db = montar();
  activarPipeline(db);
  sembrarTranscrita(db, {
    id: 'r-idempotente',
    hash: 'hash-fijo',
    extras: {
      resumen: 'Acta previa',
      resumen_hash: 'hash-fijo',
      estado: 'acta_borrador',
    },
  });

  let llamadasIa = 0;
  restaurarChat?.();
  restaurarChat = configurarChatCompletionResumen(async () => {
    llamadasIa += 1;
    return { text: '{}', model: 'x', usage: { prompt: 0, completion: 0 } };
  });
  restaurarCarga?.();
  restaurarCarga = configurarCargadorTranscripcion(async () => {
    throw new Error('no debería cargar transcripción');
  });

  const r = await ejecutarTickPipeline({ origen: 'test' });
  assert.equal(r.ok, true);
  assert.equal(llamadasIa, 0);

  const meta = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-idempotente'),
    SK: SK.meta,
  });
  assert.equal(meta.pipeline_estado, undefined);
  assert.equal(meta.resumen, 'Acta previa');
  assert.equal(meta.estado, 'acta_borrador');
});
