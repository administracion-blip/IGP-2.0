/**
 * Arqueos reales (conteo manual) vs cierres teóricos — tabla Igp_ArqueosReales
 * PK = workplaceId, SK = yyyy-mm-dd#posId
 */
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { QueryCommand, GetCommand, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { docClient, tables } from '../lib/db.js';
import { parseTextoTicketTarjeta } from '../lib/ocrTicketTarjeta.js';
import {
  listFormasPago,
  buildResolver,
  mergeTeoricoAmounts,
  grupoDeForma,
  FORMAS_PAGO_CONOCIDAS,
} from '../lib/agora/formasPago.js';
import {
  totalesMovimientosTpv,
  GRUPO_EFECTIVO,
  GRUPO_PREPAGO,
} from '../lib/cajas/movimientos.js';

/** Grupo canónico de tarjeta (para banderas de boletas en la revisión). */
const GRUPO_TARJETA = 'Tarjeta';

const router = express.Router();
const uploadOcr = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

const region = process.env.AWS_REGION || 'eu-west-3';
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region });
const tableArqueos = tables.arqueosReales;
const tableCloseouts = tables.salesCloseOuts;

/**
 * Campos planos históricos del arqueo ↔ grupo canónico de forma de pago.
 * Se siguen escribiendo por compatibilidad con datos/consumidores antiguos,
 * además del mapa dinámico `realPorMetodo`.
 */
const LEGACY_FIELDS = [
  { field: 'efectivoReal', grupo: 'Efectivo' },
  { field: 'tarjetaReal', grupo: 'Tarjeta' },
  { field: 'pendienteCobroReal', grupo: 'Pendiente de cobro' },
  { field: 'prepagoTransferenciaReal', grupo: 'Prepago Transferencia' },
  { field: 'agoraPayReal', grupo: 'AgoraPay' },
];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? round2(n) : 0;
}

/** Carga el maestro de formas de pago y su resolver (con fallback a conocidas). */
async function loadResolver() {
  let formas = [];
  try {
    formas = await listFormasPago();
  } catch (e) {
    console.warn('[arqueos] listFormasPago falló, uso fallback:', e.message || e);
  }
  return { formas, resolver: buildResolver(formas) };
}

/**
 * Lista de métodos a mostrar/arquear.
 * Las 5 formas canónicas históricas (Efectivo, Tarjeta, Pendiente de cobro,
 * Prepago Transferencia, AgoraPay) están SIEMPRE presentes y ordenadas: Ágora
 * no expone "Efectivo" en su maestro, así que no podemos depender de la tabla
 * para la base. El maestro solo ajusta `arquear`/`orden` y añade grupos nuevos;
 * por último se añaden los grupos que aparezcan en teórico/real y no estén ya.
 * Cada método: { grupo, label, arquear, orden }.
 */
function buildMetodos(formas, teorico, realMap) {
  // 1. Config del maestro agrupada por grupo (canónico o nombre).
  const tabla = new Map();
  for (const f of formas || []) {
    if (f.activo === false) continue;
    const grupo = grupoDeForma(f);
    if (!grupo) continue;
    const arquear = f.arquear !== false;
    const orden = Number(f.orden ?? 99);
    const prev = tabla.get(grupo);
    if (!prev) tabla.set(grupo, { arquear, orden });
    else {
      prev.arquear = prev.arquear || arquear;
      prev.orden = Math.min(prev.orden, orden);
    }
  }

  // 2. Base canónica fija; el maestro la sobrescribe si existe para ese grupo.
  const map = new Map();
  for (const c of FORMAS_PAGO_CONOCIDAS) {
    const t = tabla.get(c.canonico);
    map.set(c.canonico, {
      grupo: c.canonico,
      label: c.canonico,
      arquear: t ? t.arquear : true,
      orden: t ? t.orden : c.orden,
    });
  }

  // 3. Grupos del maestro que no son canónicos (formas nuevas de Ágora).
  for (const [grupo, t] of tabla) {
    if (!map.has(grupo)) map.set(grupo, { grupo, label: grupo, arquear: t.arquear, orden: t.orden });
  }

  // 4. Grupos presentes en teórico o real que no estén aún (no perder importes).
  let extra = 1000;
  for (const grupo of [...Object.keys(teorico || {}), ...Object.keys(realMap || {})]) {
    if (grupo && !map.has(grupo)) map.set(grupo, { grupo, label: grupo, arquear: true, orden: extra++ });
  }

  return [...map.values()].sort(
    (a, b) => (a.orden - b.orden) || a.grupo.localeCompare(b.grupo)
  );
}

/** Real guardado → mapa por grupo, migrando "al vuelo" registros antiguos. */
function realMapFromItem(item) {
  const out = {};
  if (!item) return out;
  if (item.realPorMetodo && typeof item.realPorMetodo === 'object' && !Array.isArray(item.realPorMetodo)) {
    for (const [k, v] of Object.entries(item.realPorMetodo)) out[k] = parseNum(v);
    return out;
  }
  for (const { field, grupo } of LEGACY_FIELDS) {
    if (item[field] != null && item[field] !== '') out[grupo] = parseNum(item[field]);
  }
  return out;
}

/** Diferencia real − teórico por grupo. arquear=false ⇒ real = teórico (diff 0). */
function buildDiff(teorico, realMap, metodos) {
  const diff = {};
  for (const m of metodos) {
    const t = teorico[m.grupo] ?? 0;
    const real = m.arquear ? (realMap[m.grupo] ?? 0) : t;
    diff[m.grupo] = round2(real - t);
  }
  return diff;
}

/** Suma algebraica de las diferencias por grupo (descuadre total). */
function sumDescuadreFromDiff(diff) {
  let s = 0;
  for (const v of Object.values(diff)) s += Number(v) || 0;
  return round2(s);
}

