/**
 * Módulo Marketing (RRSS).
 *
 * Acceso por permisos en `Igp_RolesPermisos`:
 *   - marketing.proponer  → CRUD de propuestas propias.
 *   - marketing.gestionar → visión global, aprobar/rechazar, prompts IA, carteles, estilos.
 *
 * Convención operativa: cualquier rol con `marketing.gestionar` también debe
 * recibir `marketing.proponer` (la pantalla de Permisos los asigna juntos).
 * El rol 'Administrador' bypasea ambos (comportamiento de `requirePermission`).
 *
 * El JWT solo lleva sub/email/rol — `id_local`/`id_empresa` no están en el token.
 * Se resuelven con `getUserLocales(userId)` (Get a `tables.usuarios`) y
 * `getEmpresaIdFromLocal(idLocalNorm)` (Get a `tables.locales`).
 *
 * IDs de local: el proyecto los almacena con padding a 6 dígitos (`'000005'`).
 * Cualquier `id_local` que entre por body/query DEBE pasar por `formatId6`
 * antes de guardar o consultar; mezclar formatos rompe los GSIs y la
 * validación de pertenencia.
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';
import {
  GSI_LOCAL_ESTADO_NAME,
  GSI_LOCAL_FECHA_NAME,
  GSI_EMPRESA_ESTADO_NAME,
  isMarketingLocalEstadoReady,
  isMarketingLocalFechaReady,
  isMarketingEmpresaEstadoReady,
} from '../lib/dynamo/marketing.js';

const router = Router();
const region = process.env.AWS_REGION || 'eu-west-3';
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region });

// Upload de imágenes en memoria. Límite 10MB; el frontend ya redimensiona.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const MIMES_IMAGEN_VALIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXT_POR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const TABLE_MARKETING = tables.marketing;

// ──────────────────────────────────────────────────────────────────────────
// Constantes
// ──────────────────────────────────────────────────────────────────────────

const TIPOS_PROPUESTA = [
  'Oferta',
  'Evento',
  'Novedad',
  'Menu del dia',
  'Agradecimiento',
  'Cartel Musico',
  'Otro',
];
const REDES_VALIDAS = ['instagram', 'facebook', 'tiktok'];
const ESTADOS_VALIDOS = ['pendiente', 'aprobada', 'rechazada', 'publicada'];

const MAX_ESTILO_BRIEF_CHARS = 1000;
/** URL de referencia del local (sitio web público) para contexto en prompts. */
const MAX_ESTILO_WEB_URL_CHARS = 2048;
/** URL pública o longitud máxima coherente con claves S3 en `imagen_referencia_url`. */
const MAX_PROPUESTA_REF_IMAGEN_CHARS = 2048;
const PREFIX_MARKETING_REFERENCIA_KEY = 'marketing/referencia/';
/** Imágenes de referencia del estilo visual por local (S3 `marketing/estilo-local/…`). */
const MAX_ESTILO_IMAGENES = 3;
const PREFIX_ESTILO_LOCAL_KEY = 'marketing/estilo-local/';
const ESTILO_BRIEF_FALLBACK =
  'Negocio de hostelería local. Estilo visual profesional, cálido y acogedor.';

// Campos que un usuario sin `marketing.gestionar` puede editar en una propuesta propia
// mientras sigue en estado 'pendiente'. Cualquier otro campo del body se ignora.
const CAMPOS_EDITABLES_PROPONENTE = new Set([
  'tipo',
  'redes',
  'fecha_sugerida',
  'descripcion',
  'imagen_referencia_url',
]);

// Campos que `marketing.gestionar` puede actualizar libremente.
// `creado_por`, `creado_en`, `id_propuesta` nunca se tocan vía PATCH.
const CAMPOS_EDITABLES_GESTOR = new Set([
  'tipo',
  'redes',
  'fecha_sugerida',
  'descripcion',
  'imagen_referencia_url',
  'estado',
  'comentario_rechazo',
  'prompt_generado',
  'imagen_final_url',
  'url_publicacion',
  'metricas',
  'id_actuacion',
  'id_local',
]);

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Normaliza un id_local a 6 dígitos con padding (`'5'` → `'000005'`). */
function formatId6(val) {
  if (val == null || val === '') return '';
  const s = String(val).replace(/^0+/, '') || '0';
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return '';
  return String(n).padStart(6, '0');
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function notFound(message) {
  const e = new Error(message);
  e.status = 404;
  return e;
}

function forbidden(message) {
  const e = new Error(message);
  e.status = 403;
  return e;
}

function normalizeEstiloImagenKeysFromItem(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    const k = String(x ?? '').trim();
    if (!isValidEstiloLocalImagenKey(k)) continue;
    if (!out.includes(k)) out.push(k);
    if (out.length >= MAX_ESTILO_IMAGENES) break;
  }
  return out;
}

function isValidEstiloLocalImagenKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (!key.startsWith(PREFIX_ESTILO_LOCAL_KEY)) return false;
  if (key.includes('..') || key.includes('//')) return false;
  if (key.length > 480) return false;
  const rest = key.slice(PREFIX_ESTILO_LOCAL_KEY.length);
  return /^[a-zA-Z0-9._-]+$/.test(rest);
}

function sanitizeEstiloImagenKeysFromBody(bodyKeys) {
  if (!Array.isArray(bodyKeys)) {
    throw badRequest('estilo_visual_imagen_keys debe ser un array');
  }
  const seen = new Set();
  const out = [];
  for (const x of bodyKeys) {
    const k = String(x ?? '').trim();
    if (!k) continue;
    if (!isValidEstiloLocalImagenKey(k)) {
      throw badRequest('Una o más claves de imagen de estilo no son válidas');
    }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length > MAX_ESTILO_IMAGENES) {
      throw badRequest(`Máximo ${MAX_ESTILO_IMAGENES} imágenes de referencia por local`);
    }
  }
  return out;
}

