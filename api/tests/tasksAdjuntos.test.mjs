/**
 * Adjuntos de tarea por URL prefirmada (Fase 1A).
 *
 * Lo que se fija aquí:
 *
 * - **La clave de S3 la construye el servidor.** Un nombre con `../` no puede
 *   colocar el objeto fuera del prefijo de la tarea.
 * - **`confirmar` no se fía del cliente.** Si el objeto no está en el bucket no
 *   se guarda la fila, y el tamaño y el tipo se toman de S3.
 * - **Una clave de otra tarea no se confirma**: si se admitiera, cualquiera
 *   registraría como suyo el adjunto de una tarea que no ve y se lo descargaría
 *   con la URL firmada de lectura.
 * - **Lo que no se ve responde `404`**, no `403`.
 *
 * S3 está inyectado: aquí no se sube nada a ningún sitio.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-adjuntos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { PK, SK } = await import('../lib/tasks/tipos.js');
const {
  MAX_BYTES_ADJUNTO,
  configurarAlmacenAdjuntos,
  idAdjuntoDeClave,
  validarAdjunto,
} = await import('../lib/tasks/adjuntos.js');
const { default: tareasRouter } = await import('../routes/tareas.js');

// ─── Personas ───

const ANA = { sub: '000001', email: 'ana@grupo.test', rol: 'Direccion' };
/** Sin permisos del módulo: no ve la tarea de Ana. */
const CARLOS = { sub: '000003', email: 'carlos@grupo.test', rol: 'Camarero' };

const PERMISOS_POR_ROL = {
  Direccion: ['proyectos.ver', 'proyectos.editar', 'proyectos.borrar'],
  Camarero: ['proyectos.ver'],
};

const TAREA = 't-obra';
/** Tarea de Carlos: sirve para probar que no se cruzan las claves de S3. */
const OTRA_TAREA = 't-ajena';

// ─── Servidor ───

let usuarioActual = ANA;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = ANA) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      next();
    });
    app.use('/api', tareasRouter);
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

let restaurarAlmacen = null;

after(() => {
  restaurarAlmacen?.();
  servidor?.closeAllConnections?.();
  servidor?.close();
});

// ─── Mundo de pruebas ───

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Responsable-Vencimiento-index': { hashKey: 'responsable_id', rangeKey: 'vencimiento_orden' },
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'sk_proyecto' },
      'Padre-index': { hashKey: 'tarea_padre_id', rangeKey: 'creado_en' },
      'Reunion-index': { hashKey: 'reunion_origen_id', rangeKey: 'creado_en' },
    },
  });
  db.crearTabla(tables.proyectos, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'Miembro-index': { hashKey: 'usuario_id', rangeKey: 'PK', proyeccion: 'KEYS_ONLY' } },
  });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  invalidarContextoAcceso();

  for (const persona of [ANA, CARLOS]) {
    db.sembrar(tables.usuarios, {
      id_usuario: persona.sub,
      Email: persona.email,
      Nombre: persona.email,
      Rol: persona.rol,
    });
  }
  for (const [rol, codigos] of Object.entries(PERMISOS_POR_ROL)) {
    for (const codigo of codigos) {
      db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${codigo}` });
    }
  }

  sembrarTarea(db, TAREA, ANA.sub);
  sembrarTarea(db, OTRA_TAREA, CARLOS.sub);

  /** Bucket de mentira: clave → metadatos del objeto. */
  const bucket = new Map();
  const espia = { firmadasSubida: [], firmadasLectura: [], borrados: [] };

  restaurarAlmacen?.();
  restaurarAlmacen = configurarAlmacenAdjuntos({
    urlSubida: async ({ key, contentType }) => {
      espia.firmadasSubida.push({ key, contentType });
      return `https://bucket.test/${key}?firma=subida`;
    },
    urlLectura: async ({ key }) => {
      espia.firmadasLectura.push(key);
      return `https://bucket.test/${key}?firma=lectura`;
    },
    cabecera: async ({ key }) => bucket.get(key) || null,
    borrar: async ({ key }) => {
      espia.borrados.push(key);
      bucket.delete(key);
    },
  });

  return { db, bucket, espia };
}

function sembrarTarea(db, id, responsable) {
  db.sembrar(tables.tareas, {
    PK: PK.tarea(id),
    SK: SK.meta,
    id_tarea: id,
    titulo: `Tarea ${id}`,
    estado: 'pendiente',
    prioridad: 'media',
    responsable_id: responsable,
    creado_por: responsable,
    creado_en: '2026-08-01T10:00:00.000Z',
    actualizado_en: '2026-08-01T10:00:00.000Z',
    vencimiento_orden: `9999-12-31#${id}`,
  });
}

function adjuntosDe(db, idTarea = TAREA) {
  return db
    .listar(tables.tareas)
    .filter((it) => it.PK === PK.tarea(idTarea) && String(it.SK).startsWith('ADJUNTO#'));
}

