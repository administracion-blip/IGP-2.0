import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  detectMimeFromMagic,
  sanitizeUploadFileName,
  assertBufferMimeAllowed,
  stripHttpPreambleIfPdf,
  normalizeUploadBuffer,
  ALLOWED_FACTURA_MIMES,
} from '../lib/uploadAllowlist.js';

test('detectMimeFromMagic reconoce PDF / JPEG / PNG / GIF / WEBP', () => {
  assert.equal(detectMimeFromMagic(Buffer.from('%PDF-1.4')), 'application/pdf');
  assert.equal(detectMimeFromMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectMimeFromMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(detectMimeFromMagic(Buffer.from('GIF89a....')), 'image/gif');
  const webp = Buffer.alloc(12);
  webp.write('RIFF', 0);
  webp.writeUInt32LE(4, 4);
  webp.write('WEBP', 8);
  assert.equal(detectMimeFromMagic(webp), 'image/webp');
  assert.equal(detectMimeFromMagic(Buffer.from('not-a-file')), null);
});

test('sanitizeUploadFileName elimina path traversal y chars raros', () => {
  assert.equal(sanitizeUploadFileName('../../etc/passwd.pdf'), 'passwd.pdf');
  assert.equal(sanitizeUploadFileName('factura factura!.pdf'), 'factura_factura_.pdf');
  assert.ok(!sanitizeUploadFileName('a/b\\c.png').includes('/'));
  assert.ok(!sanitizeUploadFileName('a/b\\c.png').includes('\\'));
});

test('assertBufferMimeAllowed acepta jpeg declarado como image/jpg', () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.equal(assertBufferMimeAllowed(buf, 'image/jpg'), 'image/jpeg');
  assert.equal(assertBufferMimeAllowed(buf, 'image/jpeg'), 'image/jpeg');
});

test('assertBufferMimeAllowed rechaza MIME/magic incongruentes', () => {
  const pdf = Buffer.from('%PDF-1.7');
  assert.throws(
    () => assertBufferMimeAllowed(pdf, 'image/png'),
    (err) => err.status === 400,
  );
  assert.throws(
    () => assertBufferMimeAllowed(Buffer.from('MZ'), 'application/pdf'),
    (err) => err.status === 400,
  );
  assert.ok(ALLOWED_FACTURA_MIMES.has('application/pdf'));
});

test('stripHttpPreambleIfPdf deja PDF limpio intacto', () => {
  const clean = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  const out = stripHttpPreambleIfPdf(clean);
  assert.ok(out.equals(clean));
  assert.equal(normalizeUploadBuffer(clean).toString('latin1').slice(0, 4), '%PDF');
});

test('stripHttpPreambleIfPdf recorta preámbulo HTTP ante %PDF', () => {
  const wrapped = Buffer.from(
    'HTTP/1.0 200 OK\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\ntrailer\n',
  );
  const stripped = stripHttpPreambleIfPdf(wrapped);
  assert.equal(stripped.toString('latin1').slice(0, 8), '%PDF-1.7');
  assert.equal(assertBufferMimeAllowed(stripped, 'application/pdf'), 'application/pdf');
});

test('stripHttpPreambleIfPdf no altera JPEG sin HTTP', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const out = stripHttpPreambleIfPdf(jpeg);
  assert.ok(out.equals(jpeg));
});

test('stripHttpPreambleIfPdf no inventa PDF si HTTP sin %PDF en 8KB', () => {
  const httpOnly = Buffer.from('HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nhello world');
  const out = stripHttpPreambleIfPdf(httpOnly);
  assert.ok(out.equals(httpOnly));
});