function isValidMarketingReferenciaPropuestaKey(key) {
  if (!key || typeof key !== 'string') return false;
  const k = key.trim();
  if (!k.startsWith(PREFIX_MARKETING_REFERENCIA_KEY)) return false;
  if (k.includes('..') || k.includes('//')) return false;
  if (k.length > 480) return false;
  const rest = k.slice(PREFIX_MARKETING_REFERENCIA_KEY.length);
  return /^[a-zA-Z0-9._-]+$/.test(rest);
}

/** Vacío, URL https/http normalizada, o clave S3 `marketing/referencia/…` del upload de referencia. */
function sanitizePropuestaRefImagenValor(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.length > MAX_PROPUESTA_REF_IMAGEN_CHARS) {
    s = s.slice(0, MAX_PROPUESTA_REF_IMAGEN_CHARS);
  }
  if (isValidMarketingReferenciaPropuestaKey(s)) return s;

  let urlCandidate = s;
  if (!/^https?:\/\//i.test(urlCandidate)) {
    urlCandidate = `https://${urlCandidate}`.slice(0, MAX_PROPUESTA_REF_IMAGEN_CHARS);
  }
  try {
    const u = new URL(urlCandidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw badRequest('La imagen de referencia (URL) debe usar http o https');
    }
    return u.href.slice(0, MAX_PROPUESTA_REF_IMAGEN_CHARS);
  } catch (e) {
    if (e.status === 400) throw e;
    throw badRequest(
      'imagen_referencia_url debe ser una URL https://… o la clave devuelta al subir la imagen (marketing/referencia/…)',
    );
  }
}

async function resolvePropuestaRefImagenParaPrompt(stored) {
  const s = String(stored ?? '').trim();
  if (!s) return '';
  if (isValidMarketingReferenciaPropuestaKey(s)) {
    try {
      return await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: s }),
        { expiresIn: 3600 },
      );
    } catch {
      return '';
    }
  }
  let urlCandidate = s;
  if (!/^https?:\/\//i.test(urlCandidate)) {
    urlCandidate = `https://${urlCandidate}`.slice(0, MAX_PROPUESTA_REF_IMAGEN_CHARS);
  }
  try {
    const u = new URL(urlCandidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href.slice(0, MAX_PROPUESTA_REF_IMAGEN_CHARS);
  } catch {
    return '';
  }
}

function sanitizeEstiloWebUrl(bodyWeb, prevWeb) {
  if (bodyWeb === undefined || bodyWeb === null) {
    return String(prevWeb ?? '').trim().slice(0, MAX_ESTILO_WEB_URL_CHARS);
  }
  let raw = String(bodyWeb).trim();
  if (!raw) return '';
  raw = raw.slice(0, MAX_ESTILO_WEB_URL_CHARS);
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`.slice(0, MAX_ESTILO_WEB_URL_CHARS);
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw badRequest('La URL web debe usar http o https');
    }
    return u.href.slice(0, MAX_ESTILO_WEB_URL_CHARS);
  } catch (e) {
    if (e.status === 400) throw e;
    throw badRequest('URL web no válida');
  }
}

function pushSitioWebEstilo(lines, webUrl) {
  const w = String(webUrl || '').trim();
  if (!w) return;
  lines.push('');
  lines.push(`Sitio web del local (referencia para tono, marca y contenido): ${w}`);
}

function pushRefEstiloVisualAlPrompt(lines, refImagenesCount) {
  const n = Number(refImagenesCount) || 0;
  if (n <= 0) return;
  lines.push('');
  lines.push(
    `Referencias visuales del local: en la aplicación hay ${n} imagen(es) de referencia en la identidad visual; revísalas junto a este prompt para alinear estilo, color y ambiente.`,
  );
}

function pushPropuestaRefImagenAlPrompt(lines, urlVisible) {
  const u = String(urlVisible || '').trim();
  if (!u) return;
  lines.push('');
  lines.push(`Imagen de referencia de esta propuesta (consultar si procede): ${u}`);
}

/**
 * Si el error indica que la tabla Igp_Marketing no existe, lanza un Error con
 * status 404 y mensaje accionable. El resto se re-lanza para que el middleware
 * central lo gestione. SOLO usar en operaciones sobre `tables.marketing`.
 */
function throwSiTablaMarketingFalta(err) {
  const msg = err?.message || String(err);
  if (
    err?.name === 'ResourceNotFoundException' ||
    msg.includes('Requested resource not found') ||
    msg.includes('ResourceNotFoundException')
  ) {
    const e = new Error(
      `La tabla ${TABLE_MARKETING} no existe en DynamoDB. Créala en AWS con PK 'id_propuesta' (String). Los GSIs se crearán automáticamente al arrancar.`,
    );
    e.status = 404;
    e.code = 'TABLE_NOT_FOUND';
    throw e;
  }
  throw err;
}

function normalizeLocalField(val) {
  if (Array.isArray(val)) {
    return val
      .filter((l) => l != null && String(l).trim() !== '')
      .map((l) => formatId6(String(l).trim()))
      .filter(Boolean);
  }
  if (val != null && String(val).trim() !== '') {
    const norm = formatId6(String(val).trim());
    return norm ? [norm] : [];
  }
  return [];
}

/**
 * Devuelve el array de locales (ya normalizados a `formatId6`) asignados a un
 * usuario. Lectura con Get sobre `tables.usuarios`. Si el usuario no existe o
 * no tiene `Local` asignado devuelve `[]`.
 */
async function getUserLocales(userId) {
  if (!userId) return [];
  const r = await docClient.send(new GetCommand({
    TableName: tables.usuarios,
    Key: { id_usuario: String(userId) },
  }));
  return normalizeLocalField(r.Item?.Local);
}

/**
 * Resuelve el `id_empresa` del local. El campo en `tables.locales` se llama
 * `empresa` (lower, no `id_empresa`); puede contener un id-string o estar
 * vacío. Si no hay valor, devuelve `''` y registra warning (la propuesta se
 * podrá crear pero no entrará en el GSI Empresa-Estado-index).
 */
async function getEmpresaIdFromLocal(idLocalNorm, log) {
  if (!idLocalNorm) return '';
  const r = await docClient.send(new GetCommand({
    TableName: tables.locales,
    Key: { id_Locales: idLocalNorm },
  }));
  if (!r.Item) {
    throw notFound(`Local ${idLocalNorm} no encontrado`);
  }
  const empresa = String(r.Item.empresa ?? '').trim();
  if (!empresa && log) {
    log.warn(
      { id_local: idLocalNorm },
      '[marketing] local sin empresa asignada — la propuesta no aparecerá en consultas por id_empresa',
    );
  }
  return empresa;
}

/**
 * Comprueba si el usuario tiene el permiso `marketing.gestionar`. Bypassea
 * para 'Administrador' (mismo criterio que `requirePermission`). Devuelve
 * boolean; en caso de error devuelve `false` (cierra por defecto).
 */
async function hasGestionPermission(req) {
  if (!req.user) return false;
  if (req.user.rol === 'Administrador') return true;
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.rolesPermisos,
      Key: { PK: `ROL#${req.user.rol}`, SK: 'PERMISO#marketing.gestionar' },
    }));
    return Boolean(r.Item);
  } catch (err) {
    req.log?.warn?.({ err }, '[marketing] hasGestionPermission falló');
    return false;
  }
}