async function presign(cuerpo, usuario = ANA) {
  return api(
    'POST',
    `/api/tareas/${TAREA}/adjuntos/presign`,
    { nombre: 'presupuesto.pdf', content_type: 'application/pdf', tamano: 1024, ...cuerpo },
    usuario,
  );
}

/** Simula que el navegador completó el PUT contra la URL prefirmada. */
function subir(bucket, key, { tamano = 1024, contentType = 'application/pdf' } = {}) {
  bucket.set(key, { tamano, contentType });
}

// ─── Nombres y claves ───

test('un nombre con ../ no acaba en la clave de S3', async () => {
  const { espia } = montar();

  const r = await presign({ nombre: '../../etc/passwd.pdf' });
  assert.equal(r.status, 200);

  const clave = r.body.adjunto.s3_key;
  assert.ok(!clave.includes('..'), `la clave conserva el salto de directorio: ${clave}`);
  assert.equal(clave.startsWith(`tasks/tareas/${TAREA}/adjuntos/`), true);
  assert.equal(clave.endsWith('-passwd.pdf'), true);
  assert.equal(clave.split('/').length, 5, 'ni una barra de más: nada de subcarpetas inventadas');
  assert.equal(espia.firmadasSubida[0].contentType, 'application/pdf');
});

test('idAdjuntoDeClave solo reconoce claves de la propia tarea', () => {
  const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  assert.equal(idAdjuntoDeClave(TAREA, `tasks/tareas/${TAREA}/adjuntos/${id}-nota.pdf`), id);
  assert.equal(idAdjuntoDeClave(TAREA, `tasks/tareas/${OTRA_TAREA}/adjuntos/${id}-nota.pdf`), '');
  assert.equal(idAdjuntoDeClave(TAREA, `tasks/tareas/${TAREA}/adjuntos/${id}-sub/nota.pdf`), '');
  assert.equal(idAdjuntoDeClave(TAREA, `tasks/tareas/${TAREA}/adjuntos/no-es-uuid-nota.pdf`), '');
  assert.equal(idAdjuntoDeClave(TAREA, `tasks/reuniones/${TAREA}/audio.m4a`), '');
});

// ─── Validación ───

test('la extensión tiene que corresponder al tipo declarado', () => {
  assert.equal(validarAdjunto({ nombre: 'a.pdf', contentType: 'application/pdf', tamano: 10 }).ok, true);
  assert.equal(validarAdjunto({ nombre: 'a.jpeg', contentType: 'image/jpeg', tamano: 10 }).ok, true);

  const cruzado = validarAdjunto({ nombre: 'a.html', contentType: 'application/pdf', tamano: 10 });
  assert.equal(cruzado.ok, false);
  assert.match(cruzado.error, /extensión/);
});

test('un tipo fuera de la lista y un tamaño imposible se rechazan con 400', async () => {
  montar();

  const tipo = await presign({ nombre: 'malicioso.svg', content_type: 'image/svg+xml' });
  assert.equal(tipo.status, 400);
  assert.match(tipo.body.error, /no permitido/);

  const sinTamano = await presign({ tamano: 0 });
  assert.equal(sinTamano.status, 400);

  const enorme = await presign({ tamano: MAX_BYTES_ADJUNTO + 1 });
  assert.equal(enorme.status, 400);
  assert.match(enorme.body.error, /MB/);
});

test('el presign no escribe nada: hasta que no se confirma, el adjunto no existe', async () => {
  const { db } = montar();
  const r = await presign();

  assert.equal(r.status, 200);
  assert.ok(r.body.adjunto.upload_url.includes('firma=subida'));
  assert.deepEqual(adjuntosDe(db), [], 'una subida abandonada no debe dejar fila apuntando a nada');
});

// ─── Confirmación ───

test('un adjunto no se confirma si el objeto no está en S3', async () => {
  const { db } = montar();
  const firmado = await presign();

  const r = await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, {
    s3_key: firmado.body.adjunto.s3_key,
    nombre: 'presupuesto.pdf',
  });

  assert.equal(r.status, 409);
  assert.match(r.body.error, /no se ha subido/);
  assert.deepEqual(adjuntosDe(db), [], 'sin fichero no hay fila: si no, el listado enseña ficheros que no están');
});

test('confirmar guarda el tamaño y el tipo que dice S3, no los que declara el cliente', async () => {
  const { db, bucket } = montar();
  const firmado = await presign({ tamano: 10 });
  subir(bucket, firmado.body.adjunto.s3_key, { tamano: 54321, contentType: 'application/pdf' });

  const r = await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, {
    s3_key: firmado.body.adjunto.s3_key,
    nombre: 'presupuesto.pdf',
    tamano: 10,
    content_type: 'text/html',
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.adjunto.tamano, 54321);
  assert.equal(r.body.adjunto.content_type, 'application/pdf');
  assert.equal(r.body.adjunto.subido_por, ANA.sub);

  const [guardado] = adjuntosDe(db);
  assert.equal(guardado.id_adjunto, firmado.body.adjunto.id_adjunto);
  assert.equal(guardado.s3_key, firmado.body.adjunto.s3_key);
  assert.equal(guardado.nombre, 'presupuesto.pdf');
});

