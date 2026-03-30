/**
 * Arqueos reales (conteo manual) vs cierres teóricos — tabla Igp_ArqueosReales
 * PK = workplaceId, SK = yyyy-mm-dd#posId
 */
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { QueryCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { docClient, tables } from '../lib/db.js';
import { parseTextoTicketTarjeta } from '../lib/ocrTicketTarjeta.js';

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

const PAYMENT_LABELS = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? round2(n) : 0;
}

function ensureArray(arr) {
  return Array.isArray(arr) ? arr : [];
}

/** Importes teóricos por método desde un ítem de cierre (InvoicePayments + otros pagos). */
function teoricoPorMetodo(item) {
  const out = {
    Efectivo: 0,
    Tarjeta: 0,
    'Pendiente de cobro': 0,
    'Prepago Transferencia': 0,
    AgoraPay: 0,
  };
  if (!item || typeof item !== 'object') return out;
  const payments = ensureArray(item.InvoicePayments ?? item.invoicePayments);
  for (const k of PAYMENT_LABELS) {
    const p = payments.find((x) => String(x?.MethodName ?? x?.methodName ?? '').trim() === k);
    if (p != null) {
      const n = Number(p?.Amount ?? p?.amount ?? 0) || 0;
      out[k] = round2(n);
    }
  }
  for (const key of ['TicketPayments', 'ticketPayments', 'DeliveryNotePayments', 'deliveryNotePayments', 'SalesOrderPayments', 'salesOrderPayments']) {
    const arr = ensureArray(item[key]);
    for (const p of arr) {
      const method = String(p?.MethodName ?? p?.methodName ?? '').trim();
      if (out[method] === undefined) continue;
      out[method] = round2(out[method] + (Number(p?.Amount ?? p?.amount ?? 0) || 0));
    }
  }
  for (const k of PAYMENT_LABELS) {
    const val = item[k];
    if (val != null && (typeof val === 'number' || (typeof val === 'string' && String(val).trim() !== ''))) {
      const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
      if (!Number.isNaN(n) && out[k] === 0) out[k] = round2(n);
    }
  }
  return out;
}

/** Suma teóricos de todos los cierres que coinciden con día + TPV. */
function mergeTeoricoAmounts(items) {
  const sum = {
    Efectivo: 0,
    Tarjeta: 0,
    'Pendiente de cobro': 0,
    'Prepago Transferencia': 0,
    AgoraPay: 0,
  };
  for (const it of items) {
    const t = teoricoPorMetodo(it);
    for (const k of PAYMENT_LABELS) sum[k] = round2(sum[k] + t[k]);
  }
  return sum;
}

/** Diferencias por método: real − teórico. */
function buildDiff(teorico, realParsed) {
  return {
    Efectivo: round2(realParsed.efectivoReal - teorico.Efectivo),
    Tarjeta: round2(realParsed.tarjetaReal - teorico.Tarjeta),
    'Pendiente de cobro': round2(realParsed.pendienteCobroReal - teorico['Pendiente de cobro']),
    'Prepago Transferencia': round2(realParsed.prepagoTransferenciaReal - teorico['Prepago Transferencia']),
    AgoraPay: round2(realParsed.agoraPayReal - teorico.AgoraPay),
  };
}

/** Suma algebraica de las diferencias por método (descuadre total). */
function sumDescuadreFromDiff(diff) {
  let s = 0;
  for (const k of PAYMENT_LABELS) s += diff[k];
  return round2(s);
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
    const teorico = mergeTeoricoAmounts(closeouts);

    const skArqueo = `${businessDay}#${posId}`;
    const getArqueo = await docClient.send(new GetCommand({
      TableName: tableArqueos,
      Key: { PK: workplaceId, SK: skArqueo },
    }));
    const real = getArqueo.Item || null;

    const realParsed = real
      ? {
          efectivoReal: parseNum(real.efectivoReal),
          tarjetaReal: parseNum(real.tarjetaReal),
          pendienteCobroReal: parseNum(real.pendienteCobroReal),
          prepagoTransferenciaReal: parseNum(real.prepagoTransferenciaReal),
          agoraPayReal: parseNum(real.agoraPayReal),
        }
      : {
          efectivoReal: 0,
          tarjetaReal: 0,
          pendienteCobroReal: 0,
          prepagoTransferenciaReal: 0,
          agoraPayReal: 0,
        };

    const diff = buildDiff(teorico, realParsed);
    const descuadreTotal = sumDescuadreFromDiff(diff);

    res.json({
      workplaceId,
      businessDay,
      posId,
      skArqueo,
      closeoutsCount: closeouts.length,
      teorico,
      real: realParsed,
      realGuardado: real,
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

  const existing = await docClient.send(new GetCommand({
    TableName: tableArqueos,
    Key: { PK: pk, SK: sk },
  })).then((r) => r.Item);

  const lineasSan = sanitizeTarjetaLineas(body);
  const lineasEfectivas =
    lineasSan !== null
      ? lineasSan
      : (Array.isArray(existing?.tarjetaLineas) ? existing.tarjetaLineas : []);

  const tarjetaRealNum =
    lineasEfectivas.length > 0
      ? sumTarjetaLineas(lineasEfectivas)
      : parseNum(body.tarjetaReal ?? body.tarjeta_real);

  const realParsed = {
    efectivoReal: parseNum(body.efectivoReal ?? body.efectivo_real),
    tarjetaReal: tarjetaRealNum,
    pendienteCobroReal: parseNum(body.pendienteCobroReal ?? body.pendiente_cobro_real),
    prepagoTransferenciaReal: parseNum(body.prepagoTransferenciaReal ?? body.prepago_transferencia_real),
    agoraPayReal: parseNum(body.agoraPayReal ?? body.agora_pay_real),
  };

  const skPrefixClose = `${businessDay}#${posIdStr}#`;
  let descuadreTotal = 0;
  try {
    const qClose = await docClient.send(new QueryCommand({
      TableName: tableCloseouts,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefixClose },
    }));
    const teorico = mergeTeoricoAmounts(qClose.Items || []);
    const diff = buildDiff(teorico, realParsed);
    descuadreTotal = sumDescuadreFromDiff(diff);
  } catch (e) {
    console.error('[cajas/arqueos-reales PUT] descuadre', e.message || e);
    const diff = buildDiff(mergeTeoricoAmounts([]), realParsed);
    descuadreTotal = sumDescuadreFromDiff(diff);
  }

  const item = {
    PK: pk,
    SK: sk,
    BusinessDay: businessDay,
    PosId: posIdStr,
    PosName: body.PosName ?? body.posName ?? existing?.PosName ?? '',
    WorkplaceName: body.WorkplaceName ?? body.workplaceName ?? existing?.WorkplaceName ?? '',
    efectivoReal: realParsed.efectivoReal,
    tarjetaReal: realParsed.tarjetaReal,
    pendienteCobroReal: realParsed.pendienteCobroReal,
    prepagoTransferenciaReal: realParsed.prepagoTransferenciaReal,
    agoraPayReal: realParsed.agoraPayReal,
    tarjetaLineas: lineasEfectivas,
    descuadreTotal,
    descuadreActualizadoEn: now,
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