/** Lectura/edición de estilo_visual_brief: gestor o usuario con local asignado. */
async function assertAccesoEstiloLocal(req, idLocalNorm) {
  if (!idLocalNorm) throw badRequest('id de local inválido');
  const esGestor = await hasGestionPermission(req);
  if (esGestor) return;
  const userLocales = await getUserLocales(req.user?.sub);
  if (!userLocales.includes(idLocalNorm)) {
    throw forbidden('No tienes permiso para la identidad visual de ese local');
  }
}

async function scanAllMarketing(filterExpr, exprValues, exprNames) {
  const items = [];
  let lastKey = null;
  do {
    const params = {
      TableName: TABLE_MARKETING,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
      ...(filterExpr && { FilterExpression: filterExpr }),
      ...(exprValues && { ExpressionAttributeValues: exprValues }),
      ...(exprNames && { ExpressionAttributeNames: exprNames }),
    };
    try {
      const result = await docClient.send(new ScanCommand(params));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } catch (err) {
      throwSiTablaMarketingFalta(err);
    }
  } while (lastKey);
  return items;
}

/** Genera presigned URL del avatar del artista (si tiene `imagen_key`). */
async function buildImagenArtistaUrl(imagenKey) {
  if (imagenKey == null || String(imagenKey).trim() === '') return null;
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: String(imagenKey) });
  return getSignedUrl(s3, cmd, { expiresIn: 3600 });
}

