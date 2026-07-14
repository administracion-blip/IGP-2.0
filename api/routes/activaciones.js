/**
 * Activaciones de Marcas: campañas de activación (ruletas, degustaciones…)
 * pactadas con marcas de bebidas y sus sesiones programadas por local.
 *
 * Tablas:
 *  - Igp_Activaciones (PK = id_activacion): ficha maestra de la campaña.
 *  - Igp_ActivacionSesiones (PK = id_sesion): sesiones por local/jornada.
 *      GSI local-fecha-index (id_local, fecha) → planning diario.
 *      GSI activacion-index (id_activacion) → detalle y cascada.
 *
 * Permisos: `activaciones.ver` (bar: consultar, marcar realizada/cancelada,
 * incidencias) y `activaciones.gestionar` (administración: CRUD completo).
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ScanCommand,
  QueryCommand,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  BatchGetCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { usuarioPuedeAccederLocal, jornadaNegocioHoyIso, formatId6 } from '../lib/usuarioLocales.js';

const router = Router();
const tableActivaciones = tables.activaciones;
const tableSesiones = tables.activacionSesiones;

const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const ESTADOS_FICHA = ['borrador', 'activa', 'archivada'];
const ESTADOS_SESION = ['programada', 'realizada', 'cancelada'];

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;

async function scanAll(params) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({ ...params, ...(lastKey && { ExclusiveStartKey: lastKey }) })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function queryAll(params) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({ ...params, ...(lastKey && { ExclusiveStartKey: lastKey }) })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function getFicha(idActivacion) {
  const r = await docClient.send(
    new GetCommand({ TableName: tableActivaciones, Key: { id_activacion: String(idActivacion) } })
  );
  return r.Item || null;
}

function sesionesDeActivacion(idActivacion) {
  return queryAll({
    TableName: tableSesiones,
    IndexName: 'activacion-index',
    KeyConditionExpression: 'id_activacion = :id',
    ExpressionAttributeValues: { ':id': String(idActivacion) },
  });
}

/** Campos editables de la ficha (todo lo demás se ignora en POST/PATCH). */
const CAMPOS_FICHA = [
  'codigo', 'marca', 'producto', 'productos_ids', 'tipo_activacion',
  'vigencia_inicio', 'vigencia_fin', 'duracion_horas',
  'ocasion', 'target_descripcion', 'mecanica', 'equipo_descripcion',
  'materiales', 'pago_observaciones',
  'id_empresa', 'empresa_nombre', 'empresa_cif',
  'promotor_nombre', 'promotor_telefono', 'estado',
];

function sanitizarFicha(body) {
  const out = {};
  for (const k of CAMPOS_FICHA) {
    if (body[k] === undefined) continue;
    if (k === 'duracion_horas') {
      const n = Number(body[k]);
      out[k] = Number.isFinite(n) && n >= 0 ? n : 0;
    } else if (k === 'materiales' || k === 'productos_ids') {
      out[k] = Array.isArray(body[k]) ? body[k].map((m) => String(m)).filter(Boolean) : [];
    } else {
      out[k] = String(body[k] ?? '').trim();
    }
  }
  return out;
}

/** Datetime de fin de la sesión (Date); si hora_fin < hora_inicio cruza medianoche. */
function datetimeFinSesion(sesion) {
  const { fecha, hora_inicio: hi, hora_fin: hf } = sesion;
  if (!RE_FECHA.test(fecha || '') || !RE_HORA.test(hf || '')) return null;
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hf.split(':').map(Number);
  const fin = new Date(y, m - 1, d, hh, mm);
  if (RE_HORA.test(hi || '') && hf < hi) fin.setDate(fin.getDate() + 1);
  return fin;
}

/**
 * Auto-marca como "realizada" las sesiones programadas cuya hora de fin ya
 * pasó. Silencioso: un fallo de update no rompe la respuesta. La condición
 * evita pisar una cancelación concurrente.
 */
async function autoMarcarRealizadas(sesiones) {
  const vencidas = sesiones.filter((s) => {
    if (s.estado_sesion !== 'programada') return false;
    const fin = datetimeFinSesion(s);
    return fin != null && fin.getTime() < Date.now();
  });
  if (vencidas.length === 0) return;
  await Promise.allSettled(
    vencidas.map((s) =>
      docClient.send(new UpdateCommand({
        TableName: tableSesiones,
        Key: { id_sesion: s.id_sesion },
        UpdateExpression: 'SET estado_sesion = :r',
        ConditionExpression: 'estado_sesion = :p',
        ExpressionAttributeValues: { ':r': 'realizada', ':p': 'programada' },
      })).then(() => { s.estado_sesion = 'realizada'; })
    )
  );
}

