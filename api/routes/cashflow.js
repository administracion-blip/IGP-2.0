/**
 * Cashflow — pagos/cobros en efectivo fuera del TPV con recibí firmado.
 */
import { Router } from 'express';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { usuarioPuedeAccederLocal, formatId6, jornadaNegocioHoyIso } from '../lib/usuarioLocales.js';
import { docClient, tables } from '../lib/db.js';
import { generarPdfReciboCashflow } from '../lib/cashflow/pdfRecibo.js';
import {
  pkLocal,
  skFecha,
  nowIso,
  uuid,
  nextNumeroRecibo,
  getMovimientoById,
  queryMovimientosLocalRango,
  putMovimiento,
  resolveLocalEmpresa,
} from '../lib/cashflow/store.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const UMBRAL = Number(process.env.CASHFLOW_UMBRAL_VALIDACION) || 300;

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS = new Set(['pago', 'cobro']);
const CATEGORIAS = new Set(['actuacion', 'proveedor', 'evento', 'staff', 'otros']);
const DESTINOS_COBRO = new Set(['banco', 'reparto_socios']);
const ESTADOS = new Set(['Pendiente_firma', 'Firmado', 'Pendiente_validacion', 'Anulado']);

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseEmails(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/);
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return [...new Set(arr.map((e) => String(e).trim().toLowerCase()).filter((e) => re.test(e)))];
}

async function localesVisiblesUsuario(user) {
  const scan = await docClient.send(new ScanCommand({ TableName: tables.locales }));
  const all = scan.Items || [];
  const out = [];
  for (const l of all) {
    const id = formatId6(l.id_Locales);
    if (await usuarioPuedeAccederLocal(user, id)) out.push(l);
  }
  return out;
}

async function assertLocalVisible(req, res, localId) {
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    res.status(403).json({ error: 'No tienes acceso a este local' });
    return false;
  }
  return true;
}

async function nombreUsuario(user) {
  if (!user?.sub) return user?.email || '';
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.usuarios, Key: { id_usuario: user.sub } }),
    );
    return String(r.Item?.Nombre ?? r.Item?.Email ?? user.email ?? '').trim();
  } catch {
    return user?.email || '';
  }
}

function movimientoToApi(item) {
  if (!item) return null;
  const { PK, SK, entityType, ...rest } = item;
  return rest;
}

/** GET /api/cashflow */
router.get('/cashflow', requirePermission('cashflow.ver'), async (req, res) => {
  const dateFrom = String(req.query.dateFrom || req.query.fechaDesde || '').trim();
  const dateTo = String(req.query.dateTo || req.query.fechaHasta || dateFrom).trim();
  const localId = req.query.localId ? formatId6(req.query.localId) : '';
  const tipo = String(req.query.tipo || '').trim();
  const estado = String(req.query.estado || '').trim();

  if (!RE_FECHA.test(dateFrom) || !RE_FECHA.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo (YYYY-MM-DD) obligatorios' });
  }

  const locales = await localesVisiblesUsuario(req.user);
  const ids = localId
    ? locales.filter((l) => formatId6(l.id_Locales) === localId).map((l) => formatId6(l.id_Locales))
    : locales.map((l) => formatId6(l.id_Locales));

  const movimientos = [];
  for (const id of ids) {
    const rows = await queryMovimientosLocalRango(id, dateFrom, dateTo);
    movimientos.push(...rows);
  }

  let filtered = movimientos;
  if (tipo && TIPOS.has(tipo)) filtered = filtered.filter((m) => m.tipo === tipo);
  if (estado && ESTADOS.has(estado)) filtered = filtered.filter((m) => m.estado === estado);

  filtered.sort((a, b) => {
    const cf = String(b.fecha || '').localeCompare(String(a.fecha || ''));
    if (cf !== 0) return cf;
    return String(b.creadoEn || '').localeCompare(String(a.creadoEn || ''));
  });

  res.json({ movimientos: filtered.map(movimientoToApi) });
});

