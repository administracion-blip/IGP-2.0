import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, tables, keyForFacturaPrincipalId } from '../lib/db.js';
import { calcularPropuestaImporte, sanitizeTarifas, tarifasMatrizVacia } from '../lib/tarifaActuacion.js';
import { empresaTieneEtiquetaMusicos } from '../lib/etiquetaMusicos.js';
import { getIdEmpresaFromItem } from '../lib/empresaCif.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });

const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
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

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const s = String(val).replace(/^0+/, '') || '0';
  const n = parseInt(s, 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

/** dd/mm/yyyy o yyyy-mm-dd → yyyy-mm-dd */
function fechaAIso(fecha) {
  if (!fecha) return '';
  const s = String(fecha).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return s;
}

async function esFechaFestiva(fechaIso) {
  try {
    const items = await scanAll(tables.gestionFestivos);
    for (const i of items) {
      const fc = i.FechaComparativa ?? i.Fecha;
      if (fc == null) continue;
      const iso = fechaAIso(String(fc));
      if (iso === fechaIso && (i.Festivo === true || i.Festivo === 'true')) return true;
    }
  } catch {
    /* tabla ausente */
  }
  return false;
}

const ESTADOS_FACTURA_ASOCIABLE = new Set(['pendiente_revision', 'pendiente_pago', 'parcialmente_pagada']);

function normalizarHoraActuacion(h) {
  if (h == null || h === '') return '22:00';
  const s = String(h).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Fechas inclusivas yyyy-mm-dd */
function enumerarFechasIso(fechaInicio, fechaFin) {
  const a = fechaAIso(String(fechaInicio || ''));
  const b = fechaAIso(String(fechaFin || ''));
  if (!a || !b || a > b) return [];
  const out = [];
  let cur = new Date(`${a}T12:00:00.000Z`);
  const end = new Date(`${b}T12:00:00.000Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 864e5);
  }
  return out;
}

async function findConflictoArtistaExcluyendo({ id_excluir, id_artista, fecha, hora_inicio }) {
  if (!id_artista || String(id_artista).trim() === '') return null;
  const items = await scanAll(tables.actuaciones);
  const f = fechaAIso(String(fecha));
  const h = normalizarHoraActuacion(hora_inicio);
  for (const x of items) {
    if (id_excluir != null && String(x.id_actuacion) === String(id_excluir)) continue;
    if (String(x.id_artista || '') !== String(id_artista)) continue;
    if (String(x.fecha || '') !== f) continue;
    if (normalizarHoraActuacion(x.hora_inicio) !== h) continue;
    return x;
  }
  return null;
}

function actuacionResumenConflicto(x) {
  if (!x) return null;
  return {
    id_actuacion: String(x.id_actuacion),
    fecha: String(x.fecha || ''),
    hora_inicio: String(x.hora_inicio || ''),
    id_local: String(x.id_local || ''),
    local_nombre_snapshot: String(x.local_nombre_snapshot || ''),
    estado: String(x.estado || ''),
    id_artista: String(x.id_artista || ''),
    artista_nombre_snapshot: String(x.artista_nombre_snapshot || ''),
  };
}

function mensajeErrorDynamo(err) {
  if (err?.name === 'ResourceNotFoundException') {
    return 'La tabla de artistas no existe en DynamoDB. En el servidor ejecuta: node api/scripts/create-artistas-actuaciones-tables.js';
  }
  return err?.message || 'Error al guardar';
}

// ─── ARTISTAS ───

router.get('/artistas', async (_req, res) => {
  try {
    const items = await scanAll(tables.artistas);
    items.sort((a, b) => String(a.nombre_artistico || '').localeCompare(String(b.nombre_artistico || ''), 'es'));
    res.json({ artistas: items });
  } catch (err) {
    console.error('[artistas GET]', err);
    res.status(500).json({ error: err.message || 'Error al listar artistas' });
  }
});

router.get('/artistas/:id', async (req, res) => {
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.artistas, Key: { id_artista: req.params.id } })
    );
    if (!r.Item) return res.status(404).json({ error: 'Artista no encontrado' });
    res.json({ artista: r.Item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/artistas', async (req, res) => {
  const body = req.body || {};
  const id_artista = body.id_artista && String(body.id_artista).trim() !== '' ? String(body.id_artista).trim() : uuid();
  const ts = now();
  try {
    const item = {
      id_artista,
      nombre_artistico: String(body.nombre_artistico ?? '').trim() || 'Sin nombre',
      componentes: Number(body.componentes) || 1,
      estilos_musicales: Array.isArray(body.estilos_musicales) ? body.estilos_musicales : [],
      tipo_artista: Array.isArray(body.tipo_artista) ? body.tipo_artista : body.tipo_artista ? [body.tipo_artista] : [],
      imagen_key: body.imagen_key != null ? String(body.imagen_key) : '',
      activo: body.activo !== false,
      telefono_contacto: body.telefono_contacto != null ? String(body.telefono_contacto) : '',
      email_contacto: body.email_contacto != null ? String(body.email_contacto) : '',
      observaciones: body.observaciones != null ? String(body.observaciones) : '',
      tarifas: sanitizeTarifas(body.tarifas),
      created_at: ts,
      updated_at: ts,
    };
    await docClient.send(new PutCommand({ TableName: tables.artistas, Item: item }));
    res.json({ ok: true, artista: item });
  } catch (err) {
    console.error('[artistas POST]', err);
    res.status(500).json({ error: mensajeErrorDynamo(err) });
  }
});

router.put('/artistas/:id', async (req, res) => {
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.artistas, Key: { id_artista: req.params.id } })
    );
    if (!r.Item) return res.status(404).json({ error: 'Artista no encontrado' });
    const prev = r.Item;
    const body = req.body || {};
    const item = {
      ...prev,
      nombre_artistico: body.nombre_artistico != null ? String(body.nombre_artistico).trim() : prev.nombre_artistico,
      componentes: body.componentes != null ? Number(body.componentes) : prev.componentes,
      estilos_musicales: body.estilos_musicales != null ? (Array.isArray(body.estilos_musicales) ? body.estilos_musicales : []) : prev.estilos_musicales,
      tipo_artista: body.tipo_artista != null ? (Array.isArray(body.tipo_artista) ? body.tipo_artista : [body.tipo_artista]) : prev.tipo_artista,
      imagen_key: body.imagen_key != null ? String(body.imagen_key) : prev.imagen_key,
      activo: body.activo !== undefined ? body.activo !== false : prev.activo,
      telefono_contacto: body.telefono_contacto != null ? String(body.telefono_contacto) : prev.telefono_contacto,
      email_contacto: body.email_contacto != null ? String(body.email_contacto) : prev.email_contacto,
      observaciones: body.observaciones != null ? String(body.observaciones) : prev.observaciones,
      tarifas: body.tarifas != null ? sanitizeTarifas(body.tarifas) : prev.tarifas,
      updated_at: now(),
    };
    await docClient.send(new PutCommand({ TableName: tables.artistas, Item: item }));
    res.json({ ok: true, artista: item });
  } catch (err) {
    console.error('[artistas PUT]', err);
    res.status(500).json({ error: mensajeErrorDynamo(err) });
  }
});

router.delete('/artistas/:id', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({ TableName: tables.artistas, Key: { id_artista: req.params.id } }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/artistas/:id/imagen', upload.single('file'), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'Falta archivo (field: file)' });
  const id = req.params.id;
  const ext = (req.file.originalname || 'img').match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] || 'jpg';
  const key = `artistas/${id}/${Date.now()}_${uuid().slice(0, 8)}.${ext}`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'image/jpeg',
      })
    );
    const r = await docClient.send(new GetCommand({ TableName: tables.artistas, Key: { id_artista: id } }));
    if (r.Item) {
      const item = { ...r.Item, imagen_key: key, updated_at: now() };
      await docClient.send(new PutCommand({ TableName: tables.artistas, Item: item }));
    }
    res.json({ ok: true, imagen_key: key });
  } catch (err) {
    console.error('[artistas imagen]', err);
    res.status(500).json({ error: err.message || 'Error al subir imagen' });
  }
});

/** URL prefirmada GET temporal para mostrar la imagen del artista (S3 privado). */
router.get('/artistas/:id/imagen-url', async (req, res) => {
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.artistas, Key: { id_artista: req.params.id } })
    );
    if (!r.Item) return res.status(404).json({ error: 'Artista no encontrado' });
    const key = r.Item.imagen_key;
    if (key == null || String(key).trim() === '') {
      return res.json({ url: null });
    }
    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: String(key) });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    res.json({ url, expiresIn: 3600 });
  } catch (err) {
    console.error('[artistas imagen-url]', err);
    res.status(500).json({ error: err.message || 'Error al generar URL de imagen' });
  }
});

// ─── Rutas específicas ANTES de /actuaciones/:id ───

router.get('/actuaciones/facturas-gasto-asociables', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const { numero, proveedor, cif, fecha, importeMin, importeMax } = req.query;

  try {
    const facturas = await scanAll(tables.facturas, '#t = :t', { ':t': 'IN' }, { '#t': 'tipo' });
    const empresas = await scanAll(tables.empresas);
    const empById = new Map();
    for (const e of empresas) {
      const id = getIdEmpresaFromItem(e);
      if (id) empById.set(String(id), e);
    }

    let list = facturas.filter((f) => ESTADOS_FACTURA_ASOCIABLE.has(f.estado));
    list = list.filter((f) => {
      const emp = empById.get(String(f.empresa_id || ''));
      if (!emp) return false;
      return empresaTieneEtiquetaMusicos(emp.Etiqueta);
    });

    const matchStr = (s, needle) => !needle || String(s ?? '').toLowerCase().includes(needle);

    if (numero) list = list.filter((f) => matchStr(f.numero_factura_proveedor || f.numero_factura, String(numero).toLowerCase()));
    if (proveedor) list = list.filter((f) => matchStr(f.empresa_nombre, String(proveedor).toLowerCase()));
    if (cif) list = list.filter((f) => matchStr(f.empresa_cif, String(cif).toLowerCase()));
    if (fecha) {
      const iso = fechaAIso(String(fecha));
      list = list.filter((f) => String(f.fecha_emision || '').slice(0, 10) === iso);
    }
    if (importeMin !== undefined && importeMin !== '') {
      const n = Number(importeMin);
      list = list.filter((f) => Number(f.total_factura) >= n);
    }
    if (importeMax !== undefined && importeMax !== '') {
      const n = Number(importeMax);
      list = list.filter((f) => Number(f.total_factura) <= n);
    }
    if (q) {
      list = list.filter(
        (f) =>
          matchStr(f.numero_factura_proveedor, q) ||
          matchStr(f.numero_factura, q) ||
          matchStr(f.empresa_nombre, q) ||
          matchStr(f.empresa_cif, q)
      );
    }

    list.sort((a, b) => (b.fecha_emision || '').localeCompare(a.fecha_emision || ''));

    const out = list.map((f) => ({
      id_factura: f.id_factura || f.id_entrada,
      numero_factura: f.numero_factura_proveedor || f.numero_factura || '',
      proveedor: f.empresa_nombre || '',
      empresa_cif: f.empresa_cif || '',
      fecha_emision: f.fecha_emision || '',
      total_factura: f.total_factura,
      estado: f.estado,
    }));

    res.json({ facturas: out });
  } catch (err) {
    console.error('[facturas asociables]', err);
    res.status(500).json({ error: err.message || 'Error al buscar facturas' });
  }
});

router.post('/actuaciones/calcular-importe', async (req, res) => {
  const { id_artista, fecha, hora_inicio } = req.body || {};
  if (!id_artista || !fecha) return res.status(400).json({ error: 'id_artista y fecha son obligatorios' });
  try {
    const r = await docClient.send(new GetCommand({ TableName: tables.artistas, Key: { id_artista } }));
    if (!r.Item) return res.status(404).json({ error: 'Artista no encontrado' });
    const fechaIso = fechaAIso(String(fecha));
    const hora = hora_inicio != null ? String(hora_inicio) : '22:00';
    const esFestivo = await esFechaFestiva(fechaIso);
    const tarifas = r.Item.tarifas != null ? r.Item.tarifas : tarifasMatrizVacia();
    const out = calcularPropuestaImporte(fechaIso, hora, tarifas, esFestivo);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actuaciones/asociar-factura', async (req, res) => {
  const { ids_actuacion, id_factura, usuario_id, usuario_nombre } = req.body || {};
  if (!Array.isArray(ids_actuacion) || ids_actuacion.length === 0) {
    return res.status(400).json({ error: 'ids_actuacion debe ser un array no vacío' });
  }
  if (!id_factura) return res.status(400).json({ error: 'id_factura es obligatorio' });

  try {
    const key = await keyForFacturaPrincipalId(id_factura);
    const fr = await docClient.send(new GetCommand({ TableName: tables.facturas, Key: key }));
    let factura = fr.Item;
    if (!factura) {
      const all = await scanAll(tables.facturas);
      factura = all.find((x) => (x.id_factura || x.id_entrada) === id_factura);
    }
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

    if (factura.tipo !== 'IN') return res.status(400).json({ error: 'Solo facturas recibidas (IN)' });
    if (!ESTADOS_FACTURA_ASOCIABLE.has(factura.estado)) {
      return res.status(400).json({ error: 'La factura no está en un estado asociable' });
    }

    const empresas = await scanAll(tables.empresas);
    const emp = empresas.find((e) => String(getIdEmpresaFromItem(e)) === String(factura.empresa_id));
    if (!emp || !empresaTieneEtiquetaMusicos(emp.Etiqueta)) {
      return res.status(400).json({ error: 'El proveedor de la factura no está etiquetado como músicos' });
    }

    const fechaAsoc = now();
    const usuarioStr = [usuario_nombre, usuario_id].filter(Boolean).join(' · ');

    const updates = [];
    for (const id of ids_actuacion) {
      const r = await docClient.send(
        new GetCommand({ TableName: tables.actuaciones, Key: { id_actuacion: String(id) } })
      );
      if (!r.Item) continue;
      const item = {
        ...r.Item,
        id_factura_gasto: String(factura.id_factura || factura.id_entrada || id_factura),
        pago_asociado_numero_factura: String(factura.numero_factura_proveedor || factura.numero_factura || ''),
        pago_asociado_proveedor: String(factura.empresa_nombre || ''),
        pago_asociado_fecha: String(factura.fecha_emision || '').slice(0, 10),
        pago_asociado_importe: Number(factura.total_factura) || 0,
        pago_asociado_estado: String(factura.estado || ''),
        fecha_asociacion_pago: fechaAsoc,
        usuario_asociacion_pago: usuarioStr,
        estado: 'asociada',
        updated_at: fechaAsoc,
      };
      updates.push(item);
    }

    for (let i = 0; i < updates.length; i += 25) {
      const chunk = updates.slice(i, i + 25);
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tables.actuaciones]: chunk.map((Item) => ({ PutRequest: { Item } })),
          },
        })
      );
    }

    res.json({ ok: true, actualizadas: updates.length });
  } catch (err) {
    console.error('[asociar factura]', err);
    res.status(500).json({ error: err.message || 'Error al asociar' });
  }
});

async function crearItemHuecoActuacion({ fechaIso, horaIni, idLocFormatted, localNombre }) {
  const esFestivo = await esFechaFestiva(fechaIso);
  const prop = calcularPropuestaImporte(fechaIso, horaIni, tarifasMatrizVacia(), esFestivo);
  const ts = now();
  return {
    id_actuacion: uuid(),
    id_artista: '',
    artista_nombre_snapshot: '',
    fecha: fechaIso,
    hora_inicio: horaIni,
    hora_fin: '',
    franja: prop.franja,
    tipo_dia: prop.tipo_dia,
    id_local: idLocFormatted,
    local_nombre_snapshot: localNombre,
    importe_previsto: null,
    importe_final: null,
    estado: 'pendiente',
    firma_artista_key: '',
    fecha_firma: '',
    observaciones: '',
    id_factura_gasto: '',
    pago_asociado_numero_factura: '',
    pago_asociado_proveedor: '',
    pago_asociado_fecha: '',
    pago_asociado_importe: null,
    pago_asociado_estado: '',
    fecha_asociacion_pago: '',
    usuario_asociacion_pago: '',
    created_at: ts,
    updated_at: ts,
  };
}

/** Genera huecos del calendario (sin unicidad fecha+local+hora). */
router.post('/actuaciones/generar-base', async (req, res) => {
  const body = req.body || {};
  const { fecha_inicio, fecha_fin, id_local, id_locales, horas } = body;
  /** Lista de ids de local únicos (6 dígitos). */
  let idsLocales = [];
  if (Array.isArray(id_locales) && id_locales.length > 0) {
    idsLocales = [...new Set(id_locales.map((x) => formatId6(String(x))))].filter(Boolean);
  } else if (id_local) {
    idsLocales = [formatId6(id_local)];
  }
  if (idsLocales.length === 0) {
    return res.status(400).json({ error: 'Indica id_local o id_locales (al menos un local)' });
  }
  if (!Array.isArray(horas) || horas.length === 0) {
    return res.status(400).json({ error: 'horas debe ser un array no vacío' });
  }
  const fechas = enumerarFechasIso(fecha_inicio, fecha_fin);
  if (fechas.length === 0) return res.status(400).json({ error: 'Rango de fechas inválido' });
  try {
    const creadas = [];
    for (const idLoc of idsLocales) {
      const loc = await docClient.send(
        new GetCommand({ TableName: tables.locales, Key: { id_Locales: idLoc } })
      );
      const localNombre = loc.Item?.nombre || loc.Item?.Nombre || '';
      for (const fechaIso of fechas) {
        for (const hRaw of horas) {
          const horaIni = normalizarHoraActuacion(hRaw);
          const item = await crearItemHuecoActuacion({
            fechaIso,
            horaIni,
            idLocFormatted: idLoc,
            localNombre,
          });
          creadas.push(item);
        }
      }
    }
    for (let i = 0; i < creadas.length; i += 25) {
      const chunk = creadas.slice(i, i + 25);
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tables.actuaciones]: chunk.map((Item) => ({ PutRequest: { Item } })),
          },
        })
      );
    }
    res.json({ ok: true, creadas: creadas.length, actuaciones: creadas });
  } catch (err) {
    console.error('[actuaciones generar-base]', err);
    res.status(500).json({ error: err.message || 'Error al generar actuaciones' });
  }
});

/** Comprueba si el artista ya tiene otra actuación misma fecha y hora_inicio. */
router.post('/actuaciones/conflicto-artista', async (req, res) => {
  const { id_actuacion, id_artista, fecha, hora_inicio } = req.body || {};
  if (!id_artista) return res.json({ conflicto: false });
  try {
    const otro = await findConflictoArtistaExcluyendo({
      id_excluir: id_actuacion || null,
      id_artista,
      fecha,
      hora_inicio: hora_inicio != null ? hora_inicio : '22:00',
    });
    if (!otro) return res.json({ conflicto: false });
    return res.json({ conflicto: true, otro: actuacionResumenConflicto(otro) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Quita artista del registro conflicto y lo asigna al registro destino. */
router.post('/actuaciones/mover-artista-aqui', async (req, res) => {
  const body = req.body || {};
  const id_vaciar = body.id_vaciar;
  const id_asignar = body.id_asignar;
  const id_artista = body.id_artista;
  if (!id_vaciar || !id_asignar || !id_artista) {
    return res.status(400).json({ error: 'id_vaciar, id_asignar e id_artista son obligatorios' });
  }
  try {
    const [rV, rA] = await Promise.all([
      docClient.send(new GetCommand({ TableName: tables.actuaciones, Key: { id_actuacion: String(id_vaciar) } })),
      docClient.send(new GetCommand({ TableName: tables.actuaciones, Key: { id_actuacion: String(id_asignar) } })),
    ]);
    if (!rV.Item || !rA.Item) return res.status(404).json({ error: 'Actuación no encontrada' });
    const ar = await docClient.send(
      new GetCommand({ TableName: tables.artistas, Key: { id_artista: String(id_artista) } })
    );
    const artistaNombre = ar.Item?.nombre_artistico || '';
    const fechaIso = fechaAIso(String(rA.Item.fecha));
    const horaIni = normalizarHoraActuacion(rA.Item.hora_inicio);
    const esFestivo = await esFechaFestiva(fechaIso);
    const tarifas = ar.Item?.tarifas != null ? ar.Item.tarifas : tarifasMatrizVacia();
    const prop = calcularPropuestaImporte(fechaIso, horaIni, tarifas, esFestivo);
    const importePrev =
      body.importe_previsto != null && body.importe_previsto !== ''
        ? Number(body.importe_previsto)
        : prop.importe_previsto != null
          ? prop.importe_previsto
          : null;
    const importeFinal =
      body.importe_final != null && body.importe_final !== '' ? Number(body.importe_final) : importePrev;

    const ts = now();
    const vaciar = {
      ...rV.Item,
      id_artista: '',
      artista_nombre_snapshot: '',
      importe_previsto: null,
      importe_final: null,
      estado: 'pendiente',
      observaciones: '',
      updated_at: ts,
    };
    const asignar = {
      ...rA.Item,
      id_artista: String(id_artista),
      artista_nombre_snapshot: artistaNombre,
      fecha: fechaIso,
      hora_inicio: horaIni,
      franja: prop.franja,
      tipo_dia: prop.tipo_dia,
      importe_previsto: importePrev,
      importe_final: importeFinal,
      observaciones: body.observaciones != null ? String(body.observaciones) : String(rA.Item.observaciones || ''),
      estado: body.estado != null ? String(body.estado) : 'pendiente',
      updated_at: ts,
    };
    await docClient.send(new PutCommand({ TableName: tables.actuaciones, Item: vaciar }));
    await docClient.send(new PutCommand({ TableName: tables.actuaciones, Item: asignar }));
    res.json({ ok: true, vaciado: vaciar, asignado: asignar });
  } catch (err) {
    console.error('[mover-artista-aqui]', err);
    res.status(500).json({ error: err.message || 'Error al mover artista' });
  }
});

// ─── ACTUACIONES CRUD (rutas con /item/:id) ───

router.get('/actuaciones', async (req, res) => {
  try {
    let items = await scanAll(tables.actuaciones);
    const { fechaDesde, fechaHasta, id_artista, id_local, estado } = req.query;
    if (id_artista) items = items.filter((x) => x.id_artista === id_artista);
    if (id_local) items = items.filter((x) => formatId6(x.id_local) === formatId6(id_local));
    if (estado) items = items.filter((x) => String(x.estado || '') === String(estado));
    if (fechaDesde) items = items.filter((x) => String(x.fecha || '') >= String(fechaDesde));
    if (fechaHasta) items = items.filter((x) => String(x.fecha || '') <= String(fechaHasta));
    items.sort((a, b) => {
      const cf = String(a.fecha || '').localeCompare(String(b.fecha || ''));
      if (cf !== 0) return cf;
      return String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || ''));
    });
    res.json({ actuaciones: items });
  } catch (err) {
    console.error('[actuaciones GET]', err);
    res.status(500).json({ error: err.message || 'Error al listar actuaciones' });
  }
});

router.get('/actuaciones/item/:id', async (req, res) => {
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.actuaciones, Key: { id_actuacion: req.params.id } })
    );
    if (!r.Item) return res.status(404).json({ error: 'Actuación no encontrada' });
    res.json({ actuacion: r.Item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actuaciones', async (req, res) => {
  const body = req.body || {};
  const id_actuacion = body.id_actuacion || uuid();
  const ts = now();
  try {
    let artistaNombre = String(body.artista_nombre_snapshot ?? '');
    if (!artistaNombre && body.id_artista) {
      const ar = await docClient.send(
        new GetCommand({ TableName: tables.artistas, Key: { id_artista: body.id_artista } })
      );
      artistaNombre = ar.Item?.nombre_artistico || '';
    }
    let localNombre = String(body.local_nombre_snapshot ?? '');
    if (!localNombre && body.id_local) {
      const idLoc = formatId6(body.id_local);
      const loc = await docClient.send(
        new GetCommand({ TableName: tables.locales, Key: { id_Locales: idLoc } })
      );
      localNombre = loc.Item?.nombre || loc.Item?.Nombre || '';
    }
    const fechaIso = fechaAIso(String(body.fecha || ''));
    const horaIni = body.hora_inicio != null ? String(body.hora_inicio) : '22:00';
    const esFestivo = await esFechaFestiva(fechaIso);
    let tarifas = tarifasMatrizVacia();
    if (body.id_artista) {
      const ar = await docClient.send(
        new GetCommand({ TableName: tables.artistas, Key: { id_artista: body.id_artista } })
      );
      if (ar.Item?.tarifas != null) tarifas = ar.Item.tarifas;
    }
    const prop = calcularPropuestaImporte(fechaIso, horaIni, tarifas, esFestivo);
    const importePrev =
      body.importe_previsto != null && body.importe_previsto !== ''
        ? Number(body.importe_previsto)
        : prop.importe_previsto != null
          ? prop.importe_previsto
          : null;
    const importeFinal =
      body.importe_final != null && body.importe_final !== '' ? Number(body.importe_final) : importePrev;

    const item = {
      id_actuacion,
      id_artista: String(body.id_artista ?? ''),
      artista_nombre_snapshot: artistaNombre,
      fecha: fechaIso,
      hora_inicio: horaIni,
      hora_fin: body.hora_fin != null ? String(body.hora_fin) : '',
      franja: body.franja != null ? String(body.franja) : prop.franja,
      tipo_dia: body.tipo_dia != null ? String(body.tipo_dia) : prop.tipo_dia,
      id_local: body.id_local != null ? formatId6(body.id_local) : '',
      local_nombre_snapshot: localNombre,
      importe_previsto: importePrev,
      importe_final: importeFinal,
      estado: body.estado != null ? String(body.estado) : 'pendiente',
      firma_artista_key: body.firma_artista_key != null ? String(body.firma_artista_key) : '',
      fecha_firma: body.fecha_firma != null ? String(body.fecha_firma) : '',
      observaciones: body.observaciones != null ? String(body.observaciones) : '',
      id_factura_gasto: body.id_factura_gasto != null ? String(body.id_factura_gasto) : '',
      pago_asociado_numero_factura: body.pago_asociado_numero_factura != null ? String(body.pago_asociado_numero_factura) : '',
      pago_asociado_proveedor: body.pago_asociado_proveedor != null ? String(body.pago_asociado_proveedor) : '',
      pago_asociado_fecha: body.pago_asociado_fecha != null ? String(body.pago_asociado_fecha) : '',
      pago_asociado_importe: body.pago_asociado_importe != null ? Number(body.pago_asociado_importe) : null,
      pago_asociado_estado: body.pago_asociado_estado != null ? String(body.pago_asociado_estado) : '',
      fecha_asociacion_pago: body.fecha_asociacion_pago != null ? String(body.fecha_asociacion_pago) : '',
      usuario_asociacion_pago: body.usuario_asociacion_pago != null ? String(body.usuario_asociacion_pago) : '',
      created_at: ts,
      updated_at: ts,
    };
    if (String(item.id_artista || '') && !body.forzar_conflicto) {
      const otro = await findConflictoArtistaExcluyendo({
        id_excluir: null,
        id_artista: item.id_artista,
        fecha: item.fecha,
        hora_inicio: item.hora_inicio,
      });
      if (otro) {
        return res.status(409).json({ conflicto: true, otro: actuacionResumenConflicto(otro) });
      }
    }
    await docClient.send(new PutCommand({ TableName: tables.actuaciones, Item: item }));
    res.json({ ok: true, actuacion: item });
  } catch (err) {
    console.error('[actuaciones POST]', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/actuaciones/item/:id', async (req, res) => {
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.actuaciones, Key: { id_actuacion: req.params.id } })
    );
    if (!r.Item) return res.status(404).json({ error: 'Actuación no encontrada' });
    const prev = r.Item;
    const body = req.body || {};
    const keys = [
      'id_artista',
      'artista_nombre_snapshot',
      'fecha',
      'hora_inicio',
      'hora_fin',
      'franja',
      'tipo_dia',
      'id_local',
      'local_nombre_snapshot',
      'importe_previsto',
      'importe_final',
      'estado',
      'firma_artista_key',
      'fecha_firma',
      'observaciones',
      'id_factura_gasto',
      'pago_asociado_numero_factura',
      'pago_asociado_proveedor',
      'pago_asociado_fecha',
      'pago_asociado_importe',
      'pago_asociado_estado',
      'fecha_asociacion_pago',
      'usuario_asociacion_pago',
    ];
    const item = { ...prev, updated_at: now() };
    for (const k of keys) {
      if (body[k] !== undefined) {
        if (k === 'importe_previsto' || k === 'importe_final' || k === 'pago_asociado_importe') {
          item[k] = body[k] === null || body[k] === '' ? null : Number(body[k]);
        } else if (k === 'id_local') {
          item[k] = body[k] == null || body[k] === '' ? '' : formatId6(body[k]);
        } else {
          item[k] = body[k] == null ? '' : typeof body[k] === 'string' ? body[k] : String(body[k]);
        }
      }
    }
    if (body.fecha != null) item.fecha = fechaAIso(String(body.fecha));
    const idArtFinal = String(item.id_artista || '');
    const fechaFinal = String(item.fecha || '');
    const horaFinal = normalizarHoraActuacion(item.hora_inicio);
    if (idArtFinal && !body.forzar_conflicto) {
      const otro = await findConflictoArtistaExcluyendo({
        id_excluir: prev.id_actuacion,
        id_artista: idArtFinal,
        fecha: fechaFinal,
        hora_inicio: horaFinal,
      });
      if (otro) {
        return res.status(409).json({ conflicto: true, otro: actuacionResumenConflicto(otro) });
      }
    }
    await docClient.send(new PutCommand({ TableName: tables.actuaciones, Item: item }));
    res.json({ ok: true, actuacion: item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/actuaciones/item/:id', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({ TableName: tables.actuaciones, Key: { id_actuacion: req.params.id } }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/actuaciones/item/:id/firma', upload.single('file'), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'Falta archivo (field: file)' });
  const id = req.params.id;
  const ext = (req.file.originalname || 'firma.png').match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] || 'png';
  const key = `actuaciones/${id}/firma_${Date.now()}.${ext}`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'image/png',
      })
    );
    const r = await docClient.send(new GetCommand({ TableName: tables.actuaciones, Key: { id_actuacion: id } }));
    if (!r.Item) return res.status(404).json({ error: 'Actuación no encontrada' });
    const ts = now();
    const item = {
      ...r.Item,
      firma_artista_key: key,
      fecha_firma: ts,
      estado: 'firmada',
      updated_at: ts,
    };
    await docClient.send(new PutCommand({ TableName: tables.actuaciones, Item: item }));
    res.json({ ok: true, firma_artista_key: key, actuacion: item });
  } catch (err) {
    console.error('[firma]', err);
    res.status(500).json({ error: err.message || 'Error al guardar firma' });
  }
});

export default router;