/**
 * Real efectivo para el cálculo de diferencias, aplicando movimientos de caja:
 *  - Efectivo: contado + retiradas (el dinero retirado es recaudación real que
 *    salió del cajón, así que se suma para cuadrar con el teórico).
 *  - Prepago Transferencia: importe automático = suma de transferencias.
 * No muta el mapa original (el `real` que se muestra/edita en pantalla).
 */
function effectiveRealMap(realMap, retiradas, transferencias) {
  const eff = { ...realMap };
  eff[GRUPO_EFECTIVO] = round2((Number(realMap[GRUPO_EFECTIVO]) || 0) + (Number(retiradas) || 0));
  eff[GRUPO_PREPAGO] = round2(Number(transferencias) || 0);
  return eff;
}

/** Marca en los métodos el efecto de los movimientos de caja (para la UI). */
function annotateMovimientos(metodos, retiradas, transferencias) {
  return metodos.map((m) => {
    if (m.grupo === GRUPO_EFECTIVO) return { ...m, ajusteRetiradas: round2(retiradas) };
    if (m.grupo === GRUPO_PREPAGO) return { ...m, auto: true, autoImporte: round2(transferencias) };
    return m;
  });
}

const MAX_TARJETA_LINEAS = 20;

/** @returns {Array<Record<string, string>>|null} null = no enviar; [] = sin líneas */
function sanitizeTarjetaLineas(body) {
  const raw = body?.tarjetaLineas ?? body?.tarjeta_lineas;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];
  const out = [];
  for (let i = 0; i < Math.min(raw.length, MAX_TARJETA_LINEAS); i++) {
    const x = raw[i];
    if (!x || typeof x !== 'object') continue;
    out.push({
      id: String(x.id ?? `line-${i}`).slice(0, 64),
      banco: String(x.banco ?? '').trim().slice(0, 80),
      importe: String(x.importe ?? '').trim().slice(0, 24),
      numeroComercio: String(x.numeroComercio ?? x.numero_comercio ?? '').trim().slice(0, 40),
      fechaHora: String(x.fechaHora ?? x.fecha_hora ?? '').trim().slice(0, 64),
      imagenKey: String(x.imagenKey ?? x.imagen_key ?? '').trim().slice(0, 512),
      ocrCompletado: Boolean(x.ocrCompletado ?? x.ocr_completado),
    });
  }
  return out;
}

function sumTarjetaLineas(lineas) {
  let s = 0;
  for (const l of lineas) s += parseNum(l.importe);
  return round2(s);
}

/**
 * Desglose de efectivo por denominación: { "50": 2, "0.5": 10 }.
 * @returns {Record<string, number>|null} null = no enviar (conservar el previo).
 */
function sanitizeEfectivoConteo(body) {
  const raw = body?.efectivoConteo ?? body?.efectivo_conteo;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    const qty = Math.trunc(Number(v));
    if (key && Number.isFinite(qty) && qty > 0) out[key] = qty;
  }
  return out;
}

function validTicketKey(key) {
  if (!key || typeof key !== 'string') return false;
  return key.startsWith('arqueos-tickets/') && !key.includes('..');
}

// GET /api/cajas/arqueos-reales?workplaceId=&businessDay=opcional
router.get('/cajas/arqueos-reales', async (req, res) => {
  const workplaceId = String(req.query.workplaceId || '').trim();
  if (!workplaceId) return res.status(400).json({ error: 'workplaceId obligatorio' });
  const businessDay = String(req.query.businessDay || '').trim();
  try {
    const params = {
      TableName: tableArqueos,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': workplaceId },
    };
    if (businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      params.KeyConditionExpression = 'PK = :pk AND begins_with(SK, :bd)';
      params.ExpressionAttributeValues = { ':pk': workplaceId, ':bd': businessDay };
    }
    const result = await docClient.send(new QueryCommand(params));
    const items = (result.Items || []).sort((a, b) => String(a.SK || '').localeCompare(String(b.SK || '')));
    res.json({ arqueos: items });
  } catch (err) {
    console.error('[cajas/arqueos-reales GET]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar arqueos' });
  }
});

// GET /api/cajas/arqueos-reales/compare?workplaceId=&businessDay=&posId=
router.get('/cajas/arqueos-reales/compare', async (req, res) => {
  const workplaceId = String(req.query.workplaceId || '').trim();
  const businessDay = String(req.query.businessDay || '').trim();
  const posId = String(req.query.posId ?? '').trim();
  if (!workplaceId || !businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay) || !posId) {
    return res.status(400).json({ error: 'workplaceId, businessDay (YYYY-MM-DD) y posId obligatorios' });
  }
  const skPrefix = `${businessDay}#${posId}#`;
  try {
    const qClose = await docClient.send(new QueryCommand({
      TableName: tableCloseouts,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': workplaceId, ':sk': skPrefix },
    }));
    const closeouts = qClose.Items || [];
    const { resolver } = await loadResolver();
    const teorico = mergeTeoricoAmounts(closeouts, resolver);

    const skArqueo = `${businessDay}#${posId}`;
    const getArqueo = await docClient.send(new GetCommand({
      TableName: tableArqueos,
      Key: { PK: workplaceId, SK: skArqueo },
    }));
    const real = getArqueo.Item || null;

    const realMap = realMapFromItem(real);
    // Movimientos de caja del TPV: retiradas (suma a efectivo) y transferencias
    // (real automático de prepago). El prepago se muestra ya con su importe auto.
    const { retiradas, transferencias } = await totalesMovimientosTpv(workplaceId, businessDay, posId);
    realMap[GRUPO_PREPAGO] = round2(transferencias);

    // resolver.list incluye las formas conocidas como fallback si la tabla está vacía.
    let metodos = buildMetodos(resolver.list, teorico, realMap);
    metodos = annotateMovimientos(metodos, retiradas, transferencias);
    const effective = effectiveRealMap(realMap, retiradas, transferencias);
    const diff = buildDiff(teorico, effective, metodos);
    const descuadreTotal = sumDescuadreFromDiff(diff);

    res.json({
      workplaceId,
      businessDay,
      posId,
      skArqueo,
      closeoutsCount: closeouts.length,
      metodos,
      teorico,
      real: realMap,
      realGuardado: real,
      estado: real?.estado ?? null,
      movimientos: { retiradas: round2(retiradas), transferencias: round2(transferencias) },
      diff,
      descuadreTotal,
    });
  } catch (err) {
    console.error('[cajas/arqueos-reales/compare]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al comparar' });
  }
});