/** GET /api/cashflow/resumen */
router.get('/cashflow/resumen', requirePermission('cashflow.ver'), async (req, res) => {
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || dateFrom).trim();
  if (!RE_FECHA.test(dateFrom) || !RE_FECHA.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo obligatorios' });
  }

  const locales = await localesVisiblesUsuario(req.user);
  let pagos = 0;
  let cobrosBanco = 0;
  let cobrosReparto = 0;

  for (const l of locales) {
    const id = formatId6(l.id_Locales);
    const rows = await queryMovimientosLocalRango(id, dateFrom, dateTo);
    for (const m of rows) {
      if (m.estado !== 'Firmado') continue;
      const imp = Number(m.importe) || 0;
      if (m.tipo === 'pago') pagos += imp;
      else if (m.destinoCobro === 'reparto_socios') cobrosReparto += imp;
      else cobrosBanco += imp;
    }
  }

  res.json({
    dateFrom,
    dateTo,
    pagos: round2(pagos),
    cobrosBanco: round2(cobrosBanco),
    cobrosReparto: round2(cobrosReparto),
    neto: round2(cobrosBanco - pagos),
  });
});

/** GET /api/cashflow/:movimientoId */
router.get('/cashflow/:movimientoId', requirePermission('cashflow.ver'), async (req, res) => {
  const item = await getMovimientoById(req.params.movimientoId);
  if (!item) return res.status(404).json({ error: 'Movimiento no encontrado' });
  if (!(await assertLocalVisible(req, res, item.localId))) return;
  res.json({ movimiento: movimientoToApi(item) });
});

function parseLineas(body) {
  const raw = body.lineas;
  if (Array.isArray(raw) && raw.length > 0) {
    const lineas = [];
    for (const row of raw) {
      const descripcion = String(row.descripcion ?? row.concepto ?? '').trim();
      const importe = round2(row.importe);
      if (!descripcion) continue;
      if (!importe || importe <= 0) continue;
      lineas.push({ descripcion, importe });
    }
    return lineas;
  }
  const concepto = String(body.concepto || '').trim();
  const importe = round2(body.importe);
  if (concepto && importe > 0) return [{ descripcion: concepto, importe }];
  return [];
}

function conceptoFromLineas(lineas) {
  return lineas.map((l) => l.descripcion).join('; ');
}

function importeFromLineas(lineas) {
  return round2(lineas.reduce((acc, l) => acc + (Number(l.importe) || 0), 0));
}

