/**
 * Submódulo Limpieza (dentro de Mantenimiento). Operativo y recurrente:
 * catálogo de objetos a limpiar, programación por frecuencia, registros
 * diarios por local con evidencia (foto + empleado que la realiza) para APPCC.
 *
 * Tablas (ver api/lib/db.js):
 *  - Igp_LimpiezaTipos (PK="TIPO", SK=id_tipo): catálogo global "cómo se limpia".
 *  - Igp_LimpiezaProgramacion (PK=LOCAL#<id>, SK=REGLA#<uuid>|PLANTILLA#<uuid>).
 *      GSI Tipo-Local-index (tipo, local_id) → generador de registros.
 *  - Igp_LimpiezaRegistros (PK=LOCAL#<id>, SK=FECHA#<YYYY-MM-DD>#<tipo_objeto_id>).
 *      GSI Fecha-Local-index (fecha_programada, local_id) → planning / informes.
 *  - Igp_LimpiezaIncidencias (PK=LOCAL#<id>, SK=INC#<ISO>#<uuid>).
 *
 * Datos SEPARADOS del mantenimiento correctivo (nunca se mezclan en listas).
 * Permisos: limpieza.ver, limpieza.completar, limpieza.programar,
 * limpieza.catalogo, limpieza.informes, limpieza.borrar.
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
  QueryCommand,
  ScanCommand,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { usuarioPuedeAccederLocal, jornadaNegocioHoyIso, formatId6 } from '../lib/usuarioLocales.js';

const router = Router();
const tTipos = tables.limpiezaTipos;
const tProg = tables.limpiezaProgramacion;
const tReg = tables.limpiezaRegistros;

const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const FRECUENCIAS = ['diaria', 'cada_n_dias', 'semanal', 'mensual', 'trimestral', 'anual', 'personalizada'];
const ESTADOS_REGISTRO = ['pendiente', 'hecha', 'retrasada', 'reprogramada'];
const MAX_GEN_DIAS = 366;
/** Frecuencias "periódicas" → nº de meses de salto por periodo. */
const PERIODICAS = { mensual: 1, trimestral: 3, anual: 12 };
/** Cuántos días atrás miramos para arrastrar limpiezas pendientes al checklist. */
const VENTANA_ATRASADAS_DIAS = 120;

// ─────────────────────────── helpers ───────────────────────────