async function enriquecerSesionesConFicha(sesiones) {
  const ids = [...new Set(sesiones.map((s) => s.id_activacion).filter(Boolean))];
  const fichas = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await docClient.send(new BatchGetCommand({
      RequestItems: {
        [tableActivaciones]: { Keys: chunk.map((id) => ({ id_activacion: id })) },
      },
    }));
    for (const item of r.Responses?.[tableActivaciones] || []) {
      fichas.set(item.id_activacion, item);
    }
  }
  return sesiones.map((s) => {
    const f = fichas.get(s.id_activacion) || {};
    return {
      ...s,
      codigo: f.codigo ?? '',
      marca: f.marca ?? '',
      producto: f.producto ?? '',
      tipo_activacion: f.tipo_activacion ?? '',
      mecanica: f.mecanica ?? '',
      duracion_horas: f.duracion_horas ?? 0,
      equipo_descripcion: f.equipo_descripcion ?? '',
      materiales: Array.isArray(f.materiales) ? f.materiales : [],
      pago_observaciones: f.pago_observaciones ?? '',
    };
  });
}

/** Actualiza vigencia de la ficha si aún no está definida (primera sesión). */
async function sincronizarVigenciaDesdeSesiones(idActivacion, ficha, fechasSesion) {
  if (!fechasSesion.length) return ficha;
  const sorted = [...fechasSesion].sort();
  const ini = sorted[0];
  const fin = sorted[sorted.length - 1];
  const patch = {};
  if (!ficha.vigencia_inicio) patch.vigencia_inicio = ini;
  if (!ficha.vigencia_fin) patch.vigencia_fin = fin;
  if (Object.keys(patch).length === 0) return ficha;
  const item = {
    ...ficha,
    ...patch,
    id_activacion: idActivacion,
    actualizado_en: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: tableActivaciones, Item: item }));
  return item;
}

// ──────────────────────────────────────────
// Sesiones (rutas específicas ANTES que /activaciones/:id_activacion)
// ──────────────────────────────────────────

/** Contador de sesiones programadas para la jornada (badge Planning). */
router.get('/activaciones/sesiones/pendientes-dia', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const fecha = RE_FECHA.test(String(req.query.fecha || '')) ? String(req.query.fecha) : jornadaNegocioHoyIso();
    const sesiones = await scanAll({
      TableName: tableSesiones,
      FilterExpression: 'fecha = :f AND estado_sesion = :p',
      ExpressionAttributeValues: { ':f': fecha, ':p': 'programada' },
    });
    let total = 0;
    for (const s of sesiones) {
      if (await usuarioPuedeAccederLocal(req.user, s.id_local)) total += 1;
    }
    return res.json({ total, fecha });
  } catch (err) {
    console.error('[activaciones pendientes-dia GET]', err.message || err);
    return res.status(500).json({ error: 'Error al contar activaciones del día' });
  }
});

/** Sesiones en un rango de fechas (calendario semanal). */
router.get('/activaciones/sesiones/rango', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const desde = String(req.query.desde || req.query.fechaDesde || '').trim();
    const hasta = String(req.query.hasta || req.query.fechaHasta || '').trim();
    if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) {
      return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
    }
    if (desde > hasta) return res.status(400).json({ error: 'desde no puede ser posterior a hasta' });

    const sesiones = await scanAll({
      TableName: tableSesiones,
      FilterExpression: 'fecha BETWEEN :d AND :h',
      ExpressionAttributeValues: { ':d': desde, ':h': hasta },
    });

    const filtradas = [];
    for (const s of sesiones) {
      if (await usuarioPuedeAccederLocal(req.user, s.id_local)) filtradas.push(s);
    }
    filtradas.sort((a, b) =>
      `${a.fecha}#${a.hora_inicio}`.localeCompare(`${b.fecha}#${b.hora_inicio}`),
    );
    const enriquecidas = await enriquecerSesionesConFicha(filtradas);
    const programadas = enriquecidas.filter((s) => s.estado_sesion === 'programada').length;
    return res.json({ sesiones: enriquecidas, desde, hasta, programadas });
  } catch (err) {
    console.error('[activaciones sesiones/rango GET]', err.message || err);
    return res.status(500).json({ error: 'Error al cargar sesiones del rango' });
  }
});

