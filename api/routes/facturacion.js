import { Router } from 'express';
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, tables, deleteItemBySchema, keyForFacturaPrincipalId, keyForFacturaItem } from '../lib/db.js';
import {
  queryLineasByFactura,
  queryPagosByFactura,
  queryAuditoriaByFactura,
} from '../lib/dynamo/facturasRelacionadas.js';
import {
  normalizeCif,
  cifDigitsOnly,
  getCifFromEmpresaItem,
  getNombreFromEmpresaItem,
  getIdEmpresaFromItem,
} from '../lib/empresaCif.js';
import { parseTextoFacturaCompleto, reconciliarFacturaOcr } from '../lib/ocrFacturaEntidades.js';
import { ibansDeEmpresaItem } from '../lib/remesas/resolverDatos.js';
import {
  enriquecerFacturaOcrConOpenAI,
  mergeExtraccionConIa,
  isIaEnriquecimientoDisponible,
} from '../lib/ocrEnriquecerIa.js';
import { aplicarPostProcesadoPipeline } from '../lib/ocrFacturaValidacion.js';
import { registrarPagoFactura } from '../lib/facturacion/registrarPago.js';
import {
  indexRemesasActivasPorFactura,
  findRemesaActivaDeFactura,
} from '../lib/remesas/facturaEnRemesa.js';
import {
  filtrarFacturasCompensables,
  registrarPagoCompensacion,
  METODO_PAGO_COMPENSACION,
  etiquetaFacturaCompensable,
  saldoFirmadoFactura,
} from '../lib/facturacion/compensacionFactura.js';
import { emitirOValidarFacturaPorId } from '../lib/facturacion/emitirFactura.js';
import {
  getSerieConfig,
  buildNumeroFactura,
  calcNextNumeroPorScan,
  peekNextNumero,
  errorSerieTipoIncompatible,
  existeCorrelativoDuplicado,
  serieRectificativaPorDefecto,
} from '../lib/facturacion/series.js';
import {
  construirFacturaConLineas,
  buildImpuestosResumenFromLineas,
} from '../lib/facturacion/construirFactura.js';
import {
  nombreFicheroAdjuntoFacturaRecibida,
  fechaEmisionFacturaAIso,
} from '../lib/facturacion/idDocumento.js';
import { esDuplicadoFacturaProveedor } from '../lib/facturacion/duplicadosProveedor.js';
import {
  ERROR_PROVEEDOR_IGUAL_SOCIEDAD,
  proveedorCoincideConSociedad,
} from '../lib/facturacion/validarProveedorSociedad.js';
import { limpiarMarcasFacturacionPeriodica } from '../lib/facturacion/marcasPeriodicas.js';
import {
  sanitizeAlbaranesConciliados,
  numeroFacturaParaConciliacion,
} from '../lib/facturacion/albaranesConciliados.js';
import { requirePermission, requireAnyPermission } from '../middleware/auth.js';
import {
  empresasPermitidasDelUsuario,
  facturaEmisorPermitido,
  formatId6,
} from '../lib/usuarioLocales.js';
import crypto from 'crypto';
import { enviarEmail } from '../lib/email.js';
import multer from 'multer';
import {
  multerFacturaFileFilter,
  assertBufferMimeAllowed,
  normalizeUploadBuffer,
  sanitizeUploadFileName,
} from '../lib/uploadAllowlist.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Tesseract = require('tesseract.js');

const router = Router();

/** [SEC S-08] 404 si el usuario no puede acceder a la factura por emisor (sociedad del grupo). */
async function rejectFacturaEmisorNoPermitido(req, factura, res) {
  const empresasOk = await empresasPermitidasDelUsuario(req.user);
  if (!facturaEmisorPermitido(factura, empresasOk)) {
    res.status(404).json({ error: 'Factura no encontrada' });
    return true;
  }
  return false;
}

const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: multerFacturaFileFilter, // [SEC S-06]
});

// ─── Helpers ───

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Copia el fichero en S3 a `facturas/{id}/…` para asociarlo de forma estable a la factura. */
/** Elimina todos los objetos bajo `facturas/{idFactura}/` (best-effort). */
async function eliminarArchivosS3Factura(idFactura) {
  const prefix = `facturas/${idFactura}/`;
  try {
    let continuationToken;
    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of out.Contents || []) {
        if (obj.Key) await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (e) {
    console.error('[eliminar factura IN] S3:', e.message);
  }
}

async function copiarDocumentoAFactura(sourceKey, idFactura, nombreOriginal) {
  if (!sourceKey || typeof sourceKey !== 'string' || !sourceKey.startsWith('facturas/')) {
    throw new Error('Origen de documento inválido');
  }
  const m = String(nombreOriginal || '').match(/\.([a-zA-Z0-9]{1,8})$/);
  const ext = m ? m[1] : 'pdf';
  const destKey = `facturas/${idFactura}/${Date.now()}_${uuid().slice(0, 8)}.${ext}`;
  const copySource = `${S3_BUCKET}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
  await s3.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      Key: destKey,
      CopySource: copySource,
    })
  );
  return destKey;
}

/** Normaliza fecha a yyyy-mm-dd (ISO). Acepta ya ISO o dd/mm/aaaa (u opcional dd/mm/yy). */
function fechaToIsoGuardada(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo}-${d}`;
  }
  return s;
}