function isFechaIso(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

function sanitizeRedes(redes) {
  if (!Array.isArray(redes) || redes.length === 0) return null;
  const out = [];
  for (const r of redes) {
    const v = String(r || '').trim().toLowerCase();
    if (!REDES_VALIDAS.includes(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Generadores de prompt (español; útiles para Midjourney, DALL·E, etc.)
// ──────────────────────────────────────────────────────────────────────────

function formatoSegunRedes(redes) {
  const tags = [];
  if (redes.includes('instagram')) tags.push('Instagram feed: composición cuadrada 1:1');
  if (redes.includes('facebook')) tags.push('Facebook: composición horizontal 16:9');
  if (redes.includes('tiktok')) tags.push('TikTok / Stories: composición vertical 9:16');
  return tags.length ? tags.join('; ') : 'composición cuadrada 1:1';
}

function tipoGuidance(tipo) {
  switch (tipo) {
    case 'Oferta':
      return 'Destaca el producto u oferta con estilismo apetitoso y luz natural.';
    case 'Evento':
      return 'Ambiente con clientes disfrutando del local, iluminación ambiental, sensación de celebración.';
    case 'Novedad':
      return 'Composición fresca y llamativa que enfatice lo nuevo.';
    case 'Menu del dia':
      return 'Plato fotorrealista sobre mesa del local; ingredientes visibles, tonos cálidos.';
    case 'Agradecimiento':
      return 'Tono humano y de gratitud; luz suave, detalles de hospitalidad.';
    case 'Cartel Musico':
      return 'Estilo cartel de concierto: tipografía contundente, ambiente musical.';
    default:
      return 'Imagen de marketing para hostelería, coherente con la marca.';
  }
}

function buildPromptPropuesta({
  estiloBrief,
  tipo,
  descripcion,
  redes,
  refImagenesCount = 0,
  webUrl = '',
  refPropuestaUrl = '',
}) {
  const brief = estiloBrief && estiloBrief.trim() ? estiloBrief.trim() : ESTILO_BRIEF_FALLBACK;
  const lines = [
    'Imagen de marketing para un negocio de hostelería local.',
    '',
    'Identidad visual del local:',
    brief,
  ];
  pushRefEstiloVisualAlPrompt(lines, refImagenesCount);
  pushSitioWebEstilo(lines, webUrl);
  pushPropuestaRefImagenAlPrompt(lines, refPropuestaUrl);
  lines.push(
    '',
    `Tipo de publicación: ${tipo}`,
    `Contenido / mensaje: ${descripcion}`,
    '',
    `Formato según redes: ${formatoSegunRedes(redes)}`,
    '',
    `Guía de estilo: ${tipoGuidance(tipo)}`,
    '',
    'Resultado: alta calidad, fotorrealista, iluminación profesional. Sin texto superpuesto en la imagen.',
  );
  return lines.join('\n');
}

function buildPromptCartelMusico({ estiloBrief, artista, fecha, horaInicio, refImagenesCount = 0, webUrl = '' }) {
  const brief = estiloBrief && estiloBrief.trim() ? estiloBrief.trim() : ESTILO_BRIEF_FALLBACK;
  const nombre = artista?.nombre_artistico || 'Música en vivo';
  const estilos = Array.isArray(artista?.estilos_musicales) && artista.estilos_musicales.length
    ? artista.estilos_musicales.join(', ')
    : 'música en vivo';
  const cuando = horaInicio ? `${fecha} a las ${horaInicio}` : fecha;
  const lines = [
    'Cartel para actuación musical en directo en un local de hostelería.',
    '',
    'Identidad visual del local:',
    brief,
  ];
  pushRefEstiloVisualAlPrompt(lines, refImagenesCount);
  pushSitioWebEstilo(lines, webUrl);
  lines.push(
    '',
    `Artista: ${nombre}`,
    `Estilo(s) musical(es): ${estilos}`,
    `Fecha y hora: ${cuando}`,
    '',
    'Formato: vertical 9:16 (A3 / historia de Instagram).',
    'Composición: nombre del artista muy visible en tipografía display; fecha destacada; iluminación acorde al género.',
    '',
    'Resultado: cartel de concierto de alta calidad e iluminación profesional. Válido para impresión A3 y Instagram Story.',
  );
  return lines.join('\n');
}

/** Body flag helper (agrupar_conciertos, etc.). */
function parseBoolBody(val, defaultVal = false) {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (['true', '1', 'yes', 'si', 'sí'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  return defaultVal;
}

/**
 * Un solo prompt que incluye todas las actuaciones del rango (cartel / imagen única).
 */
function buildPromptCartelMusicoAgrupado({
  estiloBrief,
  fechaInicio,
  fechaFin,
  nombreLocal,
  filas,
  refImagenesCount = 0,
  webUrl = '',
}) {
  const brief = estiloBrief && estiloBrief.trim() ? estiloBrief.trim() : ESTILO_BRIEF_FALLBACK;
  const venue = nombreLocal && String(nombreLocal).trim() ? String(nombreLocal).trim() : 'el local';
  const lines = [
    'Cartel o imagen única que incluya VARIAS actuaciones musicales en un mismo local de hostelería.',
    `Rango de fechas de la campaña: del ${fechaInicio} al ${fechaFin} (deben figurar todas las actuaciones listadas).`,
    `Nombre del local: ${venue}`,
    '',
    'Identidad visual del local:',
    brief,
  ];
  pushRefEstiloVisualAlPrompt(lines, refImagenesCount);
  pushSitioWebEstilo(lines, webUrl);
  lines.push(
    '',
    `Hay ${filas.length} actuación(es). Cada una debe leerse con claridad en la composición (nombre + fecha + hora):`,
    '',
  );
  filas.forEach((row, i) => {
    const hora = row.hora_inicio ? ` a las ${row.hora_inicio}` : '';
    lines.push(
      `${i + 1}. ${row.fecha}${hora} — ${row.nombre_artistico} (${row.estilos})`,
    );
  });
  lines.push(
    '',
    'Formato: vertical 9:16 (A3 / historia de Instagram), mucha información pero jerarquía visual clara.',
    'Composición: titular contundente con ambiente del local; bloque de agenda o filas por artista; tipografía legible.',
    'Unificar todas las actuaciones en una misma estética de “noche musical”: paleta de luz y estilo de cartel coherentes.',
    '',
    'Resultado: cartel compuesto de alta calidad e iluminación profesional. Válido para impresión A3 e Instagram Story.',
  );
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Rutas: propuestas (CRUD básico) — `marketing.proponer`
// ──────────────────────────────────────────────────────────────────────────

router.get('/marketing/propuestas', requirePermission('marketing.proponer'), async (req, res) => {
  const userId = req.user?.sub;
  const idLocalQ = req.query?.id_local != null ? formatId6(String(req.query.id_local).trim()) : '';
  const estado = req.query?.estado != null ? String(req.query.estado).trim() : '';
  const idEmpresa = req.query?.id_empresa != null ? String(req.query.id_empresa).trim() : '';
  const fechaDesde = req.query?.fecha_desde != null ? String(req.query.fecha_desde).trim() : '';
  const fechaHasta = req.query?.fecha_hasta != null ? String(req.query.fecha_hasta).trim() : '';

  if (estado && !ESTADOS_VALIDOS.includes(estado)) {
    throw badRequest(`estado inválido. Valores: ${ESTADOS_VALIDOS.join(', ')}`);
  }
  if (fechaDesde && !isFechaIso(fechaDesde)) throw badRequest('fecha_desde debe ser YYYY-MM-DD');
  if (fechaHasta && !isFechaIso(fechaHasta)) throw badRequest('fecha_hasta debe ser YYYY-MM-DD');

  const esGestor = await hasGestionPermission(req);

  // Sin gestionar: id_local obligatorio y debe pertenecer al usuario.
  if (!esGestor) {
    if (!idLocalQ) throw badRequest('id_local es obligatorio');
    const userLocales = await getUserLocales(userId);
    if (!userLocales.includes(idLocalQ)) {
      throw forbidden('No tienes acceso a las propuestas de ese local');
    }
  }

  let items = [];

  // Estrategia de consulta: GSIs si están listos, fallback a Scan + filtro en memoria.
  if (idLocalQ && (estado || !fechaDesde) && isMarketingLocalEstadoReady() && (estado || !fechaDesde)) {
    // Local-Estado-index cuando hay estado explícito o no se necesita filtro de fecha sobre SK.
    if (estado) {
      const r = await docClient.send(new QueryCommand({
        TableName: TABLE_MARKETING,
        IndexName: GSI_LOCAL_ESTADO_NAME,
        KeyConditionExpression: '#pk = :pk AND #sk = :sk',
        ExpressionAttributeNames: { '#pk': 'id_local', '#sk': 'estado' },
        ExpressionAttributeValues: { ':pk': idLocalQ, ':sk': estado },
      }));
      items = r.Items || [];
    } else {
      const r = await docClient.send(new QueryCommand({
        TableName: TABLE_MARKETING,
        IndexName: GSI_LOCAL_ESTADO_NAME,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'id_local' },
        ExpressionAttributeValues: { ':pk': idLocalQ },
      }));
      items = r.Items || [];
    }
  } else if (idLocalQ && fechaDesde && isMarketingLocalFechaReady()) {
    // Local-Fecha-index para rango de fechas.
    let keyExpr = '#pk = :pk';
    const exprVals = { ':pk': idLocalQ };
    if (fechaDesde && fechaHasta) {
      keyExpr += ' AND #sk BETWEEN :fi AND :ff';
      exprVals[':fi'] = fechaDesde;
      exprVals[':ff'] = fechaHasta;
    } else if (fechaDesde) {
      keyExpr += ' AND #sk >= :fi';
      exprVals[':fi'] = fechaDesde;
    }
    const r = await docClient.send(new QueryCommand({
      TableName: TABLE_MARKETING,
      IndexName: GSI_LOCAL_FECHA_NAME,
      KeyConditionExpression: keyExpr,
      ExpressionAttributeNames: { '#pk': 'id_local', '#sk': 'fecha_sugerida' },
      ExpressionAttributeValues: exprVals,
    }));
    items = r.Items || [];
  } else if (esGestor && idEmpresa && isMarketingEmpresaEstadoReady()) {
    if (estado) {
      const r = await docClient.send(new QueryCommand({
        TableName: TABLE_MARKETING,
        IndexName: GSI_EMPRESA_ESTADO_NAME,
        KeyConditionExpression: '#pk = :pk AND #sk = :sk',
        ExpressionAttributeNames: { '#pk': 'id_empresa', '#sk': 'estado' },
        ExpressionAttributeValues: { ':pk': idEmpresa, ':sk': estado },
      }));
      items = r.Items || [];
    } else {
      const r = await docClient.send(new QueryCommand({
        TableName: TABLE_MARKETING,
        IndexName: GSI_EMPRESA_ESTADO_NAME,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'id_empresa' },
        ExpressionAttributeValues: { ':pk': idEmpresa },
      }));
      items = r.Items || [];
    }
  } else {
    // Fallback: Scan general + filtro en memoria.
    items = await scanAllMarketing();
    if (idLocalQ) items = items.filter((p) => formatId6(String(p.id_local || '')) === idLocalQ);
    if (idEmpresa) items = items.filter((p) => String(p.id_empresa || '') === idEmpresa);
    if (estado) items = items.filter((p) => String(p.estado || '') === estado);
  }

  // Filtro fecha en memoria si la rama no lo cubrió.
  if (fechaDesde) items = items.filter((p) => String(p.fecha_sugerida || '') >= fechaDesde);
  if (fechaHasta) items = items.filter((p) => String(p.fecha_sugerida || '') <= fechaHasta);

  // Para no-gestores, segunda salvaguarda: filtrar por sus locales.
  if (!esGestor) {
    const userLocales = await getUserLocales(userId);
    items = items.filter((p) => userLocales.includes(formatId6(String(p.id_local || ''))));
  }

  items.sort((a, b) => String(b.fecha_sugerida || '').localeCompare(String(a.fecha_sugerida || '')));
  res.json({ propuestas: items });
});

router.post('/marketing/propuestas', requirePermission('marketing.proponer'), async (req, res) => {
  const body = req.body || {};
  const userId = req.user?.sub;

  const tipo = String(body.tipo || '').trim();
  if (!TIPOS_PROPUESTA.includes(tipo)) {
    throw badRequest(`tipo inválido. Valores: ${TIPOS_PROPUESTA.join(', ')}`);
  }
  const redes = sanitizeRedes(body.redes);
  if (!redes) throw badRequest(`redes debe ser un array no vacío de: ${REDES_VALIDAS.join(', ')}`);
  const fechaSugerida = String(body.fecha_sugerida || '').trim();
  if (!isFechaIso(fechaSugerida)) throw badRequest('fecha_sugerida debe ser YYYY-MM-DD');
  const descripcion = String(body.descripcion || '').trim();
  if (!descripcion) throw badRequest('descripcion es obligatoria');
  const idLocalRaw = String(body.id_local || '').trim();
  if (!idLocalRaw) throw badRequest('id_local es obligatorio');
  const idLocal = formatId6(idLocalRaw);
  if (!idLocal) throw badRequest('id_local inválido');

  const esGestor = await hasGestionPermission(req);
  if (!esGestor) {
    const userLocales = await getUserLocales(userId);
    if (!userLocales.includes(idLocal)) {
      throw forbidden('No puedes crear propuestas para un local que no es tuyo');
    }
  }

  // id_empresa SIEMPRE derivado del local (nunca del body).
  const idEmpresa = await getEmpresaIdFromLocal(idLocal, req.log);

  const now = new Date().toISOString();
  const promptInicial = String(body.prompt_generado ?? '').trim();
  const imagenReferencia = sanitizePropuestaRefImagenValor(body.imagen_referencia_url);
  const item = {
    id_propuesta: crypto.randomUUID(),
    id_local: idLocal,
    id_empresa: idEmpresa,
    tipo,
    redes,
    fecha_sugerida: fechaSugerida,
    descripcion,
    imagen_referencia_url: imagenReferencia,
    id_actuacion: String(body.id_actuacion || ''),
    ...(promptInicial ? { prompt_generado: promptInicial } : {}),
    estado: 'pendiente',
    creado_por: String(userId || ''),
    creado_en: now,
  };

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_MARKETING,
      Item: item,
    }));
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }

  res.status(201).json({ propuesta: item });
});

router.get('/marketing/propuestas/:id', requirePermission('marketing.proponer'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) throw badRequest('id es obligatorio');

  let result;
  try {
    result = await docClient.send(new GetCommand({
      TableName: TABLE_MARKETING,
      Key: { id_propuesta: id },
    }));
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }
  if (!result?.Item) throw notFound('Propuesta no encontrada');

  const esGestor = await hasGestionPermission(req);
  if (!esGestor) {
    const userLocales = await getUserLocales(req.user?.sub);
    const idLocalProp = formatId6(String(result.Item.id_local || ''));
    if (!userLocales.includes(idLocalProp)) {
      // Devolvemos 404 para no filtrar existencia.
      throw notFound('Propuesta no encontrada');
    }
  }

  res.json({ propuesta: result.Item });
});

router.patch('/marketing/propuestas/:id', requirePermission('marketing.proponer'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) throw badRequest('id es obligatorio');
  const body = req.body || {};
  const userId = req.user?.sub;

  let prev;
  try {
    const r = await docClient.send(new GetCommand({
      TableName: TABLE_MARKETING,
      Key: { id_propuesta: id },
    }));
    prev = r.Item;
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }
  if (!prev) throw notFound('Propuesta no encontrada');

  const esGestor = await hasGestionPermission(req);
  const userLocales = !esGestor ? await getUserLocales(userId) : [];
  const idLocalProp = formatId6(String(prev.id_local || ''));

  if (!esGestor) {
    if (!userLocales.includes(idLocalProp)) {
      throw forbidden('No puedes editar esta propuesta');
    }
    if (prev.estado !== 'pendiente') {
      throw forbidden('Solo se pueden editar propuestas en estado pendiente');
    }
  }

  const camposPermitidos = esGestor ? CAMPOS_EDITABLES_GESTOR : CAMPOS_EDITABLES_PROPONENTE;
  const updates = {};

  for (const k of Object.keys(body)) {
    if (!camposPermitidos.has(k)) continue;
    updates[k] = body[k];
  }

  // Validaciones para los campos enviados.
  if ('tipo' in updates) {
    const t = String(updates.tipo || '').trim();
    if (!TIPOS_PROPUESTA.includes(t)) throw badRequest('tipo inválido');
    updates.tipo = t;
  }
  if ('redes' in updates) {
    const norm = sanitizeRedes(updates.redes);
    if (!norm) throw badRequest('redes inválidas');
    updates.redes = norm;
  }
  if ('fecha_sugerida' in updates) {
    if (!isFechaIso(String(updates.fecha_sugerida || ''))) throw badRequest('fecha_sugerida YYYY-MM-DD');
    updates.fecha_sugerida = String(updates.fecha_sugerida).trim();
  }
  if ('descripcion' in updates) {
    const d = String(updates.descripcion || '').trim();
    if (!d) throw badRequest('descripcion no puede ser vacía');
    updates.descripcion = d;
  }
  if ('imagen_referencia_url' in updates) {
    updates.imagen_referencia_url = sanitizePropuestaRefImagenValor(updates.imagen_referencia_url);
  }
  if ('estado' in updates) {
    const e = String(updates.estado || '').trim();
    if (!ESTADOS_VALIDOS.includes(e)) throw badRequest(`estado inválido. Valores: ${ESTADOS_VALIDOS.join(', ')}`);
    updates.estado = e;
    if (e === 'aprobada') {
      updates.aprobado_por = String(userId || '');
      updates.aprobado_en = new Date().toISOString();
    }
    if (e === 'rechazada') {
      const com = ('comentario_rechazo' in updates
        ? updates.comentario_rechazo
        : prev.comentario_rechazo) || '';
      if (!String(com).trim()) {
        throw badRequest('Para rechazar la propuesta debes incluir comentario_rechazo');
      }
    }
  }
  if ('id_local' in updates) {
    const norm = formatId6(String(updates.id_local || '').trim());
    if (!norm) throw badRequest('id_local inválido');
    updates.id_local = norm;
    // Re-derivar id_empresa cuando cambia el local.
    updates.id_empresa = await getEmpresaIdFromLocal(norm, req.log);
  }

  const sets = [];
  const exprNames = {};
  const exprValues = {};
  let i = 0;
  for (const [k, v] of Object.entries(updates)) {
    const placeholderName = `#k${i}`;
    const placeholderValue = `:v${i}`;
    sets.push(`${placeholderName} = ${placeholderValue}`);
    exprNames[placeholderName] = k;
    exprValues[placeholderValue] = v;
    i += 1;
  }

  if (sets.length === 0) {
    return res.json({ propuesta: prev });
  }

  let updated;
  try {
    const r = await docClient.send(new UpdateCommand({
      TableName: TABLE_MARKETING,
      Key: { id_propuesta: id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: 'ALL_NEW',
    }));
    updated = r.Attributes;
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }

  res.json({ propuesta: updated });
});

router.delete('/marketing/propuestas/:id', requirePermission('marketing.proponer'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) throw badRequest('id es obligatorio');

  let prev;
  try {
    const r = await docClient.send(new GetCommand({
      TableName: TABLE_MARKETING,
      Key: { id_propuesta: id },
    }));
    prev = r.Item;
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }
  if (!prev) throw notFound('Propuesta no encontrada');

  const esGestor = await hasGestionPermission(req);
  const idLocalProp = formatId6(String(prev.id_local || ''));

  if (!esGestor) {
    const userLocales = await getUserLocales(req.user?.sub);
    if (!userLocales.includes(idLocalProp)) {
      throw forbidden('No puedes borrar esta propuesta');
    }
    if (prev.estado !== 'pendiente') {
      throw forbidden('Solo puedes borrar propuestas pendientes');
    }
  } else {
    if (prev.estado !== 'pendiente' && prev.estado !== 'rechazada') {
      throw forbidden('Solo se pueden borrar propuestas en estado pendiente o rechazada');
    }
  }

  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_MARKETING,
      Key: { id_propuesta: id },
    }));
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }

  res.status(204).send();
});