/** Sesiones de un local en una jornada, enriquecidas con la ficha. */
router.get('/activaciones/sesiones/dia', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const idLocal = formatId6(String(req.query.id_local ?? req.query.localId ?? '').trim());
    if (!idLocal || idLocal === '000000') {
      return res.status(400).json({ error: 'id_local es obligatorio' });
    }
    const fecha = RE_FECHA.test(String(req.query.fecha || '')) ? String(req.query.fecha) : jornadaNegocioHoyIso();

    if (!(await usuarioPuedeAccederLocal(req.user, idLocal))) {
      return res.status(403).json({ error: 'No tienes acceso a este local' });
    }

    const sesiones = await queryAll({
      TableName: tableSesiones,
      IndexName: 'local-fecha-index',
      KeyConditionExpression: 'id_local = :l AND fecha = :f',
      ExpressionAttributeValues: { ':l': idLocal, ':f': fecha },
    });

    await autoMarcarRealizadas(sesiones);

    const enriquecidas = await enriquecerSesionesConFicha(sesiones);
    enriquecidas.sort((a, b) => String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || '')));

    return res.json({ sesiones: enriquecidas, fecha });
  } catch (err) {
    console.error('[activaciones sesiones/dia GET]', err.message || err);
    return res.status(500).json({ error: 'Error al cargar las activaciones del día' });
  }
});

/** Actualiza una sesión (estado/incidencia con `ver`; fecha/hora con `gestionar`). */
router.patch('/activaciones/sesiones/:id_sesion', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const idSesion = String(req.params.id_sesion);
    const body = req.body || {};

    const existente = await docClient.send(
      new GetCommand({ TableName: tableSesiones, Key: { id_sesion: idSesion } })
    );
    if (!existente.Item) return res.status(404).json({ error: 'Sesión no encontrada' });

    const cambiaHorario = body.fecha !== undefined || body.hora_inicio !== undefined || body.hora_fin !== undefined;
    if (cambiaHorario && !(await hasPermission(req.user, 'activaciones.gestionar'))) {
      return res.status(403).json({ error: 'Permiso insuficiente para cambiar fecha u horario' });
    }
    if (!cambiaHorario && !(await usuarioPuedeAccederLocal(req.user, existente.Item.id_local))) {
      return res.status(403).json({ error: 'No tienes acceso a este local' });
    }

    const sets = [];
    const values = {};
    const names = {};

    if (body.estado_sesion !== undefined) {
      const e = String(body.estado_sesion).toLowerCase();
      if (!ESTADOS_SESION.includes(e)) {
        return res.status(400).json({ error: `estado_sesion inválido (${ESTADOS_SESION.join(' | ')})` });
      }
      sets.push('#es = :es'); names['#es'] = 'estado_sesion'; values[':es'] = e;
    }
    if (body.incidencia !== undefined) {
      sets.push('incidencia = :inc'); values[':inc'] = String(body.incidencia ?? '').trim();
    }
    if (body.fecha !== undefined) {
      if (!RE_FECHA.test(String(body.fecha))) return res.status(400).json({ error: 'fecha debe ser YYYY-MM-DD' });
      sets.push('fecha = :f'); values[':f'] = String(body.fecha);
    }
    if (body.hora_inicio !== undefined) {
      if (!RE_HORA.test(String(body.hora_inicio))) return res.status(400).json({ error: 'hora_inicio debe ser HH:mm' });
      sets.push('hora_inicio = :hi'); values[':hi'] = String(body.hora_inicio);
    }
    if (body.hora_fin !== undefined) {
      if (!RE_HORA.test(String(body.hora_fin))) return res.status(400).json({ error: 'hora_fin debe ser HH:mm' });
      sets.push('hora_fin = :hf'); values[':hf'] = String(body.hora_fin);
    }
    if (body.id_local !== undefined) {
      if (!(await hasPermission(req.user, 'activaciones.gestionar'))) {
        return res.status(403).json({ error: 'Permiso insuficiente para cambiar el local' });
      }
      const idLocal = formatId6(String(body.id_local).trim());
      if (!idLocal || idLocal === '000000') return res.status(400).json({ error: 'id_local inválido' });
      const loc = await docClient.send(
        new GetCommand({ TableName: tables.locales, Key: { id_Locales: idLocal } }),
      );
      sets.push('id_local = :il'); values[':il'] = idLocal;
      sets.push('local_nombre = :ln');
      values[':ln'] = String(loc.Item?.nombre ?? loc.Item?.Nombre ?? '');
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    const r = await docClient.send(new UpdateCommand({
      TableName: tableSesiones,
      Key: { id_sesion: idSesion },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.json({ ok: true, sesion: r.Attributes });
  } catch (err) {
    console.error('[activaciones sesiones PATCH]', err.message || err);
    return res.status(500).json({ error: 'Error al actualizar la sesión' });
  }
});

router.delete('/activaciones/sesiones/:id_sesion', requirePermission('activaciones.gestionar'), async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableSesiones,
      Key: { id_sesion: String(req.params.id_sesion) },
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[activaciones sesiones DELETE]', err.message || err);
    return res.status(500).json({ error: 'Error al eliminar la sesión' });
  }
});

