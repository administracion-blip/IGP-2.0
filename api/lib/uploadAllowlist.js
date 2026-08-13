import path from 'path';

/** MIME permitidos para facturas, adjuntos, OCR y recibos de pago. */
export const ALLOWED_FACTURA_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/**
 * Detecta MIME real a partir de magic bytes.
 * @param {Buffer|Uint8Array|null|undefined} buffer
 * @returns {string|null} MIME canónico o null si no se reconoce
 */
export function detectMimeFromMagic(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // PDF: %PDF
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return 'application/pdf';
  }

  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47
  if (
    b.length >= 4 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  ) {
    return 'image/png';
  }

  // GIF: GIF8
  if (
    b.length >= 4 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38
  ) {
    return 'image/gif';
  }

  // WEBP: RIFF....WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Sanitiza nombre de fichero para uso en claves S3 / metadatos.
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function sanitizeUploadFileName(name) {
  const raw = String(name || 'file').replace(/\\/g, '/');
  const base = path.basename(raw);
  const cleaned = base
    .replace(/[^\w.\-()+ ]+/gi, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180);
  return cleaned || 'file';
}

function mimeCanonico(mime) {
  const m = String(mime || '').toLowerCase().trim();
  if (m === 'image/jpg') return 'image/jpeg';
  return m;
}

/**
 * fileFilter de multer: comprueba mimetype declarado contra allowlist.
 * [SEC S-06]
 */
export function multerFacturaFileFilter(_req, file, cb) {
  const mime = String(file?.mimetype || '').toLowerCase().trim();
  if (!ALLOWED_FACTURA_MIMES.has(mime)) {
    const err = new Error('Tipo de archivo no permitido');
    err.status = 400;
    return cb(err);
  }
  return cb(null, true);
}

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const MAX_HTTP_PREAMBLE_SCAN = 8192;
const CONTENT_TYPE_PROBE = 512;
/** Mínimo de bytes de PDF tras el magic para aceptar el recorte. */
const MIN_PDF_TAIL = 8;

/**
 * Si el buffer empieza por respuesta HTTP y contiene `%PDF` cerca del inicio,
 * devuelve un sub-buffer desde el primer `%PDF`. Si no, devuelve el buffer original.
 * [SEC S-06] Solo recorta preámbulo HTTP claro; no altera PDF/imágenes válidos.
 * @param {Buffer|Uint8Array|null|undefined} buffer
 * @returns {Buffer|Uint8Array|null|undefined}
 */
export function stripHttpPreambleIfPdf(buffer) {
  if (buffer == null || buffer.length < 4) return buffer;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  ) {
    return Buffer.isBuffer(buffer) ? buffer : buf;
  }

  const headLen = Math.min(buf.length, CONTENT_TYPE_PROBE);
  const headAscii = buf.subarray(0, headLen).toString('latin1');
  const looksHttp =
    /^HTTP\//i.test(headAscii) || /Content-Type:/i.test(headAscii);
  if (!looksHttp) {
    return Buffer.isBuffer(buffer) ? buffer : buf;
  }

  const scanLen = Math.min(buf.length, MAX_HTTP_PREAMBLE_SCAN);
  const idx = buf.subarray(0, scanLen).indexOf(PDF_MAGIC);
  if (idx < 0) return Buffer.isBuffer(buffer) ? buffer : buf;
  if (buf.length - idx < MIN_PDF_TAIL) return Buffer.isBuffer(buffer) ? buffer : buf;

  return Buffer.from(buf.subarray(idx));
}

/**
 * Normaliza buffers de upload antes de validar magic bytes.
 * [SEC S-06]
 * @param {Buffer|Uint8Array|null|undefined} buffer
 * @returns {Buffer|Uint8Array|null|undefined}
 */
export function normalizeUploadBuffer(buffer) {
  return stripHttpPreambleIfPdf(buffer);
}

/**
 * Verifica magic bytes del buffer frente al MIME declarado y la allowlist.
 * Lanza Error con status 400 si no cuadra.
 * [SEC S-06]
 * @param {Buffer|Uint8Array} buffer
 * @param {string} declaredMime
 * @returns {string} MIME canónico detectado
 */
export function assertBufferMimeAllowed(buffer, declaredMime) {
  const declared = String(declaredMime || '').toLowerCase().trim();
  if (!ALLOWED_FACTURA_MIMES.has(declared)) {
    const err = new Error('Tipo de archivo no permitido');
    err.status = 400;
    throw err;
  }

  const magic = detectMimeFromMagic(buffer);
  if (!magic) {
    const err = new Error('Contenido del archivo no reconocido o no permitido');
    err.status = 400;
    throw err;
  }

  if (mimeCanonico(declared) !== magic) {
    const err = new Error('El tipo de archivo no coincide con su contenido');
    err.status = 400;
    throw err;
  }

  return magic;
}