/** POST /api/cashflow */
router.post('/cashflow', requirePermission('cashflow.registrar'), async (req, res) => {
  const body = req.body || {};
  const tipo = String(body.tipo || '').trim();
  const localId = formatId6(body.localId);
  const fecha = RE_FECHA.test(String(body.fecha || '')) ? String(body.fecha) : jornadaNegocioHoyIso();
  const categoria = String(body.categoria || 'otros').trim();
  const lineas = parseLineas(body);
  const importe = importeFromLineas(lineas);
  const concepto = conceptoFromLineas(lineas);
  const contraparte = {
    nombre: String(body.contraparte?.nombre ?? body.contraparte_nombre ?? '').trim(),
    nif: String(body.contraparte?.nif ?? body.contraparte_nif ?? '').trim(),
    telefono: String(body.contraparte?.telefono ?? '').trim() || undefined,
  };

  let contraparteRef = null;
  if (body.contraparteRef && typeof body.contraparteRef === 'object') {
    const refTipo = String(body.contraparteRef.tipo || '').trim();
    const refId = String(body.contraparteRef.id || '').trim();
    if (refTipo && refId) contraparteRef = { tipo: refTipo, id: refId };
  }

  if (!TIPOS.has(tipo)) return res.status(400).json({ error: 'tipo debe ser pago o cobro' });
  if (!localId || localId === '000000') return res.status(400).json({ error: 'localId obligatorio' });
  if (!(await assertLocalVisible(req, res, localId))) return;
  if (!lineas.length) return res.status(400).json({ error: 'Al menos una línea con descripción e importe es obligatoria' });
  if (!importe || importe <= 0) return res.status(400).json({ error: 'importe debe ser mayor que 0' });
  if (!CATEGORIAS.has(categoria)) return res.status(400).json({ error: 'categoría no válida' });
  if (!contraparte.nombre) return res.status(400).json({ error: 'nombre de contraparte obligatorio' });
  if (tipo === 'pago' && !contraparte.nif) {
    return res.status(400).json({ error: 'NIF/CIF de contraparte obligatorio en pagos' });
  }

  const importeCliente = body.importe != null ? round2(body.importe) : null;
  if (importeCliente != null && Math.abs(importeCliente - importe) > 0.01) {
    return res.status(400).json({ error: 'El importe total no coincide con la suma de las líneas' });
  }

  let destinoCobro = tipo === 'cobro' ? String(body.destinoCobro || 'banco').trim() : null;
  if (tipo === 'cobro') {
    if (!DESTINOS_COBRO.has(destinoCobro)) {
      return res.status(400).json({ error: 'destinoCobro debe ser banco o reparto_socios' });
    }
    if (destinoCobro === 'reparto_socios' && !(await hasPermission(req.user, 'cashflow.validar'))) {
      return res.status(403).json({ error: 'Permiso insuficiente para reparto entre socios' });
    }
  }

  const locEmp = await resolveLocalEmpresa(localId);
  if (!locEmp) return res.status(404).json({ error: 'Local no encontrado' });

  let actuacionId = body.actuacionId ? String(body.actuacionId).trim() : '';
  if (actuacionId) {
    const ar = await docClient.send(
      new GetCommand({ TableName: tables.actuaciones, Key: { id_actuacion: actuacionId } }),
    );
    if (ar.Item) {
      if (!contraparte.nombre && ar.Item.artista_nombre_snapshot) {
        contraparte.nombre = String(ar.Item.artista_nombre_snapshot);
      }
      if (!body.importe && ar.Item.importe_final != null) {
        /* importe ya validado arriba */
      }
    }
  }

  const movimientoId = uuid();
  const ts = nowIso();
  const emailsCopia = parseEmails(body.emailsCopia);

  const nombreCreador = await nombreUsuario(req.user);

  const item = {
    PK: pkLocal(localId),
    SK: skFecha(fecha, movimientoId),
    movimientoId,
    tipo,
    importe,
    fecha,
    localId,
    localNombre: locEmp.localNombre,
    empresaId: locEmp.empresaId,
    empresaNombre: locEmp.empresaNombre,
    empresaCif: locEmp.empresaCif,
    agoraCode: locEmp.agoraCode,
    categoria,
    concepto,
    lineas,
    contraparte,
    contraparteRef,
    destinoCobro,
    actuacionId: actuacionId || null,
    estado: 'Pendiente_firma',
    emailsCopia,
    creadoPor: req.user?.sub || req.user?.email || '',
    creadoPorNombre: nombreCreador,
    creadoEn: ts,
    actualizadoEn: ts,
  };

  await putMovimiento(item);
  res.json({ ok: true, movimiento: movimientoToApi(item) });
});