// POST /api/cajas/arqueos-reales/ocr-ticket — multipart: imagen + opcional workplaceId, businessDay, lineId
router.post('/cajas/arqueos-reales/ocr-ticket', uploadOcr.single('imagen'), async (req, res) => {
  const file = req.file;
  if (!file?.buffer) return res.status(400).json({ error: 'Falta imagen (campo imagen)' });
  const workplaceId = String(req.body.workplaceId || '').trim();
  const businessDay = String(req.body.businessDay || '').trim();
  const lineId = String(req.body.lineId || '').trim() || randomUUID();
  try {
    let buf = file.buffer;
    try {
      buf = await sharp(buf)
        .rotate()
        .resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true })
        .greyscale()
        .normalize()
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch (e) {
      console.warn('[ocr-ticket] sharp', e.message || e);
    }

    const { data } = await Tesseract.recognize(buf, 'spa+eng', { logger: () => {} });
    const text = data?.text || '';
    const parsed = parseTextoTicketTarjeta(text);

    let imagenKey = '';
    try {
      const prefix =
        workplaceId && businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)
          ? `arqueos-tickets/${workplaceId}/${businessDay}/${lineId}-${randomUUID()}.jpg`
          : `arqueos-tickets/anon/${randomUUID()}.jpg`;
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: prefix,
          Body: buf,
          ContentType: 'image/jpeg',
        }),
      );
      imagenKey = prefix;
    } catch (e) {
      console.error('[ocr-ticket] S3', e.message || e);
    }

    let imagenUrl = '';
    if (imagenKey) {
      try {
        imagenUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: S3_BUCKET, Key: imagenKey }),
          { expiresIn: 900 },
        );
      } catch (_) {
        /* noop */
      }
    }

    res.json({
      ok: true,
      imagenKey,
      imagenUrl,
      banco: parsed.banco,
      importe: parsed.importe,
      numeroComercio: parsed.numeroComercio,
      fechaHora: parsed.fechaHora,
      ocrRaw: String(parsed.ocrRaw || '').slice(0, 2000),
    });
  } catch (err) {
    console.error('[cajas/arqueos-reales/ocr-ticket]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al leer el ticket' });
  }
});

// GET /api/cajas/arqueos-reales/ticket-image-url?key=arqueos-tickets/...
router.get('/cajas/arqueos-reales/ticket-image-url', async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!validTicketKey(key)) return res.status(400).json({ error: 'key no válida' });
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      { expiresIn: 900 },
    );
    res.json({ url });
  } catch (err) {
    console.error('[cajas/arqueos-reales/ticket-image-url]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al generar URL' });
  }
});

// PUT /api/cajas/arqueos-reales — crear o actualizar
router.put('/cajas/arqueos-reales', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.PK ?? body.workplaceId ?? '').trim();
  const businessDay = String(body.BusinessDay ?? body.businessDay ?? '').trim();
  const posId = body.PosId ?? body.posId ?? '';
  if (!pk || !businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'PK (workplaceId) y BusinessDay (YYYY-MM-DD) obligatorios' });
  }
  if (posId === '' || posId == null) return res.status(400).json({ error: 'PosId obligatorio' });
  const posIdStr = String(posId).trim();
  const sk = `${businessDay}#${posIdStr}`;
  const now = new Date().toISOString();

  // No se puede modificar un arqueo si la jornada del local ya está cerrada.
  const jornadaCerrada = await docClient.send(new GetCommand({
    TableName: tables.jornadasLocal,
    Key: { PK: pk, SK: businessDay },
  })).then((r) => r.Item?.estado === 'cerrada').catch(() => false);
  if (jornadaCerrada) {
    return res.status(409).json({ error: 'La jornada del local está cerrada. Reábrela para modificar arqueos.' });
  }

  const existing = await docClient.send(new GetCommand({
    TableName: tableArqueos,
    Key: { PK: pk, SK: sk },
  })).then((r) => r.Item);

  const lineasSan = sanitizeTarjetaLineas(body);
  const lineasEfectivas =
    lineasSan !== null
      ? lineasSan
      : (Array.isArray(existing?.tarjetaLineas) ? existing.tarjetaLineas : []);

  // Desglose de efectivo: si llega se usa; si no, se conserva el previo.
  const conteoSan = sanitizeEfectivoConteo(body);
  const efectivoConteo =
    conteoSan !== null
      ? conteoSan
      : (existing?.efectivoConteo && typeof existing.efectivoConteo === 'object' ? existing.efectivoConteo : {});

  // Mapa de reales por grupo: prioridad al mapa dinámico; si no llega, se
  // reconstruye desde los campos planos del body (compatibilidad).
  const realMap = {};
  const rawMap = body.realPorMetodo ?? body.real_por_metodo;
  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    for (const [k, v] of Object.entries(rawMap)) {
      const grupo = String(k).trim();
      if (grupo) realMap[grupo] = parseNum(v);
    }
  } else {
    for (const { field, grupo } of LEGACY_FIELDS) {
      const snake = field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
      const val = body[field] ?? body[snake];
      if (val != null && val !== '') realMap[grupo] = parseNum(val);
    }
  }

  // La tarjeta cuadra con la suma de boletas cuando hay líneas con OCR.
  if (lineasEfectivas.length > 0) {
    realMap.Tarjeta = sumTarjetaLineas(lineasEfectivas);
  }

  // Movimientos de caja del TPV. El prepago es automático (suma de transferencias)
  // y las retiradas se suman al efectivo solo para el cálculo del descuadre.
  const { retiradas, transferencias } = await totalesMovimientosTpv(pk, businessDay, posIdStr);
  realMap[GRUPO_PREPAGO] = round2(transferencias);

  const skPrefixClose = `${businessDay}#${posIdStr}#`;
  const { resolver } = await loadResolver();
  let teorico = {};
  try {
    const qClose = await docClient.send(new QueryCommand({
      TableName: tableCloseouts,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefixClose },
    }));
    teorico = mergeTeoricoAmounts(qClose.Items || [], resolver);
  } catch (e) {
    console.error('[cajas/arqueos-reales PUT] descuadre', e.message || e);
  }
  const metodos = buildMetodos(resolver.list, teorico, realMap);
  const effective = effectiveRealMap(realMap, retiradas, transferencias);
  const diff = buildDiff(teorico, effective, metodos);
  const descuadreTotal = sumDescuadreFromDiff(diff);

  // Campos planos derivados del mapa (compatibilidad con datos antiguos).
  const legacyValues = {};
  for (const { field, grupo } of LEGACY_FIELDS) {
    legacyValues[field] = realMap[grupo] ?? 0;
  }

  const item = {
    PK: pk,
    SK: sk,
    BusinessDay: businessDay,
    PosId: posIdStr,
    PosName: body.PosName ?? body.posName ?? existing?.PosName ?? '',
    WorkplaceName: body.WorkplaceName ?? body.workplaceName ?? existing?.WorkplaceName ?? '',
    ...legacyValues,
    realPorMetodo: realMap,
    tarjetaLineas: lineasEfectivas,
    efectivoConteo,
    retiradasEfectivo: round2(retiradas),
    transferenciasPrepago: round2(transferencias),
    descuadreTotal,
    descuadreActualizadoEn: now,
    // Estado del arqueo del TPV. Se conserva al reguardar (no se cierra solo).
    estado: existing?.estado === 'cerrado' ? 'cerrado' : 'borrador',
    cerradoEn: existing?.cerradoEn ?? null,
    cerradoPor: existing?.cerradoPor ?? null,
    // Visto bueno de revisión (centro de mando). Se conserva al reguardar.
    revisado: existing?.revisado === true,
    revisadoEn: existing?.revisadoEn ?? null,
    revisadoPor: existing?.revisadoPor ?? null,
    creadoEn: existing?.creadoEn ?? now,
    actualizadoEn: now,
    usuarioId: body.usuarioId ?? body.usuario_id ?? existing?.usuarioId ?? '',
    usuarioNombre: body.usuarioNombre ?? body.usuario_nombre ?? existing?.usuarioNombre ?? '',
  };

  try {
    await docClient.send(new PutCommand({ TableName: tableArqueos, Item: item }));
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[cajas/arqueos-reales PUT]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al guardar arqueo' });
  }
});