// ──────────────────────────────────────────
// Ficha maestra
// ──────────────────────────────────────────

router.get('/activaciones', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const estado = String(req.query.estado || '').toLowerCase();
    let items = await scanAll({ TableName: tableActivaciones });
    if (ESTADOS_FICHA.includes(estado)) {
      items = items.filter((a) => (a.estado || 'borrador') === estado);
    }

    // Contador de sesiones programadas por activación para la lista.
    const contador = new Map();
    const sesiones = await scanAll({
      TableName: tableSesiones,
      ProjectionExpression: 'id_activacion, estado_sesion',
    });
    for (const s of sesiones) {
      if (s.estado_sesion === 'programada') {
        contador.set(s.id_activacion, (contador.get(s.id_activacion) || 0) + 1);
      }
    }
    items = items.map((a) => ({ ...a, sesiones_programadas: contador.get(a.id_activacion) || 0 }));
    items.sort((a, b) => String(b.creado_en || '').localeCompare(String(a.creado_en || '')));
    return res.json({ activaciones: items });
  } catch (err) {
    console.error('[activaciones GET]', err.message || err);
    return res.status(500).json({ error: 'Error al listar activaciones' });
  }
});

router.post('/activaciones', requirePermission('activaciones.gestionar'), async (req, res) => {
  try {
    const datos = sanitizarFicha(req.body || {});
    if (!datos.codigo) return res.status(400).json({ error: 'El código es obligatorio' });
    if (!datos.marca) return res.status(400).json({ error: 'La marca es obligatoria' });
    if (!datos.producto) return res.status(400).json({ error: 'El producto es obligatorio' });
    const estado = ESTADOS_FICHA.includes(datos.estado) ? datos.estado : 'borrador';

    const ts = new Date().toISOString();
    const item = {
      ...datos,
      id_activacion: crypto.randomUUID(),
      estado,
      creado_por: req.user?.email || req.user?.sub || '',
      creado_en: ts,
      actualizado_en: ts,
    };
    await docClient.send(new PutCommand({ TableName: tableActivaciones, Item: item }));
    return res.status(201).json({ ok: true, activacion: item });
  } catch (err) {
    console.error('[activaciones POST]', err.message || err);
    return res.status(500).json({ error: 'Error al crear la activación' });
  }
});

router.get('/activaciones/:id_activacion', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const ficha = await getFicha(req.params.id_activacion);
    if (!ficha) return res.status(404).json({ error: 'Activación no encontrada' });
    return res.json({ activacion: ficha });
  } catch (err) {
    console.error('[activaciones GET :id]', err.message || err);
    return res.status(500).json({ error: 'Error al cargar la activación' });
  }
});

router.patch('/activaciones/:id_activacion', requirePermission('activaciones.gestionar'), async (req, res) => {
  try {
    const idActivacion = String(req.params.id_activacion);
    const ficha = await getFicha(idActivacion);
    if (!ficha) return res.status(404).json({ error: 'Activación no encontrada' });

    const datos = sanitizarFicha(req.body || {});
    if (datos.estado !== undefined && !ESTADOS_FICHA.includes(datos.estado)) {
      return res.status(400).json({ error: `estado inválido (${ESTADOS_FICHA.join(' | ')})` });
    }
    const item = { ...ficha, ...datos, id_activacion: idActivacion, actualizado_en: new Date().toISOString() };
    await docClient.send(new PutCommand({ TableName: tableActivaciones, Item: item }));
    return res.json({ ok: true, activacion: item });
  } catch (err) {
    console.error('[activaciones PATCH]', err.message || err);
    return res.status(500).json({ error: 'Error al actualizar la activación' });
  }
});