// ──────────────────────────────────────────────────────────────────────────
// Rutas: gestión avanzada — `marketing.gestionar`
// ──────────────────────────────────────────────────────────────────────────

router.post('/marketing/propuestas/:id/prompt', requirePermission('marketing.gestionar'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) throw badRequest('id es obligatorio');

  let propuesta;
  try {
    const r = await docClient.send(new GetCommand({
      TableName: TABLE_MARKETING,
      Key: { id_propuesta: id },
    }));
    propuesta = r.Item;
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }
  if (!propuesta) throw notFound('Propuesta no encontrada');

  const idLocalProp = formatId6(String(propuesta.id_local || ''));
  let estiloBrief = '';
  let refImagenesCount = 0;
  let estiloWeb = '';
  if (idLocalProp) {
    const lr = await docClient.send(new GetCommand({
      TableName: tables.locales,
      Key: { id_Locales: idLocalProp },
    }));
    estiloBrief = String(lr.Item?.estilo_visual_brief || '');
    refImagenesCount = normalizeEstiloImagenKeysFromItem(lr.Item?.estilo_visual_imagen_keys).length;
    estiloWeb = String(lr.Item?.web || '').trim();
  }

  const refPropuestaUrl = await resolvePropuestaRefImagenParaPrompt(propuesta.imagen_referencia_url);

  const promptGenerado = buildPromptPropuesta({
    estiloBrief,
    tipo: String(propuesta.tipo || ''),
    descripcion: String(propuesta.descripcion || ''),
    redes: Array.isArray(propuesta.redes) ? propuesta.redes : [],
    refImagenesCount,
    webUrl: estiloWeb,
    refPropuestaUrl,
  });

  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_MARKETING,
      Key: { id_propuesta: id },
      UpdateExpression: 'SET prompt_generado = :p',
      ExpressionAttributeValues: { ':p': promptGenerado },
    }));
  } catch (err) {
    throwSiTablaMarketingFalta(err);
  }

  res.json({ id_propuesta: id, prompt_generado: promptGenerado });
});