// POST /api/cajas/arqueos-reales/estado — cerrar o reabrir el arqueo de un TPV
// body: { workplaceId|PK, businessDay, posId, estado: 'cerrado'|'borrador', usuarioId?, usuarioNombre? }
router.post('/cajas/arqueos-reales/estado', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.workplaceId ?? body.PK ?? '').trim();
  const businessDay = String(body.businessDay ?? body.BusinessDay ?? '').trim();
  const posId = String(body.posId ?? body.PosId ?? '').trim();
  const estado = String(body.estado || '').trim();
  if (!pk || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay) || !posId) {
    return res.status(400).json({ error: 'workplaceId, businessDay (YYYY-MM-DD) y posId obligatorios' });
  }
  if (estado !== 'cerrado' && estado !== 'borrador') {
    return res.status(400).json({ error: "estado debe ser 'cerrado' o 'borrador'" });
  }
  const sk = `${businessDay}#${posId}`;
  try {
    const existing = await docClient.send(new GetCommand({
      TableName: tableArqueos,
      Key: { PK: pk, SK: sk },
    })).then((r) => r.Item);
    if (!existing) {
      return res.status(404).json({ error: 'No hay arqueo guardado para este TPV; guárdalo antes de cerrarlo.' });
    }
    // Si la jornada del local está cerrada, no se puede tocar el estado del TPV.
    const jornada = await docClient.send(new GetCommand({
      TableName: tables.jornadasLocal,
      Key: { PK: pk, SK: businessDay },
    })).then((r) => r.Item).catch(() => null);
    if (jornada?.estado === 'cerrada') {
      return res.status(409).json({ error: 'La jornada del local está cerrada. Reábrela para modificar arqueos.' });
    }
    const now = new Date().toISOString();
    const item = {
      ...existing,
      estado,
      cerradoEn: estado === 'cerrado' ? now : null,
      cerradoPor: estado === 'cerrado'
        ? (String(body.usuarioNombre ?? body.usuario_nombre ?? req.user?.nombre ?? '').trim() || null)
        : null,
      actualizadoEn: now,
    };
    await docClient.send(new PutCommand({ TableName: tableArqueos, Item: item }));
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[cajas/arqueos-reales/estado]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al cambiar el estado del arqueo' });
  }
});

// POST /api/cajas/arqueos-reales/revisado — marca/desmarca el visto bueno de revisión
// body: { workplaceId|PK, businessDay, posId, revisado:boolean, usuarioId?, usuarioNombre? }
router.post('/cajas/arqueos-reales/revisado', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.workplaceId ?? body.PK ?? '').trim();
  const businessDay = String(body.businessDay ?? body.BusinessDay ?? '').trim();
  const posId = String(body.posId ?? body.PosId ?? '').trim();
  const revisado = body.revisado === true || body.revisado === 'true';
  if (!pk || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay) || !posId) {
    return res.status(400).json({ error: 'workplaceId, businessDay (YYYY-MM-DD) y posId obligatorios' });
  }
  const sk = `${businessDay}#${posId}`;
  try {
    const existing = await docClient.send(new GetCommand({
      TableName: tableArqueos,
      Key: { PK: pk, SK: sk },
    })).then((r) => r.Item);
    if (!existing) {
      return res.status(404).json({ error: 'No hay arqueo guardado para este TPV.' });
    }
    const now = new Date().toISOString();
    const item = {
      ...existing,
      revisado,
      revisadoEn: revisado ? now : null,
      revisadoPor: revisado
        ? (String(body.usuarioNombre ?? body.usuario_nombre ?? req.user?.nombre ?? '').trim() || null)
        : null,
      actualizadoEn: now,
    };
    await docClient.send(new PutCommand({ TableName: tableArqueos, Item: item }));
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[cajas/arqueos-reales/revisado]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al marcar la revisión' });
  }
});