/** Elimina la ficha y todas sus sesiones (cascada vía GSI activacion-index). */
router.delete('/activaciones/:id_activacion', requirePermission('activaciones.gestionar'), async (req, res) => {
  try {
    const idActivacion = String(req.params.id_activacion);
    const sesiones = await sesionesDeActivacion(idActivacion);
    for (let i = 0; i < sesiones.length; i += 25) {
      const chunk = sesiones.slice(i, i + 25);
      let req25 = {
        RequestItems: {
          [tableSesiones]: chunk.map((s) => ({ DeleteRequest: { Key: { id_sesion: s.id_sesion } } })),
        },
      };
      for (let intento = 0; intento < 5 && req25; intento += 1) {
        const r = await docClient.send(new BatchWriteCommand(req25));
        const unprocessed = r.UnprocessedItems?.[tableSesiones];
        req25 = unprocessed?.length ? { RequestItems: { [tableSesiones]: unprocessed } } : null;
      }
    }
    await docClient.send(new DeleteCommand({
      TableName: tableActivaciones,
      Key: { id_activacion: idActivacion },
    }));
    return res.json({ ok: true, sesionesEliminadas: sesiones.length });
  } catch (err) {
    console.error('[activaciones DELETE]', err.message || err);
    return res.status(500).json({ error: 'Error al eliminar la activación' });
  }
});

// ──────────────────────────────────────────
// Sesiones de una activación
// ──────────────────────────────────────────

router.get('/activaciones/:id_activacion/sesiones', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const sesiones = await sesionesDeActivacion(req.params.id_activacion);
    sesiones.sort((a, b) =>
      `${a.fecha || ''}#${a.hora_inicio || ''}`.localeCompare(`${b.fecha || ''}#${b.hora_inicio || ''}`)
    );
    return res.json({ sesiones });
  } catch (err) {
    console.error('[activaciones sesiones GET]', err.message || err);
    return res.status(500).json({ error: 'Error al listar las sesiones' });
  }
});

/**
 * Crea una o varias sesiones. Body: objeto { id_local, fecha, hora_inicio,
 * hora_fin? } o array de ellos. Si falta hora_fin se calcula con
 * duracion_horas de la ficha.
 */