async function queryAll(params) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({ ...params, ...(lastKey && { ExclusiveStartKey: lastKey }) }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function scanAll(params) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({ ...params, ...(lastKey && { ExclusiveStartKey: lastKey }) }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/** Si la tabla no existe, error 404 legible para el operador. */
function throwSiTablaFalta(err, tableName) {
  const msg = err?.message || String(err);
  if (
    err?.name === 'ResourceNotFoundException' ||
    /Requested resource not found|ResourceNotFoundException/.test(msg)
  ) {
    const e = new Error(`La tabla ${tableName} no existe en DynamoDB. Créala con PK (String) y SK (String).`);
    e.status = 404;
    e.code = 'TABLE_NOT_FOUND';
    throw e;
  }
  throw err;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Genera las fechas ISO de una regla dentro de [desde, hasta].
 * Espeja las frecuencias de la pantalla de recurrentes de mantenimiento.
 */
function generarFechasRegla(regla, desde, hasta) {
  if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) return [];
  const start = new Date(`${desde}T00:00:00`);
  const end = new Date(`${hasta}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  const frecuencia = String(regla.frecuencia || 'diaria');
  const fechas = [];
  let cur = new Date(start);

  if (frecuencia === 'personalizada' || frecuencia === 'semanal') {
    const dias = Array.isArray(regla.dias_semana) ? regla.dias_semana : [];
    while (cur <= end && fechas.length < MAX_GEN_DIAS) {
      const dow = cur.getDay();
      const idx = dow === 0 ? 6 : dow - 1; // Lun=0 … Dom=6
      if (dias[idx]) fechas.push(toISODate(cur));
      cur = addDays(cur, 1);
    }
    return fechas;
  }

  if (frecuencia === 'cada_n_dias') {
    const n = Math.max(1, Number(regla.cada_n_dias) || 1);
    while (cur <= end && fechas.length < MAX_GEN_DIAS) {
      fechas.push(toISODate(cur));
      cur = addDays(cur, n);
    }
    return fechas;
  }

  const step = { diaria: 1 }[frecuencia];
  if (step) {
    while (cur <= end && fechas.length < MAX_GEN_DIAS) {
      fechas.push(toISODate(cur));
      cur = addDays(cur, step);
    }
    return fechas;
  }

  // mensual | trimestral | anual: mismo día de mes que `desde`, saltando meses
  const meses = { mensual: 1, trimestral: 3, anual: 12 }[frecuencia];
  if (meses) {
    let d = new Date(start);
    while (d <= end && fechas.length < MAX_GEN_DIAS) {
      fechas.push(toISODate(d));
      d = new Date(d.getFullYear(), d.getMonth() + meses, d.getDate());
    }
    return fechas;
  }

  return fechas;
}

const skRegistro = (fecha, tipoObjetoId) => `FECHA#${fecha}#${tipoObjetoId}`;
const pkLocal = (localId) => `LOCAL#${localId}`;

/** Índice de día de semana con Lun=0 … Dom=6 (a partir de un Date). */
function idxDiaSemana(d) {
  const dow = d.getDay();
  return dow === 0 ? 6 : dow - 1;
}

/** ¿La regla es periódica (mensual/trimestral/anual) y tiene día(s) de semana marcados? */
function tieneDiasSemana(regla) {
  return Array.isArray(regla.dias_semana) && regla.dias_semana.some(Boolean);
}
function esPeriodicaPorDiaSemana(regla) {
  return Boolean(PERIODICAS[regla.frecuencia]) && tieneDiasSemana(regla);
}

/** Clave de periodo para agrupar fechas (mes / trimestre / año). */
function clavePeriodo(d, frecuencia) {
  const y = d.getFullYear();
  const m = d.getMonth();
  if (frecuencia === 'trimestral') return `${y}-Q${Math.floor(m / 3)}`;
  if (frecuencia === 'anual') return `${y}`;
  return `${y}-${m}`; // mensual
}

/**
 * Fechas candidatas (ISO) del/los día(s) de semana de la regla, agrupadas por
 * periodo, dentro de [desde, hasta]. Para elegir luego la de menor carga.
 */
function candidatasPorPeriodo(regla, desde, hasta) {
  const start = new Date(`${desde}T00:00:00`);
  const end = new Date(`${hasta}T23:59:59`);
  const dias = Array.isArray(regla.dias_semana) ? regla.dias_semana : [];
  const map = new Map();
  let cur = new Date(start);
  let guard = 0;
  while (cur <= end && guard < MAX_GEN_DIAS * 2) {
    guard += 1;
    if (dias[idxDiaSemana(cur)]) {
      const k = clavePeriodo(cur, regla.frecuencia);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(toISODate(cur));
    }
    cur = addDays(cur, 1);
  }
  return map;
}

/** Resta días a una fecha ISO (YYYY-MM-DD) y devuelve ISO. */
function fechaMenosDias(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - n);
  return toISODate(d);
}

/**
 * Mapea un registro a la forma que consume el frontend. Calcula el estado
 * efectivo: una tarea "pendiente" cuya fecha ya pasó (según jornada) se muestra
 * como "retrasada" y se arrastra a los días siguientes hasta completarse.
 */
function mapRegistro(item, hoyRef) {
  const hoy = hoyRef || jornadaNegocioHoyIso();
  let estado = item.estado;
  if (estado === 'pendiente' && String(item.fecha_programada) < hoy) estado = 'retrasada';
  return {
    id_registro: item.id_registro,
    local_id: item.local_id,
    tipo_objeto_id: item.tipo_objeto_id,
    fecha_programada: item.fecha_programada,
    estado,
    estado_base: item.estado,
    origen: item.origen ?? null,
    regla_id: item.regla_id ?? null,
    realizado_por_id: item.realizado_por_id ?? null,
    realizado_por_nombre: item.realizado_por_nombre ?? item.completado_por_nombre ?? null,
    registrado_por_usuario_nombre: item.registrado_por_usuario_nombre ?? null,
    completado_at: item.completado_at ?? null,
    tiene_foto: Array.isArray(item.foto_keys) && item.foto_keys.length > 0,
    creado_en: item.creado_en ?? null,
  };
}

async function getRegistro(localId, fecha, tipoObjetoId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tReg,
      Key: { PK: pkLocal(localId), SK: skRegistro(fecha, tipoObjetoId) },
    }),
  );
  return r.Item || null;
}

