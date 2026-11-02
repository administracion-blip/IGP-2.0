/**
 * El modelo de cada uso sale de Ajustes de IA: guardado, si no la variable
 * de entorno actual, si no la constante. Probar llama al modelo y no guarda.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-ajustes-ia';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const {
  getAjustesIa,
  guardarAjustesIa,
  probarModeloIa,
  AVISO_DICTADO,
  AVISO_OCR,
  AVISO_INFORME,
} = await import('../lib/ia/ajustes.js');
const { transcribirAudio } = await import('../lib/ia/openaiClient.js');
const {
  configurarTranscripcion,
  restablecerTranscripcion,
  transcribir,
} = await import('../lib/inventarios/dictado/transcripcion.js');
const { default: iaRouter } = await import('../routes/ia.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador', Nombre: 'Jefe' };
const CAMARERO = { sub: '000009', email: 'camarero@grupo.test', rol: 'Camarero' };

const CLAVES_ENTORNO = ['IA_INFORMES_MODEL', 'OCR_IA_MODEL', 'IA_INVENTARIO_MODEL', 'OPENAI_TRANSCRIBE_MODEL', 'OPENAI_API_KEY'];
const entornoPrevio = Object.fromEntries(CLAVES_ENTORNO.map((k) => [k, process.env[k]]));

let db = null;
let servidor = null;
let base = '';
let usuario = ADMIN;

function restaurarEntorno() {
  for (const k of CLAVES_ENTORNO) {
    if (entornoPrevio[k] === undefined) delete process.env[k];
    else process.env[k] = entornoPrevio[k];
  }
}

function limpiarEntorno() {
  for (const k of CLAVES_ENTORNO) delete process.env[k];
}

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('sin nada guardado manda la variable de entorno y, si no hay, la constante', async () => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  limpiarEntorno();
  process.env.IA_INFORMES_MODEL = 'gpt-4.1';
  process.env.OCR_IA_MODEL = 'gpt-4o';
  process.env.IA_INVENTARIO_MODEL = 'gpt-4.1-mini';
  process.env.OPENAI_TRANSCRIBE_MODEL = 'whisper-1';
  try {
    const a = await getAjustesIa();
    assert.equal(a.modelo, 'gpt-4.1');
    assert.equal(a.modeloOcr, 'gpt-4o');
    assert.equal(a.modeloLectura, 'gpt-4.1-mini');
    assert.equal(a.modeloTranscripcion, 'whisper-1');
    assert.equal(a.modeloInterpretacion, 'gpt-4o-mini');

    limpiarEntorno();
    const base = await getAjustesIa();
    assert.equal(base.modelo, 'gpt-4o-mini');
    assert.equal(base.modeloOcr, 'gpt-4o-mini');
    assert.equal(base.modeloLectura, 'gpt-4o');
    assert.equal(base.modeloTranscripcion, 'gpt-4o-mini-transcribe');
    assert.equal(base.modeloInterpretacion, 'gpt-4o-mini');
  } finally {
    restaurarEntorno();
  }
});

test('un modelo guardado gana a la variable de entorno y guardar no borra el resto', async () => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  limpiarEntorno();
  process.env.IA_INFORMES_MODEL = 'gpt-4.1';
  process.env.OPENAI_TRANSCRIBE_MODEL = 'whisper-1';
  db.sembrar(tables.ajustes, { PK: 'IA', SK: 'CONFIG', modelo: 'gpt-4o' });
  try {
    const a = await getAjustesIa();
    assert.equal(a.modelo, 'gpt-4o');
    assert.equal(a.modeloTranscripcion, 'whisper-1');

    const guardado = await guardarAjustesIa({ modeloOcr: 'gpt-4.1-mini' }, ADMIN);
    assert.equal(guardado.modelo, 'gpt-4o');
    assert.equal(guardado.modeloTranscripcion, 'whisper-1');
    assert.equal(guardado.modeloOcr, 'gpt-4.1-mini');
    assert.equal(guardado.modeloInterpretacion, 'gpt-4o-mini');
    assert.equal(guardado.modeloLectura, 'gpt-4o');

    delete process.env.OPENAI_TRANSCRIBE_MODEL;
    const otraVez = await getAjustesIa();
    assert.equal(otraVez.modeloTranscripcion, 'whisper-1', 'lo guardado no vuelve a la constante');
  } finally {
    restaurarEntorno();
  }
});

test('un fallo al leer ajustes no se toma por valores por defecto ni se pisa al guardar', async () => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.ajustes, { PK: 'IA', SK: 'CONFIG', modeloTranscripcion: 'whisper-1' });
  const cortar = () => {
    throw new Error('throttle');
  };
  db.interceptar('GetCommand', tables.ajustes, cortar);
  await assert.rejects(getAjustesIa(), (err) => /throttle/.test(String(err.message)));
  db.interceptar('GetCommand', tables.ajustes, cortar);
  await assert.rejects(guardarAjustesIa({ modelo: 'gpt-4o' }, ADMIN));
  const item = db.obtener(tables.ajustes, { PK: 'IA', SK: 'CONFIG' });
  assert.equal(item.modeloTranscripcion, 'whisper-1');
  assert.equal(item.modelo, undefined);
});

test('transcribir usa el modelo guardado', async () => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.ajustes, { PK: 'IA', SK: 'CONFIG', modeloTranscripcion: 'whisper-1' });
  configurarTranscripcion(async (_buffer, opts) => {
    assert.equal(opts.modelo, 'whisper-1');
    return { texto: 'Larios 2' };
  });
  try {
    const texto = await transcribir(
      { buffer: Buffer.from('abc'), mimetype: 'audio/webm', extDetectada: 'webm' },
      { productos: [{ productId: '1', nombre: 'Larios' }] },
    );
    assert.equal(texto, 'Larios 2');
  } finally {
    restablecerTranscripcion();
  }
});

test('probar no guarda: el chat y la transcripción reciben el modelo, y un fallo no es técnico', async () => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  limpiarEntorno();
  const fetchReal = globalThis.fetch;
  const peticiones = [];
  globalThis.fetch = async (url, init) => {
    peticiones.push({ url, init });
    const u = String(url);
    if (u.includes('/audio/')) return new Response(JSON.stringify({ text: '' }), { status: 200 });
    if (peticiones.length === 1) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    return new Response('{"error":"model_not_found"}', { status: 404 });
  };
  process.env.OPENAI_API_KEY = 'sk-solo-pruebas';
  try {
    const chat = await probarModeloIa('informes', 'gpt-4.1');
    assert.deepEqual(chat, { ok: true });
    const cuerpo = JSON.parse(peticiones[0].init.body);
    assert.equal(cuerpo.model, 'gpt-4.1');
    assert.equal(cuerpo.max_tokens, 16);

    const voz = await probarModeloIa('transcripcion', 'gpt-4o-transcribe');
    assert.deepEqual(voz, { ok: true });
    assert.equal(peticiones[1].init.body.get('model'), 'gpt-4o-transcribe');

    const mal = await probarModeloIa('ocr', 'no-existe');
    assert.equal(mal.ok, false);
    assert.equal(mal.aviso, AVISO_OCR);
    assert.equal(JSON.stringify(mal).includes('OpenAI'), false);
    assert.equal(JSON.stringify(mal).includes('404'), false);

    assert.equal(db.obtener(tables.ajustes, { PK: 'IA', SK: 'CONFIG' }), null);

    delete process.env.OPENAI_API_KEY;
    peticiones.length = 0;
    const sinClave = await probarModeloIa('informes', 'gpt-4o-mini');
    assert.equal(sinClave.ok, false);
    assert.equal(sinClave.aviso, AVISO_INFORME);
    assert.equal(peticiones.length, 0);

    await assert.rejects(probarModeloIa('no-existe', 'gpt-4o'), (err) => err.status === 400);
  } finally {
    globalThis.fetch = fetchReal;
    restaurarEntorno();
  }
});

test('un 4xx del transcriptor marca el fallo de modelo', async () => {
  const fetchReal = globalThis.fetch;
  const clave = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-solo-pruebas';
  globalThis.fetch = async () => new Response('{"error":"model"}', { status: 404 });
  try {
    await assert.rejects(transcribirAudio(Buffer.from('abc')), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.modelo, true);
      assert.equal(err.message.includes('404'), false);
      return true;
    });
  } finally {
    globalThis.fetch = fetchReal;
    if (clave === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = clave;
  }
});

test('solo un administrador guarda y prueba; probar no persiste', async () => {
  db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  limpiarEntorno();
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.openai.com')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }
    return fetchReal(url, init);
  };
  process.env.OPENAI_API_KEY = 'sk-solo-pruebas';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = usuario;
    next();
  });
  app.use('/api', iaRouter);
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    usuario = CAMARERO;
    const vedado = await api('PUT', '/api/ia/ajustes', { modelo: 'gpt-4o' });
    assert.equal(vedado.status, 403);
    const vedadoProbar = await api('POST', '/api/ia/ajustes/probar', { uso: 'informes', modelo: 'gpt-4o' });
    assert.equal(vedadoProbar.status, 403);

    usuario = ADMIN;
    const puesto = await api('PUT', '/api/ia/ajustes', { modeloTranscripcion: 'whisper-1' });
    assert.equal(puesto.status, 200);
    assert.equal(puesto.body.ajustes.modeloTranscripcion, 'whisper-1');
    assert.equal(puesto.body.ajustes.modelo, 'gpt-4o-mini');

    const leido = await api('GET', '/api/ia/ajustes');
    assert.equal(leido.body.ajustes.modeloTranscripcion, 'whisper-1');
    assert.ok(leido.body.modelosTranscripcion.includes('gpt-4o-mini-transcribe'));
    assert.equal(leido.body.puedeEditar, true);

    const prueba = await api('POST', '/api/ia/ajustes/probar', { uso: 'interpretacion', modelo: 'gpt-4o' });
    assert.equal(prueba.status, 200);
    assert.equal(prueba.body.ok, true);
    assert.equal(db.obtener(tables.ajustes, { PK: 'IA', SK: 'CONFIG' }).modeloInterpretacion, 'gpt-4o-mini');
    assert.equal(AVISO_DICTADO.includes('cuenta a mano'), true);
  } finally {
    globalThis.fetch = fetchReal;
    restaurarEntorno();
    servidor?.closeAllConnections?.();
    servidor?.close();
  }
});

after(() => {
  restablecerTranscripcion();
  restaurarEntorno();
});
