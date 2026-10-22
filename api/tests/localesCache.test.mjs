/**
 * GET /locales cachea el Scan completo de igp_Locales y deriva de él las variantes
 * `minimal` y `grupoParipe`. Toda escritura en el maestro (POST/PUT/DELETE /locales
 * y PATCH /marketing/locales/:id/estilo) debe invalidar esa caché: antes el estilo
 * visual editado desde Marketing no se veía en `?minimal=1` hasta pasados 5 min.
 */

import 'express-async-errors';
import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-cache-locales';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { listarLocalesCacheados } = await import('../lib/locales/cacheLocales.js');
const { default: localesRouter } = await import('../routes/locales.js');
const { default: marketingRouter } = await import('../routes/marketing.js');

const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };

const CENTRO = {
  id_Locales: '000010',
  nombre: 'Bar Centro',
  agoraCode: '7',
  empresa: 'Norte',
  id_empresa: '000003',
  sede: 'Grupo Paripe',
  km_desplazamiento: '12',
  estilo_visual_brief: 'Neón',
  estilo_visual_imagen_keys: ['marketing/estilo-local/a.png'],
  web: 'https://centro.test',
};
const PLAYA = { id_Locales: '000020', nombre: 'Chiringuito Playa', agoraCode: '8', sede: 'Costa' };

let servidor = null;
let base = '';
let arranque = null;

function arrancar() {
  arranque ??= (async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = ADMIN;
      next();
    });
    app.use('/api', localesRouter);
    app.use('/api', marketingRouter);
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  })();
  return arranque;
}

async function api(metodo, ruta, cuerpo) {
  await arrancar();
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' }, [CENTRO, PLAYA]);
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

const escaneos = (db) => db.operaciones.filter((o) => o.tipo === 'ScanCommand' && o.tabla === tables.locales).length;
const porId = (locales) => Object.fromEntries(locales.map((l) => [l.id_Locales, l]));

test('dos GET /locales seguidos (y en paralelo) hacen un solo Scan', async () => {
  const db = montar();
  const [a, b] = await Promise.all([api('GET', '/api/locales'), api('GET', '/api/locales')]);
  const c = await api('GET', '/api/locales');
  assert.equal(escaneos(db), 1);
  for (const r of [a, b, c]) {
    assert.equal(r.status, 200);
    assert.deepEqual(porId(r.body.locales), { '000010': CENTRO, '000020': PLAYA });
  }
});

test('minimal y grupoParipe salen de la misma caché con la forma de siempre', async () => {
  const db = montar();
  const completo = await api('GET', '/api/locales');
  const minimal = await api('GET', '/api/locales?minimal=1');
  const paripe = await api('GET', '/api/locales?grupoParipe=true');
  const ambos = await api('GET', '/api/locales?minimal=1&grupoParipe=1');
  assert.equal(escaneos(db), 1);

  assert.equal(completo.body.locales.length, 2);
  assert.deepEqual(porId(minimal.body.locales), {
    '000010': {
      id_Locales: '000010',
      nombre: 'Bar Centro',
      id_empresa: '000003',
      estilo_visual_brief: 'Neón',
      km_desplazamiento: '12',
    },
    // Como el ProjectionExpression de antes: lo que el local no tiene, no aparece.
    '000020': { id_Locales: '000020', nombre: 'Chiringuito Playa' },
  });
  assert.deepEqual(paripe.body, { locales: [CENTRO] });
  assert.deepEqual(ambos.body, { locales: [CENTRO] });
});

test('mutar lo que devuelve la caché no la altera', async () => {
  montar();
  const copia = await listarLocalesCacheados();
  copia[0].nombre = 'Pisado';
  copia[0].estilo_visual_imagen_keys?.push('x');
  copia.pop();
  const r = await api('GET', '/api/locales');
  assert.deepEqual(porId(r.body.locales), { '000010': CENTRO, '000020': PLAYA });
});

test('POST, PUT y DELETE /locales invalidan: el siguiente GET ve el cambio', async () => {
  montar();
  await api('GET', '/api/locales?minimal=1');

  assert.equal((await api('POST', '/api/locales', { id_Locales: '30', Nombre: 'Terraza' })).status, 200);
  let r = await api('GET', '/api/locales?minimal=1');
  assert.equal(porId(r.body.locales)['000030']?.nombre, 'Terraza');

  assert.equal((await api('PUT', '/api/locales', { id_Locales: '000030', Nombre: 'Terraza 2', Sede: 'Paripe' })).status, 200);
  r = await api('GET', '/api/locales?grupoParipe=1');
  assert.equal(porId(r.body.locales)['000030']?.nombre, 'Terraza 2');

  assert.equal((await api('DELETE', '/api/locales', { id_Locales: '000030' })).status, 200);
  r = await api('GET', '/api/locales');
  assert.equal(porId(r.body.locales)['000030'], undefined);
});

test('editar el estilo desde Marketing invalida el listado minimal', async () => {
  montar();
  const antes = await api('GET', '/api/locales?minimal=1');
  assert.equal(porId(antes.body.locales)['000010'].estilo_visual_brief, 'Neón');

  const patch = await api('PATCH', '/api/marketing/locales/10/estilo', { estilo_visual_brief: 'Madera y verde' });
  assert.equal(patch.status, 200);

  const despues = await api('GET', '/api/locales?minimal=1');
  assert.equal(porId(despues.body.locales)['000010'].estilo_visual_brief, 'Madera y verde');
});

test('un Scan fallido no queda cacheado', async () => {
  const db = montar();
  db.interceptar('ScanCommand', tables.locales, () => {
    throw new Error('DynamoDB caído');
  });
  const fallo = await api('GET', '/api/locales');
  assert.equal(fallo.status, 500);

  const r = await api('GET', '/api/locales');
  assert.equal(r.status, 200);
  assert.equal(r.body.locales.length, 2);
  assert.equal(escaneos(db), 2);
});