/** Suma de importes de las boletas de tarjeta de un arqueo guardado. */
function sumImportesBoletas(arqueo) {
  const lineas = Array.isArray(arqueo?.tarjetaLineas) ? arqueo.tarjetaLineas : [];
  let s = 0;
  for (const l of lineas) s += parseNum(l?.importe);
  return round2(s);
}

/** Banderas de incidencia en boletas de tarjeta. */
function flagsBoletas(arqueo) {
  const lineas = Array.isArray(arqueo?.tarjetaLineas) ? arqueo.tarjetaLineas : [];
  let sinImagen = false;
  let sinOcr = false;
  for (const l of lineas) {
    const tieneImagen = !!(l?.imagenKey);
    if (!tieneImagen) sinImagen = true;
    else if (!l?.ocrCompletado || !l?.banco) sinOcr = true;
  }
  return { numBoletas: lineas.length, sinImagen, sinOcr };
}

/**
 * Construye la celda de revisión de un TPV (día) a partir de sus cierres y su arqueo.
 * No aplica tolerancia: devuelve importes y banderas; el coloreado/umbral es del front.
 */
function buildCeldaRevision({ posId, posName, closeouts, arqueo, retiradas, transferencias, resolver }) {
  const teorico = mergeTeoricoAmounts(closeouts, resolver);
  const realMap = realMapFromItem(arqueo);
  realMap[GRUPO_PREPAGO] = round2(transferencias);
  const metodos = buildMetodos(resolver.list, teorico, realMap);
  const effective = effectiveRealMap(realMap, retiradas, transferencias);
  const diff = buildDiff(teorico, effective, metodos);
  const descuadreTotal = arqueo ? round2(arqueo.descuadreTotal) : sumDescuadreFromDiff(diff);

  const sumaBoletas = sumImportesBoletas(arqueo);
  const boletas = flagsBoletas(arqueo);
  const tarjetaTeorica = round2(teorico[GRUPO_TARJETA] ?? 0);
  // Solo evaluamos descuadre de boletas si hay boletas registradas.
  const tarjetaDiffBoletas = boletas.numBoletas > 0 ? round2(sumaBoletas - tarjetaTeorica) : 0;

  return {
    posId: String(posId),
    posName: posName || `TPV ${posId}`,
    estadoArqueo: arqueo ? (arqueo.estado === 'cerrado' ? 'cerrado' : 'borrador') : 'sin_arqueo',
    revisado: arqueo?.revisado === true,
    revisadoPor: arqueo?.revisadoPor ?? null,
    closeoutsCount: closeouts.length,
    teorico,
    real: realMap,
    diff,
    descuadreTotal,
    diffEfectivo: round2(diff[GRUPO_EFECTIVO] ?? 0),
    diffTarjeta: round2(diff[GRUPO_TARJETA] ?? 0),
    movimientos: { retiradas: round2(retiradas), transferencias: round2(transferencias) },
    tarjeta: {
      teorica: tarjetaTeorica,
      sumaBoletas,
      diffBoletas: tarjetaDiffBoletas,
      ...boletas,
    },
  };
}

