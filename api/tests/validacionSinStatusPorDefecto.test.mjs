/**
 * S-19: las validaciones de los lib llevan su 400 explícito y los catch ya no
 * convierten cualquier `new Error()` en 400: un fallo interno sale como 500
 * genérico sin su texto.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-validacion';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { default: miaRouter } = await import('../routes/mia.js');
const { default: iaRouter } = await import('../routes/ia.js');
const { default: escandallosRouter } = await import('../routes/escandallos.js');

const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };
const enviarOriginal = docClient.send;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = ADMIN;
  next();
});
app.use('/api', miaRouter);
app.use('/api', iaRouter);
app.use('/api', escandallosRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

async function put(ruta, cuerpo) {
  const res = await fetch(base + ruta, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeEach(() => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.almacenes, { hashKey: 'Id' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaConfigProducto, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.escandallos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  docClient.send = enviarOriginal;
  servidor.closeAllConnections?.();
  servidor.close();
});

test('validaciones de los lib: 400 con su mensaje', async () => {
  const casos = [
    ['/api/mia/config', { warehouseId: '5' }, 'productId es obligatorio'],
    ['/api/mia/grupos-familias', {}, 'nombre es obligatorio'],
    ['/api/ia/grupos-familias', {}, 'nombre es obligatorio'],
    ['/api/escandallos/123', { ingredientes: [{}] }, 'ingredientes[0]: ingredienteId es obligatorio'],
  ];
  for (const [ruta, cuerpo, mensaje] of casos) {
    const r = await put(ruta, cuerpo);
    assert.equal(r.status, 400, `${ruta}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, mensaje, ruta);
  }
});

test('un Error plano del lib (sin status) ya no sale como 400: 500 genérico sin su texto', async () => {
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name === 'PutCommand') throw new Error('fallo interno con detalle');
    return enviar.call(docClient, cmd);
  };
  try {
    for (const [ruta, cuerpo] of [
      ['/api/mia/config', { warehouseId: '5', productId: '7' }],
      ['/api/escandallos/123', { activo: false }],
    ]) {
      const r = await put(ruta, cuerpo);
      assert.equal(r.status, 500, `${ruta}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'No se pudo guardar');
      assert.ok(r.body.errorId);
      assert.doesNotMatch(JSON.stringify(r.body), /fallo interno/);
    }
  } finally {
    docClient.send = enviar;
  }
});