// ═══════════════════════════ CATÁLOGO DE TIPOS ═══════════════════════════

router.get('/limpieza/tipos', requireAnyPermission('limpieza.ver', 'limpieza.catalogo'), async (req, res) => {
  try {
    const items = await queryAll({
      TableName: tTipos,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TIPO' },
    });
    const soloActivos = String(req.query.solo_activos || '') === '1';
    const tipos = items
      .filter((t) => (soloActivos ? t.activo !== false : true))
      .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')));
    return res.json({ tipos });
  } catch (err) {
    try { throwSiTablaFalta(err, tTipos); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(500).json({ error: 'Error al listar tipos de limpieza' });
  }
});

router.post('/limpieza/tipos', requirePermission('limpieza.catalogo'), async (req, res) => {
  const body = req.body || {};
  const nombre = String(body.nombre ?? '').trim();
  if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });

  const now = new Date().toISOString();
  const item = {
    PK: 'TIPO',
    id_tipo: crypto.randomUUID(),
    nombre,
    descripcion_procedimiento: String(body.descripcion_procedimiento ?? '').trim(),
    productos_y_dosis: Array.isArray(body.productos_y_dosis)
      ? body.productos_y_dosis.map((p) => ({
          producto: String(p?.producto ?? '').trim(),
          dosis: String(p?.dosis ?? '').trim(),
          epi: String(p?.epi ?? '').trim(),
        })).filter((p) => p.producto)
      : [],
    requiere_vaciado_previo: Boolean(body.requiere_vaciado_previo),
    frecuencia_por_defecto: FRECUENCIAS.includes(body.frecuencia_por_defecto) ? body.frecuencia_por_defecto : 'diaria',
    activo: body.activo === undefined ? true : Boolean(body.activo),
    creado_en: now,
    actualizado_en: now,
  };
  try {
    await docClient.send(new PutCommand({ TableName: tTipos, Item: item }));
    return res.json({ ok: true, tipo: item });
  } catch (err) {
    try { throwSiTablaFalta(err, tTipos); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(500).json({ error: 'Error al crear el tipo' });
  }
});

router.patch('/limpieza/tipos/:id', requirePermission('limpieza.catalogo'), async (req, res) => {
  const id = String(req.params.id);
  const body = req.body || {};
  const now = new Date().toISOString();

  const sets = ['actualizado_en = :ts'];
  const values = { ':ts': now };
  const names = {};
  const campos = {
    nombre: (v) => String(v ?? '').trim(),
    descripcion_procedimiento: (v) => String(v ?? '').trim(),
    productos_y_dosis: (v) => (Array.isArray(v) ? v.map((p) => ({
      producto: String(p?.producto ?? '').trim(),
      dosis: String(p?.dosis ?? '').trim(),
      epi: String(p?.epi ?? '').trim(),
    })).filter((p) => p.producto) : []),
    requiere_vaciado_previo: (v) => Boolean(v),
    frecuencia_por_defecto: (v) => (FRECUENCIAS.includes(v) ? v : 'diaria'),
    activo: (v) => Boolean(v),
  };
  for (const [k, norm] of Object.entries(campos)) {
    if (body[k] === undefined) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = norm(body[k]);
    sets.push(`#${k} = :${k}`);
  }
  if (sets.length === 1) return res.status(400).json({ error: 'Sin cambios' });

  try {
    const out = await docClient.send(new UpdateCommand({
      TableName: tTipos,
      Key: { PK: 'TIPO', id_tipo: id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(id_tipo)',
      ReturnValues: 'ALL_NEW',
    }));
    return res.json({ ok: true, tipo: out.Attributes });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return res.status(404).json({ error: 'Tipo no encontrado' });
    return res.status(500).json({ error: 'Error al actualizar el tipo' });
  }
});

router.delete('/limpieza/tipos/:id', requirePermission('limpieza.catalogo'), async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({ TableName: tTipos, Key: { PK: 'TIPO', id_tipo: String(req.params.id) } }));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Error al borrar el tipo' });
  }
});