function computeHash(factura) {
  const payload = JSON.stringify({
    id: factura.id_factura,
    serie: factura.serie,
    numero: factura.numero,
    tipo: factura.tipo,
    empresa_cif: factura.empresa_cif,
    fecha_emision: factura.fecha_emision,
    base_imponible: factura.base_imponible,
    total_iva: factura.total_iva,
    total_factura: factura.total_factura,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function scanAll(tableName, filterExpr, exprValues, exprNames) {
  const items = [];
  let lastKey = null;
  do {
    const params = {
      TableName: tableName,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
      ...(filterExpr && { FilterExpression: filterExpr }),
      ...(exprValues && { ExpressionAttributeValues: exprValues }),
      ...(exprNames && { ExpressionAttributeNames: exprNames }),
    };
    const result = await docClient.send(new ScanCommand(params));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function queryByPK(tableName, pkName, pkValue) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': pkName },
        ExpressionAttributeValues: { ':pk': pkValue },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function registrarAuditoria(id_factura, accion, usuario_id, usuario_nombre, detalle) {
  const id_entrada = `AUD-${id_factura}-${Date.now()}`;
  await docClient.send(
    new PutCommand({
      TableName: tables.facturasAuditoria,
      Item: {
        id_entrada,
        id_factura,
        timestamp_accion: now(),
        accion,
        usuario_id: usuario_id || '',
        usuario_nombre: usuario_nombre || '',
        detalle: typeof detalle === 'string' ? detalle : JSON.stringify(detalle || {}),
      },
    })
  );
}

/**
 * Usuario para la auditoría en rutas autenticadas: el id sale del token (el body
 * puede no venir, p. ej. al emitir desde el listado) y el nombre visible del body
 * si lo trae, porque el token solo lleva el email.
 */
function usuarioAuditoria(req) {
  const body = req.body || {};
  return {
    usuario_id: req.user?.sub || body.usuario_id || '',
    usuario_nombre: req.user?.Nombre || body.usuario_nombre || req.user?.email || '',
  };
}

// ─── SERIES ───

// [SEC S-01]
router.get('/facturacion/series', requirePermission('facturacion.series'), async (_req, res) => {
  try {
    const items = await scanAll(tables.facturasSeries);
    const configOnly = items.filter((s) => !(s.serie || '').includes('#'));
    res.json({ series: configOnly });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.get('/facturacion/series/next-number', requireAnyPermission('facturacion.series', 'facturacion.crear', 'facturacion.emitir'), async (req, res) => {
  const { serie, emisor_id, emisor_cif, fecha_emision } = req.query;
  if (!serie) return res.status(400).json({ error: 'serie es obligatorio' });
  try {
    // El correlativo es por serie, año y sociedad emisora: sin el emisor el
    // preview mostraría el número de otra sociedad.
    const result = await peekNextNumero(serie, fecha_emision || '', { emisor_id, emisor_cif });
    if (!result) return res.status(404).json({ error: 'Serie no encontrada' });

    // Se devuelve `emisor_id` tal cual llegó para no romper el contrato del frontend.
    res.json({ serie: result.serie, emisor_id: emisor_id || 'DEFAULT', ultimo_numero: result.ultimo_numero - 1, next_numero: result.ultimo_numero, num_digitos: result.num_digitos || 6 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.post('/facturacion/series', requirePermission('facturacion.series'), async (req, res) => {
  const { serie, descripcion, tipo, prefijo_formato, activa, notas, reinicio_anual, num_digitos } = req.body || {};
  if (!serie || !tipo) return res.status(400).json({ error: 'serie y tipo son obligatorios' });
  // El carácter "#" está reservado para los ítems contador de correlativo.
  if (String(serie).includes('#')) return res.status(400).json({ error: 'El nombre de la serie no puede contener el carácter "#"' });
  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturasSeries, Key: { serie } }));
    if (existing.Item) return res.status(409).json({ error: `La serie "${serie}" ya existe` });
    const item = {
      serie,
      descripcion: descripcion || '',
      tipo,
      prefijo_formato: prefijo_formato || `${serie}-{YYYY}-`,
      ultimo_numero: 0,
      ultimo_anio: new Date().getFullYear(),
      activa: activa !== false,
      notas: notas || '',
      reinicio_anual: reinicio_anual !== false,
      num_digitos: num_digitos || 6,
    };
    await docClient.send(new PutCommand({ TableName: tables.facturasSeries, Item: item }));
    res.json({ ok: true, serie: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.put('/facturacion/series', requirePermission('facturacion.series'), async (req, res) => {
  const { serie, descripcion, prefijo_formato, activa, notas, reinicio_anual, num_digitos } = req.body || {};
  if (!serie) return res.status(400).json({ error: 'serie es obligatorio' });
  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturasSeries, Key: { serie } }));
    if (!existing.Item) return res.status(404).json({ error: 'Serie no encontrada' });
    const updated = { ...existing.Item };
    if (descripcion !== undefined) updated.descripcion = descripcion;
    if (prefijo_formato !== undefined) updated.prefijo_formato = prefijo_formato;
    if (activa !== undefined) updated.activa = activa;
    if (notas !== undefined) updated.notas = notas;
    if (reinicio_anual !== undefined) updated.reinicio_anual = reinicio_anual;
    if (num_digitos !== undefined) updated.num_digitos = num_digitos;
    await docClient.send(new PutCommand({ TableName: tables.facturasSeries, Item: updated }));
    res.json({ ok: true, serie: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.delete('/facturacion/series', requirePermission('facturacion.series'), async (req, res) => {
  const { serie } = req.body || {};
  if (!serie) return res.status(400).json({ error: 'serie es obligatorio' });
  // Los ítems contador de correlativo llevan "#": no son series borrables.
  if (String(serie).includes('#')) return res.status(400).json({ error: 'El nombre de la serie no puede contener el carácter "#"' });
  try {
    await docClient.send(new DeleteCommand({ TableName: tables.facturasSeries, Key: { serie } }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FACTURAS ───

// [SEC S-01]
router.get('/facturacion/facturas', requirePermission('facturacion.ver'), async (req, res) => {
  try {
    const { tipo } = req.query;
    let items;
    if (tipo) {
      items = await scanAll(tables.facturas, '#t = :t', { ':t': tipo }, { '#t': 'tipo' });
    } else {
      items = await scanAll(tables.facturas);
    }
    items.sort((a, b) => (b.fecha_emision || '').localeCompare(a.fecha_emision || ''));

    const remesas = await scanAll(tables.remesas);
    const idxRemesas = indexRemesasActivasPorFactura(remesas);
    items = items.map((f) => {
      if (f.tipo === 'OUT') return { ...f, remesaActiva: null };
      return { ...f, remesaActiva: idxRemesas.get(f.id_factura) || null };
    });

    // [SEC S-08]
    const empresasOk = await empresasPermitidasDelUsuario(req.user);
    items = items.filter((f) => facturaEmisorPermitido(f, empresasOk));

    res.json({ facturas: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.get('/facturacion/facturas/:id', requirePermission('facturacion.ver'), async (req, res) => {
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(req.params.id) })
    );
    if (!result.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, result.Item, res)) return;
    const lineas = await queryLineasByFactura(req.params.id);
    lineas.sort((a, b) => (a.id_linea || '').localeCompare(b.id_linea || ''));
    const pagos = await queryPagosByFactura(req.params.id);
    pagos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    const auditoria = await queryAuditoriaByFactura(req.params.id);
    auditoria.sort((a, b) => (b.timestamp_accion || '').localeCompare(a.timestamp_accion || ''));
    const remesaActiva = result.Item.tipo === 'OUT'
      ? null
      : await findRemesaActivaDeFactura(req.params.id);
    res.json({ factura: result.Item, lineas, pagos, auditoria, remesaActiva });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.post('/facturacion/facturas', requirePermission('facturacion.crear'), async (req, res) => {
  const body = req.body || {};
  // El resto de campos del cuerpo los normaliza `construirFacturaConLineas`.
  const {
    tipo, serie, emisor_nombre, emisor_cif, empresa_nombre, empresa_cif,
    fecha_emision, usuario_id, usuario_nombre,
  } = body;

  if (!tipo || !serie) return res.status(400).json({ error: 'tipo y serie son obligatorios' });
  if (!emisor_nombre && !emisor_cif) return res.status(400).json({ error: 'Datos del emisor son obligatorios' });
  if (!empresa_nombre && !empresa_cif) return res.status(400).json({ error: 'Datos de empresa son obligatorios' });

  try {
    // [SEC S-08]
    const empresasOk = await empresasPermitidasDelUsuario(req.user);
    if (empresasOk != null) {
      const emisorId = formatId6(body.emisor_id);
      if (!emisorId || emisorId === '000000' || !empresasOk.has(emisorId)) {
        return res.status(403).json({ error: 'No tienes permiso para crear facturas con esta sociedad emisora' });
      }
    }

    const serieConfig = await getSerieConfig(serie);
    if (!serieConfig) return res.status(404).json({ error: `Serie "${serie}" no encontrada` });
    const errorTipoSerie = errorSerieTipoIncompatible(serieConfig, tipo);
    if (errorTipoSerie) return res.status(400).json({ error: errorTipoSerie });

    // Ventas (OUT): el número se reserva al emitir, no al crear el borrador, para
    // no dejar huecos en el correlativo si el borrador se descarta.
    let numero = 0;
    let numero_factura = '';
    if (tipo !== 'OUT') {
      const serieData = await calcNextNumeroPorScan(serie, fecha_emision, body);
      if (!serieData) return res.status(404).json({ error: `Serie "${serie}" no encontrada` });
      numero = serieData.ultimo_numero;
      numero_factura = buildNumeroFactura(serieData, numero, fecha_emision);

      // El mismo número en otra sociedad emisora no es duplicado: la numeración
      // es correlativa por serie, año y emisor.
      const duplicado = await existeCorrelativoDuplicado(
        { serieConfig: serieData, numero, numero_factura, fecha_emision, emisor_id: body.emisor_id, emisor_cif },
        '',
      );
      if (duplicado) {
        return res.status(409).json({ error: `El número de factura ${numero_factura} ya existe para esta sociedad. Esto puede ocurrir si se registraron dos facturas simultáneamente. Por favor, inténtelo de nuevo.` });
      }
    }

    const id_entrada = uuid();

    const { factura, lineas: lineasToSave } = construirFacturaConLineas({
      id_factura: id_entrada,
      numero,
      numero_factura,
      datos: body,
    });
    const total_factura = factura.total_factura;

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));

    for (const linea of lineasToSave) {
      await docClient.send(new PutCommand({ TableName: tables.facturasLineas, Item: linea }));
    }

    await registrarAuditoria(id_entrada, 'creacion', usuario_id, usuario_nombre, { tipo, serie, numero_factura, total_factura });

    res.json({ ok: true, factura, lineas: lineasToSave });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.put('/facturacion/facturas/:id', requirePermission('facturacion.editar'), async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });

    const factura = existing.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, factura, res)) return;
    const esGasto = factura.tipo === 'IN';
    const estadoOriginal = factura.estado;

    if (estadoOriginal === 'anulada') {
      return res.status(400).json({ error: 'No se pueden editar facturas anuladas' });
    }
    if (!esGasto && !['borrador', 'pendiente_revision'].includes(estadoOriginal)) {
      return res.status(400).json({ error: 'Solo se pueden editar facturas en estado borrador o pendiente de revisión' });
    }

    const editableFields = [
      'emisor_id', 'emisor_nombre', 'emisor_cif', 'emisor_direccion',
      'emisor_cp', 'emisor_municipio', 'emisor_provincia', 'emisor_email',
      'emisor_iban', 'emisor_iban_alternativo',
      'empresa_id', 'empresa_nombre', 'empresa_cif', 'empresa_direccion',
      'empresa_cp', 'empresa_municipio', 'empresa_provincia', 'empresa_email',
      'empresa_iban', 'empresa_iban_alternativo',
      'fecha_emision', 'fecha_operacion', 'fecha_vencimiento',
      'condiciones_pago', 'forma_pago', 'observaciones', 'local_id',
      'numero_factura_proveedor', 'fecha_contabilizacion',
    ];

    const changes = {};
    for (const field of editableFields) {
      if (body[field] !== undefined) {
        changes[field] = body[field];
        factura[field] = body[field];
      }
    }

    // Solo en borrador/revisión se acepta body.estado. En IN ya validada se ignora
    // para que no pueda saltarse el recálculo de pago (p. ej. forzar 'borrador').
    if (
      body.estado !== undefined &&
      ['borrador', 'pendiente_revision'].includes(estadoOriginal)
    ) {
      changes.estado = body.estado;
      factura.estado = body.estado;
    }

    // `es_abono` va aparte de la lista genérica porque es una bandera que decide
    // una validación fiscal (un documento de venta solo puede ir en negativo si es
    // un abono), y la lista genérica copia el valor tal cual: un "false" de texto
    // habría pasado por verdadero. Sin este campo no había forma de emitir un
    // abono manual desde la interfaz.
    if (body.es_abono !== undefined) {
      const esAbono = body.es_abono === true || body.es_abono === 'true';
      changes.es_abono = esAbono;
      factura.es_abono = esAbono;
    }

    if (Array.isArray(body.lineas)) {
      const oldLineas = await queryLineasByFactura(id);

      let base_imponible = 0;
      let total_iva = 0;
      let total_retencion = 0;

      const nuevasLineas = body.lineas.map((l, i) => {
        const cantidad = Number(l.cantidad) || 0;
        const precio = Number(l.precio_unitario) || 0;
        const descuento = Number(l.descuento_pct) || 0;
        const tipoIva = Number(l.tipo_iva) || 0;
        const retencionPct = Number(l.retencion_pct) || 0;

        const base = round2(cantidad * precio * (1 - descuento / 100));
        const iva = round2(base * tipoIva / 100);
        const retencion = round2(base * retencionPct / 100);
        const total = round2(base + iva - retencion);

        base_imponible += base;
        total_iva += iva;
        total_retencion += retencion;

        return {
          id_factura: id,
          id_linea: `L${String(i + 1).padStart(3, '0')}`,
          producto_id: l.producto_id || '',
          producto_ref: l.producto_ref || '',
          descripcion: l.descripcion || '',
          cantidad,
          precio_unitario: precio,
          descuento_pct: descuento,
          tipo_iva: tipoIva,
          iva_nombre: l.iva_nombre || `${tipoIva}%`,
          retencion_pct: retencionPct,
          base_linea: base,
          iva_linea: iva,
          retencion_linea: retencion,
          total_linea: total,
        };
      });

      // Reemplazo atómico: los Put sobrescriben L001..LNNN y solo se borran las
      // líneas antiguas sobrantes. Antes se borraba todo y se reinsertaba en un
      // bucle sin transacción: un fallo a mitad dejaba la factura sin líneas.
      const idsNuevos = new Set(nuevasLineas.map((l) => l.id_linea));
      const operaciones = [
        ...nuevasLineas.map((item) => ({ Put: { TableName: tables.facturasLineas, Item: item } })),
        ...oldLineas
          .filter((ol) => !idsNuevos.has(ol.id_linea))
          .map((ol) => ({
            Delete: { TableName: tables.facturasLineas, Key: { id_factura: id, id_linea: ol.id_linea } },
          })),
      ];
      // TransactWrite admite hasta 100 operaciones; trocear por si acaso.
      for (let i = 0; i < operaciones.length; i += 100) {
        const bloque = operaciones.slice(i, i + 100);
        if (bloque.length === 1 && bloque[0].Put) {
          await docClient.send(new PutCommand(bloque[0].Put));
        } else if (bloque.length > 0) {
          await docClient.send(new TransactWriteCommand({ TransactItems: bloque }));
        }
      }

      factura.base_imponible = round2(base_imponible);
      factura.total_iva = round2(total_iva);
      factura.total_retencion = round2(total_retencion);
      factura.total_factura = round2(base_imponible + total_iva - total_retencion);
      factura.saldo_pendiente = round2(factura.total_factura - (factura.total_cobrado || 0));
      factura.impuestos_resumen = buildImpuestosResumenFromLineas(body.lineas);

      // Gasto (IN) ya validado: al cambiar totales, recalcular estado de pago.
      // Usa estadoOriginal (no factura.estado) para no depender de body.estado.
      if (
        esGasto &&
        !['borrador', 'pendiente_revision', 'anulada'].includes(estadoOriginal)
      ) {
        const saldo = factura.saldo_pendiente;
        factura.saldo_pendiente = Math.max(0, saldo);
        if (saldo <= 0) {
          factura.estado = 'pagada';
        } else if ((factura.total_cobrado || 0) > 0) {
          factura.estado = 'parcialmente_pagada';
        } else {
          factura.estado = 'pendiente_pago';
        }
      }
    }

    factura.modificado_por = body.usuario_id || factura.modificado_por;
    factura.modificado_en = now();
    factura.version = (factura.version || 1) + 1;

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
    await registrarAuditoria(id, 'modificacion', body.usuario_id, body.usuario_nombre, changes);

    res.json({ ok: true, factura });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EMITIR factura (cambia estado + genera hash VERI*FACTU) ───

/** Validación masiva de facturas IN en pendiente_revision (p. ej. tras OCR). */
// [SEC S-01]
router.post('/facturacion/facturas/validar-revision', requirePermission('facturacion.emitir'), async (req, res) => {
  const { facturaIds } = req.body || {};
  const { usuario_id, usuario_nombre } = usuarioAuditoria(req);
  const ids = Array.isArray(facturaIds)
    ? [...new Set(facturaIds.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'facturaIds debe ser un array no vacío' });
  }

  try {
    const validadas = [];
    const fallidas = [];

    for (const id of ids) {
      const result = await emitirOValidarFacturaPorId(id, { usuario_id, usuario_nombre, soloRevision: true });
      if (result.ok) {
        validadas.push({ id_factura: id, estado: result.factura.estado });
      } else {
        fallidas.push({
          id_factura: id,
          motivo: result.errores?.join(' · ') || result.error || 'Error al validar',
        });
      }
    }

    res.json({
      ok: true,
      validadas: validadas.length,
      fallidas: fallidas.length,
      detalleValidadas: validadas,
      detalleFallidas: fallidas,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.post('/facturacion/facturas/:id/emitir', requirePermission('facturacion.emitir'), async (req, res) => {
  const id = req.params.id;
  const { usuario_id, usuario_nombre } = usuarioAuditoria(req);

  try {
    const existing = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
    );
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, existing.Item, res)) return;

    const result = await emitirOValidarFacturaPorId(id, { usuario_id, usuario_nombre });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.errores ? { errores: result.errores } : {}),
      });
    }
    res.json({ ok: true, factura: result.factura });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANULAR factura ───

// [SEC S-01]
router.post('/facturacion/facturas/:id/anular', requirePermission('facturacion.anular'), async (req, res) => {
  const id = req.params.id;
  const { motivo, usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, factura, res)) return;

    if (factura.estado === 'anulada') return res.status(400).json({ error: 'La factura ya está anulada' });
    if (factura.estado === 'borrador') {
      await docClient.send(new DeleteCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
      const lineas = await queryLineasByFactura(id);
      for (const l of lineas) {
        await docClient.send(new DeleteCommand({ TableName: tables.facturasLineas, Key: { id_factura: id, id_linea: l.id_linea } }));
      }
      await registrarAuditoria(id, 'eliminacion', usuario_id, usuario_nombre, { motivo });
      return res.json({ ok: true, eliminada: true });
    }

    factura.estado = 'anulada';
    factura.modificado_por = usuario_id || '';
    factura.modificado_en = now();
    factura.version = (factura.version || 1) + 1;
    factura.verifactu_registro_anulacion = JSON.stringify({
      id_factura: factura.id_factura,
      motivo: motivo || '',
      timestamp: now(),
    });

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
    await registrarAuditoria(id, 'anulacion', usuario_id, usuario_nombre, { motivo });

    res.json({ ok: true, factura });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Eliminación física solo para facturas de gasto (IN): pagos, líneas, auditoría y registro. */
// [SEC S-01]
router.delete('/facturacion/facturas/:id', requirePermission('facturacion.editar'), async (req, res) => {
  const id = req.params.id;
  const { usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, factura, res)) return;

    if (factura.tipo !== 'IN') {
      return res.status(403).json({
        error: 'Solo se pueden eliminar facturas de gasto (recibidas). Las facturas de venta deben anularse.',
      });
    }

    const pagos = await queryPagosByFactura(id);
    for (const p of pagos) {
      await deleteItemBySchema(tables.facturasPagos, p);
    }

    const lineas = await queryLineasByFactura(id);
    for (const l of lineas) {
      await deleteItemBySchema(tables.facturasLineas, l);
    }

    const audits = await queryAuditoriaByFactura(id);
    for (const a of audits) {
      await deleteItemBySchema(tables.facturasAuditoria, a);
    }

    await deleteItemBySchema(tables.facturas, factura);

    await registrarAuditoria(id, 'eliminacion', usuario_id, usuario_nombre, {
      tipo: 'IN',
      motivo: 'borrado_definitivo_gasto',
      estado_previo: factura.estado,
    });

    await eliminarArchivosS3Factura(id);

    res.json({ ok: true, eliminada: true });
  } catch (err) {
    console.error('[DELETE /facturacion/facturas/:id]', id, err?.message, err?.stack);
    res.status(500).json({ error: err.message || 'Error al eliminar la factura' });
  }
});

// ─── DUPLICAR factura ───

// [SEC S-01]
router.post('/facturacion/facturas/:id/duplicar', requirePermission('facturacion.crear'), async (req, res) => {
  const id = req.params.id;
  const { serie, usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const original = existing.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, original, res)) return;

    const targetSerie = serie || original.serie;
    const nuevaFechaEmision = now().slice(0, 10);
    const serieConfig = await getSerieConfig(targetSerie);
    if (!serieConfig) return res.status(404).json({ error: `Serie "${targetSerie}" no encontrada` });
    const errorTipoSerie = errorSerieTipoIncompatible(serieConfig, original.tipo);
    if (errorTipoSerie) return res.status(400).json({ error: errorTipoSerie });

    // La copia nace en borrador: en ventas (OUT) sin número hasta la emisión.
    let numero = 0;
    let nuevo_numero_factura = '';
    if (original.tipo !== 'OUT') {
      // La copia conserva la sociedad emisora de la original, que es la que
      // manda en el correlativo.
      const serieData = await calcNextNumeroPorScan(targetSerie, nuevaFechaEmision, original);
      if (!serieData) return res.status(404).json({ error: `Serie "${targetSerie}" no encontrada` });
      numero = serieData.ultimo_numero;
      nuevo_numero_factura = buildNumeroFactura(serieData, numero, nuevaFechaEmision);
    }
    const nuevo_id = uuid();

    const nueva = { ...original };
    nueva.id_entrada = nuevo_id;
    nueva.id_factura = nuevo_id;
    nueva.numero_factura = nuevo_numero_factura;
    nueva.serie = targetSerie;
    nueva.numero = numero;
    nueva.estado = 'borrador';
    nueva.fecha_emision = nuevaFechaEmision;
    nueva.fecha_operacion = '';
    nueva.fecha_vencimiento = '';
    nueva.total_cobrado = 0;
    nueva.saldo_pendiente = nueva.total_factura;
    nueva.creado_por = usuario_id || '';
    nueva.creado_en = now();
    nueva.modificado_por = usuario_id || '';
    nueva.modificado_en = now();
    nueva.version = 1;
    nueva.verifactu_hash = '';
    nueva.verifactu_hash_anterior = '';
    nueva.verifactu_qr_data = '';
    nueva.verifactu_registro_alta = '';
    nueva.verifactu_registro_anulacion = '';
    nueva.verifactu_estado = 'no_enviado';
    nueva.es_rectificativa = false;
    nueva.factura_rectificada_id = '';
    nueva.motivo_rectificacion = '';
    nueva.rectificativa_tipo = '';
    limpiarMarcasFacturacionPeriodica(nueva);
    if (nueva.tipo === 'IN') {
      nueva.fecha_contabilizacion = now();
      nueva.contabilizado_por = usuario_nombre || '';
      nueva.contabilizado_por_id = usuario_id || '';
    }

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: nueva }));

    const lineas = await queryLineasByFactura(id);
    for (const l of lineas) {
      await docClient.send(
        new PutCommand({
          TableName: tables.facturasLineas,
          Item: { ...l, id_entrada: `${nuevo_id}#${l.id_linea}`, id_factura: nuevo_id },
        })
      );
    }

    await registrarAuditoria(nuevo_id, 'creacion', usuario_id, usuario_nombre, { duplicada_de: id });

    res.json({ ok: true, factura: nueva });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RECTIFICATIVA ───

// [SEC S-01]
router.post('/facturacion/facturas/:id/rectificar', requirePermission('facturacion.emitir'), async (req, res) => {
  const id = req.params.id;
  const { serie_rectificativa, motivo, usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const original = existing.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, original, res)) return;

    if (original.estado === 'borrador' || original.estado === 'anulada') {
      return res.status(400).json({ error: 'No se puede rectificar una factura en borrador o anulada' });
    }

    // Sin serie explícita se elige una compatible con el tipo de la original: la
    // 'FR' de siempre es serie de venta y bloqueaba rectificar gastos. Criterio
    // definitivo (serie propia de rectificativas por tipo) pendiente de decidir.
    const targetSerie = serie_rectificativa || (await serieRectificativaPorDefecto(original.tipo, original.serie));
    if (!targetSerie) return res.status(400).json({ error: 'No hay ninguna serie disponible para la rectificativa' });
    const rectFechaEmision = now().slice(0, 10);
    const serieConfig = await getSerieConfig(targetSerie);
    if (!serieConfig) return res.status(404).json({ error: `Serie "${targetSerie}" no encontrada` });
    const errorTipoSerie = errorSerieTipoIncompatible(serieConfig, original.tipo);
    if (errorTipoSerie) return res.status(400).json({ error: errorTipoSerie });

    // La rectificativa nace en borrador: en ventas (OUT) sin número hasta la emisión.
    let numero = 0;
    let nuevo_numero_factura = '';
    if (original.tipo !== 'OUT') {
      // La rectificativa la emite la misma sociedad que la factura original.
      const serieData = await calcNextNumeroPorScan(targetSerie, rectFechaEmision, original);
      if (!serieData) return res.status(404).json({ error: `Serie "${targetSerie}" no encontrada` });
      numero = serieData.ultimo_numero;
      nuevo_numero_factura = buildNumeroFactura(serieData, numero, rectFechaEmision);
    }
    const nuevo_id = uuid();

    const rectificativa = { ...original };
    rectificativa.id_entrada = nuevo_id;
    rectificativa.id_factura = nuevo_id;
    rectificativa.numero_factura = nuevo_numero_factura;
    rectificativa.serie = targetSerie;
    rectificativa.numero = numero;
    rectificativa.estado = 'borrador';
    rectificativa.es_rectificativa = true;
    rectificativa.factura_rectificada_id = id;
    rectificativa.motivo_rectificacion = motivo || '';
    // Rectificar desde aquí es siempre **por sustitución**: se copia una factura
    // concreta para rehacerla, y queda señalada en `factura_rectificada_id`. Hay
    // que fijarlo y no heredarlo: rectificar un abono de rappel —que nace con
    // `rectificativa_tipo: 'diferencias'` y sin factura señalada— arrastraría ese
    // valor y produciría la combinación imposible "por diferencias con factura
    // concreta", que es justo la que distingue los dos tipos ante VERI*FACTU.
    rectificativa.rectificativa_tipo = 'sustitucion';
    limpiarMarcasFacturacionPeriodica(rectificativa);
    rectificativa.fecha_emision = rectFechaEmision;
    rectificativa.total_cobrado = 0;
    rectificativa.saldo_pendiente = rectificativa.total_factura;
    rectificativa.creado_por = usuario_id || '';
    rectificativa.creado_en = now();
    rectificativa.modificado_por = usuario_id || '';
    rectificativa.modificado_en = now();
    rectificativa.version = 1;
    rectificativa.verifactu_hash = '';
    rectificativa.verifactu_hash_anterior = '';
    rectificativa.verifactu_registro_alta = '';
    rectificativa.verifactu_registro_anulacion = '';
    rectificativa.verifactu_estado = 'no_enviado';

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: rectificativa }));

    const lineas = await queryLineasByFactura(id);
    for (const l of lineas) {
      await docClient.send(
        new PutCommand({
          TableName: tables.facturasLineas,
          Item: { ...l, id_entrada: `${nuevo_id}#${l.id_linea}`, id_factura: nuevo_id },
        })
      );
    }

    await registrarAuditoria(nuevo_id, 'rectificacion', usuario_id, usuario_nombre, { rectifica_a: id, motivo });

    res.json({ ok: true, factura: rectificativa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PAGOS / COBROS ───

// [SEC S-01]
router.get('/facturacion/pagos', requirePermission('facturacion.cobrar_pagar'), async (_req, res) => {
  try {
    const items = await scanAll(tables.facturasPagos);
    items.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json({ pagos: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.get('/facturacion/facturas/:id/pagos', requirePermission('facturacion.ver'), async (req, res) => {
  try {
    const existing = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(req.params.id) }),
    );
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, existing.Item, res)) return;

    const pagos = await queryPagosByFactura(req.params.id);
    pagos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    res.json({ pagos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Facturas IN compensables con la origen (misma sociedad + proveedor, saldo ≠ 0). */
// [SEC S-01]
router.get('/facturacion/facturas/:id/compensables', requirePermission('facturacion.cobrar_pagar'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const origenResult = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
    );
    if (!origenResult.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const origen = origenResult.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, origen, res)) return;
    if (origen.tipo !== 'IN') {
      return res.status(400).json({ error: 'La compensación solo aplica a facturas de gasto' });
    }

    const todas = await scanAll(tables.facturas, '#t = :t', { ':t': 'IN' }, { '#t': 'tipo' });
    const candidatas = filtrarFacturasCompensables(origen, todas).map((f) => ({
      id_factura: f.id_factura,
      numero_factura: f.numero_factura || '',
      numero_factura_proveedor: f.numero_factura_proveedor || '',
      empresa_nombre: f.empresa_nombre || '',
      emisor_nombre: f.emisor_nombre || '',
      fecha_emision: f.fecha_emision || '',
      estado: f.estado || '',
      total_factura: f.total_factura,
      saldo_pendiente: saldoFirmadoFactura(f),
      etiqueta: etiquetaFacturaCompensable(f),
    }));
    candidatas.sort((a, b) => String(b.fecha_emision || '').localeCompare(String(a.fecha_emision || '')));
    res.json({ ok: true, facturas: candidatas });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error al listar compensables' });
  }
});

// [SEC S-01]
router.post('/facturacion/facturas/:id/pagos/compensacion', requirePermission('facturacion.cobrar_pagar'), async (req, res) => {
  const b = req.body || {};
  const { usuario_id, usuario_nombre } = usuarioAuditoria(req);
  try {
    const origenResult = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(req.params.id) }),
    );
    if (!origenResult.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, origenResult.Item, res)) return;

    const remesaActiva = await findRemesaActivaDeFactura(req.params.id);
    if (remesaActiva) {
      return res.status(409).json({
        error: `Esta factura está en la remesa «${remesaActiva.nombre || remesaActiva.remesaId}»`,
        code: 'FACTURA_EN_REMESA',
        remesaActiva,
      });
    }
    const idsDestino = [...new Set(
      (Array.isArray(b.facturas_compensar) ? b.facturas_compensar : [])
        .map((x) => String(x).trim())
        .filter(Boolean),
    )];
    for (const idDestino of idsDestino) {
      const remesaDestino = await findRemesaActivaDeFactura(idDestino);
      if (remesaDestino) {
        return res.status(409).json({
          error: `La factura destino está en la remesa «${remesaDestino.nombre || remesaDestino.remesaId}»`,
          code: 'FACTURA_EN_REMESA',
          remesaActiva: remesaDestino,
        });
      }
    }
    const result = await registrarPagoCompensacion({
      id_factura_origen: req.params.id,
      facturas_compensar: b.facturas_compensar,
      importe: b.importe,
      fecha: b.fecha,
      observaciones: b.observaciones,
      usuario_id,
      usuario_nombre,
    });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Error al registrar compensación' });
  }
});

/** Acepta JSON o multipart/form-data (campo archivo `recibo`). */
function maybeUploadReciboPago(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    return upload.single('recibo')(req, res, next);
  }
  next();
}

// [SEC S-01]
router.post('/facturacion/facturas/:id/pagos', requirePermission('facturacion.cobrar_pagar'), maybeUploadReciboPago, async (req, res) => {
  const id_factura = req.params.id;
  const b = req.body || {};
  const fechaRaw = b.fecha;
  const importe = b.importe;
  const metodo_pago = b.metodo_pago;
  const cuenta_caja = b.cuenta_caja;
  const referencia = b.referencia;
  const observaciones = b.observaciones;
  const usuario_id = b.usuario_id;
  const usuario_nombre = b.usuario_nombre;

  const fechaIso = fechaToIsoGuardada(fechaRaw);
  if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
    return res.status(400).json({ error: 'La fecha es obligatoria (AAAA-MM-DD o dd/mm/aaaa)' });
  }

  const importeNum = round2(Number(importe));
  if (!importe || Number.isNaN(importeNum) || importeNum <= 0) {
    return res.status(400).json({ error: 'Importe debe ser mayor que 0' });
  }

  if (String(metodo_pago || '').trim().toLowerCase() === METODO_PAGO_COMPENSACION) {
    return res.status(400).json({
      error: 'La compensación entre facturas debe registrarse desde el flujo dedicado de compensación',
    });
  }

  try {
    const remesaActiva = await findRemesaActivaDeFactura(id_factura);
    if (remesaActiva) {
      return res.status(409).json({
        error: `Esta factura está en la remesa «${remesaActiva.nombre || remesaActiva.remesaId}»`,
        code: 'FACTURA_EN_REMESA',
        remesaActiva,
      });
    }

    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id_factura) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, factura, res)) return;

    const pagos = await queryPagosByFactura(id_factura);
    const nextIdx = pagos.length + 1;
    const id_pago = `P${String(nextIdx).padStart(3, '0')}`;

    let recibo_file_key = '';
    let recibo_nombre = '';
    if (req.file && req.file.buffer) {
      const buf = normalizeUploadBuffer(req.file.buffer); // [SEC S-06]
      const detectedMime = assertBufferMimeAllowed(buf, req.file.mimetype); // [SEC S-06]
      const safeName = sanitizeUploadFileName(req.file.originalname); // [SEC S-06]
      const ext = safeName.includes('.') ? safeName.split('.').pop() : 'bin';
      recibo_file_key = `facturas/${id_factura}/recibos/${Date.now()}_${uuid().slice(0, 8)}.${ext}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: recibo_file_key,
          Body: buf,
          ContentType: detectedMime || req.file.mimetype || 'application/octet-stream',
        })
      );
      recibo_nombre = safeName;
    }

    const pago = {
      id_entrada: `${id_factura}#${id_pago}`,
      id_factura,
      id_pago,
      fecha: fechaIso,
      importe: importeNum,
      metodo_pago: metodo_pago || '',
      cuenta_caja: cuenta_caja || '',
      referencia: referencia || '',
      observaciones: observaciones || '',
      justificante: '',
      recibo_file_key: recibo_file_key || '',
      recibo_nombre: recibo_nombre || '',
      creado_por: usuario_id || '',
      creado_en: now(),
    };

    await docClient.send(new PutCommand({ TableName: tables.facturasPagos, Item: pago }));

    const nuevoTotalCobrado = round2((factura.total_cobrado || 0) + importeNum);
    const nuevoSaldo = round2(factura.total_factura - nuevoTotalCobrado);

    let nuevoEstado = factura.estado;
    if (nuevoSaldo <= 0) {
      nuevoEstado = factura.tipo === 'OUT' ? 'cobrada' : 'pagada';
    } else if (nuevoTotalCobrado > 0) {
      nuevoEstado = factura.tipo === 'OUT' ? 'parcialmente_cobrada' : 'parcialmente_pagada';
    }

    factura.total_cobrado = nuevoTotalCobrado;
    factura.saldo_pendiente = Math.max(0, nuevoSaldo);
    factura.estado = nuevoEstado;
    factura.modificado_por = usuario_id || '';
    factura.modificado_en = now();

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
    await registrarAuditoria(id_factura, 'pago', usuario_id, usuario_nombre, { importe: importeNum, metodo_pago, nuevo_estado: nuevoEstado });

    res.json({ ok: true, pago, factura });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// [SEC S-01]
router.put('/facturacion/pagos/:id_factura/:id_pago', requirePermission('facturacion.cobrar_pagar'), async (req, res) => {
  const { id_factura, id_pago } = req.params;
  const b = req.body || {};
  const fechaRaw = b.fecha;
  const importe = b.importe;
  const metodo_pago = b.metodo_pago;
  const referencia = b.referencia;
  const observaciones = b.observaciones;
  const usuario_id = b.usuario_id;
  const usuario_nombre = b.usuario_nombre;

  const fechaIso = fechaToIsoGuardada(fechaRaw);
  if (!fechaIso || !/^\d{4}-\d{2}-\d{2}$/.test(fechaIso)) {
    return res.status(400).json({ error: 'La fecha es obligatoria (AAAA-MM-DD o dd/mm/aaaa)' });
  }

  const importeNum = round2(Number(importe));
  if (!importe || Number.isNaN(importeNum) || importeNum <= 0) {
    return res.status(400).json({ error: 'Importe debe ser mayor que 0' });
  }

  try {
    const remesaActiva = await findRemesaActivaDeFactura(id_factura);
    if (remesaActiva) {
      return res.status(409).json({
        error: `Esta factura está en la remesa «${remesaActiva.nombre || remesaActiva.remesaId}»`,
        code: 'FACTURA_EN_REMESA',
        remesaActiva,
      });
    }

    const pagoResult = await docClient.send(
      new GetCommand({ TableName: tables.facturasPagos, Key: { id_factura, id_pago } }),
    );
    if (!pagoResult.Item) return res.status(404).json({ error: 'Pago no encontrado' });
    if (String(pagoResult.Item.metodo_pago || '') === METODO_PAGO_COMPENSACION) {
      return res.status(400).json({
        error: 'Los pagos por compensación no se pueden editar. Contacta con administración si necesitas corregirlos.',
      });
    }
    if (String(metodo_pago || '').trim().toLowerCase() === METODO_PAGO_COMPENSACION) {
      return res.status(400).json({
        error: 'La compensación entre facturas debe registrarse desde el flujo dedicado de compensación',
      });
    }

    const facResult = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id_factura) }),
    );
    if (!facResult.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = facResult.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, factura, res)) return;

    const importeAnterior = round2(Number(pagoResult.Item.importe) || 0);
    const delta = round2(importeNum - importeAnterior);
    const nuevoTotalCobrado = round2(Math.max(0, (factura.total_cobrado || 0) + delta));
    const nuevoSaldo = round2(factura.total_factura - nuevoTotalCobrado);

    let nuevoEstado = factura.estado;
    if (nuevoSaldo <= 0 && factura.estado !== 'anulada') {
      nuevoEstado = factura.tipo === 'OUT' ? 'cobrada' : 'pagada';
    } else if (nuevoTotalCobrado <= 0 && factura.estado !== 'anulada') {
      nuevoEstado = factura.tipo === 'OUT' ? 'emitida' : 'pendiente_pago';
    } else if (nuevoTotalCobrado > 0 && nuevoSaldo > 0) {
      nuevoEstado = factura.tipo === 'OUT' ? 'parcialmente_cobrada' : 'parcialmente_pagada';
    }

    const pagoActualizado = {
      ...pagoResult.Item,
      fecha: fechaIso,
      importe: importeNum,
      metodo_pago: metodo_pago || '',
      referencia: referencia || '',
      observaciones: observaciones || '',
      modificado_por: usuario_id || '',
      modificado_en: now(),
    };

    await docClient.send(new PutCommand({ TableName: tables.facturasPagos, Item: pagoActualizado }));

    factura.total_cobrado = nuevoTotalCobrado;
    factura.saldo_pendiente = Math.max(0, nuevoSaldo);
    factura.estado = nuevoEstado;
    factura.modificado_por = usuario_id || '';
    factura.modificado_en = now();

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
    await registrarAuditoria(id_factura, 'editar_pago', usuario_id, usuario_nombre, {
      id_pago,
      importe_anterior: importeAnterior,
      importe_nuevo: importeNum,
      metodo_pago,
      nuevo_estado: nuevoEstado,
    });

    res.json({ ok: true, pago: pagoActualizado, factura });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.delete('/facturacion/pagos/:id_factura/:id_pago', requirePermission('facturacion.cobrar_pagar'), async (req, res) => {
  const { id_factura, id_pago } = req.params;
  const { usuario_id, usuario_nombre } = req.body || {};

  try {
    const facResult = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id_factura) }),
    );
    if (!facResult.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, facResult.Item, res)) return;

    const remesaActiva = await findRemesaActivaDeFactura(id_factura);
    if (remesaActiva) {
      return res.status(409).json({
        error: `Esta factura está en la remesa «${remesaActiva.nombre || remesaActiva.remesaId}»`,
        code: 'FACTURA_EN_REMESA',
        remesaActiva,
      });
    }

    const pagoResult = await docClient.send(
      new GetCommand({ TableName: tables.facturasPagos, Key: { id_factura, id_pago } })
    );
    if (!pagoResult.Item) return res.status(404).json({ error: 'Pago no encontrado' });
    if (String(pagoResult.Item.metodo_pago || '') === METODO_PAGO_COMPENSACION) {
      return res.status(400).json({
        error: 'Los pagos por compensación no se pueden eliminar desde aquí. Contacta con administración si necesitas corregirlos.',
      });
    }

    await docClient.send(new DeleteCommand({ TableName: tables.facturasPagos, Key: { id_factura, id_pago } }));

    const factura = facResult.Item;
    const nuevoTotalCobrado = round2(Math.max(0, (factura.total_cobrado || 0) - pagoResult.Item.importe));
    const nuevoSaldo = round2(factura.total_factura - nuevoTotalCobrado);

    let nuevoEstado = factura.estado;
    if (nuevoTotalCobrado <= 0 && factura.estado !== 'anulada') {
      nuevoEstado = factura.tipo === 'OUT' ? 'emitida' : 'pendiente_pago';
    } else if (nuevoTotalCobrado > 0 && nuevoSaldo > 0) {
      nuevoEstado = factura.tipo === 'OUT' ? 'parcialmente_cobrada' : 'parcialmente_pagada';
    }

    factura.total_cobrado = nuevoTotalCobrado;
    factura.saldo_pendiente = Math.max(0, nuevoSaldo);
    factura.estado = nuevoEstado;
    factura.modificado_en = now();

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
    await registrarAuditoria(id_factura, 'eliminar_pago', usuario_id, usuario_nombre, { id_pago, importe: pagoResult.Item.importe });
    res.json({ ok: true, factura });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MÉTRICAS / RESUMEN ───

// [SEC S-01]
router.get('/facturacion/metricas', requirePermission('facturacion.ver'), async (req, res) => {
  try {
    const empresaIdFiltro = String(req.query.empresaId || '').trim();
    const anioQ = parseInt(String(req.query.anio || ''), 10);
    const mesQ = parseInt(String(req.query.mes || ''), 10);
    const tieneAnio = Number.isFinite(anioQ) && anioQ >= 1970 && anioQ <= 2100;
    const tieneFiltroMes = tieneAnio && Number.isFinite(mesQ) && mesQ >= 1 && mesQ <= 12;
    const prefijoMes = tieneFiltroMes
      ? `${anioQ}-${String(mesQ).padStart(2, '0')}`
      : null;
    const prefijoAnio = (!tieneFiltroMes && tieneAnio) ? `${anioQ}-` : null;

    let facturas = await scanAll(tables.facturas);
    // [SEC S-08]
    const empresasOk = await empresasPermitidasDelUsuario(req.user);
    facturas = facturas.filter((f) => facturaEmisorPermitido(f, empresasOk));

    let out = facturas.filter((f) => f.tipo === 'OUT');
    let inF = facturas.filter((f) => f.tipo === 'IN');
    if (empresaIdFiltro) {
      out = out.filter((f) => String(f.emisor_id || '').trim() === empresaIdFiltro);
      inF = inF.filter((f) => String(f.emisor_id || '').trim() === empresaIdFiltro);
    }
    if (prefijoMes) {
      const enMes = (f) => (f.fecha_emision || '').startsWith(prefijoMes);
      out = out.filter(enMes);
      inF = inF.filter(enMes);
    } else if (prefijoAnio) {
      const enAnio = (f) => (f.fecha_emision || '').startsWith(prefijoAnio);
      out = out.filter(enAnio);
      inF = inF.filter(enAnio);
    }

    const activas = (arr) => arr.filter((f) => f.estado !== 'borrador' && f.estado !== 'anulada');

    const totalEmitido = activas(out).reduce((s, f) => s + (f.total_factura || 0), 0);
    const totalCobrado = out.reduce((s, f) => s + (f.total_cobrado || 0), 0);
    const totalPendienteCobro = out.filter((f) => !['anulada', 'borrador', 'cobrada'].includes(f.estado)).reduce((s, f) => s + (f.saldo_pendiente || 0), 0);
    const facturasVencidas = out.filter((f) => f.estado === 'vencida');

    const totalGastos = activas(inF).reduce((s, f) => s + (f.total_factura || 0), 0);
    const totalPagado = inF.reduce((s, f) => s + (f.total_cobrado || 0), 0);
    const totalPendientePago = inF.filter((f) => !['anulada', 'borrador', 'pagada'].includes(f.estado)).reduce((s, f) => s + (f.saldo_pendiente || 0), 0);

    const pad2 = (n) => String(n).padStart(2, '0');
    const meses = [];
    if (prefijoMes) {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(anioQ, mesQ - 1 - i, 1);
        meses.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
      }
    } else if (prefijoAnio) {
      for (let m = 0; m < 12; m++) {
        meses.push(`${anioQ}-${pad2(m + 1)}`);
      }
    } else {
      const hoy = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
        meses.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
      }
    }

    const tieneFiltroPeriodo = !!(prefijoMes || prefijoAnio);
    const outBase = tieneFiltroPeriodo ? facturas.filter((f) => f.tipo === 'OUT') : out;
    const inBase = tieneFiltroPeriodo ? facturas.filter((f) => f.tipo === 'IN') : inF;
    let outChart = outBase;
    let inChart = inBase;
    if (empresaIdFiltro) {
      outChart = outChart.filter((f) => String(f.emisor_id || '').trim() === empresaIdFiltro);
      inChart = inChart.filter((f) => String(f.emisor_id || '').trim() === empresaIdFiltro);
    }

    const mensual = meses.map((mesKey) => {
      const outMes = activas(outChart).filter((f) => (f.fecha_emision || '').startsWith(mesKey));
      const inMes = activas(inChart).filter((f) => (f.fecha_emision || '').startsWith(mesKey));
      return {
        mes: mesKey,
        ingresos: round2(outMes.reduce((s, f) => s + (f.total_factura || 0), 0)),
        gastos: round2(inMes.reduce((s, f) => s + (f.total_factura || 0), 0)),
        cobrado: round2(outMes.reduce((s, f) => s + (f.total_cobrado || 0), 0)),
        pagado: round2(inMes.reduce((s, f) => s + (f.total_cobrado || 0), 0)),
        numOut: outMes.length,
        numIn: inMes.length,
      };
    });

    // Top 5 clientes por facturación
    const porCliente = {};
    activas(out).forEach((f) => {
      const k = f.empresa_nombre || 'Sin cliente';
      if (!porCliente[k]) porCliente[k] = { nombre: k, total: 0, count: 0 };
      porCliente[k].total += f.total_factura || 0;
      porCliente[k].count++;
    });
    const topClientes = Object.values(porCliente).sort((a, b) => b.total - a.total).slice(0, 5)
      .map((c) => ({ nombre: c.nombre, total: round2(c.total), count: c.count }));

    // Top 5 proveedores por gasto
    const porProveedor = {};
    activas(inF).forEach((f) => {
      const k = f.empresa_nombre || 'Sin proveedor';
      if (!porProveedor[k]) porProveedor[k] = { nombre: k, total: 0, count: 0 };
      porProveedor[k].total += f.total_factura || 0;
      porProveedor[k].count++;
    });
    const topProveedores = Object.values(porProveedor).sort((a, b) => b.total - a.total).slice(0, 5)
      .map((p) => ({ nombre: p.nombre, total: round2(p.total), count: p.count }));

    // Distribución por estado
    const estadosOut = {};
    out.forEach((f) => { estadosOut[f.estado] = (estadosOut[f.estado] || 0) + 1; });
    const estadosIn = {};
    inF.forEach((f) => { estadosIn[f.estado] = (estadosIn[f.estado] || 0) + 1; });

    res.json({
      empresaId: empresaIdFiltro || null,
      anio: tieneAnio ? anioQ : null,
      mes: tieneFiltroMes ? mesQ : null,
      metricas: {
        totalEmitido: round2(totalEmitido),
        totalCobrado: round2(totalCobrado),
        totalPendienteCobro: round2(totalPendienteCobro),
        facturasVencidasCount: facturasVencidas.length,
        facturasVencidasImporte: round2(facturasVencidas.reduce((s, f) => s + (f.saldo_pendiente || 0), 0)),
        totalGastos: round2(totalGastos),
        totalPagado: round2(totalPagado),
        totalPendientePago: round2(totalPendientePago),
        countOut: out.length,
        countIn: inF.length,
        margenNeto: round2(totalEmitido - totalGastos),
        mensual,
        topClientes,
        topProveedores,
        estadosOut,
        estadosIn,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ENVÍO EMAIL CON PDF ───

// [SEC S-01]
router.post('/facturacion/facturas/:id/enviar-email', requirePermission('facturacion.editar'), async (req, res) => {
  const id = req.params.id;
  const { destinatario, asunto, cuerpo, pdf_base64, usuario_id, usuario_nombre } = req.body || {};

  if (!destinatario) return res.status(400).json({ error: 'Falta destinatario' });
  if (!process.env.SMTP_USER) return res.status(500).json({ error: 'SMTP no configurado. Define SMTP_HOST, SMTP_USER y SMTP_PASS en variables de entorno.' });

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, factura, res)) return;

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: destinatario,
      subject: asunto || `Factura ${factura.numero_factura || id}`,
      html: cuerpo || `
        <p>Estimado/a <strong>${factura.empresa_nombre || 'cliente'}</strong>,</p>
        <p>Adjuntamos la factura <strong>${factura.numero_factura || id}</strong> por un total de <strong>${(factura.total_factura || 0).toFixed(2)} €</strong>.</p>
        <p>Quedamos a su disposición para cualquier consulta.</p>
        <p>Un saludo,<br/>IPG Hostelería</p>
      `,
      attachments: pdf_base64
        ? [{
            filename: `${factura.numero_factura || id}.pdf`,
            content: Buffer.from(pdf_base64, 'base64'),
            contentType: 'application/pdf',
          }]
        : [],
    };

    await enviarEmail(mailOptions);

    await registrarAuditoria(id, 'envio_email', usuario_id, usuario_nombre, {
      destinatario,
      asunto: mailOptions.subject,
    });

    res.json({ ok: true, message: `Email enviado a ${destinatario}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MÉTRICAS AVANZADAS (cuadro de mando) ───

// [SEC S-01]
router.get('/facturacion/metricas-avanzadas', requirePermission('facturacion.ver'), async (req, res) => {
  try {
    let facturas = await scanAll(tables.facturas);
    // [SEC S-08]
    const empresasOk = await empresasPermitidasDelUsuario(req.user);
    facturas = facturas.filter((f) => facturaEmisorPermitido(f, empresasOk));

    const pagos = await scanAll(tables.facturasPagos);
    const hoy = new Date();
    const anioActual = hoy.getFullYear();
    const mesActual = hoy.getMonth();

    const activas = facturas.filter((f) => f.estado !== 'anulada');
    const out = activas.filter((f) => f.tipo === 'OUT');
    const inF = activas.filter((f) => f.tipo === 'IN');

    const empresaIdFiltro = String(req.query.empresaId || '').trim();
    const outS = empresaIdFiltro ? out.filter((f) => String(f.emisor_id || '').trim() === empresaIdFiltro) : out;
    /** Recibidas: misma sociedad del grupo que en emitidas (emisor = empresa receptora del gasto). */
    const inS = empresaIdFiltro ? inF.filter((f) => String(f.emisor_id || '').trim() === empresaIdFiltro) : inF;

    const empMap = new Map();
    for (const f of activas) {
      const id = String(f.emisor_id || '').trim();
      if (!id) continue;
      const nombre = String(f.emisor_nombre || '').trim() || id;
      if (!empMap.has(id)) empMap.set(id, nombre);
    }
    const empresasOpciones = [...empMap.entries()]
      .map(([id, nombre]) => ({ id, nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    const idsFacturasScope = new Set();
    for (const f of outS) {
      if (f.id_factura) idsFacturasScope.add(f.id_factura);
    }
    for (const f of inS) {
      if (f.id_factura) idsFacturasScope.add(f.id_factura);
    }

    // Desglose mensual últimos 24 meses
    const meses24 = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(anioActual, mesActual - i, 1);
      meses24.push(d.toISOString().slice(0, 7));
    }

    const mensual = meses24.map((mes) => {
      const oM = outS.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(mes));
      const iM = inS.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(mes));
      const ingresos = round2(oM.reduce((s, f) => s + (f.total_factura || 0), 0));
      const gastos = round2(iM.reduce((s, f) => s + (f.total_factura || 0), 0));
      return {
        mes,
        ingresos,
        gastos,
        margen: round2(ingresos - gastos),
        cobrado: round2(oM.reduce((s, f) => s + (f.total_cobrado || 0), 0)),
        pagado: round2(iM.reduce((s, f) => s + (f.total_cobrado || 0), 0)),
        numOut: oM.length,
        numIn: iM.length,
        baseIva: round2(oM.reduce((s, f) => s + (f.total_iva || 0), 0)),
        ivaSoportado: round2(iM.reduce((s, f) => s + (f.total_iva || 0), 0)),
      };
    });

    // Desglose trimestral año actual
    const trimestres = [0, 1, 2, 3].map((q) => {
      const mStart = q * 3;
      const mesesQ = [0, 1, 2].map((i) => {
        const d = new Date(anioActual, mStart + i, 1);
        return d.toISOString().slice(0, 7);
      });
      const oQ = outS.filter((f) => f.estado !== 'borrador' && mesesQ.some((m) => (f.fecha_emision || '').startsWith(m)));
      const iQ = inS.filter((f) => f.estado !== 'borrador' && mesesQ.some((m) => (f.fecha_emision || '').startsWith(m)));
      const ing = round2(oQ.reduce((s, f) => s + (f.total_factura || 0), 0));
      const gas = round2(iQ.reduce((s, f) => s + (f.total_factura || 0), 0));
      return {
        trimestre: `T${q + 1}`,
        ingresos: ing,
        gastos: gas,
        margen: round2(ing - gas),
        ivaRepercutido: round2(oQ.reduce((s, f) => s + (f.total_iva || 0), 0)),
        ivaSoportado: round2(iQ.reduce((s, f) => s + (f.total_iva || 0), 0)),
      };
    });

    // Año actual vs anterior
    const anioAnt = String(anioActual - 1);
    const anioCur = String(anioActual);
    const outAnt = outS.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioAnt));
    const outCur = outS.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioCur));
    const inAnt = inS.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioAnt));
    const inCur = inS.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioCur));

    const comparativa = {
      anioActual: {
        ingresos: round2(outCur.reduce((s, f) => s + (f.total_factura || 0), 0)),
        gastos: round2(inCur.reduce((s, f) => s + (f.total_factura || 0), 0)),
        numOut: outCur.length,
        numIn: inCur.length,
      },
      anioAnterior: {
        ingresos: round2(outAnt.reduce((s, f) => s + (f.total_factura || 0), 0)),
        gastos: round2(inAnt.reduce((s, f) => s + (f.total_factura || 0), 0)),
        numOut: outAnt.length,
        numIn: inAnt.length,
      },
    };

    // Aging (antigüedad deuda)
    const hoyStr = hoy.toISOString().slice(0, 10);
    const pendientes = outS.filter((f) => (f.saldo_pendiente || 0) > 0 && !['anulada', 'borrador', 'cobrada'].includes(f.estado));
    const aging = { corriente: 0, '30d': 0, '60d': 0, '90d': 0, mas90: 0 };
    pendientes.forEach((f) => {
      const fv = f.fecha_vencimiento || f.fecha_emision || '';
      if (!fv) { aging.corriente += f.saldo_pendiente || 0; return; }
      const dias = Math.floor((new Date(hoyStr).getTime() - new Date(fv).getTime()) / 86400000);
      if (dias <= 0) aging.corriente += f.saldo_pendiente || 0;
      else if (dias <= 30) aging['30d'] += f.saldo_pendiente || 0;
      else if (dias <= 60) aging['60d'] += f.saldo_pendiente || 0;
      else if (dias <= 90) aging['90d'] += f.saldo_pendiente || 0;
      else aging.mas90 += f.saldo_pendiente || 0;
    });
    Object.keys(aging).forEach((k) => { aging[k] = round2(aging[k]); });

    // Desglose IVA trimestral (para modelo 303)
    const ivaResumen = trimestres.map((t) => ({
      trimestre: t.trimestre,
      repercutido: t.ivaRepercutido,
      soportado: t.ivaSoportado,
      diferencia: round2(t.ivaRepercutido - t.ivaSoportado),
    }));

    // Actividad reciente (últimos pagos)
    const pagosRecientes = pagos
      .filter((p) => idsFacturasScope.has(p.id_factura))
      .sort((a, b) => (b.creado_en || '').localeCompare(a.creado_en || ''))
      .slice(0, 10)
      .map((p) => ({
        id_pago: p.id_pago,
        id_factura: p.id_factura,
        fecha: p.fecha,
        importe: p.importe,
        metodo_pago: p.metodo_pago,
        creado_por: p.creado_por_nombre || '',
      }));

    res.json({
      mensual,
      trimestres,
      comparativa,
      aging,
      ivaResumen,
      pagosRecientes,
      empresasOpciones,
      empresaId: empresaIdFiltro || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Automatización: marcar facturas vencidas ───

// [SEC S-01]
router.post('/facturacion/check-vencimientos', requirePermission('facturacion.editar'), async (req, res) => {
  try {
    const hoy = now().slice(0, 10);
    const facturas = await scanAll(tables.facturas);

    const pendientes = facturas.filter(
      (f) =>
        f.fecha_vencimiento &&
        f.fecha_vencimiento < hoy &&
        ['emitida', 'parcialmente_cobrada', 'pendiente_pago', 'parcialmente_pagada'].includes(f.estado),
    );

    let actualizadas = 0;
    for (const f of pendientes) {
      await docClient.send(
        new UpdateCommand({
          TableName: tables.facturas,
          Key: await keyForFacturaItem(f),
          UpdateExpression: 'SET estado = :e, actualizado_en = :ts',
          ExpressionAttributeValues: { ':e': 'vencida', ':ts': now() },
        }),
      );
      await registrarAuditoria(f.id_factura, 'vencimiento_auto', 'sistema', 'Sistema', {
        estado_anterior: f.estado,
        fecha_vencimiento: f.fecha_vencimiento,
      });
      actualizadas++;
    }

    res.json({ ok: true, revisadas: facturas.length, actualizadas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CONCILIACIÓN ALBARÁN ↔ FACTURA IN ───

/** Reemplaza el array completo `albaranes_conciliados` de una factura IN. */
// [SEC S-01]
router.put('/facturacion/facturas/:id/albaranes-conciliados', requirePermission('facturacion.emitir'), async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  const { usuario_id, usuario_nombre } = usuarioAuditoria(req);

  try {
    const existing = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
    );
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, existing.Item, res)) return;

    const factura = existing.Item;
    if (String(factura.tipo || '').toUpperCase() !== 'IN') {
      return res.status(400).json({ error: 'Solo facturas de tipo IN admiten albaranes conciliados' });
    }
    if (String(factura.estado || '').toLowerCase() !== 'pendiente_revision') {
      return res.status(409).json({
        error: 'No se pueden modificar albaranes conciliados tras validar la factura',
      });
    }

    const fechaFactura =
      fechaEmisionFacturaAIso(factura.fecha_emision) || fechaToIsoGuardada(factura.fecha_emision) || '';
    const sanitized = sanitizeAlbaranesConciliados(body.albaranes_conciliados, {
      id_factura: factura.id_factura || id,
      numero_factura: numeroFacturaParaConciliacion(factura),
      fecha_factura: fechaFactura,
      ahoraIso: now(),
      asignado_por: usuario_nombre,
      asignado_por_id: usuario_id,
    });
    if (!sanitized.ok) {
      return res.status(400).json({ error: sanitized.error });
    }

    const ts = now();
    await docClient.send(
      new UpdateCommand({
        TableName: tables.facturas,
        Key: await keyForFacturaPrincipalId(id),
        UpdateExpression: 'SET albaranes_conciliados = :a, actualizado_en = :ts',
        ExpressionAttributeValues: { ':a': sanitized.items, ':ts': ts },
      }),
    );

    await registrarAuditoria(id, 'albaranes_conciliados', usuario_id, usuario_nombre, {
      count: sanitized.items.length,
      keys: sanitized.items.map((x) => x.key),
    });

    res.json({
      ok: true,
      albaranes_conciliados: sanitized.items,
      factura: {
        id_factura: factura.id_factura || id,
        albaranes_conciliados: sanitized.items,
        actualizado_en: ts,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADJUNTOS (S3) ───

// [SEC S-01]
router.post('/facturacion/facturas/:id/adjuntos', requirePermission('facturacion.editar'), upload.single('file'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const buf = normalizeUploadBuffer(req.file.buffer); // [SEC S-06]
    const detectedMime = assertBufferMimeAllowed(buf, req.file.mimetype); // [SEC S-06]
    const safeName = sanitizeUploadFileName(req.file.originalname); // [SEC S-06]

    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, existing.Item, res)) return;

    const ext = safeName.includes('.') ? safeName.split('.').pop() : 'bin';
    const fileKey = `facturas/${id}/${Date.now()}_${uuid().slice(0, 8)}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: buf,
      ContentType: detectedMime || req.file.mimetype,
    }));

    const adjuntos = existing.Item.adjuntos || [];
    adjuntos.push({
      id: uuid(),
      fileKey,
      nombre: safeName,
      tipo: detectedMime || req.file.mimetype,
      size: buf.length,
      subido_en: now(),
      subido_por: req.body.usuario_nombre || '',
    });

    await docClient.send(new UpdateCommand({
      TableName: tables.facturas,
      Key: await keyForFacturaPrincipalId(id),
      UpdateExpression: 'SET adjuntos = :adj, actualizado_en = :ts',
      ExpressionAttributeValues: { ':adj': adjuntos, ':ts': now() },
    }));

    await registrarAuditoria(id, 'adjunto_subido', req.body.usuario_id, req.body.usuario_nombre, {
      nombre: safeName,
      fileKey,
    });

    res.json({ ok: true, adjuntos });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// [SEC S-01]
router.get('/facturacion/facturas/:id/adjuntos', requirePermission('facturacion.ver'), async (req, res) => {
  const id = req.params.id;
  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, existing.Item, res)) return;

    let adjuntos = Array.isArray(existing.Item.adjuntos) ? [...existing.Item.adjuntos] : [];
    if (adjuntos.length === 0 && existing.Item.documento_file_key) {
      adjuntos = [
        {
          id: 'documento',
          fileKey: existing.Item.documento_file_key,
          nombre: existing.Item.documento_nombre || '',
          tipo: 'application/octet-stream',
          size: 0,
        },
      ];
    }
    const withUrls = await Promise.all(
      adjuntos.map(async (a) => {
        const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: a.fileKey });
        const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
        return { ...a, url };
      })
    );

    res.json({ adjuntos: withUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [SEC S-01]
router.delete('/facturacion/facturas/:id/adjuntos/:adjId', requirePermission('facturacion.editar'), async (req, res) => {
  const { id, adjId } = req.params;
  const { usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, existing.Item, res)) return;

    const adjuntos = existing.Item.adjuntos || [];
    const adj = adjuntos.find((a) => a.id === adjId);
    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });

    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: adj.fileKey }));

    const nuevos = adjuntos.filter((a) => a.id !== adjId);
    await docClient.send(new UpdateCommand({
      TableName: tables.facturas,
      Key: await keyForFacturaPrincipalId(id),
      UpdateExpression: 'SET adjuntos = :adj, actualizado_en = :ts',
      ExpressionAttributeValues: { ':adj': nuevos, ':ts': now() },
    }));

    await registrarAuditoria(id, 'adjunto_eliminado', usuario_id, usuario_nombre, { nombre: adj.nombre });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function adjuntosDeFacturaItem(item) {
  let adjuntos = Array.isArray(item.adjuntos) ? [...item.adjuntos] : [];
  if (adjuntos.length === 0 && item.documento_file_key) {
    adjuntos = [
      {
        id: 'documento',
        fileKey: item.documento_file_key,
        nombre: item.documento_nombre || '',
        tipo: 'application/octet-stream',
        size: 0,
      },
    ];
  }
  return adjuntos;
}

// [SEC S-01]
router.get('/facturacion/facturas/:id/adjuntos/:adjId/descargar', requirePermission('facturacion.ver'), async (req, res) => {
  const { id, adjId } = req.params;
  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    // [SEC S-08]
    if (await rejectFacturaEmisorNoPermitido(req, existing.Item, res)) return;

    const adjuntos = adjuntosDeFacturaItem(existing.Item);
    const indice = adjuntos.findIndex((a) => a.id === adjId);
    if (indice < 0) return res.status(404).json({ error: 'Adjunto no encontrado' });
    const adj = adjuntos[indice];

    const filename =
      existing.Item.tipo === 'IN'
        ? nombreFicheroAdjuntoFacturaRecibida(existing.Item, adj, indice)
        : (adj.nombre || `adjunto-${adjId}`).replace(/[/\\:*?"<>|]/g, '_');

    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: adj.fileKey }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const contentType = obj.ContentType || adj.tipo || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OCR / REGISTRO MASIVO ───

// [SEC S-01]
router.get('/facturacion/ocr/status', requirePermission('facturacion.crear'), (_req, res) => {
  res.json({ ready: isTesseractWorkerReady() });
});

// [SEC S-01]
router.post('/facturacion/ocr/prewarm', requirePermission('facturacion.crear'), async (_req, res) => {
  try {
    await prewarmTesseractWorker();
    res.json({ ok: true, ready: isTesseractWorkerReady() });
  } catch (err) {
    res.status(500).json({ error: err.message, ready: false });
  }
});

// [SEC S-01]
router.post('/facturacion/ocr/extraer', requirePermission('facturacion.crear'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const buf = normalizeUploadBuffer(req.file.buffer); // [SEC S-06]
    const detectedMime = assertBufferMimeAllowed(buf, req.file.mimetype); // [SEC S-06]
    const safeName = sanitizeUploadFileName(req.file.originalname); // [SEC S-06]

    const extracted = await extraerDatosBasicos(buf, detectedMime || req.file.mimetype, safeName);

    const fileKey = `facturas/ocr-temp/${Date.now()}_${uuid().slice(0, 8)}_${safeName}`;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: buf,
      ContentType: detectedMime || req.file.mimetype,
    }));

    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
    const previewUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });

    res.json({
      ok: true,
      datos: extracted,
      archivo: {
        fileKey,
        nombre: safeName,
        tipo: detectedMime || req.file.mimetype,
        size: buf.length,
        previewUrl,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** Tras elegir sociedad receptora: separar proveedor y opcionalmente ajustar importes (respeta campos_manuales). */
// [SEC S-01]
router.post('/facturacion/ocr/reconciliar', requirePermission('facturacion.crear'), async (req, res) => {
  try {
    const datos = await ejecutarReconciliarFacturaOcr(req.body || {});
    res.json({ ok: true, datos });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

/**
 * Capa IA opcional: normaliza y valida datos ya extraídos (requiere OPENAI_API_KEY en el servidor).
 * POST body: { datos: object, texto_extraido?: string }
 */
// [SEC S-01]
router.post('/facturacion/ocr/enriquecer-ia', requirePermission('facturacion.crear'), async (req, res) => {
  try {
    const { datos, texto_extraido } = req.body || {};
    if (!datos || typeof datos !== 'object') {
      return res.status(400).json({ error: 'Falta objeto datos' });
    }
    if (!isIaEnriquecimientoDisponible()) {
      return res.json({
        ok: true,
        skipped: true,
        reason: 'Configure OPENAI_API_KEY en el servidor para activar la capa IA.',
        datos,
      });
    }

    const texto = texto_extraido != null ? String(texto_extraido) : String(datos.texto_extraido || '');
    const iaParsed = await enriquecerFacturaOcrConOpenAI(datos, texto);
    let merged = mergeExtraccionConIa(datos, iaParsed);

    merged.texto_extraido = datos.texto_extraido;
    merged.metodo_extraccion = datos.metodo_extraccion;
    merged.entidades_candidatas = Array.isArray(datos.entidades_candidatas) ? datos.entidades_candidatas : [];
    merged.ambiguedad_proveedor = datos.ambiguedad_proveedor;

    if (merged.proveedor_cif) {
      try {
        const emp = await buscarEmpresaPorCif(merged.proveedor_cif);
        if (emp) {
          merged.proveedor_nombre = getNombreFromEmpresaItem(emp);
          merged.empresa_id = getIdEmpresaFromItem(emp);
          merged.proveedor_en_maestros = true;
          merged.nombre_sugerido_ocr = '';
          merged.confianza = {
            ...merged.confianza,
            proveedor_nombre: 'alta',
            proveedor_cif: 'alta',
          };
        } else {
          merged.proveedor_en_maestros = false;
          merged.empresa_id = '';
          merged.nombre_sugerido_ocr =
            merged.proveedor_nombre || datos.nombre_sugerido_ocr || inferProveedorNombre(texto, merged.proveedor_cif) || '';
        }
      } catch (e) {
        console.error('[OCR IA] buscarEmpresaPorCif:', e.message);
      }
    } else {
      merged.proveedor_en_maestros = false;
      merged.empresa_id = '';
    }

    aplicarPostProcesadoPipeline(merged, texto);
    /** Mismo criterio que extraer: desglose solo manual en UI. No tocar lineas_articulos. */
    merged.desglose_impuestos = [];
    if (merged.extraction_snapshot && typeof merged.extraction_snapshot === 'object') {
      merged.extraction_snapshot = {
        ...merged.extraction_snapshot,
        desglose_impuestos: [],
      };
    }
    if (!Array.isArray(merged.lineas_articulos)) {
      merged.lineas_articulos = [];
    }

    res.json({ ok: true, datos: merged });
  } catch (err) {
    console.error('[OCR IA]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ─── OCR POR ZONA (selección manual tipo a3) ───

// [SEC S-01]
router.post('/facturacion/ocr/extraer-zona', requirePermission('facturacion.crear'), async (req, res) => {
  const { fileKey, x, y, width, height, pageWidth, pageHeight } = req.body || {};
  if (!fileKey || width == null || height == null) {
    return res.status(400).json({ error: 'Faltan parámetros (fileKey, x, y, width, height)' });
  }

  try {
    const sharp = (await import('sharp')).default;

    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const fileBuffer = Buffer.concat(chunks);

    const mimetype = obj.ContentType || '';
    const isImage = IMAGE_MIMES.includes(mimetype);
    const isPdf = isPdfMime(mimetype, fileKey);

    let imgBuffer;
    if (isImage) {
      imgBuffer = fileBuffer;
    } else if (isPdf) {
      imgBuffer = await renderPdfFirstPageToPngBuffer(fileBuffer);
      if (!imgBuffer) return res.status(500).json({ error: 'No se pudo rasterizar el PDF' });
    } else {
      return res.status(400).json({ error: 'Tipo de archivo no soportado' });
    }

    const meta = await sharp(imgBuffer).metadata();
    const imgW = meta.width || 1;
    const imgH = meta.height || 1;

    const scaleX = imgW / (pageWidth || imgW);
    const scaleY = imgH / (pageHeight || imgH);

    const left = Math.max(0, Math.round(x * scaleX));
    const top = Math.max(0, Math.round(y * scaleY));
    const cropW = Math.min(Math.round(width * scaleX), imgW - left);
    const cropH = Math.min(Math.round(height * scaleY), imgH - top);

    if (cropW < 5 || cropH < 5) {
      return res.status(400).json({ error: 'Zona demasiado pequeña' });
    }

    let croppedPipeline = sharp(imgBuffer)
      .extract({ left, top, width: cropW, height: cropH });

    const MIN_OCR_WIDTH = 1000;
    if (cropW < MIN_OCR_WIDTH) {
      const upscale = Math.ceil(MIN_OCR_WIDTH / cropW);
      croppedPipeline = croppedPipeline.resize(cropW * upscale, cropH * upscale, {
        kernel: 'lanczos3',
        fit: 'fill',
      });
      console.log(`[OCR-zona] Upscale x${upscale} → ${cropW * upscale}x${cropH * upscale}`);
    }

    const croppedBuffer = await croppedPipeline
      .sharpen()
      .png()
      .toBuffer();

    const text = await ocrWithTesseract(croppedBuffer);
    const cleaned = (text || '').trim().replace(/\n+/g, ' ');
    console.log(`[OCR-zona] Extraído de zona (${cropW}x${cropH}): "${cleaned}"`);

    res.json({ ok: true, texto: cleaned });
  } catch (err) {
    console.error('[OCR-zona] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Vista previa PNG página 1 (PDF) o imagen normalizada — para modo selección de zona en el cliente (<img> no puede mostrar PDF). */
// [SEC S-01]
router.get('/facturacion/ocr/preview-png', requirePermission('facturacion.crear'), async (req, res) => {
  const fileKey = req.query.fileKey;
  if (!fileKey || typeof fileKey !== 'string' || !fileKey.startsWith('facturas/') || fileKey.includes('..')) {
    return res.status(400).json({ error: 'fileKey inválido' });
  }

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const fileBuffer = Buffer.concat(chunks);
    const mimetype = obj.ContentType || '';
    const isImage = IMAGE_MIMES.includes(mimetype);
    const isPdf = isPdfMime(mimetype, fileKey);

    let pngBuffer;
    if (isPdf) {
      pngBuffer = await renderPdfFirstPageToPngBuffer(fileBuffer);
      if (!pngBuffer) return res.status(500).json({ error: 'No se pudo rasterizar el PDF' });
    } else if (isImage) {
      const sharp = (await import('sharp')).default;
      pngBuffer = await sharp(fileBuffer).png().toBuffer();
    } else {
      return res.status(400).json({ error: 'Tipo de archivo no soportado para vista previa' });
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.send(pngBuffer);
  } catch (err) {
    console.error('[OCR preview-png] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Worker Tesseract compartido: crear/terminar uno por petición añadía varios
 * segundos por documento en el registro masivo. Se serializan los trabajos
 * con una cola simple y, si el worker falla, se descarta para recrearlo.
 */
let tesseractWorkerPromise = null;
let tesseractWorkerReady = false;
let tesseractQueue = Promise.resolve();

/** True cuando el worker Tesseract terminó de cargar (spa+eng). */
export function isTesseractWorkerReady() {
  return tesseractWorkerReady;
}

/** Precarga el worker Tesseract en segundo plano (evita timeout en la 1ª factura escaneada). */
export function prewarmTesseractWorker() {
  if (tesseractWorkerReady && tesseractWorkerPromise) {
    return tesseractWorkerPromise;
  }
  if (tesseractWorkerPromise) return tesseractWorkerPromise;
  tesseractWorkerPromise = Tesseract.createWorker('spa+eng')
    .then((worker) => {
      tesseractWorkerReady = true;
      return worker;
    })
    .catch((e) => {
      tesseractWorkerPromise = null;
      tesseractWorkerReady = false;
      console.warn('[OCR] Precarga Tesseract falló:', e.message);
      throw e;
    });
  return tesseractWorkerPromise;
}

async function ocrWithTesseract(imageBuffer) {
  const run = async () => {
    try {
      if (!tesseractWorkerPromise) {
        tesseractWorkerPromise = Tesseract.createWorker('spa+eng').then((worker) => {
          tesseractWorkerReady = true;
          return worker;
        });
      }
      const worker = await tesseractWorkerPromise;
      const { data } = await worker.recognize(imageBuffer);
      return data.text || '';
    } catch (e) {
      const pendiente = tesseractWorkerPromise;
      tesseractWorkerPromise = null;
      tesseractWorkerReady = false;
      try {
        const w = await pendiente;
        await w?.terminate();
      } catch { /* worker ya roto */ }
      throw e;
    }
  };
  const p = tesseractQueue.then(run, run);
  tesseractQueue = p.then(() => {}, () => {});
  return p;
}

/** Normaliza importes factura ES (miles con `.`, decimales con `,`) y fallback OCR/PDF (ej. 160.00). */
function normalizeImporteFacturaEsp(raw) {
  if (raw == null || raw === '') return NaN;
  let s = String(raw).trim();
  s = s.replace(/€/g, '').replace(/\u00A0/g, '').replace(/\s+/g, '');
  s = s.replace(/[^\d.,\-]/g, '');
  if (!s || s === '-') return NaN;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  // Español: 1.234,56 — la coma decimal va después del último punto
  if (lastComma > lastDot) {
    const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  // US: 1,234.56
  if (lastDot > lastComma && lastComma >= 0) {
    const n = parseFloat(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  // Solo coma: 160,00
  if (lastComma !== -1 && lastDot === -1) {
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  // Solo puntos: 160.00 (decimal) o 1.234 (miles ES)
  if (lastDot !== -1 && lastComma === -1) {
    const parts = s.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      return parseFloat(s);
    }
    if (parts.length > 2) {
      const sign = s.startsWith('-') ? -1 : 1;
      const n = parseFloat(s.replace(/^-/, '').split('.').join(''));
      return Number.isFinite(n) ? sign * n : NaN;
    }
    if (parts.length === 2 && parts[1].length === 3) {
      return parseFloat(s.replace('.', ''));
    }
    return parseFloat(s);
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Extrae el texto embebido de un PDF usando pdfjs-dist (sin necesidad de pdf-parse). */
async function extractTextFromPdfWithPdfjs(pdfBuffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    disableWorker: true,
    useSystemFonts: true,
  }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    fullText += tc.items.map((item) => item.str).join(' ') + '\n';
  }
  return fullText;
}

/**
 * Rasteriza páginas del PDF a PNG para OCR (requiere canvas + pdfjs-dist).
 * Devuelve hasta `maxPages` páginas desde la primera y, si el documento es
 * más largo e `incluirUltima` está activo, añade también la última página
 * (donde suelen ir los totales de facturas multipágina).
 */
async function renderPdfPagesToPngBuffers(pdfBuffer, { maxPages = 1, incluirUltima = false } = {}) {
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    class NodeCanvasFactory {
      create(width, height) {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
      }
      reset(pair, width, height) {
        pair.canvas.width = width;
        pair.canvas.height = height;
      }
      destroy(pair) {
        pair.canvas.width = 0;
        pair.canvas.height = 0;
        pair.canvas = null;
        pair.context = null;
      }
    }

    const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    const canvasFactory = new NodeCanvasFactory();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      disableWorker: true,
      useSystemFonts: true,
      canvasFactory,
    }).promise;
    if (doc.numPages < 1) return [];

    const paginas = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) paginas.push(i);
    if (incluirUltima && doc.numPages > maxPages) paginas.push(doc.numPages);

    const buffers = [];
    for (const num of paginas) {
      const page = await doc.getPage(num);
      const scale = 2;
      const viewport = page.getViewport({ scale });
      const w = Math.ceil(viewport.width);
      const h = Math.ceil(viewport.height);
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      buffers.push(canvas.toBuffer('image/png'));
    }
    return buffers;
  } catch (e) {
    console.error('[OCR] No se pudo rasterizar PDF para OCR:', e.message);
    return [];
  }
}

/** Rasteriza solo la página 1 (vista previa y zona OCR). */
async function renderPdfFirstPageToPngBuffer(pdfBuffer) {
  const pages = await renderPdfPagesToPngBuffers(pdfBuffer, { maxPages: 1 });
  return pages[0] || null;
}

function inferProveedorNombre(text, cifProveedor) {
  if (!text) return '';
  const RECEPTOR_LABELS = /\b(cliente|destinatario|adquiriente|receptor|facturar\s*a|bill\s*to|comprador)\b/i;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cifNorm = (cifProveedor || '').replace(/\s/g, '');

  if (cifNorm) {
    const idx = lines.findIndex((l) => l.replace(/\s/g, '').includes(cifNorm));
    if (idx >= 0) {
      const nearbyBefore = lines.slice(Math.max(0, idx - 4), idx + 1).join(' ');
      const isReceptorZone = RECEPTOR_LABELS.test(nearbyBefore);
      if (!isReceptorZone && idx > 0) {
        for (let i = idx - 1; i >= Math.max(0, idx - 3); i--) {
          const candidate = lines[i];
          if (candidate.length >= 3 && candidate.length < 120 &&
              !/^\d{1,2}[\/\-]/.test(candidate) &&
              !/^[A-Z0-9]{8,}$/i.test(candidate) &&
              !RECEPTOR_LABELS.test(candidate) &&
              !/^\d+[.,]\d{2}\s*€?$/.test(candidate)) {
            return candidate.replace(/^[\s\-–—]+/, '').slice(0, 120);
          }
        }
      }
    }
  }

  const sl = text.match(
    /([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúñ0-9\s.,&\-]{3,80}(?:S\.?L\.?U\.?|S\.?L\.?|S\.?A\.?|S\.?C\.?O\.?O\.?P\.?))\.?/i
  );
  if (sl) {
    const slPos = text.indexOf(sl[0]);
    const ctxBefore = text.slice(Math.max(0, slPos - 120), slPos);
    if (!RECEPTOR_LABELS.test(ctxBefore)) {
      return sl[1].trim().replace(/\s+/g, ' ').slice(0, 120);
    }
  }
  return '';
}

function confianzaToScore(level) {
  if (level === 'alta') return 0.85;
  if (level === 'media') return 0.55;
  return 0.25;
}

function averageOcrConfidence(conf) {
  const vals = Object.values(conf).filter((v) => typeof v === 'string');
  if (!vals.length) return 0;
  const sum = vals.reduce((a, v) => a + confianzaToScore(v), 0);
  return Math.round((sum / vals.length) * 100) / 100;
}

/**
 * Busca en `igp_Empresas` por CIF/NIF.
 * 1) Coincidencia exacta tras normalizar (incl. homóglifos y atributo Cif/NIF).
 * 2) Fallback: mismos dígitos (≥7) por si difiere letra de control / OCR.
 * Si no hay match, log de diagnóstico en consola del API.
 */
async function buscarEmpresaPorCif(cifRaw) {
  const cif = normalizeCif(cifRaw);
  if (!cif) return null;
  let lastKey = null;
  const items = [];
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.empresas,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  const normFromItem = (item) => normalizeCif(getCifFromEmpresaItem(item));

  let found = items.find((item) => normFromItem(item) === cif);

  if (!found) {
    const dOcr = cifDigitsOnly(cif);
    if (dOcr.length >= 7) {
      const digitMatches = items.filter((item) => {
        const ni = normFromItem(item);
        if (!ni) return false;
        return cifDigitsOnly(ni) === dOcr;
      });
      if (digitMatches.length === 1) {
        found = digitMatches[0];
        console.log(
          `[OCR-maestro] Coincidencia por dígitos del CIF/NIF (OCR="${cif}" vs maestro="${normFromItem(found)}") id=${getIdEmpresaFromItem(found)}`,
        );
      } else if (digitMatches.length > 1) {
        console.warn(
          `[OCR-maestro] Varios registros comparten los mismos dígitos (${dOcr}); no se aplica fallback. ids=${digitMatches.map(getIdEmpresaFromItem).join(',')}`,
        );
      }
    }
  }

  if (!found) {
    const withCif = items
      .map((item) => ({ item, n: normFromItem(item) }))
      .filter((x) => x.n);
    const muestra = withCif.slice(0, 8).map((x) => x.n);
    console.warn(
      `[OCR-maestro] Sin coincidencia para CIF buscado (raw="${String(cifRaw).slice(0, 32)}" → normalizado="${cif}"). Tabla=${tables.empresas} filas=${items.length} con_CIF_normalizado=${withCif.length}. Muestra primeros CIF en maestro: ${JSON.stringify(muestra)}`,
    );
  }

  return found || null;
}

/** IBAN del proveedor: borrador OCR o, si falta, maestro por id/CIF. */
async function ibansProveedorParaFactura(b) {
  let iban = String(b?.empresa_iban ?? '').trim();
  let ibanAlternativo = String(b?.empresa_iban_alternativo ?? '').trim();
  if (iban) return { iban, iban_alternativo: ibanAlternativo };

  let emp = null;
  const id = String(b?.empresa_id ?? '').trim();
  if (id) {
    const r = await docClient.send(new GetCommand({ TableName: tables.empresas, Key: { id_empresa: id } }));
    emp = r.Item ?? null;
  }
  if (!emp && b?.proveedor_cif) {
    emp = await buscarEmpresaPorCif(b.proveedor_cif);
  }
  if (emp) {
    const delMaestro = ibansDeEmpresaItem(emp);
    if (!iban && delMaestro.iban) iban = delMaestro.iban;
    if (!ibanAlternativo && delMaestro.iban_alternativo) ibanAlternativo = delMaestro.iban_alternativo;
  }
  return { iban, iban_alternativo: ibanAlternativo };
}

const IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/tiff', 'image/bmp'];
const MIN_TEXT_THRESHOLD = 50;

function isPdfMime(mimetype, filename) {
  if (mimetype === 'application/pdf') return true;
  const n = (filename || '').toLowerCase();
  if (n.endsWith('.pdf')) {
    if (!mimetype || mimetype === 'application/octet-stream' || mimetype === 'binary/octet-stream') return true;
  }
  return mimetype === 'application/octet-stream' && n.endsWith('.pdf');
}

/** Alias: parseo completo con entidades candidatas y retención (ver api/lib/ocrFacturaEntidades.js). */
function parsearTextoFactura(text) {
  return parseTextoFacturaCompleto(text);
}

/** Puntúa la calidad de un parseo para comparar texto embebido vs OCR. */
function scoreParseo(p) {
  let s = 0;
  if (p.proveedor_cif) s += 3;
  if (p.totalFactura > 0) s += 3;
  if (p.baseImponible > 0) s += 2;
  if (p.totalIva > 0) s += 1;
  if (p.retencion > 0 || (p.retencionMatches && p.retencionMatches.length > 0)) s += 1;
  if (p.fechas.length > 0) s += 2;
  if (p.numFacturas.length > 0) s += 2;
  if (Array.isArray(p.desglose_impuestos) && p.desglose_impuestos.length > 1) s += 2;
  return s;
}

async function extraerDatosBasicos(buffer, mimetype, filename) {
  let text = '';
  let metodo_extraccion = 'pdf_text';
  let parseo;
  const isImage = IMAGE_MIMES.includes(mimetype);
  const isPdf = isPdfMime(mimetype, filename);

  // ── IMAGEN: OCR directo ──
  if (isImage) {
    metodo_extraccion = 'image_ocr';
    console.log('[OCR] Imagen detectada, ejecutando Tesseract OCR…');
    try {
      text = await ocrWithTesseract(buffer);
      console.log(`[OCR] Tesseract extrajo ${text.length} caracteres`);
    } catch (e) {
      console.error('[OCR] Tesseract falló en imagen:', e.message);
    }
    parseo = parsearTextoFactura(text);

  // ── PDF: texto embebido primero → fallback OCR si el parseo es pobre ──
  } else if (isPdf) {
    try {
      text = await extractTextFromPdfWithPdfjs(buffer);
    } catch (e) {
      console.error('[OCR] pdfjs texto embebido falló, usando fallback regex:', e.message);
      text = extractTextFromPdfBufferFallback(buffer);
    }

    metodo_extraccion = 'pdf_text';
    parseo = parsearTextoFactura(text);
    const scoreTxt = scoreParseo(parseo);
    console.log(`[OCR] PDF texto embebido: ${text.trim().length} chars, score parseo=${scoreTxt}`);

    const necesitaFallback = text.trim().length < MIN_TEXT_THRESHOLD || scoreTxt < 4;

    if (necesitaFallback) {
      console.log('[OCR] Texto embebido insuficiente o parseo pobre — intentando OCR por imagen…');
      // Hasta 2 primeras páginas + última: en facturas escaneadas largas los
      // totales suelen ir al final y antes solo se OCR-izaba la página 1.
      const pngs = await renderPdfPagesToPngBuffers(buffer, { maxPages: 2, incluirUltima: true });
      if (pngs.length > 0) {
        try {
          let ocrText = '';
          for (const png of pngs) {
            ocrText += (await ocrWithTesseract(png)) + '\n';
          }
          ocrText = ocrText.trim();
          console.log(`[OCR] Tesseract (PDF rasterizado, ${pngs.length} pág.) extrajo ${ocrText.length} caracteres`);
          if (ocrText) {
            const parseoOcr = parsearTextoFactura(ocrText);
            const scoreOcr = scoreParseo(parseoOcr);
            console.log(`[OCR] Score texto embebido=${scoreTxt}, score OCR imagen=${scoreOcr}`);
            const textoEmbebidoCorto = text.trim().length < MIN_TEXT_THRESHOLD;
            const ocrMasLargo =
              ocrText.length >= MIN_TEXT_THRESHOLD && ocrText.length > text.trim().length;
            if (scoreOcr > scoreTxt) {
              text = ocrText;
              parseo = parseoOcr;
              metodo_extraccion = 'pdf_ocr_fallback';
              console.log('[OCR] Usando resultado OCR (mejor score que texto embebido)');
            } else if (textoEmbebidoCorto && ocrMasLargo) {
              // Texto largo para la IA; se conserva el parseo embebido (score OCR no mejora).
              text = ocrText;
              metodo_extraccion = 'pdf_ocr_fallback';
              console.log(
                '[OCR] Usando texto OCR (PDF escaneado: embebido corto, OCR más largo); parseo embebido conservado',
              );
            } else {
              console.log('[OCR] Texto embebido igual o mejor que OCR, manteniendo texto embebido');
            }
          }
        } catch (e) {
          console.error('[OCR] Tesseract en PDF rasterizado falló:', e.message);
        }
      }
    }
  } else {
    parseo = parsearTextoFactura(text);
  }

  console.log(`[OCR] Método final: ${metodo_extraccion} — Texto: ${text.length} chars`);
  console.log(`[OCR] Texto (primeros 500 chars):`, text.slice(0, 500));

  const {
    cifs,
    entidades_candidatas,
    proveedor_cif,
    ambiguedad_proveedor,
    fechas,
    fecha_emision_probable,
    totalFactura,
    baseImponible,
    base_imponible_total,
    totalIva,
    retencion,
    recargo_equivalencia_total,
    desglose_impuestos,
    desglose_parse_meta,
    totalMatches,
    baseMatches,
    ivaMatches,
    retencionMatches,
    numFacturas,
    importes_coherentes,
  } = parseo;
  const nombreOcrSugerido = inferProveedorNombre(text, proveedor_cif);

  let proveedor_nombre = '';
  let empresa_id = '';
  let proveedor_en_maestros = false;
  if (proveedor_cif) {
    try {
      const emp = await buscarEmpresaPorCif(proveedor_cif);
      if (emp) {
        proveedor_nombre = getNombreFromEmpresaItem(emp);
        empresa_id = getIdEmpresaFromItem(emp);
        proveedor_en_maestros = true;
      }
    } catch (e) {
      console.error('[OCR] Error buscando empresa por CIF:', e.message);
    }
  }

  console.log('[OCR] Resultados:', {
    proveedor_cif,
    proveedor_en_maestros,
    fechas,
    totalFactura,
    baseImponible,
    totalIva,
    numFacturas: numFacturas.slice(0, 3),
    metodo_extraccion,
  });

  const confianza = {
    proveedor_cif: proveedor_cif ? (cifs.length === 1 ? 'alta' : 'media') : 'baja',
    proveedor_nombre: proveedor_en_maestros ? 'alta' : proveedor_cif ? 'baja' : 'baja',
    fecha: fechas.length > 0 ? (fechas.length === 1 ? 'alta' : 'media') : 'baja',
    total: totalFactura > 0 ? (totalMatches.length > 0 ? 'alta' : 'media') : 'baja',
    numero_factura: numFacturas.length > 0 ? 'media' : 'baja',
    base_imponible: baseImponible > 0 ? (baseMatches.length > 0 ? 'alta' : 'media') : 'baja',
    total_iva: totalIva > 0 ? (ivaMatches.length > 0 ? 'alta' : 'media') : 'baja',
    retencion: retencion > 0 || (retencionMatches && retencionMatches.length > 0) ? 'alta' : 'baja',
  };

  const ocr_confianza_global = averageOcrConfidence(confianza);

  const proveedorCifCanon = proveedor_cif ? normalizeCif(proveedor_cif) : '';
  if (proveedorCifCanon && proveedorCifCanon !== proveedor_cif) {
    console.log(`[OCR] CIF normalizado para respuesta: "${proveedor_cif}" → "${proveedorCifCanon}"`);
  }

  const result = {
    proveedor_cif: proveedorCifCanon || proveedor_cif || '',
    proveedor_nombre: proveedor_nombre || '',
    empresa_id: empresa_id || '',
    proveedor_en_maestros,
    nombre_sugerido_ocr: !proveedor_en_maestros && proveedor_cif ? nombreOcrSugerido || '' : '',
    numero_factura_proveedor: numFacturas[0] || '',
    fecha_emision: fecha_emision_probable || fechas[0] || '',
    total_factura: totalFactura,
    base_imponible: baseImponible,
    base_imponible_total: base_imponible_total ?? baseImponible,
    total_iva: totalIva,
    retencion,
    recargo_equivalencia_total: recargo_equivalencia_total ?? 0,
    desglose_impuestos: Array.isArray(desglose_impuestos) ? desglose_impuestos : [],
    lineas_articulos: [],
    desglose_parse_meta:
      desglose_parse_meta && typeof desglose_parse_meta === 'object' ? desglose_parse_meta : undefined,
    confianza,
    texto_extraido: text.slice(0, 8000),
    metodo_extraccion,
    ocr_confianza_global,
    entidades_candidatas,
    ambiguedad_proveedor,
    importes_coherentes,
    proveedor_resuelto_por: 'extraccion',
    receptor_resuelto_por: null,
    match_por: null,
    extraction_snapshot: {
      proveedor_cif: proveedorCifCanon || proveedor_cif || '',
      numero_factura_proveedor: numFacturas[0] || '',
      fecha_emision: fecha_emision_probable || fechas[0] || '',
      base_imponible: baseImponible,
      total_iva: totalIva,
      retencion,
      total_factura: totalFactura,
      confianza,
      base_imponible_total: base_imponible_total ?? baseImponible,
      recargo_equivalencia_total: recargo_equivalencia_total ?? 0,
      desglose_impuestos: Array.isArray(desglose_impuestos) ? desglose_impuestos : [],
      desglose_parse_meta:
        desglose_parse_meta && typeof desglose_parse_meta === 'object' ? desglose_parse_meta : undefined,
    },
  };

  aplicarPostProcesadoPipeline(result, text);
  /** No enviar líneas de desglose al cliente: el usuario las introduce a mano en registro masivo. */
  result.desglose_impuestos = [];
  if (result.extraction_snapshot && typeof result.extraction_snapshot === 'object') {
    result.extraction_snapshot = {
      ...result.extraction_snapshot,
      desglose_impuestos: [],
    };
  }
  return result;
}

async function ejecutarReconciliarFacturaOcr(body) {
  return reconciliarFacturaOcr(body, {
    buscarEmpresaPorCif,
    getNombreFromEmpresaItem,
    getIdEmpresaFromItem,
  });
}

function extractTextFromPdfBufferFallback(buffer) {
  const str = buffer.toString('latin1');
  const texts = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let sm;
  while ((sm = streamRegex.exec(str)) !== null) {
    const content = sm[1];
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tm;
    while ((tm = tjRegex.exec(content)) !== null) {
      texts.push(tm[1]);
    }
    const tjArrayRegex = /\[((?:\([^)]*\)|[^\]])*)\]\s*TJ/gi;
    while ((tm = tjArrayRegex.exec(content)) !== null) {
      const inner = tm[1];
      const parts = [];
      const partRegex = /\(([^)]*)\)/g;
      let pm;
      while ((pm = partRegex.exec(inner)) !== null) {
        parts.push(pm[1]);
      }
      if (parts.length) texts.push(parts.join(''));
    }
  }
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

// [SEC S-01]
router.post('/facturacion/ocr/confirmar', requirePermission('facturacion.crear'), async (req, res) => {
  const { borradores, usuario_id, usuario_nombre } = req.body || {};
  if (!Array.isArray(borradores) || borradores.length === 0) {
    return res.status(400).json({ error: 'No se recibieron borradores' });
  }

  try {
    // [SEC S-08]
    const empresasOk = await empresasPermitidasDelUsuario(req.user);

    const activos = borradores.filter((b) => !b.descartado);
    for (const b of activos) {
      const emisorId = b.sociedad_grupo_id || b.emisor_id || '';
      const emisorNombre = b.sociedad_grupo_nombre || b.emisor_nombre || '';
      if (!emisorId && !emisorNombre) {
        return res.status(400).json({
          error: 'Falta la empresa del grupo (GRUPO PARIPE) en uno o más borradores. Selecciónala antes de confirmar.',
        });
      }
      if (empresasOk != null) {
        const emisorFmt = formatId6(emisorId);
        if (!emisorFmt || emisorFmt === '000000' || !empresasOk.has(emisorFmt)) {
          return res.status(403).json({ error: 'No tienes permiso para crear facturas con esta sociedad emisora' });
        }
      }
      if (proveedorCoincideConSociedad(b)) {
        return res.status(400).json({ error: ERROR_PROVEEDOR_IGUAL_SOCIEDAD });
      }
    }

    const creados = [];
    for (const b of borradores) {
      if (b.descartado) continue;

      const desgArr = Array.isArray(b.desglose_impuestos) ? b.desglose_impuestos : [];
      const partesImp = [];
      if (
        desgArr.length > 1 ||
        desgArr.some((x) => x && x.tipo === 'recargo_equivalencia')
      ) {
        for (const L of desgArr) {
          if (!L || !L.tipo) continue;
          if (L.tipo === 'iva' && L.porcentaje != null && !Number.isNaN(Number(L.porcentaje))) {
            partesImp.push(`IVA ${L.porcentaje}%`);
          }
          if (
            L.tipo === 'recargo_equivalencia' &&
            L.porcentaje != null &&
            !Number.isNaN(Number(L.porcentaje))
          ) {
            partesImp.push(`R.E. ${L.porcentaje}%`);
          }
          if (L.tipo === 'retencion') partesImp.push('Retención');
        }
      } else {
        const tipoIvaPct = Number(b.tipo_iva_pct);
        const retPct = Number(b.retencion_pct);
        if (!Number.isNaN(tipoIvaPct)) partesImp.push(`IVA ${tipoIvaPct}%`);
        if (!Number.isNaN(retPct) && retPct > 0) partesImp.push(`Ret ${retPct}%`);
      }
      const impuestosResumenOcr = [...new Set(partesImp)].join(' · ') || '';

      const id_factura = uuid();
      const emisorId = b.sociedad_grupo_id || b.emisor_id || '';
      const emisorNombre = b.sociedad_grupo_nombre || b.emisor_nombre || '';
      const emisorCif = b.sociedad_grupo_cif || b.emisor_cif || '';

      let adjuntos = [];
      let documento_file_key = '';
      let documento_nombre = '';
      if (b.archivo && b.archivo.fileKey) {
        let fileKeyFinal = String(b.archivo.fileKey);
        documento_nombre = b.archivo.nombre != null ? String(b.archivo.nombre) : '';
        try {
          fileKeyFinal = await copiarDocumentoAFactura(fileKeyFinal, id_factura, documento_nombre);
        } catch (e) {
          console.error('[OCR confirmar] Copia S3 falló, se mantiene clave origen:', e.message);
        }
        documento_file_key = fileKeyFinal;
        adjuntos = [
          {
            id: uuid(),
            fileKey: fileKeyFinal,
            nombre: documento_nombre,
            tipo: b.archivo.tipo != null ? String(b.archivo.tipo) : '',
            size: Number(b.archivo.size) || 0,
            subido_en: now(),
            subido_por: usuario_nombre || '',
          },
        ];
      }

      const { iban: empresaIban, iban_alternativo: empresaIbanAlt } = await ibansProveedorParaFactura(b);

      const factura = {
        id_entrada: id_factura,
        id_factura,
        tipo: 'IN',
        estado: 'pendiente_revision',
        serie: b.serie || '',
        numero: 0,
        numero_factura: '',
        fecha_emision: fechaToIsoGuardada(b.fecha_emision) || '',
        fecha_vencimiento: fechaToIsoGuardada(b.fecha_vencimiento) || '',
        emisor_id: emisorId,
        emisor_nombre: emisorNombre,
        emisor_cif: emisorCif,
        emisor_direccion: b.emisor_direccion || '',
        emisor_cp: b.emisor_cp || '',
        emisor_municipio: b.emisor_municipio || '',
        emisor_provincia: b.emisor_provincia || '',
        emisor_email: b.emisor_email || '',
        emisor_iban: b.emisor_iban || '',
        emisor_iban_alternativo: b.emisor_iban_alternativo || '',
        empresa_id: b.empresa_id || '',
        empresa_nombre: b.proveedor_nombre || '',
        empresa_cif: b.proveedor_cif || '',
        empresa_direccion: '',
        empresa_cp: '',
        empresa_municipio: '',
        empresa_provincia: '',
        empresa_email: '',
        empresa_iban: empresaIban,
        empresa_iban_alternativo: empresaIbanAlt,
        numero_factura_proveedor: b.numero_factura_proveedor || '',
        base_imponible: round2(b.base_imponible || 0),
        base_imponible_total: round2(b.base_imponible_total ?? b.base_imponible ?? 0),
        total_iva: round2(b.total_iva || 0),
        total_retencion: round2(b.retencion ?? b.total_retencion ?? 0),
        recargo_equivalencia_total: round2(b.recargo_equivalencia_total ?? 0),
        desglose_impuestos: Array.isArray(b.desglose_impuestos) ? b.desglose_impuestos : [],
        total_factura: round2(b.total_factura || 0),
        total_cobrado: 0,
        saldo_pendiente: round2(b.total_factura || 0),
        forma_pago: b.forma_pago || '',
        condiciones_pago: b.condiciones_pago || '',
        observaciones: String(b.observaciones ?? '').trim(),
        local_id: b.local_id || '',
        documento_file_key,
        documento_nombre,
        adjuntos,
        version: 1,
        creado_por: usuario_id || '',
        creado_en: now(),
        modificado_por: '',
        modificado_en: '',
        origen: 'ocr',
        ocr_confianza: b.confianza || {},
        ...(b.ia_meta && typeof b.ia_meta === 'object' ? { ocr_ia_meta: b.ia_meta } : {}),
        ...(b.ocr_pipeline_meta && typeof b.ocr_pipeline_meta === 'object'
          ? { ocr_pipeline_meta: b.ocr_pipeline_meta }
          : {}),
        impuestos_resumen: impuestosResumenOcr,
        fecha_contabilizacion: now(),
        contabilizado_por: usuario_nombre || '',
        contabilizado_por_id: usuario_id || '',
      };

      await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
      await registrarAuditoria(id_factura, 'creacion_ocr', usuario_id, usuario_nombre, {
        archivo: b.archivo?.nombre,
        confianza: b.confianza,
      });

      creados.push(id_factura);
    }

    res.json({ ok: true, creados: creados.length, ids: creados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RECORDATORIOS COBRO ───

// [SEC S-01]
router.post('/facturacion/enviar-recordatorios', requirePermission('facturacion.editar'), async (req, res) => {
  if (!process.env.SMTP_USER) return res.status(500).json({ error: 'SMTP no configurado' });

  try {
    const facturas = await scanAll(tables.facturas);
    const vencidas = facturas.filter(
      (f) => f.tipo === 'OUT' && f.estado === 'vencida' && f.empresa_email && (f.saldo_pendiente || 0) > 0
    );

    let enviados = 0;
    for (const f of vencidas) {
      const ultimoRecordatorio = f.ultimo_recordatorio || '';
      const hoy = now().slice(0, 10);
      if (ultimoRecordatorio === hoy) continue;

      try {
        await enviarEmail({
          to: f.empresa_email,
          subject: `Recordatorio: Factura ${f.numero_factura || f.id_factura} pendiente de pago`,
          html: `
            <p>Estimado/a <strong>${f.empresa_nombre || 'cliente'}</strong>,</p>
            <p>Le recordamos que la factura <strong>${f.numero_factura || f.id_factura}</strong> emitida el ${f.fecha_emision || '—'}
            con vencimiento ${f.fecha_vencimiento || '—'} tiene un saldo pendiente de <strong>${(f.saldo_pendiente || 0).toFixed(2)} €</strong>.</p>
            <p>Le rogamos proceda a su abono a la mayor brevedad posible.</p>
            <p>Un saludo,<br/>IPG Hostelería</p>
          `,
        });

        await docClient.send(new UpdateCommand({
          TableName: tables.facturas,
          Key: await keyForFacturaItem(f),
          UpdateExpression: 'SET ultimo_recordatorio = :h',
          ExpressionAttributeValues: { ':h': hoy },
        }));

        await registrarAuditoria(f.id_entrada, 'recordatorio_cobro', 'sistema', 'Sistema', {
          destinatario: f.empresa_email,
          saldo: f.saldo_pendiente,
        });

        enviados++;
      } catch {
        // Si falla un email, continuar con el siguiente
      }
    }

    res.json({ ok: true, vencidas: vencidas.length, enviados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DETECCIÓN DUPLICADOS ───

// [SEC S-01]
router.post('/facturacion/check-duplicados', requirePermission('facturacion.crear'), async (req, res) => {
  const { proveedor_cif, numero_factura_proveedor, fecha_emision } = req.body || {};
  try {
    const ref = { proveedor_cif, numero_factura_proveedor, fecha_emision };
    const facturas = await scanAll(tables.facturas, '#t = :t', { ':t': 'IN' }, { '#t': 'tipo' });
    const posibles = facturas.filter((f) => esDuplicadoFacturaProveedor(ref, f));

    res.json({
      duplicados: posibles.map((f) => ({
        id_factura: f.id_factura,
        numero_factura: f.numero_factura,
        numero_factura_proveedor: f.numero_factura_proveedor,
        empresa_nombre: f.empresa_nombre,
        empresa_cif: f.empresa_cif,
        total_factura: f.total_factura,
        fecha_emision: f.fecha_emision,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Precalienta OCR al arranque del módulo (no bloquea peticiones). */
prewarmTesseractWorker().catch(() => {});

export default router;
