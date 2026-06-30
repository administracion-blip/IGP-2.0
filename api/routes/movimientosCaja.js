/**
 * Movimientos de caja — retiradas de efectivo y transferencias de prepago.
 * Tabla Igp_MovimientosCaja. PK = workplaceId, SK = `${businessDay}#${posId}#${tipo}#${id}`.
 *
 * Se registran a cualquier hora del día y el arqueo de caja los lee para ajustar
 * el real (retiradas → Efectivo; transferencias → Prepago Transferencia).
 */
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { docClient, tables } from '../lib/db.js';
import {
  listMovimientos,
  esTipoValido,
  parseImporte,
  TIPOS_MOVIMIENTO,
} from '../lib/cajas/movimientos.js';

const router = express.Router();
const uploadJustificante = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

const region = process.env.AWS_REGION || 'eu-west-3';
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region });
const tableMovimientos = tables.movimientosCaja;

const JUSTIF_PREFIX = 'cajas-movimientos/';

function validJustificanteKey(key) {
  if (!key || typeof key !== 'string') return false;
  return key.startsWith(JUSTIF_PREFIX) && !key.includes('..');
}

function isoDay(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
}

// GET /api/cajas/movimientos?workplaceId=&businessDay=&posId=opcional
router.get('/cajas/movimientos', async (req, res) => {
  const workplaceId = String(req.query.workplaceId || '').trim();
  const businessDay = String(req.query.businessDay || '').trim();
  const posId = req.query.posId == null ? undefined : String(req.query.posId).trim();
  if (!workplaceId || !isoDay(businessDay)) {
    return res.status(400).json({ error: 'workplaceId y businessDay (YYYY-MM-DD) obligatorios' });
  }
  try {
    const movimientos = await listMovimientos({ workplaceId, businessDay, posId });
    res.json({ movimientos, tipos: TIPOS_MOVIMIENTO });
  } catch (err) {
    console.error('[cajas/movimientos GET]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar movimientos' });
  }
});

// POST /api/cajas/movimientos/justificante — multipart: imagen (+ workplaceId, businessDay)
router.post('/cajas/movimientos/justificante', uploadJustificante.single('imagen'), async (req, res) => {
  const file = req.file;
  if (!file?.buffer) return res.status(400).json({ error: 'Falta imagen (campo imagen)' });
  const workplaceId = String(req.body.workplaceId || '').trim();
  const businessDay = String(req.body.businessDay || '').trim();
  try {
    let buf = file.buffer;
    let contentType = 'image/jpeg';
    try {
      buf = await sharp(file.buffer)
        .rotate()
        .resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch (e) {
      console.warn('[movimientos/justificante] sharp', e.message || e);
      contentType = file.mimetype || 'application/octet-stream';
    }
    const base = workplaceId && isoDay(businessDay) ? `${workplaceId}/${businessDay}` : 'anon';
    const key = `${JUSTIF_PREFIX}${base}/${randomUUID()}.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: contentType,
    }));
    let url = '';
    try {
      url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: 900 });
    } catch (_) { /* noop */ }
    res.json({ ok: true, key, url });
  } catch (err) {
    console.error('[cajas/movimientos/justificante]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al subir el justificante' });
  }
});

// GET /api/cajas/movimientos/justificante-url?key=cajas-movimientos/...
router.get('/cajas/movimientos/justificante-url', async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!validJustificanteKey(key)) return res.status(400).json({ error: 'key no válida' });
  try {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: 900 });
    res.json({ url });
  } catch (err) {
    console.error('[cajas/movimientos/justificante-url]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al generar URL' });
  }
});

// POST /api/cajas/movimientos — crear  |  PUT — actualizar
async function upsertMovimiento(req, res) {
  const body = req.body || {};
  const workplaceId = String(body.workplaceId ?? body.PK ?? '').trim();
  const businessDay = String(body.businessDay ?? body.BusinessDay ?? '').trim();
  const posId = String(body.posId ?? body.PosId ?? '').trim();
  const tipo = String(body.tipo || '').trim();

  if (!workplaceId || !isoDay(businessDay)) {
    return res.status(400).json({ error: 'workplaceId y businessDay (YYYY-MM-DD) obligatorios' });
  }
  if (posId === '') return res.status(400).json({ error: 'posId obligatorio (los movimientos se atan a un TPV)' });
  if (!esTipoValido(tipo)) return res.status(400).json({ error: 'tipo inválido (retirada | transferencia)' });

  const importe = parseImporte(body.importe);
  if (!(importe > 0)) return res.status(400).json({ error: 'importe debe ser mayor que 0' });

  const justificanteKey = String(body.justificanteKey ?? body.justificante_key ?? '').trim();
  if (justificanteKey && !validJustificanteKey(justificanteKey)) {
    return res.status(400).json({ error: 'justificanteKey no válida' });
  }

  const now = new Date().toISOString();
  // En actualización conservamos el SK/id original; en alta generamos uno nuevo.
  let id = String(body.id || '').trim();
  let sk = String(body.SK || '').trim();
  let existing = null;
  if (sk) {
    existing = await docClient.send(new GetCommand({
      TableName: tableMovimientos,
      Key: { PK: workplaceId, SK: sk },
    })).then((r) => r.Item).catch(() => null);
  }
  if (!sk) {
    id = id || randomUUID();
    sk = `${businessDay}#${posId}#${tipo}#${id}`;
  } else if (!id) {
    id = sk.split('#').pop() || randomUUID();
  }

  const item = {
    PK: workplaceId,
    SK: sk,
    id,
    BusinessDay: businessDay,
    PosId: posId,
    PosName: String(body.posName ?? body.PosName ?? existing?.PosName ?? '').trim(),
    WorkplaceName: String(body.workplaceName ?? body.WorkplaceName ?? existing?.WorkplaceName ?? '').trim(),
    tipo,
    importe,
    concepto: String(body.concepto ?? existing?.concepto ?? '').trim().slice(0, 240),
    justificanteKey: justificanteKey || existing?.justificanteKey || '',
    hora: String(body.hora ?? existing?.hora ?? now.slice(11, 16)).slice(0, 5),
    creadoEn: existing?.creadoEn ?? now,
    actualizadoEn: now,
    usuarioId: String(body.usuarioId ?? body.usuario_id ?? existing?.usuarioId ?? req.user?.sub ?? '').trim(),
    usuarioNombre: String(body.usuarioNombre ?? body.usuario_nombre ?? existing?.usuarioNombre ?? req.user?.nombre ?? '').trim(),
  };

  try {
    await docClient.send(new PutCommand({ TableName: tableMovimientos, Item: item }));
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[cajas/movimientos PUT/POST]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al guardar el movimiento' });
  }
}

router.post('/cajas/movimientos', upsertMovimiento);
router.put('/cajas/movimientos', upsertMovimiento);

// DELETE /api/cajas/movimientos?PK=&SK=
router.delete('/cajas/movimientos', async (req, res) => {
  const pk = String(req.query.PK ?? req.body?.PK ?? '').trim();
  const sk = String(req.query.SK ?? req.body?.SK ?? '').trim();
  if (!pk || !sk) return res.status(400).json({ error: 'PK y SK obligatorios' });
  try {
    await docClient.send(new DeleteCommand({ TableName: tableMovimientos, Key: { PK: pk, SK: sk } }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[cajas/movimientos DELETE]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al eliminar el movimiento' });
  }
});

export default router;