// ═══════════════════════════ PROGRAMACIÓN (REGLAS) ═══════════════════════════

router.get('/limpieza/reglas', requireAnyPermission('limpieza.ver', 'limpieza.programar'), async (req, res) => {
  const localId = formatId6(String(req.query.local_id ?? '').trim());
  if (!localId || localId === '000000') return res.status(400).json({ error: 'local_id es obligatorio' });
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    return res.status(403).json({ error: 'No tienes acceso a este local' });
  }
  try {
    const items = await queryAll({
      TableName: tProg,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pkLocal(localId), ':sk': 'REGLA#' },
    });
    items.sort((a, b) => String(a.creado_en || '').localeCompare(String(b.creado_en || '')));
    return res.json({ reglas: items });
  } catch (err) {
    try { throwSiTablaFalta(err, tProg); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(500).json({ error: 'Error al listar reglas' });
  }
});

router.post('/limpieza/reglas', requirePermission('limpieza.programar'), async (req, res) => {
  const body = req.body || {};
  const localId = formatId6(String(body.local_id ?? '').trim());
  const tipoObjetoId = String(body.tipo_objeto_id ?? '').trim();
  const frecuencia = String(body.frecuencia ?? '').trim();

  if (!localId || localId === '000000') return res.status(400).json({ error: 'local_id es obligatorio' });
  if (!tipoObjetoId) return res.status(400).json({ error: 'tipo_objeto_id es obligatorio' });
  if (!FRECUENCIAS.includes(frecuencia)) return res.status(400).json({ error: 'frecuencia no válida' });
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    return res.status(403).json({ error: 'No tienes acceso a este local' });
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const item = {
    PK: pkLocal(localId),
    SK: `REGLA#${id}`,
    tipo: 'REGLA',
    id_regla: id,
    local_id: localId,
    tipo_objeto_id: tipoObjetoId,
    frecuencia,
    cada_n_dias: frecuencia === 'cada_n_dias' ? Math.max(1, Number(body.cada_n_dias) || 1) : null,
    dias_semana: Array.isArray(body.dias_semana) ? body.dias_semana.map(Boolean).slice(0, 7) : [],
    rol_responsable: String(body.rol_responsable ?? '').trim() || null,
    activo: body.activo === undefined ? true : Boolean(body.activo),
    creado_en: now,
    actualizado_en: now,
  };
  try {
    await docClient.send(new PutCommand({ TableName: tProg, Item: item }));
    return res.json({ ok: true, regla: item });
  } catch (err) {
    try { throwSiTablaFalta(err, tProg); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(500).json({ error: 'Error al crear la regla' });
  }
});

router.patch('/limpieza/reglas/:localId/:id', requirePermission('limpieza.programar'), async (req, res) => {
  const localId = formatId6(String(req.params.localId).trim());
  const id = String(req.params.id);
  const body = req.body || {};
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    return res.status(403).json({ error: 'No tienes acceso a este local' });
  }
  if (body.frecuencia !== undefined && !FRECUENCIAS.includes(body.frecuencia)) {
    return res.status(400).json({ error: 'frecuencia no válida' });
  }

  const sets = ['actualizado_en = :ts'];
  const values = { ':ts': new Date().toISOString() };
  const names = {};
  const campos = {
    tipo_objeto_id: (v) => String(v ?? '').trim(),
    frecuencia: (v) => String(v),
    cada_n_dias: (v) => Math.max(1, Number(v) || 1),
    dias_semana: (v) => (Array.isArray(v) ? v.map(Boolean).slice(0, 7) : []),
    rol_responsable: (v) => (String(v ?? '').trim() || null),
    activo: (v) => Boolean(v),
  };
  for (const [k, norm] of Object.entries(campos)) {
    if (body[k] === undefined) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = norm(body[k]);
    sets.push(`#${k} = :${k}`);
  }
  if (sets.length === 1) return res.status(400).json({ error: 'Sin cambios' });

  try {
    const out = await docClient.send(new UpdateCommand({
      TableName: tProg,
      Key: { PK: pkLocal(localId), SK: `REGLA#${id}` },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(SK)',
      ReturnValues: 'ALL_NEW',
    }));
    return res.json({ ok: true, regla: out.Attributes });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return res.status(404).json({ error: 'Regla no encontrada' });
    return res.status(500).json({ error: 'Error al actualizar la regla' });
  }
});