// GET /api/cajas/revision?dateFrom=&dateTo=&workplaceIds=code1,code2
// Centro de mando: cruza teórico (cierres) y real (arqueo) por local → TPV → día.
router.get('/cajas/revision', async (req, res) => {
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || req.query.dateFrom || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo (YYYY-MM-DD) obligatorios' });
  }
  const workplaceIds = String(req.query.workplaceIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (workplaceIds.length === 0) {
    return res.status(400).json({ error: 'workplaceIds obligatorio (códigos Ágora separados por coma)' });
  }
  const lo = dateFrom;
  const hi = `${dateTo}#\uffff`;
  try {
    const { resolver } = await loadResolver();
    const locales = [];

    for (const wp of workplaceIds) {
      // Cierres teóricos del rango.
      const qClose = await docClient.send(new QueryCommand({
        TableName: tableCloseouts,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':pk': wp, ':lo': lo, ':hi': hi },
      }));
      // Arqueos del rango (SK = businessDay#posId).
      const qArq = await docClient.send(new QueryCommand({
        TableName: tableArqueos,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':pk': wp, ':lo': lo, ':hi': hi },
      }));
      // Movimientos del rango (SK = businessDay#posId#tipo#id).
      const qMov = await docClient.send(new QueryCommand({
        TableName: tables.movimientosCaja,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':pk': wp, ':lo': lo, ':hi': hi },
      })).catch(() => ({ Items: [] }));
      // Jornadas del rango (SK = businessDay).
      const qJor = await docClient.send(new QueryCommand({
        TableName: tables.jornadasLocal,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi2',
        ExpressionAttributeValues: { ':pk': wp, ':lo': lo, ':hi2': dateTo },
      })).catch(() => ({ Items: [] }));

      const closeouts = qClose.Items || [];
      const arqueos = qArq.Items || [];
      const movimientos = qMov.Items || [];
      const jornadas = qJor.Items || [];

      // Índices por día.
      const arqueoByDayPos = new Map(); // `${day}#${posId}` -> arqueo
      for (const a of arqueos) arqueoByDayPos.set(`${a.BusinessDay}#${a.PosId}`, a);
      const jornadaByDay = new Map();
      for (const j of jornadas) jornadaByDay.set(String(j.SK), j);

      // Agrupar cierres por día#posId y guardar el nombre de TPV/local.
      const closeoutsByDayPos = new Map();
      let workplaceName = '';
      for (const c of closeouts) {
        if (!workplaceName) workplaceName = String(c.WorkplaceName ?? c.workplaceName ?? '').trim();
        const sk = String(c.SK || '');
        const parts = sk.split('#');
        const day = c.BusinessDay ?? parts[0] ?? '';
        const posId = parts[1] ?? String(c.PosId ?? '');
        if (!day) continue;
        const key = `${day}#${posId}`;
        if (!closeoutsByDayPos.has(key)) closeoutsByDayPos.set(key, []);
        closeoutsByDayPos.get(key).push(c);
      }
      if (!workplaceName) {
        workplaceName = String(arqueos[0]?.WorkplaceName ?? '').trim() || wp;
      }

      // Movimientos agregados por día#posId.
      const movByDayPos = new Map();
      for (const m of movimientos) {
        const key = `${m.BusinessDay}#${m.PosId}`;
        const cur = movByDayPos.get(key) || { retiradas: 0, transferencias: 0 };
        const imp = parseNum(m.importe);
        if (m.tipo === 'retirada') cur.retiradas += imp;
        else if (m.tipo === 'transferencia') cur.transferencias += imp;
        movByDayPos.set(key, cur);
      }

      // Conjunto de claves día#posId (unión cierres + arqueos).
      const claves = new Set([...closeoutsByDayPos.keys(), ...arqueoByDayPos.keys()]);

      // Estructura por día → tpvs.
      const dias = new Map(); // day -> { tpvs:[], ... }
      for (const key of claves) {
        const [day, posId] = key.split('#');
        const arqueo = arqueoByDayPos.get(key) || null;
        const grupoCloseouts = closeoutsByDayPos.get(key) || [];
        const mov = movByDayPos.get(key) || { retiradas: 0, transferencias: 0 };
        const posName = String(arqueo?.PosName ?? grupoCloseouts[0]?.PosName ?? grupoCloseouts[0]?.SaleCenterName ?? '').trim();
        const celda = buildCeldaRevision({
          posId,
          posName,
          closeouts: grupoCloseouts,
          arqueo,
          retiradas: mov.retiradas,
          transferencias: mov.transferencias,
          resolver,
        });
        if (!dias.has(day)) dias.set(day, []);
        dias.get(day).push(celda);
      }

      // Construir array de días con consolidado de local.
      const diasArr = [];
      for (const [day, tpvs] of dias) {
        tpvs.sort((a, b) => String(a.posName).localeCompare(String(b.posName)));
        const teoLocal = {};
        const realLocal = {};
        let descuadreLocal = 0;
        for (const t of tpvs) {
          for (const [g, v] of Object.entries(t.teorico)) teoLocal[g] = round2((teoLocal[g] ?? 0) + (Number(v) || 0));
          for (const [g, v] of Object.entries(t.real)) realLocal[g] = round2((realLocal[g] ?? 0) + (Number(v) || 0));
          if (t.estadoArqueo !== 'sin_arqueo') descuadreLocal += Number(t.descuadreTotal) || 0;
        }
        const conArqueo = tpvs.filter((t) => t.estadoArqueo !== 'sin_arqueo');
        const sinArqueo = tpvs.filter((t) => t.estadoArqueo === 'sin_arqueo').length;
        const borradores = tpvs.filter((t) => t.estadoArqueo === 'borrador').length;
        const revisados = tpvs.filter((t) => t.revisado).length;
        const jornada = jornadaByDay.get(day) || null;
        diasArr.push({
          businessDay: day,
          tpvs,
          teorico: teoLocal,
          real: realLocal,
          descuadreTotal: round2(descuadreLocal),
          totalTpvs: tpvs.length,
          conArqueo: conArqueo.length,
          sinArqueo,
          borradores,
          revisados,
          estadoJornada: jornada?.estado ?? 'abierta',
        });
      }
      diasArr.sort((a, b) => a.businessDay.localeCompare(b.businessDay));

      locales.push({ workplaceId: wp, workplaceName, dias: diasArr });
    }

    res.json({ dateFrom, dateTo, locales });
  } catch (err) {
    console.error('[cajas/revision]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al construir la revisión de cajas' });
  }
});

/** Valor mínimo (en €) para considerar una denominación como billete (resto = monedas). */
const DENOM_BILLETE_MIN = 5;