router.post('/marketing/carteles-musico/generar', requirePermission('marketing.gestionar'), async (req, res) => {
  const body = req.body || {};
  const idLocalRaw = String(body.id_local || '').trim();
  if (!idLocalRaw) throw badRequest('id_local es obligatorio');
  const idLocal = formatId6(idLocalRaw);
  if (!idLocal) throw badRequest('id_local inválido');
  const fechaInicio = String(body.fecha_inicio || '').trim();
  const fechaFin = String(body.fecha_fin || '').trim();
  if (!isFechaIso(fechaInicio)) throw badRequest('fecha_inicio debe ser YYYY-MM-DD');
  if (!isFechaIso(fechaFin)) throw badRequest('fecha_fin debe ser YYYY-MM-DD');
  if (fechaInicio > fechaFin) throw badRequest('fecha_inicio debe ser anterior o igual a fecha_fin');

  const agruparConciertos = parseBoolBody(body.agrupar_conciertos, false);

  // estilo_visual_brief del local
  const lr = await docClient.send(new GetCommand({
    TableName: tables.locales,
    Key: { id_Locales: idLocal },
  }));
  if (!lr.Item) throw notFound(`Local ${idLocal} no encontrado`);
  const estiloBrief = String(lr.Item.estilo_visual_brief || '');
  const nombreLocal = String(lr.Item.nombre || '').trim();
  const refImagenesCount = normalizeEstiloImagenKeysFromItem(lr.Item.estilo_visual_imagen_keys).length;
  const estiloWeb = String(lr.Item.web || '').trim();

  // Scan + filtro en memoria por id_local + rango de fechas (mismo patrón que /actuaciones).
  const allActuaciones = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.actuaciones,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    allActuaciones.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  const actuacionesFiltradas = allActuaciones.filter((a) => {
    const idl = formatId6(String(a.id_local || ''));
    if (idl !== idLocal) return false;
    const f = String(a.fecha || '');
    return f >= fechaInicio && f <= fechaFin;
  });

  // Para cada actuación, obtener artista (Get a tables.artistas).
  const artistaCache = new Map();
  const enriched = [];
  for (const act of actuacionesFiltradas) {
    const idArtista = String(act.id_artista || '').trim();
    let artista = null;
    if (idArtista) {
      if (artistaCache.has(idArtista)) {
        artista = artistaCache.get(idArtista);
      } else {
        const ar = await docClient.send(new GetCommand({
          TableName: tables.artistas,
          Key: { id_artista: idArtista },
        }));
        artista = ar.Item || null;
        artistaCache.set(idArtista, artista);
      }
    }
    const imagenArtistaUrl = artista ? await buildImagenArtistaUrl(artista.imagen_key) : null;
    enriched.push({ act, artista, imagenArtistaUrl });
  }

  enriched.sort((x, y) => {
    const cf = String(x.act.fecha || '').localeCompare(String(y.act.fecha || ''));
    if (cf !== 0) return cf;
    return String(x.act.hora_inicio || '').localeCompare(String(y.act.hora_inicio || ''));
  });

  let promptAgrupado = '';
  if (agruparConciertos && enriched.length > 0) {
    const filas = enriched.map(({ act, artista }) => ({
      fecha: String(act.fecha || ''),
      hora_inicio: String(act.hora_inicio || ''),
      nombre_artistico: artista?.nombre_artistico || 'Música en vivo',
      estilos: Array.isArray(artista?.estilos_musicales) && artista.estilos_musicales.length
        ? artista.estilos_musicales.join(', ')
        : 'música en vivo',
    }));
    promptAgrupado = buildPromptCartelMusicoAgrupado({
      estiloBrief,
      fechaInicio,
      fechaFin,
      nombreLocal,
      filas,
      refImagenesCount,
      webUrl: estiloWeb,
    });
  }

  const out = enriched.map(({ act, artista, imagenArtistaUrl }) => ({
    id_actuacion: String(act.id_actuacion || ''),
    nombre_artistico: artista?.nombre_artistico || '',
    fecha: String(act.fecha || ''),
    hora_inicio: String(act.hora_inicio || ''),
    imagen_artista_url: imagenArtistaUrl,
    prompt: agruparConciertos ? '' : buildPromptCartelMusico({
      estiloBrief,
      artista,
      fecha: String(act.fecha || ''),
      horaInicio: String(act.hora_inicio || ''),
      refImagenesCount,
      webUrl: estiloWeb,
    }),
  }));

  res.json({
    id_local: idLocal,
    fecha_inicio: fechaInicio,
    fecha_fin: fechaFin,
    agrupar_conciertos: agruparConciertos,
    ...(agruparConciertos ? { prompt_agrupado: promptAgrupado } : {}),
    carteles: out,
  });
});

