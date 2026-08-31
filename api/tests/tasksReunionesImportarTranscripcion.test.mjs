/**
 * Importación de transcripción en texto (salta STT → `transcrita`).
 *
 * - Import OK: S3 + META en `transcrita`, congela orden, sin aviso.
 * - Segundo import → `ya_iniciado` sin reescribir S3.
 * - Carrera concurrente → un ganador + ConditionalCheck → `ya_iniciado`.
 * - Limpia `audio_s3_key` huérfano de presign.
 * - Texto vacío → 400.
 * - Tras import, `procesar` audio no arranca de nuevo.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-import-tx';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { configurarAlmacenAudio } = await import('../lib/tasks/reuniones/audio.js');
const {
  configurarAlmacenTranscripcion,
} = await import('../lib/tasks/reuniones/importarTranscripcion.js');
const { hashTexto } = await import('../lib/tasks/reuniones/hashTexto.js');
const { claveTranscripcionReunion } = await import('../lib/tasks/reuniones/transcripcionAws.js');
const { default: reunionesRouter } = await import('../routes/reuniones.js');

const ANA = { sub: '000007', email: 'ana@grupo.test', rol: 'Gestora reuniones' };

const PERMISOS_POR_ROL = {
  'Gestora reuniones': [
    'reuniones.ver',
    'reuniones.gestionar',
    'reuniones.ver_direccion',
    'proyectos.editar',
  ],
};

let usuarioActual = ANA;
let servidor = null;
let base = '';
let restaurarAlmacenAudio = null;
let restaurarAlmacenTx = null;

async function api(metodo, ruta, cuerpo, usuario = ANA) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', reunionesRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  restaurarAlmacenAudio?.();
  restaurarAlmacenTx?.();
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.reuniones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'fecha' },
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'fecha' },
      'Serie-index': { hashKey: 'serie_id', rangeKey: 'fecha' },
      'Pipeline-index': { hashKey: 'pipeline_estado', rangeKey: 'pipeline_desde' },
    },
  });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.notificaciones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'NoLeidas-index': { hashKey: 'usuario_no_leida', rangeKey: 'creado_en', proyeccion: 'KEYS_ONLY' },
    },
  });
  db.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Reunion-index': { hashKey: 'reunion_origen_id', rangeKey: 'creado_en' },
    },
  });
  db.crearTabla(tables.proyectos, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Miembro-index': { hashKey: 'usuario_id', rangeKey: 'PK', proyeccion: 'KEYS_ONLY' },
    },
  });

  db.sembrar(tables.usuarios, {
    id_usuario: ANA.sub,
    Email: ANA.email,
    Rol: ANA.rol,
    Nombre: 'Ana',
    Departamentos: ['dep-mkt'],
  });
  for (const codigo of PERMISOS_POR_ROL['Gestora reuniones']) {
    db.sembrar(tables.rolesPermisos, { PK: `ROL#${ANA.rol}`, SK: `PERMISO#${codigo}` });
  }
  db.sembrar(tables.ajustes, {
    PK: 'departamentos',
    SK: 'DEP#dep-mkt',
    nombre: 'Marketing',
    responsable_id: ANA.sub,
    activo: true,
    orden: 1,
  });

  db.instalar(docClient);
  invalidarContextoAcceso();

  const bucket = new Map();
  const espiaTx = { puts: [] };

  restaurarAlmacenAudio?.();
  restaurarAlmacenAudio = configurarAlmacenAudio({
    urlSubida: async ({ key, contentType }) =>
      `https://bucket.test/${key}?firma=subida&ct=${encodeURIComponent(contentType)}`,
    cabecera: async ({ key }) => {
      const obj = bucket.get(key);
      if (!obj) return null;
      return { tamano: obj.tamano, contentType: obj.contentType };
    },
  });

  restaurarAlmacenTx?.();
  restaurarAlmacenTx = configurarAlmacenTranscripcion({
    putJson: async ({ key, body }) => {
      espiaTx.puts.push({ key, body });
      bucket.set(key, {
        tamano: Buffer.byteLength(body, 'utf8'),
        contentType: 'application/json; charset=utf-8',
        body,
      });
    },
  });

  return { db, bucket, espiaTx };
}

function sembrarReunion(db, { id, extras = {} } = {}) {
  db.sembrar(tables.reuniones, {
    PK: `REU#${id}`,
    SK: 'META',
    id_reunion: id,
    titulo: 'Comité import',
    fecha: '2026-08-28',
    hora_inicio: '10:00',
    hora_fin: '11:00',
    estado: 'convocada',
    visibilidad: 'departamento',
    departamento_id: 'dep-mkt',
    orden_del_dia: '1. Presupuesto\n2. Personal',
    convocada_por: ANA.sub,
    gsi_listado: 'REU',
    creado_en: '2026-08-28T08:00:00.000Z',
    actualizado_en: '2026-08-28T08:00:00.000Z',
    ...extras,
  });
}

const TEXTO_OK = 'Ana: Revisamos el presupuesto.\nBea: De acuerdo, lo cerramos.';

test('hashTexto coincide con SHA-256 UTF-8 del tick', () => {
  const esperado = createHash('sha256').update(TEXTO_OK, 'utf8').digest('hex');
  assert.equal(hashTexto(TEXTO_OK), esperado);
});

test('importar OK: S3 + META en transcrita, congela orden, sin aviso', async () => {
  const { db, espiaTx } = montar();
  sembrarReunion(db, {
    id: 'r-imp-ok',
    extras: { pipeline_error: 'viejo', pipeline_error_fase: 'transcripcion' },
  });

  const r = await api('POST', '/api/reuniones/r-imp-ok/transcripcion/importar', {
    texto: TEXTO_OK,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ya_iniciado, false);
  assert.equal(r.body.reunion.pipeline_estado, 'transcrita');
  assert.equal(r.body.reunion.origen_audio, 'transcripcion_importada');
  assert.equal(r.body.reunion.transcripcion_job_id, null);
  assert.equal(
    r.body.reunion.transcripcion_s3_key,
    claveTranscripcionReunion('r-imp-ok'),
  );
  assert.equal(r.body.reunion.transcripcion_hash, hashTexto(TEXTO_OK));

  assert.equal(espiaTx.puts.length, 1);
  const put = espiaTx.puts[0];
  assert.equal(put.key, claveTranscripcionReunion('r-imp-ok'));
  const parsed = JSON.parse(put.body);
  assert.equal(parsed.texto, TEXTO_OK);
  assert.equal(parsed.origen, 'importada');
  assert.ok(parsed.generado_en);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-imp-ok', SK: 'META' });
  assert.equal(meta.pipeline_estado, 'transcrita');
  assert.equal(meta.origen_audio, 'transcripcion_importada');
  assert.equal(meta.transcripcion_s3_key, put.key);
  assert.equal(meta.transcripcion_hash, hashTexto(TEXTO_OK));
  assert.ok(meta.pipeline_desde);
  assert.equal(meta.orden_del_dia_congelado, '1. Presupuesto\n2. Personal');
  assert.ok(meta.orden_del_dia_congelado_en);
  assert.equal(meta.pipeline_error, undefined);
  assert.equal(meta.pipeline_error_fase, undefined);
  assert.notEqual(meta.audio_estado, 'presente');
  assert.equal(meta.transcripcion_job_id, undefined);
});

test('segundo import responde ya_iniciado sin reescribir S3', async () => {
  const { db, espiaTx } = montar();
  sembrarReunion(db, { id: 'r-imp-idem' });

  const p1 = await api('POST', '/api/reuniones/r-imp-idem/transcripcion/importar', {
    texto: TEXTO_OK,
  });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.ya_iniciado, false);
  const desde1 = p1.body.reunion.pipeline_desde;
  assert.equal(espiaTx.puts.length, 1);

  const p2 = await api('POST', '/api/reuniones/r-imp-idem/transcripcion/importar', {
    texto: 'otro texto distinto que no debe guardarse',
  });
  assert.equal(p2.status, 200);
  assert.equal(p2.body.ya_iniciado, true);
  assert.equal(p2.body.reunion.pipeline_estado, 'transcrita');
  assert.equal(p2.body.reunion.pipeline_desde, desde1);
  assert.equal(espiaTx.puts.length, 1, 'no debe haber segundo PutObject');

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-imp-idem', SK: 'META' });
  assert.equal(meta.transcripcion_hash, hashTexto(TEXTO_OK));
  assert.equal(meta.pipeline_desde, desde1);
});

test('carrera: dos imports concurrentes → un ganador e idempotente', async () => {
  const { db, espiaTx } = montar();
  sembrarReunion(db, { id: 'r-imp-race' });

  const textoB = 'Texto concurrente distinto que no debe quedar en META si pierde.';
  const [a, b] = await Promise.all([
    api('POST', '/api/reuniones/r-imp-race/transcripcion/importar', { texto: TEXTO_OK }),
    api('POST', '/api/reuniones/r-imp-race/transcripcion/importar', { texto: textoB }),
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const cuerpos = [a.body, b.body];
  const ganadores = cuerpos.filter((x) => x.ok && !x.ya_iniciado);
  const perdedores = cuerpos.filter((x) => x.ok && x.ya_iniciado);
  assert.equal(ganadores.length, 1);
  assert.equal(perdedores.length, 1);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-imp-race', SK: 'META' });
  assert.equal(meta.pipeline_estado, 'transcrita');
  assert.equal(meta.origen_audio, 'transcripcion_importada');
  assert.equal(meta.transcripcion_hash, ganadores[0].reunion.transcripcion_hash);
  assert.equal(perdedores[0].reunion.transcripcion_hash, meta.transcripcion_hash);
  assert.equal(perdedores[0].reunion.pipeline_desde, meta.pipeline_desde);
  assert.ok(espiaTx.puts.length >= 1);
});

test('importar quita audio_s3_key huérfano de un presign previo', async () => {
  const { db } = montar();
  const keyHuerfana = 'tasks/reuniones/r-imp-huerfano/audio.m4a';
  sembrarReunion(db, {
    id: 'r-imp-huerfano',
    extras: { audio_s3_key: keyHuerfana },
  });

  const r = await api('POST', '/api/reuniones/r-imp-huerfano/transcripcion/importar', {
    texto: TEXTO_OK,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ya_iniciado, false);
  assert.equal(r.body.reunion.audio_s3_key, null);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-imp-huerfano', SK: 'META' });
  assert.equal(meta.audio_s3_key, undefined);
  assert.equal(meta.pipeline_estado, 'transcrita');
});

test('texto vacío o solo espacios responde 400', async () => {
  const { db, espiaTx } = montar();
  sembrarReunion(db, { id: 'r-imp-vacio' });

  const r1 = await api('POST', '/api/reuniones/r-imp-vacio/transcripcion/importar', {
    texto: '',
  });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error || '', /vacío/i);

  const r2 = await api('POST', '/api/reuniones/r-imp-vacio/transcripcion/importar', {
    transcript: '   \n\t  ',
  });
  assert.equal(r2.status, 400);
  assert.equal(espiaTx.puts.length, 0);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-imp-vacio', SK: 'META' });
  assert.equal(meta.pipeline_estado, undefined);
});

test('importar funciona sin aviso_grabacion', async () => {
  const { db } = montar();
  sembrarReunion(db, { id: 'r-imp-sin-aviso' });
  // Sin aviso_grabacion en META a propósito.

  const r = await api('POST', '/api/reuniones/r-imp-sin-aviso/transcripcion/importar', {
    transcript: TEXTO_OK,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ya_iniciado, false);
  assert.equal(r.body.reunion.pipeline_estado, 'transcrita');

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-imp-sin-aviso', SK: 'META' });
  assert.equal(meta.aviso_grabacion, undefined);
  assert.equal(meta.pipeline_estado, 'transcrita');
});

test('tras importar no se puede procesar audio (ya_iniciado)', async () => {
  const { db, bucket } = montar();
  sembrarReunion(db, { id: 'r-imp-luego-audio' });

  const imp = await api('POST', '/api/reuniones/r-imp-luego-audio/transcripcion/importar', {
    texto: TEXTO_OK,
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.ya_iniciado, false);

  const key = 'tasks/reuniones/r-imp-luego-audio/audio.m4a';
  bucket.set(key, { tamano: 1_000_000, contentType: 'audio/mp4' });

  const proc = await api('POST', '/api/reuniones/r-imp-luego-audio/procesar', {
    s3_key: key,
  });
  assert.equal(proc.status, 200);
  assert.equal(proc.body.ya_iniciado, true);
  assert.equal(proc.body.reunion.pipeline_estado, 'transcrita');
  assert.equal(proc.body.reunion.origen_audio, 'transcripcion_importada');

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-imp-luego-audio', SK: 'META' });
  assert.equal(meta.pipeline_estado, 'transcrita');
  assert.equal(meta.origen_audio, 'transcripcion_importada');
  assert.notEqual(meta.audio_estado, 'presente');
});
