/**
 * Fase 4 — descarga de acta PDF.
 *
 * - Sin resumen usable → 409.
 * - Reunión no visible → 404 (D-16).
 * - Con resumen → 200, magic `%PDF`, Content-Disposition y PutObject AES256.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-acta-pdf';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const {
  configurarAlmacenActaPdf,
  parametrosSubidaActaPdf,
  partirResumen,
} = await import('../lib/tasks/reuniones/pdfActa.js');
const { default: reunionesRouter } = await import('../routes/reuniones.js');

const ANA = { sub: '000007', email: 'ana@grupo.test', rol: 'Gestora reuniones' };
const CARLOS = { sub: '000009', email: 'carlos@grupo.test', rol: 'Camarero' };

const PERMISOS_POR_ROL = {
  'Gestora reuniones': [
    'reuniones.ver',
    'reuniones.gestionar',
    'reuniones.ver_direccion',
    'proyectos.editar',
  ],
  Camarero: ['reuniones.ver'],
};

let usuarioActual = ANA;
let servidor = null;
let base = '';
let restaurarAlmacen = null;

async function apiBinario(metodo, ruta, usuario = ANA) {
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
  const res = await fetch(base + ruta, { method: metodo });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/pdf')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      contentType,
      disposition: res.headers.get('content-disposition') || '',
      buffer: buf,
      body: null,
    };
  }
  return {
    status: res.status,
    contentType,
    disposition: res.headers.get('content-disposition') || '',
    buffer: null,
    body: await res.json().catch(() => ({})),
  };
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
  db.sembrar(tables.usuarios, {
    id_usuario: CARLOS.sub,
    Email: CARLOS.email,
    Rol: CARLOS.rol,
    Nombre: 'Carlos',
    Departamentos: [],
  });
  for (const codigo of PERMISOS_POR_ROL['Gestora reuniones']) {
    db.sembrar(tables.rolesPermisos, { PK: `ROL#${ANA.rol}`, SK: `PERMISO#${codigo}` });
  }
  for (const codigo of PERMISOS_POR_ROL.Camarero) {
    db.sembrar(tables.rolesPermisos, { PK: `ROL#${CARLOS.rol}`, SK: `PERMISO#${codigo}` });
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
  const espia = { puts: [] };

  restaurarAlmacen?.();
  restaurarAlmacen = configurarAlmacenActaPdf({
    putPdf: async ({ key, cuerpo }) => {
      espia.puts.push({ key, tamano: cuerpo?.length || 0, cuerpo });
      bucket.set(key, cuerpo);
    },
  });

  return { db, bucket, espia };
}

function sembrarReunion(db, { id, extras = {}, acuerdos = [] } = {}) {
  db.sembrar(tables.reuniones, {
    PK: `REU#${id}`,
    SK: 'META',
    id_reunion: id,
    titulo: 'Comité marketing',
    fecha: '2026-08-28',
    hora_inicio: '10:00',
    hora_fin: '11:00',
    estado: 'acta_borrador',
    visibilidad: 'departamento',
    departamento_id: 'dep-mkt',
    orden_del_dia: '1. Presupuesto',
    convocada_por: ANA.sub,
    gsi_listado: 'REU',
    creado_en: '2026-08-28T08:00:00.000Z',
    actualizado_en: '2026-08-28T08:00:00.000Z',
    ...extras,
  });
  for (const ac of acuerdos) {
    db.sembrar(tables.reuniones, {
      PK: `REU#${id}`,
      SK: `ACUERDO#${ac.id_acuerdo}`,
      id_acuerdo: ac.id_acuerdo,
      texto: ac.texto,
      responsable_id: ac.responsable_id || ANA.sub,
      fecha_limite: ac.fecha_limite || '2026-09-15',
      estado: ac.estado || 'abierto',
    });
  }
}

test('partirResumen detecta puntos numerados', () => {
  const r = partirResumen('1. Presupuesto\nDetalle A\n2. Personal\nDetalle B');
  assert.equal(r.numerado, true);
  assert.equal(r.bloques.length, 2);
  assert.match(r.bloques[0], /^1\./);
  assert.match(r.bloques[1], /^2\./);
});

test('PutObject del acta lleva AES256 explícito', () => {
  const p = parametrosSubidaActaPdf({ key: 'tasks/reuniones/x/acta.pdf', cuerpo: Buffer.from('%PDF') });
  assert.equal(p.ServerSideEncryption, 'AES256');
  assert.equal(p.ContentType, 'application/pdf');
});

test('sin resumen usable responde 409', async () => {
  const { db, espia } = montar();
  sembrarReunion(db, { id: 'r-sin-acta', extras: { resumen: '   ' } });

  const r = await apiBinario('GET', '/api/reuniones/r-sin-acta/acta.pdf');
  assert.equal(r.status, 409);
  assert.match(r.body?.error || '', /aún no hay acta/i);
  assert.equal(espia.puts.length, 0);
});

test('reunión no visible responde 404', async () => {
  const { db, espia } = montar();
  sembrarReunion(db, {
    id: 'r-oculta',
    extras: {
      visibilidad: 'direccion',
      departamento_id: undefined,
      resumen: '1. Tema secreto',
    },
  });
  // Quitar departamento_id sembrado por defecto
  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-oculta', SK: 'META' });
  delete meta.departamento_id;
  meta.visibilidad = 'direccion';
  db.sembrar(tables.reuniones, meta);

  const r = await apiBinario('GET', '/api/reuniones/r-oculta/acta.pdf', CARLOS);
  assert.equal(r.status, 404);
  assert.ok(r.body?.error);
  assert.equal(espia.puts.length, 0);
});

test('con resumen descarga PDF (%PDF) y guarda clave S3', async () => {
  const { db, espia, bucket } = montar();
  sembrarReunion(db, {
    id: 'r-ok',
    extras: {
      resumen: '1. Presupuesto\nSe revisó el techo.\n2. Personal\nSe acordó cubrir turnos.',
      estado: 'acta_borrador',
    },
    acuerdos: [
      {
        id_acuerdo: 'a1',
        texto: 'Cubrir turnos del fin de semana',
        fecha_limite: '2026-09-01',
        estado: 'abierto',
      },
    ],
  });

  const r = await apiBinario('GET', '/api/reuniones/r-ok/acta.pdf');
  assert.equal(r.status, 200);
  assert.match(r.contentType, /application\/pdf/i);
  assert.match(r.disposition, /attachment/i);
  assert.match(r.disposition, /acta-.*\.pdf/i);
  assert.ok(r.buffer);
  assert.equal(r.buffer.subarray(0, 4).toString('utf8'), '%PDF');

  assert.equal(espia.puts.length, 1);
  assert.equal(espia.puts[0].key, 'tasks/reuniones/r-ok/acta.pdf');
  assert.ok(bucket.has('tasks/reuniones/r-ok/acta.pdf'));

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-ok', SK: 'META' });
  assert.equal(meta.acta_pdf_s3_key, 'tasks/reuniones/r-ok/acta.pdf');
});

test('si la reunión desaparece al persistir la clave, igual sirve el PDF', async () => {
  const { db, espia } = montar();
  sembrarReunion(db, {
    id: 'r-carrera',
    extras: { resumen: '1. Tema único', estado: 'acta_validada' },
  });

  db.interceptar('UpdateCommand', tables.reuniones, async () => {
    await docClient.send(
      new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
        TableName: tables.reuniones,
        Key: { PK: 'REU#r-carrera', SK: 'META' },
      }),
    );
  });

  const r = await apiBinario('GET', '/api/reuniones/r-carrera/acta.pdf');
  assert.equal(r.status, 200);
  assert.equal(r.buffer.subarray(0, 4).toString('utf8'), '%PDF');
  assert.equal(espia.puts.length, 1);
  assert.equal(db.obtener(tables.reuniones, { PK: 'REU#r-carrera', SK: 'META' }), null);
});

test('cada GET regenera y sobrescribe el PDF en S3', async () => {
  const { db, espia } = montar();
  sembrarReunion(db, {
    id: 'r-regen',
    extras: { resumen: '1. Primer borrador', estado: 'acta_validada' },
  });

  const a = await apiBinario('GET', '/api/reuniones/r-regen/acta.pdf');
  assert.equal(a.status, 200);

  db.sembrar(tables.reuniones, {
    ...db.obtener(tables.reuniones, { PK: 'REU#r-regen', SK: 'META' }),
    resumen: '1. Resumen actualizado tras validar',
  });

  const b = await apiBinario('GET', '/api/reuniones/r-regen/acta.pdf');
  assert.equal(b.status, 200);
  assert.equal(espia.puts.length, 2);
  assert.equal(espia.puts[1].key, 'tasks/reuniones/r-regen/acta.pdf');
});