/** Normaliza un nombre de sociedad/empresa para cruzar local.empresa con empresas.Nombre. */
function normNombreEmpresa(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Desglosa un mapa de conteo { "50": 2, "0.5": 10 } en billetes/monedas (importe €). */
function desglosarConteo(efectivoConteo) {
  let billetes = 0;
  let monedas = 0;
  if (efectivoConteo && typeof efectivoConteo === 'object' && !Array.isArray(efectivoConteo)) {
    for (const [k, v] of Object.entries(efectivoConteo)) {
      const valor = parseFloat(String(k).replace(',', '.'));
      const qty = Math.trunc(Number(v));
      if (!Number.isFinite(valor) || !Number.isFinite(qty) || qty <= 0) continue;
      const imp = valor * qty;
      if (valor >= DENOM_BILLETE_MIN) billetes += imp;
      else monedas += imp;
    }
  }
  return { billetes: round2(billetes), monedas: round2(monedas) };
}

// GET /api/cajas/efectivo-ingresar?dateFrom=&dateTo=&workplaceIds=code1,code2
// Total de efectivo a ingresar en banco por sociedad → local, en un rango.
// "A ingresar" = efectivo contado en el arqueo + retiradas de efectivo (que también
// se ingresan). Las retiradas cuentan siempre como billetes.
router.get('/cajas/efectivo-ingresar', async (req, res) => {
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || req.query.dateFrom || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo (YYYY-MM-DD) obligatorios' });
  }
  const workplaceIds = String(req.query.workplaceIds || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (workplaceIds.length === 0) {
    return res.status(400).json({ error: 'workplaceIds obligatorio (códigos Ágora separados por coma)' });
  }
  const lo = dateFrom;
  const hi = `${dateTo}#\uffff`;
  try {
    // Maestros: local (agoraCode → empresa) y empresa (Nombre → IBAN).
    const scanAll = async (TableName, ProjectionExpression) => {
      const items = [];
      let lastKey = null;
      do {
        const r = await docClient.send(new ScanCommand({
          TableName,
          ...(ProjectionExpression && { ProjectionExpression }),
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        items.push(...(r.Items || []));
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
      return items;
    };

    const [localesItems, empresasItems] = await Promise.all([
      scanAll(tables.locales).catch(() => []),
      scanAll(tables.empresas).catch(() => []),
    ]);

    const localByAgora = new Map(); // agoraCode -> { nombre, empresa }
    for (const l of localesItems) {
      const code = String(l.agoraCode ?? l.AgoraCode ?? '').trim();
      if (!code) continue;
      localByAgora.set(code, {
        nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
        empresa: String(l.empresa ?? l.Empresa ?? '').trim(),
      });
    }
    const empresaByNombre = new Map(); // normNombre -> { nombre, iban }
    const empresaById = new Map();
    for (const e of empresasItems) {
      const nombre = String(e.Nombre ?? '').trim();
      const iban = String(e.Iban ?? e.IBAN ?? '').trim();
      const id = String(e.id_empresa ?? '').trim();
      if (nombre) empresaByNombre.set(normNombreEmpresa(nombre), { nombre, iban });
      if (id) empresaById.set(id, { nombre, iban });
    }

    // Acumulador por local (workplace).
    const porLocal = [];
    for (const wp of workplaceIds) {
      const qArq = await docClient.send(new QueryCommand({
        TableName: tableArqueos,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':pk': wp, ':lo': lo, ':hi': hi },
      }));
      const qMov = await docClient.send(new QueryCommand({
        TableName: tables.movimientosCaja,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':pk': wp, ':lo': lo, ':hi': hi },
      })).catch(() => ({ Items: [] }));

      const arqueos = qArq.Items || [];
      const movimientos = qMov.Items || [];

      let billetesConteo = 0;
      let monedasConteo = 0;
      let sinDesglose = 0;
      let arqueosSinConteo = 0;
      let workplaceName = '';
      for (const a of arqueos) {
        if (!workplaceName) workplaceName = String(a.WorkplaceName ?? '').trim();
        const realMap = realMapFromItem(a);
        const contado = round2(realMap[GRUPO_EFECTIVO] ?? 0);
        const conteo = a.efectivoConteo;
        const tieneConteo = conteo && typeof conteo === 'object' && !Array.isArray(conteo) && Object.keys(conteo).length > 0;
        if (tieneConteo) {
          const d = desglosarConteo(conteo);
          billetesConteo += d.billetes;
          monedasConteo += d.monedas;
        } else if (contado > 0) {
          sinDesglose += contado;
          arqueosSinConteo += 1;
        }
      }

      let retiradas = 0;
      for (const m of movimientos) {
        if (m.tipo === 'retirada') retiradas += parseNum(m.importe);
      }
      retiradas = round2(retiradas);

      const aIngresar = round2(billetesConteo + monedasConteo + sinDesglose + retiradas);
      // Solo incluir locales con algo que ingresar.
      if (aIngresar <= 0 && retiradas <= 0) continue;

      const local = localByAgora.get(wp) || null;
      porLocal.push({
        workplaceId: wp,
        nombre: local?.nombre || workplaceName || wp,
        empresaNombre: local?.empresa || '',
        billetes: round2(billetesConteo + retiradas),
        monedas: round2(monedasConteo),
        sinDesglose: round2(sinDesglose),
        retiradas,
        aIngresar,
        arqueosSinConteo,
      });
    }

    // Agrupar por sociedad (empresa). Locales sin empresa van a "(Sin sociedad)".
    const sociedadesMap = new Map();
    for (const l of porLocal) {
      const emp = empresaByNombre.get(normNombreEmpresa(l.empresaNombre));
      const claveNombre = l.empresaNombre || '(Sin sociedad)';
      const key = normNombreEmpresa(claveNombre) || '__sin__';
      if (!sociedadesMap.has(key)) {
        sociedadesMap.set(key, {
          empresa: emp?.nombre || claveNombre,
          iban: emp?.iban || '',
          totalBilletes: 0,
          totalMonedas: 0,
          totalSinDesglose: 0,
          totalRetiradas: 0,
          totalAIngresar: 0,
          locales: [],
        });
      }
      const s = sociedadesMap.get(key);
      s.totalBilletes = round2(s.totalBilletes + l.billetes);
      s.totalMonedas = round2(s.totalMonedas + l.monedas);
      s.totalSinDesglose = round2(s.totalSinDesglose + l.sinDesglose);
      s.totalRetiradas = round2(s.totalRetiradas + l.retiradas);
      s.totalAIngresar = round2(s.totalAIngresar + l.aIngresar);
      s.locales.push(l);
    }

    const sociedades = [...sociedadesMap.values()].sort((a, b) => a.empresa.localeCompare(b.empresa));
    for (const s of sociedades) s.locales.sort((a, b) => a.nombre.localeCompare(b.nombre));

    const totalGeneral = sociedades.reduce(
      (acc, s) => ({
        billetes: round2(acc.billetes + s.totalBilletes),
        monedas: round2(acc.monedas + s.totalMonedas),
        sinDesglose: round2(acc.sinDesglose + s.totalSinDesglose),
        retiradas: round2(acc.retiradas + s.totalRetiradas),
        aIngresar: round2(acc.aIngresar + s.totalAIngresar),
      }),
      { billetes: 0, monedas: 0, sinDesglose: 0, retiradas: 0, aIngresar: 0 },
    );

    res.json({ dateFrom, dateTo, sociedades, totalGeneral });
  } catch (err) {
    console.error('[cajas/efectivo-ingresar]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al calcular el efectivo a ingresar' });
  }
});

// GET /api/cajas/jornada?workplaceId=&businessDay= — estado de la jornada del local
// Devuelve los arqueos guardados (con estado) y el registro de jornada si existe.
router.get('/cajas/jornada', async (req, res) => {
  const workplaceId = String(req.query.workplaceId || '').trim();
  const businessDay = String(req.query.businessDay || '').trim();
  if (!workplaceId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'workplaceId y businessDay (YYYY-MM-DD) obligatorios' });
  }
  try {
    const qArq = await docClient.send(new QueryCommand({
      TableName: tableArqueos,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :bd)',
      ExpressionAttributeValues: { ':pk': workplaceId, ':bd': businessDay },
    }));
    const arqueos = (qArq.Items || []).map((a) => ({
      posId: String(a.PosId ?? ''),
      posName: String(a.PosName ?? ''),
      estado: a.estado === 'cerrado' ? 'cerrado' : 'borrador',
      descuadreTotal: round2(a.descuadreTotal),
      cerradoEn: a.cerradoEn ?? null,
    }));
    const jornada = await docClient.send(new GetCommand({
      TableName: tables.jornadasLocal,
      Key: { PK: workplaceId, SK: businessDay },
    })).then((r) => r.Item || null).catch(() => null);

    const pendientes = arqueos.filter((a) => a.estado !== 'cerrado').map((a) => a.posId);
    res.json({
      workplaceId,
      businessDay,
      arqueos,
      jornada,
      estado: jornada?.estado ?? 'abierta',
      puedeCerrar: pendientes.length === 0 && arqueos.length > 0,
      pendientes,
    });
  } catch (err) {
    console.error('[cajas/jornada GET]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al cargar la jornada' });
  }
});

