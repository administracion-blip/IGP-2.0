/**
 * Los endpoints OCR reciben un `fileKey` del cliente y leen ese objeto del
 * bucket compartido. Solo pueden leer lo que el propio OCR subió
 * (`facturas/ocr-temp/`), nunca actas, firmas, extractos bancarios o tareas.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { S3Client } from '@aws-sdk/client-s3';

// El router precarga un worker de Tesseract al importarse; el real deja el proceso vivo.
const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-ocr';

const llamadasS3 = [];
S3Client.prototype.send = async function sendFalso(cmd) {
  llamadasS3.push({ tipo: cmd.constructor.name, key: cmd.input?.Key });
  return { ContentType: 'text/plain', Body: Readable.from([Buffer.from('contenido')]) };
};

const { validarClaveS3 } = await import('../lib/s3/claves.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };

let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo) {
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = ADMIN;
      next();
    });
    app.use('/api', facturacionRouter);
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
  servidor?.closeAllConnections?.();
  servidor?.close();
});

beforeEach(() => {
  llamadasS3.length = 0;
});

const ZONA = { x: 0, y: 0, width: 100, height: 100, pageWidth: 100, pageHeight: 100 };

const CLAVES_AJENAS = [
  'actas/2026/acta-consejo.pdf',
  'firmas/actuaciones/123.png',
  'banca/n43/extracto.n43',
  'tareas/adjuntos/doc.pdf',
  'facturas/abc123/1700000000_factura.pdf',
  'facturas/ocr-temp/../../actas/acta.pdf',
  '/facturas/ocr-temp/x.pdf',
  'facturas/ocr-temp/',
  'facturas//ocr-temp/x.pdf',
  'facturas/ocr-temp\\..\\actas.pdf',
  '',
];

test('extraer-zona rechaza claves fuera de facturas/ocr-temp/ sin tocar S3', async () => {
  for (const fileKey of CLAVES_AJENAS.filter(Boolean)) {
    const r = await api('POST', '/api/facturacion/ocr/extraer-zona', { fileKey, ...ZONA });
    assert.equal(r.status, 400, fileKey);
    assert.match(r.body.error, /fileKey/);
  }
  const noString = await api('POST', '/api/facturacion/ocr/extraer-zona', { fileKey: { $ne: '' }, ...ZONA });
  assert.equal(noString.status, 400);
  assert.equal(llamadasS3.length, 0, 'no debe leerse nada del bucket');
});

test('preview-png rechaza claves fuera de facturas/ocr-temp/ sin tocar S3', async () => {
  for (const fileKey of CLAVES_AJENAS) {
    const r = await api('GET', `/api/facturacion/ocr/preview-png?fileKey=${encodeURIComponent(fileKey)}`);
    assert.equal(r.status, 400, fileKey);
  }
  const r = await api('GET', '/api/facturacion/ocr/preview-png?fileKey=a&fileKey=b');
  assert.equal(r.status, 400, 'un array en la query no es una clave');
  assert.equal(llamadasS3.length, 0);
});

test('extraer-zona y preview-png siguen leyendo claves de facturas/ocr-temp/', async () => {
  const fileKey = 'facturas/ocr-temp/1700000000_abcd1234_factura.pdf';
  const zona = await api('POST', '/api/facturacion/ocr/extraer-zona', { fileKey, ...ZONA });
  // El S3 falso devuelve text/plain: llega a leer el objeto y lo descarta por tipo.
  assert.equal(zona.status, 400);
  assert.match(zona.body.error, /no soportado/);

  const prev = await api('GET', `/api/facturacion/ocr/preview-png?fileKey=${encodeURIComponent(fileKey)}`);
  assert.equal(prev.status, 400);
  assert.match(prev.body.error, /no soportado/);

  assert.deepEqual(llamadasS3, [
    { tipo: 'GetObjectCommand', key: fileKey },
    { tipo: 'GetObjectCommand', key: fileKey },
  ]);
});

test('nombres saneados con puntos intermedios (Fra_12..pdf) siguen siendo claves válidas', async () => {
  const fileKey = 'facturas/ocr-temp/1_ab_Fra_12..pdf';
  assert.deepEqual(validarClaveS3(fileKey, ['facturas/ocr-temp/']), { ok: true, key: fileKey });
  const prev = await api('GET', `/api/facturacion/ocr/preview-png?fileKey=${encodeURIComponent(fileKey)}`);
  assert.match(prev.body.error, /no soportado/, 'llega a leer el objeto');
  assert.deepEqual(llamadasS3, [{ tipo: 'GetObjectCommand', key: fileKey }]);
});

test('ocr/confirmar no acepta como documento una clave de otro módulo', async () => {
  const r = await api('POST', '/api/facturacion/ocr/confirmar', {
    borradores: [{
      sociedad_grupo_id: '000001',
      sociedad_grupo_nombre: 'Central',
      proveedor_cif: 'B12345678',
      fecha_emision: '2026-01-10',
      archivo: { fileKey: 'actas/2026/acta-consejo.pdf', nombre: 'acta.pdf' },
    }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Documento adjunto inválido/);
  assert.equal(llamadasS3.length, 0, 'ni copia ni lectura del objeto ajeno');
});

test('validarClaveS3: matriz de casos', () => {
  const P = ['facturas/ocr-temp/'];
  assert.deepEqual(validarClaveS3('facturas/ocr-temp/1_a_b.pdf', P), { ok: true, key: 'facturas/ocr-temp/1_a_b.pdf' });
  for (const mala of [...CLAVES_AJENAS, null, undefined, 42, ['facturas/ocr-temp/x'], 'facturas/ocr-temp/a\u0000b', 'facturas/ocr-temp/./x', `facturas/ocr-temp/${'a'.repeat(1100)}`]) {
    assert.equal(validarClaveS3(mala, P).ok, false, String(mala));
  }
  for (const mala of ['facturas/ocr-temp/../actas/x.pdf', 'facturas/ocr-temp/a/../../x', 'facturas/ocr-temp/..']) {
    assert.equal(validarClaveS3(mala, P).ok, false, mala);
  }
  assert.equal(validarClaveS3('facturas/ocr-temp/x.pdf', []).ok, false, 'sin prefijos no se permite nada');
  assert.equal(validarClaveS3('facturas/ocr-temp-otro/x.pdf', ['facturas/ocr-temp']).ok, false, 'un prefijo sin barra final no vale');
});