router.post('/activaciones/:id_activacion/sesiones', requirePermission('activaciones.gestionar'), async (req, res) => {
  try {
    const idActivacion = String(req.params.id_activacion);
    const ficha = await getFicha(idActivacion);
    if (!ficha) return res.status(404).json({ error: 'Activación no encontrada' });

    const entradas = Array.isArray(req.body) ? req.body : [req.body || {}];
    if (entradas.length === 0) return res.status(400).json({ error: 'Indica al menos una sesión' });
    if (entradas.length > 200) return res.status(400).json({ error: 'Máximo 200 sesiones por petición' });

    const nombresLocales = new Map();
    const ts = new Date().toISOString();
    const items = [];

    for (const e of entradas) {
      const idLocal = formatId6(String(e.id_local ?? e.localId ?? '').trim());
      const fecha = String(e.fecha || '').trim();
      const horaInicio = String(e.hora_inicio || '').trim();
      let horaFin = String(e.hora_fin || '').trim();

      if (!idLocal || idLocal === '000000') return res.status(400).json({ error: 'id_local es obligatorio en cada sesión' });
      if (!RE_FECHA.test(fecha)) return res.status(400).json({ error: 'fecha debe ser YYYY-MM-DD' });
      if (!RE_HORA.test(horaInicio)) return res.status(400).json({ error: 'hora_inicio debe ser HH:mm' });

      if (!horaFin) {
        const dur = Number(ficha.duracion_horas) || 0;
        const [hh, mm] = horaInicio.split(':').map(Number);
        const totalMin = (hh * 60 + mm + Math.round(dur * 60)) % (24 * 60);
        horaFin = `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
      }
      if (!RE_HORA.test(horaFin)) return res.status(400).json({ error: 'hora_fin debe ser HH:mm' });

      if (ficha.vigencia_inicio && fecha < ficha.vigencia_inicio) {
        return res.status(400).json({ error: `La fecha ${fecha} es anterior al inicio de vigencia (${ficha.vigencia_inicio})` });
      }
      if (ficha.vigencia_fin && fecha > ficha.vigencia_fin) {
        return res.status(400).json({ error: `La fecha ${fecha} es posterior al fin de vigencia (${ficha.vigencia_fin})` });
      }

      if (!nombresLocales.has(idLocal)) {
        const loc = await docClient.send(
          new GetCommand({ TableName: tables.locales, Key: { id_Locales: idLocal } })
        );
        nombresLocales.set(idLocal, String(loc.Item?.nombre ?? loc.Item?.Nombre ?? ''));
      }

      items.push({
        id_sesion: crypto.randomUUID(),
        id_activacion: idActivacion,
        id_local: idLocal,
        local_nombre: nombresLocales.get(idLocal),
        fecha,
        hora_inicio: horaInicio,
        hora_fin: horaFin,
        estado_sesion: 'programada',
        incidencia: '',
        creado_por: req.user?.email || req.user?.sub || '',
        creado_en: ts,
      });
    }

    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      let req25 = {
        RequestItems: { [tableSesiones]: chunk.map((Item) => ({ PutRequest: { Item } })) },
      };
      for (let intento = 0; intento < 5 && req25; intento += 1) {
        const r = await docClient.send(new BatchWriteCommand(req25));
        const unprocessed = r.UnprocessedItems?.[tableSesiones];
        req25 = unprocessed?.length ? { RequestItems: { [tableSesiones]: unprocessed } } : null;
      }
    }

    await sincronizarVigenciaDesdeSesiones(idActivacion, ficha, items.map((i) => i.fecha));

    return res.status(201).json({ ok: true, sesiones: items });
  } catch (err) {
    console.error('[activaciones sesiones POST]', err.message || err);
    return res.status(500).json({ error: 'Error al crear las sesiones' });
  }
});

// ─── Adjuntos ficha maestra (S3) ───

router.post('/activaciones/:id_activacion/adjuntos', requirePermission('activaciones.gestionar'), upload.single('file'), async (req, res) => {
  const idActivacion = String(req.params.id_activacion);
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const existing = await getFicha(idActivacion);
    if (!existing) return res.status(404).json({ error: 'Activación no encontrada' });

    const ext = (req.file.originalname || 'file').split('.').pop();
    const fileKey = `activaciones/${idActivacion}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const adjuntos = Array.isArray(existing.adjuntos) ? [...existing.adjuntos] : [];
    adjuntos.push({
      id: crypto.randomUUID(),
      fileKey,
      nombre: req.file.originalname,
      tipo: req.file.mimetype,
      size: req.file.size,
      subido_en: new Date().toISOString(),
      subido_por: req.body?.usuario_nombre || req.user?.email || '',
    });

    await docClient.send(new UpdateCommand({
      TableName: tableActivaciones,
      Key: { id_activacion: idActivacion },
      UpdateExpression: 'SET adjuntos = :adj, actualizado_en = :ts',
      ExpressionAttributeValues: { ':adj': adjuntos, ':ts': new Date().toISOString() },
    }));

    return res.json({ ok: true, adjuntos });
  } catch (err) {
    console.error('[activaciones adjuntos POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al subir adjunto' });
  }
});

router.get('/activaciones/:id_activacion/adjuntos', requirePermission('activaciones.ver'), async (req, res) => {
  try {
    const existing = await getFicha(req.params.id_activacion);
    if (!existing) return res.status(404).json({ error: 'Activación no encontrada' });

    const adjuntos = Array.isArray(existing.adjuntos) ? existing.adjuntos : [];
    const withUrls = await Promise.all(
      adjuntos.map(async (a) => {
        const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: a.fileKey });
        const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
        return { ...a, url };
      }),
    );
    return res.json({ adjuntos: withUrls });
  } catch (err) {
    console.error('[activaciones adjuntos GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar adjuntos' });
  }
});

router.delete('/activaciones/:id_activacion/adjuntos/:adjId', requirePermission('activaciones.gestionar'), async (req, res) => {
  try {
    const idActivacion = String(req.params.id_activacion);
    const adjId = String(req.params.adjId);
    const existing = await getFicha(idActivacion);
    if (!existing) return res.status(404).json({ error: 'Activación no encontrada' });

    const adjuntos = Array.isArray(existing.adjuntos) ? existing.adjuntos : [];
    const adj = adjuntos.find((a) => a.id === adjId);
    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: adj.fileKey }));
    } catch (e) {
      console.warn('[activaciones adjuntos DELETE S3]', e.message || e);
    }

    const nuevos = adjuntos.filter((a) => a.id !== adjId);
    await docClient.send(new UpdateCommand({
      TableName: tableActivaciones,
      Key: { id_activacion: idActivacion },
      UpdateExpression: 'SET adjuntos = :adj, actualizado_en = :ts',
      ExpressionAttributeValues: { ':adj': nuevos, ':ts': new Date().toISOString() },
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[activaciones adjuntos DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar adjunto' });
  }
});

export default router;