router.delete('/limpieza/reglas/:localId/:id', requirePermission('limpieza.programar'), async (req, res) => {
  const localId = formatId6(String(req.params.localId).trim());
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    return res.status(403).json({ error: 'No tienes acceso a este local' });
  }
  try {
    await docClient.send(new DeleteCommand({ TableName: tProg, Key: { PK: pkLocal(localId), SK: `REGLA#${String(req.params.id)}` } }));
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Error al borrar la regla' });
  }
});

// ═══════════════════════════ GENERACIÓN DE REGISTROS ═══════════════════════════

/**
 * Materializa registros a partir de las reglas activas de un local en un rango.
 * Idempotente: la SK es determinista (FECHA#fecha#tipo) y se usa
 * ConditionExpression attribute_not_exists(SK) para no duplicar.
 */
router.post('/limpieza/registros/generar', requirePermission('limpieza.programar'), async (req, res) => {
  const body = req.body || {};
  const localId = formatId6(String(body.local_id ?? '').trim());
  const desde = String(body.desde ?? '').trim();
  const hasta = String(body.hasta ?? '').trim();

  if (!localId || localId === '000000') return res.status(400).json({ error: 'local_id es obligatorio' });
  if (!RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
  if (desde > hasta) return res.status(400).json({ error: 'desde no puede ser posterior a hasta' });
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    return res.status(403).json({ error: 'No tienes acceso a este local' });
  }

  try {
    const reglas = (await queryAll({
      TableName: tProg,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pkLocal(localId), ':sk': 'REGLA#' },
    })).filter((r) => r.activo !== false);

    // Registros ya existentes del local en el rango: para reparto de carga
    // (elegir el día con menos limpiezas) y para "sticky" (no recolocar un
    // periodo que ya tiene registro de esa regla).
    const existentesRango = await queryAll({
      TableName: tReg,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
      ExpressionAttributeValues: { ':pk': pkLocal(localId), ':lo': `FECHA#${desde}`, ':hi': `FECHA#${hasta}#\uffff` },
    });
    const cargaPorFecha = new Map();
    for (const it of existentesRango) {
      const f = String(it.fecha_programada || '');
      if (f) cargaPorFecha.set(f, (cargaPorFecha.get(f) || 0) + 1);
    }

    const now = new Date().toISOString();
    let creados = 0;
    let existentes = 0;

    const crearRegistro = async (regla, fecha) => {
      const item = {
        PK: pkLocal(localId),
        SK: skRegistro(fecha, regla.tipo_objeto_id),
        id_registro: crypto.randomUUID(),
        local_id: localId,
        tipo_objeto_id: regla.tipo_objeto_id,
        fecha_programada: fecha,
        rol_responsable: regla.rol_responsable ?? null,
        estado: 'pendiente',
        origen: 'frecuencia',
        regla_id: regla.id_regla,
        creado_en: now,
        actualizado_en: now,
      };
      try {
        await docClient.send(new PutCommand({
          TableName: tReg,
          Item: item,
          ConditionExpression: 'attribute_not_exists(SK)',
        }));
        creados += 1;
        cargaPorFecha.set(fecha, (cargaPorFecha.get(fecha) || 0) + 1);
      } catch (e) {
        if (e?.name === 'ConditionalCheckFailedException') existentes += 1;
        else throw e;
      }
    };

    for (const regla of reglas) {
      if (esPeriodicaPorDiaSemana(regla)) {
        // Periódica por día de semana: 1 registro por periodo, en la fecha
        // candidata con MENOS carga (reparto). Sticky: si el periodo ya tiene
        // un registro de esta regla, no se recoloca.
        const candMap = candidatasPorPeriodo(regla, desde, hasta);
        const periodosOcupados = new Set(
          existentesRango
            .filter((e) => e.regla_id === regla.id_regla && e.fecha_programada)
            .map((e) => clavePeriodo(new Date(`${e.fecha_programada}T00:00:00`), regla.frecuencia)),
        );
        for (const [periodo, fechas] of candMap) {
          if (periodosOcupados.has(periodo)) { existentes += 1; continue; }
          let best = null;
          let bestCarga = Infinity;
          for (const f of fechas) {
            const carga = cargaPorFecha.get(f) || 0;
            if (carga < bestCarga) { bestCarga = carga; best = f; }
          }
          if (best) await crearRegistro(regla, best);
        }
      } else {
        const fechas = generarFechasRegla(regla, desde, hasta);
        for (const fecha of fechas) await crearRegistro(regla, fecha);
      }
    }
    return res.json({ ok: true, creados, existentes, reglas: reglas.length });
  } catch (err) {
    try { throwSiTablaFalta(err, tReg); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(500).json({ error: 'Error al generar registros' });
  }
});