/** POST /api/cashflow/:movimientoId/firmar */
router.post('/cashflow/:movimientoId/firmar', requirePermission('cashflow.registrar'), upload.single('file'), async (req, res) => {
  let firmaBuffer = req.file?.buffer;
  if (!firmaBuffer && req.body?.firmaBase64) {
    const raw = String(req.body.firmaBase64).replace(/^data:image\/png;base64,/, '');
    firmaBuffer = Buffer.from(raw, 'base64');
  }
  if (!firmaBuffer?.length) return res.status(400).json({ error: 'Falta firma (file o firmaBase64)' });

  const item = await getMovimientoById(req.params.movimientoId);
  if (!item) return res.status(404).json({ error: 'Movimiento no encontrado' });
  if (!(await assertLocalVisible(req, res, item.localId))) return;
  if (item.estado !== 'Pendiente_firma') {
    return res.status(400).json({ error: 'El movimiento no está pendiente de firma' });
  }

  const ts = nowIso();
  const anio = (item.fecha || ts).slice(0, 4);
  const numeroRecibo = await nextNumeroRecibo(anio);

  const firmaKey = `cashflow/${item.movimientoId}/firma_${Date.now()}.png`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: firmaKey,
      Body: firmaBuffer,
      ContentType: 'image/png',
    }),
  );

  const esPago = item.tipo === 'pago';
  const nombreEncargado = await nombreUsuario(req.user);
  const firmadoPorId = esPago ? null : req.user?.sub || '';
  const firmadoPorNombre = esPago ? item.contraparte?.nombre || '' : nombreEncargado;

  const movPdf = {
    ...item,
    numeroRecibo,
    firmadoPorId,
    firmadoPorNombre,
    creadoPorNombre: item.creadoPorNombre || item.creadoPor,
  };
  const pdfBuf = await generarPdfReciboCashflow(movPdf, firmaBuffer);
  const reciboKey = `cashflow/${item.movimientoId}/recibo_${Date.now()}.pdf`;
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: reciboKey,
      Body: pdfBuf,
      ContentType: 'application/pdf',
    }),
  );

  const requiereValidacion = Number(item.importe) > UMBRAL;
  const nuevoEstado = requiereValidacion ? 'Pendiente_validacion' : 'Firmado';

  const updated = {
    ...item,
    estado: nuevoEstado,
    numeroRecibo,
    firmaS3Key: firmaKey,
    reciboS3Key: reciboKey,
    firmadoPorId,
    firmadoPorNombre,
    firmadoEn: ts,
    actualizadoEn: ts,
  };
  await putMovimiento(updated);

  res.json({ ok: true, movimiento: movimientoToApi(updated) });
});

/** POST /api/cashflow/:movimientoId/validar */
router.post('/cashflow/:movimientoId/validar', requirePermission('cashflow.validar'), async (req, res) => {
  const item = await getMovimientoById(req.params.movimientoId);
  if (!item) return res.status(404).json({ error: 'Movimiento no encontrado' });
  if (!(await assertLocalVisible(req, res, item.localId))) return;
  if (item.estado !== 'Pendiente_validacion') {
    return res.status(400).json({ error: 'El movimiento no está pendiente de validación' });
  }

  const ts = nowIso();
  const updated = {
    ...item,
    estado: 'Firmado',
    validadoPor: req.user?.email || req.user?.sub || '',
    validadoEn: ts,
    actualizadoEn: ts,
  };
  await putMovimiento(updated);
  res.json({ ok: true, movimiento: movimientoToApi(updated) });
});

/** POST /api/cashflow/:movimientoId/anular */
router.post('/cashflow/:movimientoId/anular', requirePermission('cashflow.validar'), async (req, res) => {
  const motivo = String(req.body?.motivo || '').trim();
  if (!motivo) return res.status(400).json({ error: 'motivo obligatorio' });

  const item = await getMovimientoById(req.params.movimientoId);
  if (!item) return res.status(404).json({ error: 'Movimiento no encontrado' });
  if (!(await assertLocalVisible(req, res, item.localId))) return;
  if (item.estado === 'Anulado') return res.status(400).json({ error: 'Ya está anulado' });

  const ts = nowIso();
  const updated = {
    ...item,
    estado: 'Anulado',
    anulacion: {
      motivo,
      usuarioId: req.user?.sub || '',
      usuarioEmail: req.user?.email || '',
      fecha: ts,
    },
    actualizadoEn: ts,
  };
  await putMovimiento(updated);
  res.json({ ok: true, movimiento: movimientoToApi(updated) });
});

/** GET /api/cashflow/:movimientoId/recibo */
router.get('/cashflow/:movimientoId/recibo', requirePermission('cashflow.ver'), async (req, res) => {
  const item = await getMovimientoById(req.params.movimientoId);
  if (!item) return res.status(404).json({ error: 'Movimiento no encontrado' });
  if (!(await assertLocalVisible(req, res, item.localId))) return;
  if (!item.reciboS3Key) return res.status(404).json({ error: 'Recibo no generado aún' });

  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: item.reciboS3Key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
  res.json({ url, expiresIn: 3600, numeroRecibo: item.numeroRecibo });
});

export default router;