test('una clave de otra tarea no se confirma', async () => {
  const { db, bucket } = montar();
  const ajena = `tasks/tareas/${OTRA_TAREA}/adjuntos/f47ac10b-58cc-4372-a567-0e02b2c3d479-nomina.pdf`;
  subir(bucket, ajena);

  const r = await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, { s3_key: ajena, nombre: 'nomina.pdf' });

  assert.equal(r.status, 400);
  assert.match(r.body.error, /no corresponde a esta tarea/);
  assert.deepEqual(adjuntosDe(db), []);
});

test('una clave con salto de directorio no se confirma', async () => {
  const { db } = montar();

  const r = await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, {
    s3_key: `tasks/tareas/${TAREA}/adjuntos/../../reuniones/secreta/audio.m4a`,
  });

  assert.equal(r.status, 400);
  assert.deepEqual(adjuntosDe(db), []);
});

test('un objeto que llega al bucket por encima del máximo se rechaza y se borra', async () => {
  const { db, espia, bucket } = montar();
  const firmado = await presign({ tamano: 1024 });
  subir(bucket, firmado.body.adjunto.s3_key, { tamano: MAX_BYTES_ADJUNTO + 1 });

  const r = await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, {
    s3_key: firmado.body.adjunto.s3_key,
  });

  assert.equal(r.status, 400);
  assert.deepEqual(adjuntosDe(db), []);
  assert.deepEqual(espia.borrados, [firmado.body.adjunto.s3_key]);
});

// ─── Lectura y borrado ───

test('la URL de lectura se firma para una hora y aparece en el detalle de la tarea', async () => {
  const { bucket, espia } = montar();
  const firmado = await presign();
  subir(bucket, firmado.body.adjunto.s3_key);
  await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, { s3_key: firmado.body.adjunto.s3_key });

  const r = await api('GET', `/api/tareas/${TAREA}/adjuntos/${firmado.body.adjunto.id_adjunto}/url`);
  assert.equal(r.status, 200);
  assert.equal(r.body.expira_en_seg, 3600);
  assert.ok(r.body.url.includes('firma=lectura'));
  assert.deepEqual(espia.firmadasLectura, [firmado.body.adjunto.s3_key]);

  const detalle = await api('GET', `/api/tareas/${TAREA}`);
  assert.equal(detalle.body.tarea.adjuntos.length, 1);
  assert.equal(detalle.body.tarea.adjuntos[0].id_adjunto, firmado.body.adjunto.id_adjunto);
});

test('pedir la URL de un adjunto que no existe responde 404', async () => {
  montar();
  const r = await api('GET', `/api/tareas/${TAREA}/adjuntos/no-existe/url`);
  assert.equal(r.status, 404);
});

test('borrar el adjunto quita la fila y el objeto de S3', async () => {
  const { db, bucket, espia } = montar();
  const firmado = await presign();
  subir(bucket, firmado.body.adjunto.s3_key);
  await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, { s3_key: firmado.body.adjunto.s3_key });

  const r = await api('DELETE', `/api/tareas/${TAREA}/adjuntos/${firmado.body.adjunto.id_adjunto}`);
  assert.equal(r.status, 200);
  assert.deepEqual(adjuntosDe(db), []);
  assert.deepEqual(espia.borrados, [firmado.body.adjunto.s3_key]);

  const acciones = db
    .listar(tables.actividad)
    .filter((a) => a.PK === `TAREA#${TAREA}`)
    .map((a) => a.accion)
    .sort();
  assert.deepEqual(acciones, ['adjunto_anadido', 'adjunto_borrado']);
});

// ─── Acceso ───

test('quien no ve la tarea recibe 404 en presign, confirmar, url y borrado', async () => {
  const { db, bucket } = montar();
  const firmado = await presign();
  subir(bucket, firmado.body.adjunto.s3_key);
  await api('POST', `/api/tareas/${TAREA}/adjuntos/confirmar`, { s3_key: firmado.body.adjunto.s3_key });

  const firmar = await presign({}, CARLOS);
  assert.equal(firmar.status, 404, 'un 403 confirmaría que la tarea existe');

  const confirmar = await api(
    'POST',
    `/api/tareas/${TAREA}/adjuntos/confirmar`,
    { s3_key: firmado.body.adjunto.s3_key },
    CARLOS,
  );
  assert.equal(confirmar.status, 404);

  const url = await api('GET', `/api/tareas/${TAREA}/adjuntos/${firmado.body.adjunto.id_adjunto}/url`, undefined, CARLOS);
  assert.equal(url.status, 404);

  const borrado = await api(
    'DELETE',
    `/api/tareas/${TAREA}/adjuntos/${firmado.body.adjunto.id_adjunto}`,
    undefined,
    CARLOS,
  );
  assert.equal(borrado.status, 404);
  assert.equal(adjuntosDe(db).length, 1, 'nada de lo anterior puede haber tocado el adjunto');
});
