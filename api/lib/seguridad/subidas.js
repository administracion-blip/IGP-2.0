import multer from 'multer';
import { detectMimeFromMagic } from '../uploadAllowlist.js';

/**
 * Subidas de ficheros con lista cerrada de tipos.
 *
 * El tipo se decide por los magic bytes del buffer, nunca por `mimetype` ni por la
 * extensión que manda el cliente. Tras validar, `file.mimetype` pasa a ser el tipo
 * detectado y `file.extDetectada` su extensión: así el `ContentType` de S3 y la
 * extensión de la clave salen del contenido real. HTML y SVG no entran en ningún perfil.
 */

const MB = 1024 * 1024;

export const MENSAJE_TIPO_NO_PERMITIDO = 'Tipo de archivo no permitido';

const IMAGEN = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic'];
const OFFICE = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
];

export const PERFILES = Object.freeze({
  /** Fotos, carteles, tickets, justificantes. */
  imagen: { tipos: IMAGEN, maxBytes: 20 * MB, maxFicheros: 1 },
  /** Firmas dibujadas en pantalla: PNG del lienzo (FirmaEnPantallaModal / buildFirmaFormData). */
  firma: { tipos: ['image/png'], maxBytes: 8 * MB, maxFicheros: 1 },
  /** Documentos de negocio: PDF + imágenes. */
  documento: { tipos: ['application/pdf', ...IMAGEN], maxBytes: 20 * MB, maxFicheros: 1 },
  /** Adjuntos generales: PDF, imágenes y Office (Word/Excel). */
  adjunto: { tipos: ['application/pdf', ...IMAGEN, ...OFFICE], maxBytes: 20 * MB, maxFicheros: 1 },
  /** Hojas de cálculo e importaciones de texto. */
  hoja: {
    tipos: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv'],
    maxBytes: 10 * MB,
    maxFicheros: 1,
  },
});

const EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
};

export function extensionDeTipo(mime) {
  return EXTENSION[mime] || 'bin';
}

function extensionDeclarada(nombre) {
  return String(nombre || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] || '';
}

/** HEIF/HEIC de iPhone: caja `ftyp` con marca heic/heix/hevc/heim/heis/mif1/msf1. */
function esHeic(b) {
  if (b.length < 12 || b.toString('latin1', 4, 8) !== 'ftyp') return false;
  return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b.toString('latin1', 8, 12));
}

/** ZIP de Office: el nombre de las entradas va en claro en las cabeceras locales. */
function tipoOfficeZip(b) {
  if (!(b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)) return null;
  const cabeza = b.toString('latin1', 0, Math.min(b.length, 64 * 1024));
  if (cabeza.includes('word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (cabeza.includes('xl/')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return null;
}

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** CSV: texto (UTF-8/Latin-1) sin bytes de control ni marcas de HTML/XML. */
function pareceCsv(b) {
  const muestra = b.subarray(0, Math.min(b.length, 64 * 1024));
  for (const c of muestra) {
    if (c === 0 || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) return false;
  }
  const texto = muestra.toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (/^<|<\s*(html|script|svg|body|iframe|!doctype)/.test(texto)) return false;
  return /[;,\t]/.test(texto);
}

/**
 * Tipo real del contenido o `null`. `nombre` solo desempata lo que los bytes no
 * distinguen (Word vs Excel en formato OLE antiguo; CSV, que es texto).
 */
export function detectarTipo(buffer, nombre = '') {
  if (!buffer || buffer.length < 4) return null;
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const magia = detectMimeFromMagic(b);
  if (magia) return magia;
  if (esHeic(b)) return 'image/heic';
  const office = tipoOfficeZip(b);
  if (office) return office;
  const ext = extensionDeclarada(nombre);
  if (b.length >= 8 && b.subarray(0, 8).equals(OLE)) {
    if (ext === 'doc') return 'application/msword';
    if (ext === 'xls') return 'application/vnd.ms-excel';
    return null;
  }
  if (ext === 'csv' && pareceCsv(b)) return 'text/csv';
  return null;
}

function errorSubida(mensaje = MENSAJE_TIPO_NO_PERMITIDO) {
  return Object.assign(new Error(mensaje), { status: 400 });
}

function perfilDe(nombre) {
  const p = PERFILES[nombre];
  if (!p) throw new Error(`Perfil de subida desconocido: ${nombre}`);
  return p;
}

/**
 * Valida un fichero de multer contra un perfil y fija `mimetype`/`extDetectada`.
 * Lanza 400 ('Tipo de archivo no permitido') si el contenido no es de un tipo del perfil.
 * @param {{ buffer: Buffer, originalname?: string, size?: number, mimetype?: string }} file
 * @param {keyof typeof PERFILES} perfil
 * @param {{ maxBytes?: number }} [opts]
 */
export function comprobarArchivo(file, perfil, { maxBytes } = {}) {
  const p = perfilDe(perfil);
  if (!file?.buffer) throw errorSubida('No se recibió archivo');
  const tope = Math.min(maxBytes || p.maxBytes, p.maxBytes);
  if (file.buffer.length > tope) {
    throw errorSubida(`El archivo supera el tamaño máximo (${Math.round(tope / MB)} MB)`);
  }
  const tipo = detectarTipo(file.buffer, file.originalname);
  if (!tipo || !p.tipos.includes(tipo)) throw errorSubida();
  file.mimetype = tipo;
  file.extDetectada = extensionDeTipo(tipo);
  return tipo;
}

/**
 * Para rutas que comprueban permisos dentro del handler: valida `file` y, si no
 * pasa, responde 400 y devuelve `true` (`if (rechazaArchivo(res, req.file, 'imagen')) return;`).
 */
export function rechazaArchivo(res, file, perfil, opts) {
  try {
    comprobarArchivo(file, perfil, opts);
    return false;
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || MENSAJE_TIPO_NO_PERMITIDO });
    return true;
  }
}

/** Todos los ficheros de `req.file` / `req.files` (single, array o fields). */
function ficherosDe(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return [];
}

/**
 * Middleware que valida lo que multer dejó en `req.file(s)`. Sin fichero pasa
 * (cada ruta decide si es obligatorio). Ponerlo después de los permisos/alcance.
 */
export function validarSubidas(perfil, opts = {}) {
  perfilDe(perfil);
  return (req, res, next) => {
    try {
      for (const f of ficherosDe(req)) comprobarArchivo(f, perfil, opts);
      return next();
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message || MENSAJE_TIPO_NO_PERMITIDO });
    }
  };
}

/**
 * multer en memoria con el límite del perfil (o uno menor) y número máximo de ficheros.
 * El tipo se valida después con `validarSubidas` / `comprobarArchivo`.
 */
export function multerPerfil(perfil, { maxBytes, maxFicheros } = {}) {
  const p = perfilDe(perfil);
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.min(maxBytes || p.maxBytes, p.maxBytes),
      files: maxFicheros || p.maxFicheros,
    },
  });
}

/**
 * Data URL de imagen (`data:image/…;base64,…`) validada por contenido. Devuelve la
 * data URL normalizada con el tipo real o `null` si no es una imagen del perfil.
 */
export function imagenDataUrlSegura(valor, { perfil = 'imagen', maxBytes } = {}) {
  const p = perfilDe(perfil);
  const m = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(valor || '').trim());
  if (!m) return null;
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length || buf.length > Math.min(maxBytes || p.maxBytes, p.maxBytes)) return null;
  const tipo = detectarTipo(buf);
  if (!tipo || !tipo.startsWith('image/') || !p.tipos.includes(tipo)) return null;
  return `data:${tipo};base64,${buf.toString('base64')}`;
}
