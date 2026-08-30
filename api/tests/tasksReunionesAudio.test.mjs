/**
 * Fase 2A — captura de audio por subida (presign + procesar).
 *
 * - Sin aviso aceptado → no se emite URL.
 * - Objeto ausente en procesar → 409.
 * - Doble procesar → un solo arranque (idempotente).
 * - Con aviso + objeto → META con `pipeline_estado = audio_pendiente`.
 *
 * S3 inyectado: no se sube nada a ningún sitio.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-audio';
process.env.REUNIONES_MAX_AUDIO_MB = process.env.REUNIONES_MAX_AUDIO_MB || '500';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { configurarAlmacenAudio } = await import('../lib/tasks/reuniones/audio.js');
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
let restaurarAlmacen = null;

async function api(metodo, ruta, cuerpo, usuario = ANA) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
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
  restaurarAlmacen?.();
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
  const espia = { firmadasSubida: [], cabeceras: [] };

  restaurarAlmacen?.();
  restaurarAlmacen = configurarAlmacenAudio({
    urlSubida: async ({ key, contentType }) => {
      espia.firmadasSubida.push({ key, contentType });
      return `https://bucket.test/${key}?firma=subida`;
    },
    cabecera: async ({ key }) => {
      espia.cabeceras.push(key);
      const obj = bucket.get(key);
      if (!obj) return null;
      return { tamano: obj.tamano, contentType: obj.contentType };
    },
  });

  return { db, bucket, espia };
}

function sembrarReunion(db, { id, aviso = null, extras = {} } = {}) {
  db.sembrar(tables.reuniones, {
    PK: `REU#${id}`,
    SK: 'META',
    id_reunion: id,
    titulo: 'Comité audio',
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
    ...(aviso ? { aviso_grabacion: aviso } : {}),
    ...extras,
  });
}

const CUERPO_PRESIGN = {
  nombre: 'reunion.m4a',
  contentType: 'audio/mp4',
  tamano: 12 * 1024 * 1024,
};

test('sin aviso aceptado no emite URL de subida', async () => {
  const { db, espia } = montar();
  sembrarReunion(db, { id: 'r-sin-aviso' });

  const r = await api('POST', '/api/reuniones/r-sin-aviso/audio/presign', CUERPO_PRESIGN);
  assert.equal(r.status, 409);
  assert.match(r.body.error || '', /aviso de grabación/i);
  assert.equal(espia.firmadasSubida.length, 0);
});

test('aviso solo informados (sin aceptación) tampoco emite URL', async () => {
  const { db, espia } = montar();
  sembrarReunion(db, {
    id: 'r-solo-info',
    aviso: { informados: [ANA.sub], aceptado_por: '', aceptado_en: '' },
  });

  const r = await api('POST', '/api/reuniones/r-solo-info/audio/presign', CUERPO_PRESIGN);
  assert.equal(r.status, 409);
  assert.equal(espia.firmadasSubida.length, 0);
});

test('con aviso aceptado emite presign, congela orden y guarda clave', async () => {
  const { db, espia } = montar();
  sembrarReunion(db, {
    id: 'r-ok',
    aviso: {
      informados: [ANA.sub],
      aceptado_por: ANA.sub,
      aceptado_en: '2026-08-28T09:00:00.000Z',
    },
  });

  const r = await api('POST', '/api/reuniones/r-ok/audio/presign', CUERPO_PRESIGN);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.audio.upload_url.includes('firma=subida'));
  assert.equal(r.body.audio.s3_key, 'tasks/reuniones/r-ok/audio.m4a');
  assert.equal(r.body.audio.content_type, 'audio/mp4');
  assert.equal(espia.firmadasSubida.length, 1);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-ok', SK: 'META' });
  assert.equal(meta.audio_s3_key, 'tasks/reuniones/r-ok/audio.m4a');
  assert.equal(meta.orden_del_dia_congelado, '1. Presupuesto\n2. Personal');
  assert.ok(meta.orden_del_dia_congelado_en);
});

test('procesar sin objeto en S3 responde 409', async () => {
  const { db } = montar();
  sembrarReunion(db, {
    id: 'r-sin-obj',
    aviso: {
      informados: [ANA.sub],
      aceptado_por: ANA.sub,
      aceptado_en: '2026-08-28T09:00:00.000Z',
    },
  });

  const pre = await api('POST', '/api/reuniones/r-sin-obj/audio/presign', CUERPO_PRESIGN);
  assert.equal(pre.status, 200);

  const r = await api('POST', '/api/reuniones/r-sin-obj/procesar', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error || '', /no está|todavía/i);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-sin-obj', SK: 'META' });
  assert.equal(meta.pipeline_estado, undefined);
});

test('con aviso y objeto: META en audio_pendiente; doble procesar es idempotente', async () => {
  const { db, bucket } = montar();
  sembrarReunion(db, {
    id: 'r-pipe',
    aviso: {
      informados: [ANA.sub],
      aceptado_por: ANA.sub,
      aceptado_en: '2026-08-28T09:00:00.000Z',
    },
    extras: { pipeline_error: 'fallo previo', pipeline_error_fase: 'transcripcion' },
  });

  const pre = await api('POST', '/api/reuniones/r-pipe/audio/presign', CUERPO_PRESIGN);
  assert.equal(pre.status, 200);
  const key = pre.body.audio.s3_key;
  bucket.set(key, { tamano: 3_000_000, contentType: 'audio/mp4' });

  const p1 = await api('POST', '/api/reuniones/r-pipe/procesar', { duracion_seg: 3600 });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.ya_iniciado, false);
  assert.equal(p1.body.reunion.pipeline_estado, 'audio_pendiente');
  assert.equal(p1.body.reunion.origen_audio, 'subida');
  assert.equal(p1.body.reunion.audio_estado, 'presente');
  assert.equal(p1.body.reunion.audio_s3_key, key);

  const meta1 = db.obtener(tables.reuniones, { PK: 'REU#r-pipe', SK: 'META' });
  assert.equal(meta1.pipeline_estado, 'audio_pendiente');
  assert.ok(meta1.pipeline_desde);
  assert.equal(meta1.audio_estado, 'presente');
  assert.equal(meta1.origen_audio, 'subida');
  assert.equal(meta1.audio_tamano, 3_000_000);
  assert.equal(meta1.duracion_seg, 3600);
  assert.equal(meta1.pipeline_error, undefined);
  assert.equal(meta1.pipeline_error_fase, undefined);
  const desde1 = meta1.pipeline_desde;

  const p2 = await api('POST', '/api/reuniones/r-pipe/procesar', {});
  assert.equal(p2.status, 200);
  assert.equal(p2.body.ya_iniciado, true);
  assert.equal(p2.body.reunion.pipeline_estado, 'audio_pendiente');

  const meta2 = db.obtener(tables.reuniones, { PK: 'REU#r-pipe', SK: 'META' });
  assert.equal(meta2.pipeline_desde, desde1, 'no debe reescribir pipeline_desde');

  const ficha = await api('GET', '/api/reuniones/r-pipe');
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.reunion.audio_estado, 'presente');
  assert.equal(ficha.body.reunion.pipeline_estado, 'audio_pendiente');
  assert.equal(ficha.body.reunion.origen_audio, 'subida');
});

test('con transcripcion_job_id no relanza aunque se llame a procesar', async () => {
  const { db, bucket } = montar();
  const key = 'tasks/reuniones/r-job/audio.m4a';
  sembrarReunion(db, {
    id: 'r-job',
    aviso: {
      informados: [ANA.sub],
      aceptado_por: ANA.sub,
      aceptado_en: '2026-08-28T09:00:00.000Z',
    },
    extras: {
      audio_s3_key: key,
      transcripcion_job_id: 'job-ya-lanzado',
      pipeline_estado: 'transcribiendo',
      pipeline_desde: '2026-08-28T10:00:00.000Z',
    },
  });
  bucket.set(key, { tamano: 1000, contentType: 'audio/mp4' });

  const r = await api('POST', '/api/reuniones/r-job/procesar', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ya_iniciado, true);
  assert.equal(r.body.reunion.transcripcion_job_id, 'job-ya-lanzado');

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-job', SK: 'META' });
  assert.equal(meta.pipeline_estado, 'transcribiendo');
  assert.equal(meta.pipeline_desde, '2026-08-28T10:00:00.000Z');
});

test('presign tras pipeline iniciado responde 409 y no reescribe audio_s3_key', async () => {
  const { db, espia } = montar();
  const keyOriginal = 'tasks/reuniones/r-represign/audio.m4a';
  sembrarReunion(db, {
    id: 'r-represign',
    aviso: {
      informados: [ANA.sub],
      aceptado_por: ANA.sub,
      aceptado_en: '2026-08-28T09:00:00.000Z',
    },
    extras: {
      audio_s3_key: keyOriginal,
      audio_estado: 'presente',
      pipeline_estado: 'audio_pendiente',
      pipeline_desde: '2026-08-28T10:00:00.000Z',
      origen_audio: 'subida',
    },
  });

  const r = await api('POST', '/api/reuniones/r-represign/audio/presign', {
    nombre: 'otro.mp3',
    contentType: 'audio/mpeg',
    tamano: 5 * 1024 * 1024,
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error || '', /ya está en marcha|no se puede volver a subir/i);
  assert.equal(espia.firmadasSubida.length, 0);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-represign', SK: 'META' });
  assert.equal(meta.audio_s3_key, keyOriginal);
  assert.equal(meta.pipeline_estado, 'audio_pendiente');
  assert.equal(meta.audio_estado, 'presente');
});

test('procesar con objeto de 0 bytes responde 409 y no marca presente', async () => {
  const { db, bucket } = montar();
  sembrarReunion(db, {
    id: 'r-vacio',
    aviso: {
      informados: [ANA.sub],
      aceptado_por: ANA.sub,
      aceptado_en: '2026-08-28T09:00:00.000Z',
    },
  });

  const pre = await api('POST', '/api/reuniones/r-vacio/audio/presign', CUERPO_PRESIGN);
  assert.equal(pre.status, 200);
  const key = pre.body.audio.s3_key;
  bucket.set(key, { tamano: 0, contentType: 'audio/mp4' });

  const r = await api('POST', '/api/reuniones/r-vacio/procesar', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error || '', /vacío|incompleto/i);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-vacio', SK: 'META' });
  assert.equal(meta.pipeline_estado, undefined);
  assert.notEqual(meta.audio_estado, 'presente');
  assert.equal(meta.origen_audio, undefined);
});