// ═══════════════════════════ REGISTROS ═══════════════════════════

/** Checklist de un local en una fecha (por defecto, jornada de negocio de hoy). */
router.get('/limpieza/registros', requireAnyPermission('limpieza.ver', 'limpieza.completar'), async (req, res) => {
  const localId = formatId6(String(req.query.local_id ?? '').trim());
  if (!localId || localId === '000000') return res.status(400).json({ error: 'local_id es obligatorio' });
  const fecha = RE_FECHA.test(String(req.query.fecha || '')) ? String(req.query.fecha) : jornadaNegocioHoyIso();
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    return res.status(403).json({ error: 'No tienes acceso a este local' });
  }
  try {
    // Trae la fecha pedida + una ventana hacia atrás, para arrastrar las
    // limpiezas pendientes de días anteriores (se muestran como "retrasada").
    const minDate = fechaMenosDias(fecha, VENTANA_ATRASADAS_DIAS);
    const items = await queryAll({
      TableName: tReg,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
      ExpressionAttributeValues: { ':pk': pkLocal(localId), ':lo': `FECHA#${minDate}`, ':hi': `FECHA#${fecha}#\uffff` },
    });
    const visibles = items.filter((it) => {
      const f = String(it.fecha_programada || '');
      if (f === fecha) return true;
      // De días anteriores, solo las que siguen sin hacerse.
      return f < fecha && ['pendiente', 'retrasada'].includes(String(it.estado));
    });
    visibles.sort((a, b) => String(a.fecha_programada || '').localeCompare(String(b.fecha_programada || '')));
    return res.json({ fecha, registros: visibles.map((it) => mapRegistro(it, fecha)) });
  } catch (err) {
    try { throwSiTablaFalta(err, tReg); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(500).json({ error: 'Error al listar registros' });
  }
});

/**
 * Contador para la tarjeta del planning: limpiezas pendientes (hoy + arrastradas
 * de días anteriores) en los locales accesibles del usuario.
 */