// POST /api/cajas/jornada/cerrar — consolida y cierra la jornada del local
// body: { workplaceId|PK, businessDay, workplaceName?, usuarioId?, usuarioNombre? }
router.post('/cajas/jornada/cerrar', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.workplaceId ?? body.PK ?? '').trim();
  const businessDay = String(body.businessDay ?? body.BusinessDay ?? '').trim();
  if (!pk || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'workplaceId y businessDay (YYYY-MM-DD) obligatorios' });
  }
  try {
    const qArq = await docClient.send(new QueryCommand({
      TableName: tableArqueos,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :bd)',
      ExpressionAttributeValues: { ':pk': pk, ':bd': businessDay },
    }));
    const arqueos = qArq.Items || [];
    if (arqueos.length === 0) {
      return res.status(409).json({ error: 'No hay arqueos guardados en esta jornada para cerrar.' });
    }
    // Bloqueo: solo los TPVs con arqueo guardado en borrador impiden el cierre.
    const pendientes = arqueos.filter((a) => a.estado !== 'cerrado');
    if (pendientes.length > 0) {
      return res.status(409).json({
        error: `Hay ${pendientes.length} arqueo(s) sin cerrar. Cierra todos los TPVs iniciados antes de cerrar la jornada.`,
        pendientes: pendientes.map((a) => String(a.PosId ?? '')),
      });
    }

    const now = new Date().toISOString();
    const tpvs = arqueos.map((a) => ({
      posId: String(a.PosId ?? ''),
      posName: String(a.PosName ?? ''),
      descuadreTotal: round2(a.descuadreTotal),
      retiradasEfectivo: round2(a.retiradasEfectivo),
      transferenciasPrepago: round2(a.transferenciasPrepago),
      cerradoEn: a.cerradoEn ?? null,
    }));
    const descuadreTotal = round2(tpvs.reduce((s, t) => s + (Number(t.descuadreTotal) || 0), 0));
    const item = {
      PK: pk,
      SK: businessDay,
      BusinessDay: businessDay,
      WorkplaceName: String(body.workplaceName ?? body.WorkplaceName ?? arqueos[0]?.WorkplaceName ?? '').trim(),
      estado: 'cerrada',
      tpvs,
      arqueosCerrados: tpvs.length,
      descuadreTotal,
      cerradoEn: now,
      cerradoPor: String(body.usuarioNombre ?? body.usuario_nombre ?? req.user?.nombre ?? '').trim() || null,
      actualizadoEn: now,
    };
    await docClient.send(new PutCommand({ TableName: tables.jornadasLocal, Item: item }));
    res.json({ ok: true, jornada: item });
  } catch (err) {
    console.error('[cajas/jornada/cerrar]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al cerrar la jornada' });
  }
});

// POST /api/cajas/jornada/reabrir — reabre una jornada cerrada
router.post('/cajas/jornada/reabrir', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.workplaceId ?? body.PK ?? '').trim();
  const businessDay = String(body.businessDay ?? body.BusinessDay ?? '').trim();
  if (!pk || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'workplaceId y businessDay (YYYY-MM-DD) obligatorios' });
  }
  try {
    const existing = await docClient.send(new GetCommand({
      TableName: tables.jornadasLocal,
      Key: { PK: pk, SK: businessDay },
    })).then((r) => r.Item).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'No hay jornada cerrada para reabrir.' });
    const now = new Date().toISOString();
    const item = { ...existing, estado: 'abierta', reabiertoEn: now, actualizadoEn: now };
    await docClient.send(new PutCommand({ TableName: tables.jornadasLocal, Item: item }));
    res.json({ ok: true, jornada: item });
  } catch (err) {
    console.error('[cajas/jornada/reabrir]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al reabrir la jornada' });
  }
});

// DELETE /api/cajas/arqueos-reales?PK=&SK=
router.delete('/cajas/arqueos-reales', async (req, res) => {
  const pk = String(req.query.PK ?? req.body?.PK ?? '').trim();
  const sk = String(req.query.SK ?? req.body?.SK ?? '').trim();
  if (!pk || !sk) return res.status(400).json({ error: 'PK y SK obligatorios' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableArqueos,
      Key: { PK: pk, SK: sk },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[cajas/arqueos-reales DELETE]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al eliminar' });
  }
});

export default router;
