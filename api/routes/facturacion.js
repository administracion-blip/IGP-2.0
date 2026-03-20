import { Router } from 'express';
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, tables } from '../lib/db.js';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import multer from 'multer';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');

const router = Router();

const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// ─── SERIES ───

router.get('/facturacion/series', async (_req, res) => {
  try {
    const items = await scanAll(tables.facturasSeries);
    const configOnly = items.filter((s) => !(s.serie || '').includes('#'));
    res.json({ series: configOnly });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/facturacion/series/next-number', async (req, res) => {
  const { serie, emisor_id, fecha_emision } = req.query;
  if (!serie) return res.status(400).json({ error: 'serie es obligatorio' });
  try {
    const result = await calcNextNumero(serie, emisor_id || 'DEFAULT', fecha_emision || '');
    if (!result) return res.status(404).json({ error: 'Serie no encontrada' });

    res.json({ serie: result.serie, emisor_id: emisor_id || 'DEFAULT', ultimo_numero: result.ultimo_numero - 1, next_numero: result.ultimo_numero, num_digitos: result.num_digitos || 6 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/facturacion/series', async (req, res) => {
  const { serie, descripcion, tipo, prefijo_formato, activa, notas, reinicio_anual, num_digitos } = req.body || {};
  if (!serie || !tipo) return res.status(400).json({ error: 'serie y tipo son obligatorios' });
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

router.put('/facturacion/series', async (req, res) => {
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

router.delete('/facturacion/series', async (req, res) => {
  const { serie } = req.body || {};
  if (!serie) return res.status(400).json({ error: 'serie es obligatorio' });
  try {
    await docClient.send(new DeleteCommand({ TableName: tables.facturasSeries, Key: { serie } }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getSerieConfig(serie) {
  const existing = await docClient.send(new GetCommand({ TableName: tables.facturasSeries, Key: { serie } }));
  return existing.Item || null;
}

async function calcNextNumero(serie, emisorId, fechaEmision) {
  const serieConfig = await getSerieConfig(serie);
  if (!serieConfig) return null;

  const year = fechaEmision ? fechaEmision.substring(0, 4) : String(new Date().getFullYear());
  const reinicioAnual = serieConfig.reinicio_anual !== false;

  const todas = await scanAll(tables.facturas, 'serie = :s AND emisor_id = :e', { ':s': serie, ':e': emisorId || 'DEFAULT' });

  let relevantes = todas;
  if (reinicioAnual) {
    relevantes = todas.filter(f => (f.fecha_emision || '').startsWith(year));
  }

  const maxNumero = relevantes.reduce((max, f) => Math.max(max, f.numero || 0), 0);
  return { ...serieConfig, ultimo_numero: maxNumero + 1 };
}

function buildNumeroFactura(serieData, numero, fechaEmision) {
  const year = fechaEmision ? fechaEmision.substring(0, 4) : String(new Date().getFullYear());
  const digits = serieData.num_digitos || 6;
  const prefix = `${serieData.serie}-${year}-`;
  return `${prefix}${String(numero).padStart(digits, '0')}`;
}

// ─── FACTURAS ───

router.get('/facturacion/facturas', async (req, res) => {
  try {
    const { tipo } = req.query;
    let items;
    if (tipo) {
      items = await scanAll(tables.facturas, '#t = :t', { ':t': tipo }, { '#t': 'tipo' });
    } else {
      items = await scanAll(tables.facturas);
    }
    items.sort((a, b) => (b.fecha_emision || '').localeCompare(a.fecha_emision || ''));
    res.json({ facturas: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/facturacion/facturas/:id', async (req, res) => {
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: tables.facturas, Key: { id_entrada: req.params.id } })
    );
    if (!result.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const lineas = await scanAll(tables.facturasLineas, 'id_factura = :fid', { ':fid': req.params.id });
    lineas.sort((a, b) => (a.id_linea || '').localeCompare(b.id_linea || ''));
    const pagos = await scanAll(tables.facturasPagos, 'id_factura = :fid', { ':fid': req.params.id });
    pagos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    const auditoria = await scanAll(tables.facturasAuditoria, 'id_factura = :fid', { ':fid': req.params.id });
    auditoria.sort((a, b) => (b.timestamp_accion || '').localeCompare(a.timestamp_accion || ''));
    res.json({ factura: result.Item, lineas, pagos, auditoria });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/facturacion/facturas', async (req, res) => {
  const body = req.body || {};
  const {
    tipo, serie,
    emisor_id, emisor_nombre, emisor_cif, emisor_direccion,
    emisor_cp, emisor_municipio, emisor_provincia, emisor_email,
    emisor_iban, emisor_iban_alternativo,
    empresa_id, empresa_nombre, empresa_cif, empresa_direccion,
    empresa_cp, empresa_municipio, empresa_provincia, empresa_email,
    empresa_iban, empresa_iban_alternativo,
    fecha_emision, fecha_operacion, fecha_vencimiento,
    condiciones_pago, forma_pago, observaciones, local_id,
    es_rectificativa, factura_rectificada_id, motivo_rectificacion,
    numero_factura_proveedor, fecha_contabilizacion,
    lineas, usuario_id, usuario_nombre,
  } = body;

  if (!tipo || !serie) return res.status(400).json({ error: 'tipo y serie son obligatorios' });
  if (!emisor_nombre && !emisor_cif) return res.status(400).json({ error: 'Datos del emisor son obligatorios' });
  if (!empresa_nombre && !empresa_cif) return res.status(400).json({ error: 'Datos de empresa son obligatorios' });

  try {
    const emisorKey = emisor_id || emisor_cif || 'DEFAULT';
    const serieData = await calcNextNumero(serie, emisorKey, fecha_emision);
    if (!serieData) return res.status(404).json({ error: `Serie "${serie}" no encontrada` });
    const numero = serieData.ultimo_numero;
    const numero_factura = buildNumeroFactura(serieData, numero, fecha_emision);

    const duplicado = await scanAll(tables.facturas, 'numero_factura = :nf', { ':nf': numero_factura });
    if (duplicado.length > 0) {
      return res.status(409).json({ error: `El número de factura ${numero_factura} ya existe. Esto puede ocurrir si se registraron dos facturas simultáneamente. Por favor, inténtelo de nuevo.` });
    }

    const id_entrada = uuid();

    let base_imponible = 0;
    let total_iva = 0;
    let total_retencion = 0;
    const lineasToSave = [];

    if (Array.isArray(lineas)) {
      for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
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

        lineasToSave.push({
          id_factura: id_entrada,
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
        });
      }
    }

    base_imponible = round2(base_imponible);
    total_iva = round2(total_iva);
    total_retencion = round2(total_retencion);
    const total_factura = round2(base_imponible + total_iva - total_retencion);

    const factura = {
      id_entrada,
      id_factura: id_entrada,
      numero_factura,
      tipo,
      serie,
      numero,
      estado: 'borrador',
      emisor_id: emisor_id || '',
      emisor_nombre: emisor_nombre || '',
      emisor_cif: emisor_cif || '',
      emisor_direccion: emisor_direccion || '',
      emisor_cp: emisor_cp || '',
      emisor_municipio: emisor_municipio || '',
      emisor_provincia: emisor_provincia || '',
      emisor_email: emisor_email || '',
      emisor_iban: emisor_iban || '',
      emisor_iban_alternativo: emisor_iban_alternativo || '',
      empresa_id: empresa_id || '',
      empresa_nombre: empresa_nombre || '',
      empresa_cif: empresa_cif || '',
      empresa_direccion: empresa_direccion || '',
      empresa_cp: empresa_cp || '',
      empresa_municipio: empresa_municipio || '',
      empresa_provincia: empresa_provincia || '',
      empresa_email: empresa_email || '',
      empresa_iban: empresa_iban || '',
      empresa_iban_alternativo: empresa_iban_alternativo || '',
      fecha_emision: fecha_emision || now().slice(0, 10),
      fecha_operacion: fecha_operacion || '',
      fecha_vencimiento: fecha_vencimiento || '',
      condiciones_pago: condiciones_pago || '',
      forma_pago: forma_pago || '',
      base_imponible,
      total_iva,
      total_retencion,
      total_factura,
      total_cobrado: 0,
      saldo_pendiente: total_factura,
      observaciones: observaciones || '',
      adjuntos: [],
      local_id: local_id || '',
      es_rectificativa: es_rectificativa || false,
      factura_rectificada_id: factura_rectificada_id || '',
      motivo_rectificacion: motivo_rectificacion || '',
      numero_factura_proveedor: numero_factura_proveedor || '',
      fecha_contabilizacion: fecha_contabilizacion || '',
      creado_por: usuario_id || '',
      creado_en: now(),
      modificado_por: usuario_id || '',
      modificado_en: now(),
      version: 1,
      verifactu_hash: '',
      verifactu_hash_anterior: '',
      verifactu_qr_data: '',
      verifactu_registro_alta: '',
      verifactu_registro_anulacion: '',
      verifactu_estado: 'no_enviado',
      verifactu_huella_completa: '',
      verifactu_cadena_encadenamiento: '',
    };

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

router.put('/facturacion/facturas/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });

    const factura = existing.Item;

    if (!['borrador', 'pendiente_revision'].includes(factura.estado)) {
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
      'numero_factura_proveedor', 'fecha_contabilizacion', 'estado',
    ];

    const changes = {};
    for (const field of editableFields) {
      if (body[field] !== undefined) {
        changes[field] = body[field];
        factura[field] = body[field];
      }
    }

    if (Array.isArray(body.lineas)) {
      const oldLineas = await scanAll(tables.facturasLineas, 'id_factura = :fid', { ':fid': id });
      for (const ol of oldLineas) {
        await docClient.send(new DeleteCommand({ TableName: tables.facturasLineas, Key: { id_factura: id, id_linea: ol.id_linea } }));
      }

      let base_imponible = 0;
      let total_iva = 0;
      let total_retencion = 0;

      for (let i = 0; i < body.lineas.length; i++) {
        const l = body.lineas[i];
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

        await docClient.send(
          new PutCommand({
            TableName: tables.facturasLineas,
            Item: {
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
            },
          })
        );
      }

      factura.base_imponible = round2(base_imponible);
      factura.total_iva = round2(total_iva);
      factura.total_retencion = round2(total_retencion);
      factura.total_factura = round2(base_imponible + total_iva - total_retencion);
      factura.saldo_pendiente = round2(factura.total_factura - (factura.total_cobrado || 0));
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

router.post('/facturacion/facturas/:id/emitir', async (req, res) => {
  const id = req.params.id;
  const { usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;

    if (factura.estado !== 'borrador') {
      return res.status(400).json({ error: 'Solo se pueden emitir facturas en borrador' });
    }

    // Validaciones fiscales obligatorias
    const errores = [];
    if (!factura.empresa_nombre && !factura.empresa_cif) errores.push('Datos de empresa (nombre o CIF) obligatorios');
    if (factura.tipo === 'OUT' && !factura.empresa_cif) errores.push('CIF/NIF del cliente es obligatorio para facturas de venta');
    if (!factura.fecha_emision) errores.push('La fecha de emisión es obligatoria');
    if (!factura.serie) errores.push('La serie es obligatoria');
    if ((factura.total_factura || 0) === 0) errores.push('La factura no puede tener importe 0');

    const lineas = await scanAll(tables.facturasLineas, 'id_factura = :id', { ':id': id }, null);
    if (factura.tipo === 'OUT' && lineas.length === 0) errores.push('La factura debe tener al menos una línea');

    for (const l of lineas) {
      if (!l.descripcion) errores.push(`Línea ${l.id_linea}: falta descripción`);
      if ((l.cantidad || 0) <= 0) errores.push(`Línea ${l.id_linea}: cantidad debe ser mayor que 0`);
    }

    if (errores.length > 0) {
      return res.status(400).json({ error: 'Validación fiscal fallida', errores });
    }

    factura.estado = 'emitida';
    if (factura.tipo === 'IN') factura.estado = 'pendiente_pago';

    if (!factura.fecha_vencimiento && factura.condiciones_pago) {
      const diasMap = { contado: 0, '15_dias': 15, '30_dias': 30, '60_dias': 60, '90_dias': 90 };
      const dias = diasMap[factura.condiciones_pago];
      if (dias != null) {
        const base = new Date(factura.fecha_emision || now().slice(0, 10));
        base.setDate(base.getDate() + dias);
        factura.fecha_vencimiento = base.toISOString().slice(0, 10);
      }
    }

    factura.modificado_por = usuario_id || '';
    factura.modificado_en = now();
    factura.version = (factura.version || 1) + 1;

    factura.verifactu_hash = computeHash(factura);
    factura.verifactu_registro_alta = JSON.stringify({
      id_factura: factura.id_factura,
      fecha_emision: factura.fecha_emision,
      hash: factura.verifactu_hash,
      timestamp: now(),
    });

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
    await registrarAuditoria(id, 'emision', usuario_id, usuario_nombre, { estado: factura.estado, hash: factura.verifactu_hash });

    res.json({ ok: true, factura });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANULAR factura ───

router.post('/facturacion/facturas/:id/anular', async (req, res) => {
  const id = req.params.id;
  const { motivo, usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;

    if (factura.estado === 'anulada') return res.status(400).json({ error: 'La factura ya está anulada' });
    if (factura.estado === 'borrador') {
      await docClient.send(new DeleteCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
      const lineas = await scanAll(tables.facturasLineas, 'id_factura = :fid', { ':fid': id });
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

// ─── DUPLICAR factura ───

router.post('/facturacion/facturas/:id/duplicar', async (req, res) => {
  const id = req.params.id;
  const { serie, usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const original = existing.Item;

    const targetSerie = serie || original.serie;
    const emisorKey = original.emisor_id || original.emisor_cif || 'DEFAULT';
    const nuevaFechaEmision = now().slice(0, 10);
    const serieData = await calcNextNumero(targetSerie, emisorKey, nuevaFechaEmision);
    if (!serieData) return res.status(404).json({ error: `Serie "${targetSerie}" no encontrada` });
    const numero = serieData.ultimo_numero;
    const nuevo_numero_factura = buildNumeroFactura(serieData, numero, nuevaFechaEmision);
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

    await docClient.send(new PutCommand({ TableName: tables.facturas, Item: nueva }));

    const lineas = await scanAll(tables.facturasLineas, 'id_factura = :fid', { ':fid': id });
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

router.post('/facturacion/facturas/:id/rectificar', async (req, res) => {
  const id = req.params.id;
  const { serie_rectificativa, motivo, usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const original = existing.Item;

    if (original.estado === 'borrador' || original.estado === 'anulada') {
      return res.status(400).json({ error: 'No se puede rectificar una factura en borrador o anulada' });
    }

    const targetSerie = serie_rectificativa || 'FR';
    const emisorKey = original.emisor_id || original.emisor_cif || 'DEFAULT';
    const rectFechaEmision = now().slice(0, 10);
    const serieData = await calcNextNumero(targetSerie, emisorKey, rectFechaEmision);
    if (!serieData) return res.status(404).json({ error: `Serie "${targetSerie}" no encontrada` });
    const numero = serieData.ultimo_numero;
    const nuevo_numero_factura = buildNumeroFactura(serieData, numero, rectFechaEmision);
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

    const lineas = await scanAll(tables.facturasLineas, 'id_factura = :fid', { ':fid': id });
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

router.get('/facturacion/pagos', async (_req, res) => {
  try {
    const items = await scanAll(tables.facturasPagos);
    items.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json({ pagos: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/facturacion/facturas/:id/pagos', async (req, res) => {
  try {
    const pagos = await scanAll(tables.facturasPagos, 'id_factura = :fid', { ':fid': req.params.id });
    pagos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    res.json({ pagos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/facturacion/facturas/:id/pagos', async (req, res) => {
  const id_factura = req.params.id;
  const { fecha, importe, metodo_pago, cuenta_caja, referencia, observaciones, usuario_id, usuario_nombre } = req.body || {};

  if (!importe || Number(importe) <= 0) return res.status(400).json({ error: 'Importe debe ser mayor que 0' });

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id_factura } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;

    const importeNum = round2(Number(importe));
    const pagos = await scanAll(tables.facturasPagos, 'id_factura = :fid', { ':fid': id_factura });
    const nextIdx = pagos.length + 1;
    const id_pago = `P${String(nextIdx).padStart(3, '0')}`;

    const pago = {
      id_entrada: `${id_factura}#${id_pago}`,
      id_factura,
      id_pago,
      fecha: fecha || now().slice(0, 10),
      importe: importeNum,
      metodo_pago: metodo_pago || '',
      cuenta_caja: cuenta_caja || '',
      referencia: referencia || '',
      observaciones: observaciones || '',
      justificante: '',
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
    res.status(500).json({ error: err.message });
  }
});

router.delete('/facturacion/pagos/:id_factura/:id_pago', async (req, res) => {
  const { id_factura, id_pago } = req.params;
  const { usuario_id, usuario_nombre } = req.body || {};

  try {
    const pagoResult = await docClient.send(
      new GetCommand({ TableName: tables.facturasPagos, Key: { id_factura, id_pago } })
    );
    if (!pagoResult.Item) return res.status(404).json({ error: 'Pago no encontrado' });

    await docClient.send(new DeleteCommand({ TableName: tables.facturasPagos, Key: { id_factura, id_pago } }));

    const facResult = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id_factura } }));
    if (facResult.Item) {
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
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MÉTRICAS / RESUMEN ───

router.get('/facturacion/metricas', async (_req, res) => {
  try {
    const facturas = await scanAll(tables.facturas);

    const out = facturas.filter((f) => f.tipo === 'OUT');
    const inF = facturas.filter((f) => f.tipo === 'IN');

    const activas = (arr) => arr.filter((f) => f.estado !== 'borrador' && f.estado !== 'anulada');

    const totalEmitido = activas(out).reduce((s, f) => s + (f.total_factura || 0), 0);
    const totalCobrado = out.reduce((s, f) => s + (f.total_cobrado || 0), 0);
    const totalPendienteCobro = out.filter((f) => !['anulada', 'borrador', 'cobrada'].includes(f.estado)).reduce((s, f) => s + (f.saldo_pendiente || 0), 0);
    const facturasVencidas = out.filter((f) => f.estado === 'vencida');

    const totalGastos = activas(inF).reduce((s, f) => s + (f.total_factura || 0), 0);
    const totalPagado = inF.reduce((s, f) => s + (f.total_cobrado || 0), 0);
    const totalPendientePago = inF.filter((f) => !['anulada', 'borrador', 'pagada'].includes(f.estado)).reduce((s, f) => s + (f.saldo_pendiente || 0), 0);

    // Evolución mensual (últimos 12 meses)
    const hoy = new Date();
    const meses = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      meses.push(d.toISOString().slice(0, 7)); // "YYYY-MM"
    }

    const mensual = meses.map((mes) => {
      const outMes = activas(out).filter((f) => (f.fecha_emision || '').startsWith(mes));
      const inMes = activas(inF).filter((f) => (f.fecha_emision || '').startsWith(mes));
      return {
        mes,
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

router.post('/facturacion/facturas/:id/enviar-email', async (req, res) => {
  const id = req.params.id;
  const { destinatario, asunto, cuerpo, pdf_base64, usuario_id, usuario_nombre } = req.body || {};

  if (!destinatario) return res.status(400).json({ error: 'Falta destinatario' });
  if (!process.env.SMTP_USER) return res.status(500).json({ error: 'SMTP no configurado. Define SMTP_HOST, SMTP_USER y SMTP_PASS en variables de entorno.' });

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });
    const factura = existing.Item;

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

    await smtpTransport.sendMail(mailOptions);

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

router.get('/facturacion/metricas-avanzadas', async (req, res) => {
  try {
    const facturas = await scanAll(tables.facturas);
    const pagos = await scanAll(tables.facturasPagos);
    const hoy = new Date();
    const anioActual = hoy.getFullYear();
    const mesActual = hoy.getMonth();

    const activas = facturas.filter((f) => f.estado !== 'anulada');
    const out = activas.filter((f) => f.tipo === 'OUT');
    const inF = activas.filter((f) => f.tipo === 'IN');

    // Desglose mensual últimos 24 meses
    const meses24 = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(anioActual, mesActual - i, 1);
      meses24.push(d.toISOString().slice(0, 7));
    }

    const mensual = meses24.map((mes) => {
      const oM = out.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(mes));
      const iM = inF.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(mes));
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
      const oQ = out.filter((f) => f.estado !== 'borrador' && mesesQ.some((m) => (f.fecha_emision || '').startsWith(m)));
      const iQ = inF.filter((f) => f.estado !== 'borrador' && mesesQ.some((m) => (f.fecha_emision || '').startsWith(m)));
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
    const outAnt = out.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioAnt));
    const outCur = out.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioCur));
    const inAnt = inF.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioAnt));
    const inCur = inF.filter((f) => f.estado !== 'borrador' && (f.fecha_emision || '').startsWith(anioCur));

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
    const pendientes = out.filter((f) => (f.saldo_pendiente || 0) > 0 && !['anulada', 'borrador', 'cobrada'].includes(f.estado));
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
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Automatización: marcar facturas vencidas ───

router.post('/facturacion/check-vencimientos', async (req, res) => {
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
          Key: { id_entrada: f.id_entrada },
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

// ─── ADJUNTOS (S3) ───

router.post('/facturacion/facturas/:id/adjuntos', upload.single('file'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });

    const ext = (req.file.originalname || 'file').split('.').pop();
    const fileKey = `facturas/${id}/${Date.now()}_${uuid().slice(0, 8)}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const adjuntos = existing.Item.adjuntos || [];
    adjuntos.push({
      id: uuid(),
      fileKey,
      nombre: req.file.originalname,
      tipo: req.file.mimetype,
      size: req.file.size,
      subido_en: now(),
      subido_por: req.body.usuario_nombre || '',
    });

    await docClient.send(new UpdateCommand({
      TableName: tables.facturas,
      Key: { id_entrada: id },
      UpdateExpression: 'SET adjuntos = :adj, actualizado_en = :ts',
      ExpressionAttributeValues: { ':adj': adjuntos, ':ts': now() },
    }));

    await registrarAuditoria(id, 'adjunto_subido', req.body.usuario_id, req.body.usuario_nombre, {
      nombre: req.file.originalname,
      fileKey,
    });

    res.json({ ok: true, adjuntos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/facturacion/facturas/:id/adjuntos', async (req, res) => {
  const id = req.params.id;
  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });

    const adjuntos = existing.Item.adjuntos || [];
    const withUrls = await Promise.all(adjuntos.map(async (a) => {
      const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: a.fileKey });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      return { ...a, url };
    }));

    res.json({ adjuntos: withUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/facturacion/facturas/:id/adjuntos/:adjId', async (req, res) => {
  const { id, adjId } = req.params;
  const { usuario_id, usuario_nombre } = req.body || {};

  try {
    const existing = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: { id_entrada: id } }));
    if (!existing.Item) return res.status(404).json({ error: 'Factura no encontrada' });

    const adjuntos = existing.Item.adjuntos || [];
    const adj = adjuntos.find((a) => a.id === adjId);
    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });

    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: adj.fileKey }));

    const nuevos = adjuntos.filter((a) => a.id !== adjId);
    await docClient.send(new UpdateCommand({
      TableName: tables.facturas,
      Key: { id_entrada: id },
      UpdateExpression: 'SET adjuntos = :adj, actualizado_en = :ts',
      ExpressionAttributeValues: { ':adj': nuevos, ':ts': now() },
    }));

    await registrarAuditoria(id, 'adjunto_eliminado', usuario_id, usuario_nombre, { nombre: adj.nombre });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OCR / REGISTRO MASIVO ───

router.post('/facturacion/ocr/extraer', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const extracted = await extraerDatosBasicos(req.file.buffer, req.file.mimetype, req.file.originalname);

    const fileKey = `facturas/ocr-temp/${Date.now()}_${uuid().slice(0, 8)}_${req.file.originalname}`;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
    const previewUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });

    res.json({
      ok: true,
      datos: extracted,
      archivo: {
        fileKey,
        nombre: req.file.originalname,
        tipo: req.file.mimetype,
        size: req.file.size,
        previewUrl,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function ocrWithTesseract(imageBuffer) {
  const worker = await Tesseract.createWorker('spa+eng');
  try {
    const { data } = await worker.recognize(imageBuffer);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
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

/** Rasteriza la página 1 del PDF a PNG para OCR (requiere canvas + pdfjs-dist). */
async function renderPdfFirstPageToPngBuffer(pdfBuffer) {
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const getDocument = pdfjs.getDocument;
    const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    const loadingTask = getDocument({
      data: new Uint8Array(buf),
      disableWorker: true,
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;
    if (pdf.numPages < 1) return null;
    const page = await pdf.getPage(1);
    const scale = 2;
    const viewport = page.getViewport({ scale });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toBuffer('image/png');
  } catch (e) {
    console.error('[OCR] No se pudo rasterizar PDF para OCR:', e.message);
    return null;
  }
}

function pickProveedorCif(text, cifs) {
  if (!cifs.length) return '';
  if (cifs.length === 1) return cifs[0];
  const lower = text.toLowerCase();
  const clienteIdx = lower.search(/\b(cliente|destinatario|adquiriente)\b/);
  const head = clienteIdx > 0 ? text.slice(0, clienteIdx) : text;
  const cifRegex = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/gi;
  const inHead = [];
  let m;
  while ((m = cifRegex.exec(head)) !== null) {
    const c = m[1].toUpperCase();
    if (!inHead.includes(c)) inHead.push(c);
  }
  if (inHead.length) return inHead[0];
  return cifs[0];
}

function inferProveedorNombre(text, cifProveedor) {
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cifNorm = (cifProveedor || '').replace(/\s/g, '');
  if (cifNorm) {
    const idx = lines.findIndex((l) => l.replace(/\s/g, '').includes(cifNorm));
    if (idx > 0) {
      const candidate = lines[idx - 1];
      if (candidate.length >= 3 && candidate.length < 120 && !/^\d{1,2}[\/\-]/.test(candidate) && !/^[A-Z0-9]{8,}$/i.test(candidate)) {
        return candidate.replace(/^[\s\-–—]+/, '').slice(0, 120);
      }
    }
  }
  const sl = text.match(
    /([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúñ0-9\s.,&\-]{3,80}(?:S\.?L\.?U\.?|S\.?L\.?|S\.?A\.?|S\.?C\.?O\.?O\.?P\.?))\.?/i
  );
  if (sl) return sl[1].trim().replace(/\s+/g, ' ').slice(0, 120);
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

function normalizeCif(val) {
  return String(val ?? '').trim().toUpperCase();
}

/** Busca en `igp_Empresas` por CIF (misma lógica que `/api/empresas/check-cif`). */
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
  const found = items.find((item) => normalizeCif(item?.Cif) === cif);
  return found || null;
}

const IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/tiff', 'image/bmp'];
const MIN_TEXT_THRESHOLD = 50;

function isPdfMime(mimetype, filename) {
  if (mimetype === 'application/pdf') return true;
  const n = (filename || '').toLowerCase();
  return mimetype === 'application/octet-stream' && n.endsWith('.pdf');
}

async function extraerDatosBasicos(buffer, mimetype, filename) {
  let text = '';
  let metodo_extraccion = 'pdf_text';
  const isImage = IMAGE_MIMES.includes(mimetype);
  const isPdf = isPdfMime(mimetype, filename);

  if (isPdf) {
    try {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const parsed = await pdfParse(buf);
      text = (parsed && parsed.text) || '';
    } catch (e) {
      console.error('[OCR] pdf-parse falló, usando fallback:', e.message);
      text = extractTextFromPdfBufferFallback(buffer);
    }

    if (text.trim().length < MIN_TEXT_THRESHOLD) {
      console.log(`[OCR] PDF con poco texto (${text.trim().length} chars) — intentando OCR por imagen (pág. 1)…`);
      const png = await renderPdfFirstPageToPngBuffer(buffer);
      if (png) {
        try {
          const ocrText = await ocrWithTesseract(png);
          if (ocrText && ocrText.trim().length > text.trim().length) {
            text = ocrText;
            metodo_extraccion = 'pdf_ocr_fallback';
            console.log(`[OCR] PDF escaneado: Tesseract extrajo ${text.length} caracteres`);
          }
        } catch (e) {
          console.error('[OCR] Tesseract en PDF rasterizado falló:', e.message);
        }
      }
    } else {
      metodo_extraccion = 'pdf_text';
    }
  } else if (isImage) {
    metodo_extraccion = 'image_ocr';
    console.log('[OCR] Imagen detectada, ejecutando Tesseract OCR…');
    try {
      text = await ocrWithTesseract(buffer);
      console.log(`[OCR] Tesseract extrajo ${text.length} caracteres`);
    } catch (e) {
      console.error('[OCR] Tesseract falló en imagen:', e.message);
    }
  }

  console.log(`[OCR] Texto extraído (${text.length} chars) [${metodo_extraccion}]:`, text.slice(0, 500));

  const parseImporte = (str) => normalizeImporteFacturaEsp(str);

  const cifs = [];
  const cifRegex = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/gi;
  let m;
  while ((m = cifRegex.exec(text)) !== null) {
    if (!cifs.includes(m[1].toUpperCase())) cifs.push(m[1].toUpperCase());
  }
  const proveedor_cif = pickProveedorCif(text, cifs);

  const fechas = [];
  const fechaRegex = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/g;
  while ((m = fechaRegex.exec(text)) !== null) {
    let y = m[3].length === 2 ? '20' + m[3] : m[3];
    const yNum = parseInt(y, 10);
    if (yNum < 2000 || yNum > 2100) continue;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      fechas.push(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }

  let totalFactura = 0;
  let baseImponible = 0;
  let totalIva = 0;

  const amountCapture = '(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})';
  const totalRegex = new RegExp(
    `(?:total\\s*(?:factura)?|importe\\s*total|total\\s*a\\s*pagar|total\\s*€?)[:\\s]*${amountCapture}\\s*€?`,
    'gi'
  );
  const baseRegex = new RegExp(
    `(?:base\\s*imponible|subtotal|base\\s+i)[:\\s]*${amountCapture}\\s*€?`,
    'gi'
  );
  const ivaRegex = new RegExp(
    `(?:cuota\\s*iva|iva\\s*(?:\\d+\\s*%?\\s*)?|total\\s*iva|importe\\s*iva)[:\\s]*${amountCapture}\\s*€?`,
    'gi'
  );

  const totalMatches = [];
  while ((m = totalRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v > 0) totalMatches.push(v);
  }
  if (totalMatches.length > 0) totalFactura = totalMatches[totalMatches.length - 1];

  const baseMatches = [];
  while ((m = baseRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v > 0) baseMatches.push(v);
  }
  if (baseMatches.length > 0) baseImponible = baseMatches[baseMatches.length - 1];

  const ivaMatches = [];
  while ((m = ivaRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v > 0) ivaMatches.push(v);
  }
  if (ivaMatches.length > 0) totalIva = ivaMatches[ivaMatches.length - 1];

  if (!totalFactura || !baseImponible) {
    const allImportes = [];
    const importePatterns = [
      /(\d{1,3}(?:\.\d{3})*,\d{2})\s*€/g,
      /€\s*(\d{1,3}(?:\.\d{3})*,\d{2})/g,
      /(\d{1,3}(?:\.\d{3})*,\d{2})/g,
      /(\d+\.\d{2})\s*€/g,
      /€\s*(\d+\.\d{2})/g,
      /\b(\d{1,3}(?:\.\d{3})+\.\d{2})\b/g,
    ];
    for (const regex of importePatterns) {
      while ((m = regex.exec(text)) !== null) {
        const val = parseImporte(m[1]);
        if (!Number.isNaN(val) && val > 0.01) allImportes.push(val);
      }
    }
    const unique = [...new Set(allImportes)].sort((a, b) => b - a);
    if (!totalFactura && unique.length > 0) totalFactura = unique[0];
    if (!baseImponible && unique.length > 1) baseImponible = unique[1];
    if (!totalIva && unique.length > 2) totalIva = unique[2];
  }

  if (baseImponible && totalFactura && !totalIva) {
    totalIva = Math.round((totalFactura - baseImponible) * 100) / 100;
  }
  if (totalFactura && totalIva && !baseImponible) {
    baseImponible = Math.round((totalFactura - totalIva) * 100) / 100;
  }

  const numFacturas = [];
  const nfPatterns = [
    /(?:factura|fact\.?|fra\.?|invoice|nº\s*fact(?:ura)?|n[uú]m(?:ero)?\.?\s*(?:de\s+)?fact(?:ura)?)[:\s#nº.]*\s*([A-Z0-9][A-Z0-9\-\/. ]*[A-Z0-9])/gi,
    /(?:nº|n\.º|núm\.?|número)[:\s]+([A-Z0-9][A-Z0-9\-\/]*)/gi,
    /(?:invoice\s*(?:no|number|#)?)[:\s]*([A-Z0-9][A-Z0-9\-\/]*)/gi,
  ];
  for (const regex of nfPatterns) {
    while ((m = regex.exec(text)) !== null) {
      const val = m[1].trim();
      if (val.length >= 1 && !numFacturas.includes(val)) numFacturas.push(val);
    }
  }

  const nombreOcrSugerido = inferProveedorNombre(text, proveedor_cif);

  let proveedor_nombre = '';
  let empresa_id = '';
  let proveedor_en_maestros = false;
  if (proveedor_cif) {
    try {
      const emp = await buscarEmpresaPorCif(proveedor_cif);
      if (emp) {
        proveedor_nombre = String(emp.Nombre || '').trim();
        empresa_id = emp.id_empresa != null ? String(emp.id_empresa) : '';
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
  };

  const ocr_confianza_global = averageOcrConfidence(confianza);

  return {
    proveedor_cif: proveedor_cif || '',
    proveedor_nombre: proveedor_nombre || '',
    empresa_id: empresa_id || '',
    proveedor_en_maestros,
    /** Solo si hay CIF y no está en maestro: sugerencia OCR para rellenar al crear empresa */
    nombre_sugerido_ocr: !proveedor_en_maestros && proveedor_cif ? nombreOcrSugerido || '' : '',
    numero_factura_proveedor: numFacturas[0] || '',
    fecha_emision: fechas[0] || '',
    total_factura: totalFactura,
    base_imponible: baseImponible,
    total_iva: totalIva,
    confianza,
    texto_extraido: text.slice(0, 8000),
    metodo_extraccion,
    ocr_confianza_global,
  };
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

router.post('/facturacion/ocr/confirmar', async (req, res) => {
  const { borradores, usuario_id, usuario_nombre } = req.body || {};
  if (!Array.isArray(borradores) || borradores.length === 0) {
    return res.status(400).json({ error: 'No se recibieron borradores' });
  }

  try {
    const creados = [];
    for (const b of borradores) {
      if (b.descartado) continue;

      const id_factura = uuid();
      const factura = {
        id_entrada: id_factura,
        id_factura,
        tipo: 'IN',
        estado: 'pendiente_revision',
        serie: b.serie || '',
        numero: 0,
        numero_factura: '',
        fecha_emision: b.fecha_emision || '',
        fecha_vencimiento: b.fecha_vencimiento || '',
        empresa_id: b.empresa_id || '',
        empresa_nombre: b.proveedor_nombre || '',
        empresa_cif: b.proveedor_cif || '',
        empresa_direccion: '',
        empresa_cp: '',
        empresa_municipio: '',
        empresa_provincia: '',
        empresa_email: '',
        numero_factura_proveedor: b.numero_factura_proveedor || '',
        base_imponible: round2(b.base_imponible || 0),
        total_iva: round2(b.total_iva || 0),
        total_retencion: 0,
        total_factura: round2(b.total_factura || 0),
        total_cobrado: 0,
        saldo_pendiente: round2(b.total_factura || 0),
        forma_pago: b.forma_pago || '',
        condiciones_pago: b.condiciones_pago || '',
        observaciones: b.observaciones || 'Creada desde OCR/registro masivo',
        local_id: b.local_id || '',
        adjuntos: b.archivo ? [{
          id: uuid(),
          fileKey: b.archivo.fileKey,
          nombre: b.archivo.nombre,
          tipo: b.archivo.tipo,
          size: b.archivo.size || 0,
          subido_en: now(),
          subido_por: usuario_nombre || '',
        }] : [],
        version: 1,
        creado_por: usuario_id || '',
        creado_en: now(),
        modificado_por: '',
        modificado_en: '',
        origen: 'ocr',
        ocr_confianza: b.confianza || {},
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

router.post('/facturacion/enviar-recordatorios', async (req, res) => {
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
        await smtpTransport.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
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
          Key: { id_entrada: f.id_entrada },
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

router.post('/facturacion/check-duplicados', async (req, res) => {
  const { proveedor_cif, numero_factura_proveedor, fecha_emision, total_factura } = req.body || {};
  try {
    const facturas = await scanAll(tables.facturas, '#t = :t', { ':t': 'IN' }, { '#t': 'tipo' });
    const posibles = facturas.filter((f) => {
      let score = 0;
      if (proveedor_cif && f.empresa_cif === proveedor_cif) score += 3;
      if (numero_factura_proveedor && f.numero_factura_proveedor === numero_factura_proveedor) score += 4;
      if (fecha_emision && f.fecha_emision === fecha_emision) score += 1;
      if (total_factura && Math.abs((f.total_factura || 0) - total_factura) < 0.02) score += 2;
      return score >= 5;
    });

    res.json({ duplicados: posibles.map((f) => ({ id_factura: f.id_factura, numero_factura: f.numero_factura, empresa_nombre: f.empresa_nombre, total_factura: f.total_factura, fecha_emision: f.fecha_emision })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