router.get('/limpieza/registros/pendientes-dia', requireAnyPermission('limpieza.ver', 'planning_dia.ver'), async (req, res) => {
  const fecha = RE_FECHA.test(String(req.query.fecha || '')) ? String(req.query.fecha) : jornadaNegocioHoyIso();
  try {
    const items = await scanAll({
      TableName: tReg,
      FilterExpression: 'fecha_programada <= :f AND (estado = :p OR estado = :r)',
      ExpressionAttributeValues: { ':f': fecha, ':p': 'pendiente', ':r': 'retrasada' },
    });
    let total = 0;
    const accesibles = new Map();
    for (const it of items) {
      const lid = String(it.local_id || '');
      if (!accesibles.has(lid)) accesibles.set(lid, await usuarioPuedeAccederLocal(req.user, lid));
      if (accesibles.get(lid)) total += 1;
    }
    return res.json({ total, fecha });
  } catch (err) {
    try { throwSiTablaFalta(err, tReg); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(500).json({ error: 'Error al contar limpiezas del día' });
  }
});

/**
 * Completar un registro → estado "hecha". Evidencia = foto(s) + empleado que la
 * realizó (elegido del staff). Se guarda también el usuario logueado que registra
 * la limpieza (trazabilidad). No usa firma.
 */
router.post(
  '/limpieza/registros/completar',
  requirePermission('limpieza.completar'),
  upload.fields([{ name: 'foto', maxCount: 3 }]),
  async (req, res) => {
    const localId = formatId6(String(req.body.local_id ?? '').trim());
    const fecha = String(req.body.fecha_programada ?? '').trim();
    const tipoObjetoId = String(req.body.tipo_objeto_id ?? '').trim();
    const realizadoPorId = String(req.body.realizado_por_id ?? '').trim();
    const realizadoPorNombre = String(req.body.realizado_por_nombre ?? '').trim();

    if (!localId || localId === '000000') return res.status(400).json({ error: 'local_id es obligatorio' });
    if (!RE_FECHA.test(fecha)) return res.status(400).json({ error: 'fecha_programada no válida' });
    if (!tipoObjetoId) return res.status(400).json({ error: 'tipo_objeto_id es obligatorio' });
    if (!realizadoPorNombre) return res.status(400).json({ error: 'Indica quién ha realizado la limpieza' });
    if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
      return res.status(403).json({ error: 'No tienes acceso a este local' });
    }

    const fotos = req.files?.foto || [];
    if (fotos.length === 0) return res.status(400).json({ error: 'Se requiere al menos una foto' });

    try {
      const existente = await getRegistro(localId, fecha, tipoObjetoId);
      if (!existente) return res.status(404).json({ error: 'Registro no encontrado. Genera la programación primero.' });

      const base = `limpieza/${localId}/${fecha}/${tipoObjetoId}`;
      const fotoKeys = [];
      for (const f of fotos) {
        const ext = (f.originalname || 'foto.jpg').split('.').pop();
        const key = `${base}/foto_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: f.buffer, ContentType: f.mimetype }));
        fotoKeys.push(key);
      }

      const now = new Date().toISOString();
      const usuarioNombre = String(req.user?.Nombre ?? req.user?.nombre ?? req.user?.email ?? '').trim();
      const out = await docClient.send(new UpdateCommand({
        TableName: tReg,
        Key: { PK: pkLocal(localId), SK: skRegistro(fecha, tipoObjetoId) },
        UpdateExpression: 'SET estado = :e, realizado_por_id = :rid, realizado_por_nombre = :rn, registrado_por_usuario_id = :uid, registrado_por_usuario_nombre = :un, completado_at = :ts, foto_keys = :fk, actualizado_en = :ts',
        ExpressionAttributeValues: {
          ':e': 'hecha',
          ':rid': realizadoPorId || null,
          ':rn': realizadoPorNombre,
          ':uid': String(req.user?.id_usuario ?? req.user?.email ?? ''),
          ':un': usuarioNombre,
          ':ts': now,
          ':fk': fotoKeys,
        },
        ConditionExpression: 'attribute_exists(SK)',
        ReturnValues: 'ALL_NEW',
      }));
      return res.json({ ok: true, registro: mapRegistro(out.Attributes) });
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') return res.status(404).json({ error: 'Registro no encontrado' });
      try { throwSiTablaFalta(err, tReg); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
      return res.status(500).json({ error: err.message || 'Error al completar el registro' });
    }
  },
);

/** Borrar uno o varios registros (checklist). Elimina también las fotos en S3 si las hay. */
router.delete('/limpieza/registros', requirePermission('limpieza.borrar'), async (req, res) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (rawItems.length === 0) {
    return res.status(400).json({ error: 'items es obligatorio (array no vacío)' });
  }

  const accesibles = new Map();
  let borrados = 0;
  const errores = [];

  for (const raw of rawItems) {
    const localId = formatId6(String(raw?.local_id ?? '').trim());
    const fecha = String(raw?.fecha_programada ?? '').trim();
    const tipoObjetoId = String(raw?.tipo_objeto_id ?? '').trim();

    if (!localId || localId === '000000' || !RE_FECHA.test(fecha) || !tipoObjetoId) {
      errores.push({ local_id: localId, fecha_programada: fecha, tipo_objeto_id: tipoObjetoId, error: 'Datos incompletos o no válidos' });
      continue;
    }

    if (!accesibles.has(localId)) {
      accesibles.set(localId, await usuarioPuedeAccederLocal(req.user, localId));
    }
    if (!accesibles.get(localId)) {
      errores.push({ local_id: localId, fecha_programada: fecha, tipo_objeto_id: tipoObjetoId, error: 'Sin acceso al local' });
      continue;
    }

    try {
      const item = await getRegistro(localId, fecha, tipoObjetoId);
      if (!item) {
        errores.push({ local_id: localId, fecha_programada: fecha, tipo_objeto_id: tipoObjetoId, error: 'Registro no encontrado' });
        continue;
      }

      const fotoKeys = Array.isArray(item.foto_keys) ? item.foto_keys.filter(Boolean) : [];
      for (const key of fotoKeys) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        } catch {
          // No bloquear el borrado del registro si falla S3
        }
      }

      await docClient.send(
        new DeleteCommand({
          TableName: tReg,
          Key: { PK: pkLocal(localId), SK: skRegistro(fecha, tipoObjetoId) },
        }),
      );
      borrados += 1;
    } catch (err) {
      try { throwSiTablaFalta(err, tReg); } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
      }
      errores.push({
        local_id: localId,
        fecha_programada: fecha,
        tipo_objeto_id: tipoObjetoId,
        error: err.message || 'Error al borrar',
      });
    }
  }

  if (borrados === 0 && errores.length > 0) {
    return res.status(400).json({ error: errores[0].error, errores });
  }

  return res.json({ ok: true, borrados, errores: errores.length ? errores : undefined });
});

/** Evidencia (URLs firmadas de fotos) de un registro concreto. */
router.get('/limpieza/registros/evidencia', requireAnyPermission('limpieza.ver', 'limpieza.informes'), async (req, res) => {
  const localId = formatId6(String(req.query.local_id ?? '').trim());
  const fecha = String(req.query.fecha_programada ?? '').trim();
  const tipoObjetoId = String(req.query.tipo_objeto_id ?? '').trim();
  if (!localId || localId === '000000' || !RE_FECHA.test(fecha) || !tipoObjetoId) {
    return res.status(400).json({ error: 'local_id, fecha_programada y tipo_objeto_id son obligatorios' });
  }
  if (!(await usuarioPuedeAccederLocal(req.user, localId))) {
    return res.status(403).json({ error: 'No tienes acceso a este local' });
  }
  try {
    const item = await getRegistro(localId, fecha, tipoObjetoId);
    if (!item) return res.status(404).json({ error: 'Registro no encontrado' });
    const fotoKeys = Array.isArray(item.foto_keys) ? item.foto_keys : [];
    const fotos = await Promise.all(
      fotoKeys.map((k) => getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: k }), { expiresIn: 3600 })),
    );
    return res.json({ fotos });
  } catch (err) {
    return res.status(500).json({ error: 'Error al obtener la evidencia' });
  }
});

export default router;