router.get('/marketing/locales/:id/estilo', requirePermission('marketing.proponer'), async (req, res) => {
  const idLocal = formatId6(String(req.params.id || '').trim());
  await assertAccesoEstiloLocal(req, idLocal);
  const r = await docClient.send(new GetCommand({
    TableName: tables.locales,
    Key: { id_Locales: idLocal },
  }));
  if (!r.Item) throw notFound(`Local ${idLocal} no encontrado`);
  res.json({
    id_local: idLocal,
    estilo_visual_brief: String(r.Item.estilo_visual_brief || ''),
    estilo_visual_imagen_keys: normalizeEstiloImagenKeysFromItem(r.Item.estilo_visual_imagen_keys),
    web: String(r.Item.web || ''),
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Upload de imágenes (referencia / final / estilo-local). Multipart campo `tipo`:
// `referencia` | `final` | `estilo-local` (referencias de identidad visual del local).
// Disponible con marketing.proponer; la referencia de propuesta forma parte del flujo básico.
//
// Se guarda la S3 KEY (no la URL firmada). El frontend pide URLs con GET /marketing/imagen-url.
// ──────────────────────────────────────────────────────────────────────────

router.post(
  '/marketing/upload-imagen',
  requirePermission('marketing.proponer'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) throw badRequest('Falta el archivo (campo "file")');
    const mime = req.file.mimetype;
    if (!MIMES_IMAGEN_VALIDOS.has(mime)) {
      throw badRequest('Tipo de imagen no soportado. Usa JPEG, PNG o WebP.');
    }
    const tipoRaw = String(req.body?.tipo || 'referencia').trim().toLowerCase().replace(/-/g, '_');
    let subfolder = 'referencia';
    if (tipoRaw === 'final') subfolder = 'final';
    else if (tipoRaw === 'estilo_local') subfolder = 'estilo-local';
    const ext = EXT_POR_MIME[mime];
    const key = `marketing/${subfolder}/${crypto.randomUUID()}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: mime,
    }));

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      { expiresIn: 3600 },
    );
    res.status(201).json({ key, url, expiresIn: 3600 });
  },
);

router.get(
  '/marketing/imagen-url',
  requirePermission('marketing.proponer'),
  async (req, res) => {
    const key = String(req.query?.key || '').trim();
    if (!key) throw badRequest('key es obligatorio');
    if (!key.startsWith('marketing/')) {
      throw badRequest('key fuera del namespace de marketing');
    }
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      { expiresIn: 3600 },
    );
    res.json({ url, expiresIn: 3600 });
  },
);

router.patch('/marketing/locales/:id/estilo', requirePermission('marketing.proponer'), async (req, res) => {
  const idLocal = formatId6(String(req.params.id || '').trim());
  await assertAccesoEstiloLocal(req, idLocal);
  const body = req.body || {};

  const r = await docClient.send(new GetCommand({
    TableName: tables.locales,
    Key: { id_Locales: idLocal },
  }));
  if (!r.Item) throw notFound(`Local ${idLocal} no encontrado`);

  const prevBrief = String(r.Item.estilo_visual_brief || '');
  const prevKeys = normalizeEstiloImagenKeysFromItem(r.Item.estilo_visual_imagen_keys);
  const prevWeb = String(r.Item.web || '');

  const estilo =
    body.estilo_visual_brief !== undefined && body.estilo_visual_brief !== null
      ? String(body.estilo_visual_brief).slice(0, MAX_ESTILO_BRIEF_CHARS)
      : prevBrief;

  const keys =
    body.estilo_visual_imagen_keys !== undefined && body.estilo_visual_imagen_keys !== null
      ? sanitizeEstiloImagenKeysFromBody(body.estilo_visual_imagen_keys)
      : prevKeys;

  const web = sanitizeEstiloWebUrl(body.web, prevWeb);

  await docClient.send(new UpdateCommand({
    TableName: tables.locales,
    Key: { id_Locales: idLocal },
    UpdateExpression: 'SET estilo_visual_brief = :s, estilo_visual_imagen_keys = :k, web = :w',
    ExpressionAttributeValues: { ':s': estilo, ':k': keys, ':w': web },
  }));

  res.json({ id_local: idLocal, estilo_visual_brief: estilo, estilo_visual_imagen_keys: keys, web });
});

export default router;
