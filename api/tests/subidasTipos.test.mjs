/**
 * S-20: las subidas se aceptan por el contenido real, no por el mimetype ni la
 * extensión que manda el cliente. Ataques: HTML con nombre .png y mimetype image/png,
 * SVG con script y data URLs falsas en Mystery Guest / mantenimiento.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-subidas';
if (!process.env.AWS_ACCESS_KEY_ID) {
  process.env.AWS_ACCESS_KEY_ID = 'clave-de-prueba';
  process.env.AWS_SECRET_ACCESS_KEY = 'secreto-de-prueba';
}

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const subidas = await import('../lib/seguridad/subidas.js');
const { mgTodosLosIdsPregunta } = await import('../lib/mysteryGuestCuestionario.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { default: escandallosRouter } = await import('../routes/escandallos.js');
const { default: mysteryRouter } = await import('../routes/mysteryGuest.js');

const { detectarTipo, comprobarArchivo, imagenDataUrlSegura, multerPerfil, validarSubidas } = subidas;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(12)]);
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
const HTML = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('[Content_Types].xml'), Buffer.from('xl/workbook.xml')]);

const ADMIN = { sub: '000001', email: 'admin@grupo.test', rol: 'Administrador' };

let servidor = null;
let base = '';
let db = null;

async function arrancar() {
  if (servidor) return;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => {
    req.user = ADMIN;
    req.log = { info() {}, warn() {}, error() {} };
    next();
  });
  const upload = multerPerfil('documento');
  app.post('/x/documento', upload.single('file'), validarSubidas('documento'), (req, res) => {
    res.json({ tipo: req.file.mimetype, ext: req.file.extDetectada });
  });
  app.post('/x/varios', multerPerfil('imagen').array('file', 5), validarSubidas('imagen'), (_req, res) => res.json({ ok: true }));
  app.use('/api', escandallosRouter);
  app.use('/api', mysteryRouter);
  app.use(errorHandler);
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function subir(ruta, partes, campo = 'file') {
  await arrancar();
  const form = new FormData();
  for (const { buffer, nombre, tipo } of partes) form.append(campo, new Blob([buffer], { type: tipo }), nombre);
  const res = await fetch(base + ruta, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function montar() {
  db = crearDynamoMemoria();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.escandallos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.mysteryGuest, { hashKey: process.env.DDB_MISTERY_GUEST_PK || 'ud_mysteryguest' });
  db.instalar(docClient);
  db.sembrar(tables.usuarios, { id_usuario: '000001', Email: ADMIN.email, Rol: 'Administrador', Local: [] });
  db.sembrar(tables.locales, { id_Locales: '000010', nombre: 'NORTE' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
}

// ─── Detección por contenido ───

test('detectarTipo: por bytes, no por nombre', () => {
  assert.equal(detectarTipo(PNG, 'x.jpg'), 'image/png');
  assert.equal(detectarTipo(JPEG), 'image/jpeg');
  assert.equal(detectarTipo(HEIC, 'IMG_0001.HEIC'), 'image/heic');
  assert.equal(detectarTipo(PDF), 'application/pdf');
  assert.equal(detectarTipo(XLSX, 'x.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(detectarTipo(HTML, 'foto.png'), null);
  assert.equal(detectarTipo(SVG, 'logo.svg'), null);
  assert.equal(detectarTipo(Buffer.from('<html><body>a;b</body></html>'), 'datos.csv'), null);
  assert.equal(detectarTipo(Buffer.from('fecha;importe\n2026-10-01;10\n'), 'datos.csv'), 'text/csv');
});

test('comprobarArchivo: fija mimetype y extensión desde el contenido', () => {
  const f = { buffer: PNG, originalname: 'firma.exe', mimetype: 'text/html' };
  assert.equal(comprobarArchivo(f, 'firma'), 'image/png');
  assert.equal(f.mimetype, 'image/png');
  assert.equal(f.extDetectada, 'png');
  assert.throws(() => comprobarArchivo({ buffer: JPEG }, 'firma'), /Tipo de archivo no permitido/);
  assert.throws(() => comprobarArchivo({ buffer: PDF }, 'imagen'), /Tipo de archivo no permitido/);
  assert.throws(() => comprobarArchivo({ buffer: Buffer.alloc(9 * 1024 * 1024, 0x89) }, 'firma'), /tamaño máximo/);
});

// ─── Middleware ───

test('subida: un .png que en realidad es HTML → 400', async () => {
  const r = await subir('/x/documento', [{ buffer: HTML, nombre: 'factura.png', tipo: 'image/png' }]);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Tipo de archivo no permitido');
});

test('subida: SVG → 400 (aunque se declare image/svg+xml o image/png)', async () => {
  for (const tipo of ['image/svg+xml', 'image/png']) {
    const r = await subir('/x/documento', [{ buffer: SVG, nombre: 'logo.svg', tipo }]);
    assert.equal(r.status, 400, tipo);
    assert.equal(r.body.error, 'Tipo de archivo no permitido');
  }
});

test('subida: PNG real y PDF pasan con el tipo detectado, aunque el cliente mienta', async () => {
  const png = await subir('/x/documento', [{ buffer: PNG, nombre: 'foto.html', tipo: 'text/html' }]);
  assert.equal(png.status, 200);
  assert.deepEqual(png.body, { tipo: 'image/png', ext: 'png' });
  const pdf = await subir('/x/documento', [{ buffer: PDF, nombre: 'f.pdf', tipo: 'application/pdf' }]);
  assert.deepEqual(pdf.body, { tipo: 'application/pdf', ext: 'pdf' });
});

test('subida: más ficheros que el perfil → 400 en español', async () => {
  const r = await subir('/x/varios', [1, 2].map(() => ({ buffer: PNG, nombre: 'a.png', tipo: 'image/png' })));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /archivos/);
});

// ─── Rutas reales ───

test('escandallos: foto HTML con mimetype image/png → 400 y no se sube nada', async () => {
  montar();
  db.interceptar('PutCommand', tables.escandallos, () => { throw new Error('no debería escribir'); });
  const r = await subir('/api/escandallos/000123/imagen', [{ buffer: HTML, nombre: 'plato.png', tipo: 'image/png' }]);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Tipo de archivo no permitido');
});

test('mystery guest: data URL "image/png" con HTML dentro → 400; una imagen real se guarda con su tipo', async () => {
  montar();
  const respuestas = Object.fromEntries(mgTodosLosIdsPregunta().map((id) => [id, 4]));
  const visita = (fotos) => ({
    Fecha: '2026-10-05', LocalId: '000010', Respuestas: respuestas, ProductoFotos: fotos,
  });
  await arrancar();
  const enviar = (body) => fetch(`${base}/api/mystery-guest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

  const falsa = await enviar(visita([`data:image/png;base64,${HTML.toString('base64')}`]));
  assert.equal(falsa.status, 400);
  const svg = await enviar(visita([`data:image/svg+xml;base64,${SVG.toString('base64')}`]));
  assert.equal(svg.status, 400);
  assert.equal(svg.body.error, 'Tipo de archivo no permitido');
  assert.equal(db.listar(tables.mysteryGuest).length, 0);

  const buena = await enviar(visita([`data:image/jpeg;base64,${PNG.toString('base64')}`]));
  assert.ok(buena.status < 300, JSON.stringify(buena.body));
  const [guardada] = db.listar(tables.mysteryGuest);
  assert.deepEqual(guardada.ProductoFotos, [`data:image/png;base64,${PNG.toString('base64')}`]);
});

test('imagenDataUrlSegura: normaliza al tipo real y rechaza lo que no es imagen', () => {
  assert.equal(imagenDataUrlSegura(`data:image/jpeg;base64,${PNG.toString('base64')}`), `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(imagenDataUrlSegura(`data:image/png;base64,${HTML.toString('base64')}`), null);
  assert.equal(imagenDataUrlSegura(`data:application/pdf;base64,${PDF.toString('base64')}`), null);
  assert.equal(imagenDataUrlSegura('javascript:alert(1)'), null);
});
