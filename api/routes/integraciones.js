/**
 * Namespace de integración externa: SOLO LECTURA.
 * Montar en server.js ANTES de requireAuth.
 * Auth: X-Api-Key (middleware propio; no JWT).
 */
import { Router } from 'express';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { camposFechaVirtuales } from '../lib/actuacionFechaVirtual.js';
import { GSI_ACTUACIONES_LISTADO } from '../lib/actuacionesIndice.js';
import {
  rejectNonGetIntegraciones,
  requireIntegracionApiKey,
} from '../middleware/integracionApiKey.js';

const router = Router();

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
/** Días inclusivos. Un año natural (incluido el bisiesto) cabe; más, no. */
const MAX_RANGO_DIAS = 366;

router.use('/integraciones', rejectNonGetIntegraciones);
router.use('/integraciones', requireIntegracionApiKey({ scope: 'actuaciones:read' }));

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

function pareceIdLocal(valor) {
  const s = String(valor || '').trim();
  if (!s) return false;
  // Numérico (p. ej. id_local 6 dígitos o sin padding) o UUID
  if (/^\d{1,12}$/.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  return false;
}

function normalizeIdLocal(v) {
  const s = String(v ?? '').replace(/^0+/, '') || '0';
  const n = parseInt(s, 10);
  if (Number.isNaN(n)) return String(v ?? '').trim().toLowerCase();
  return String(Math.max(0, n)).padStart(6, '0');
}

function diasInclusivos(desde, hasta) {
  const a = Date.parse(`${desde}T12:00:00Z`);
  const b = Date.parse(`${hasta}T12:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Cursor:
 * - v1 (el de siempre): `{ fecha, hora_inicio, id_actuacion }`. Sigue válido:
 *   se salta todo lo que no quede estrictamente después, en el mismo orden.
 * - v2: `{ v: 2, k }` con la ExclusiveStartKey del GSI Listado-Fecha. Es el que
 *   devuelve esta ruta a partir de ahora, para no releer las páginas ya vistas.
 */
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  try {
    const o = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object') return null;
    if (o.v === 2 && o.k && typeof o.k === 'object') return { tipo: 'v2', k: o.k };
    if (!o.fecha && !o.id_actuacion) return null;
    return {
      tipo: 'v1',
      fecha: String(o.fecha || ''),
      hora_inicio: String(o.hora_inicio || ''),
      id_actuacion: String(o.id_actuacion || ''),
    };
  } catch {
    return null;
  }
}

function claveContinuacionActuacion(item) {
  return {
    id_actuacion: item.id_actuacion,
    gsi_listado: 'ACTUACION',
    gsi_fecha: item.gsi_fecha,
  };
}

function pasaFiltroActuacion(x, { localFiltro, localNombreNorm, filtrarPorId, localIdNorm }) {
  const fecha = String(x.fecha || '').trim();
  if (!RE_FECHA.test(fecha)) return false;
  if (isBlank(x.id_artista) && isBlank(x.artista_nombre_snapshot)) return false;
  if (localFiltro) {
    const nombreOk = String(x.local_nombre_snapshot || '').trim().toLowerCase() === localNombreNorm;
    const idOk = filtrarPorId && normalizeIdLocal(x.id_local) === localIdNorm;
    if (!nombreOk && !idOk) return false;
  }
  return true;
}

/**
 * Página del GSI Listado-Fecha. El rango ya está en la clave; el filtro de
 * hueco y de local se aplica aquí, y se sigue leyendo hasta llenar `limit`.
 */
async function paginaActuaciones({ fechaDesde, fechaHasta, limit, cursor, filtro }) {
  const out = [];
  let esk = cursor?.tipo === 'v2' ? cursor.k : undefined;
  let saltarV1 = cursor?.tipo === 'v1';
  let hayMas = false;

  while (out.length < limit) {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.actuaciones,
      IndexName: GSI_ACTUACIONES_LISTADO,
      KeyConditionExpression: 'gsi_listado = :t AND gsi_fecha BETWEEN :a AND :b',
      ExpressionAttributeValues: {
        ':t': 'ACTUACION',
        ':a': `${fechaDesde}#`,
        ':b': `${fechaHasta}#\uffff`,
      },
      Limit: Math.max(limit, 50),
      ...(esk && { ExclusiveStartKey: esk }),
    }));
    const batch = r.Items || [];
    if (batch.length === 0) break;

    let corte = -1;
    for (let i = 0; i < batch.length; i += 1) {
      const x = batch[i];
      if (saltarV1 && compareActuacion(x, cursor) <= 0) continue;
      saltarV1 = false;
      if (!pasaFiltroActuacion(x, filtro)) continue;
      out.push(x);
      if (out.length >= limit) {
        corte = i;
        break;
      }
    }

    if (out.length >= limit) {
      const restoPasa = corte >= 0 && batch.slice(corte + 1).some((x) => {
        if (saltarV1 && compareActuacion(x, cursor) <= 0) return false;
        return pasaFiltroActuacion(x, filtro);
      });
      hayMas = restoPasa || Boolean(r.LastEvaluatedKey);
      esk = claveContinuacionActuacion(out[out.length - 1]);
      break;
    }

    if (!r.LastEvaluatedKey) break;
    esk = r.LastEvaluatedKey;
  }

  const last = out[out.length - 1];
  const nextCursor = hayMas && last ? encodeCursor({ v: 2, k: claveContinuacionActuacion(last) }) : null;
  return { page: out, nextCursor };
}

function compareActuacion(a, b) {
  const cf = String(a.fecha || '').localeCompare(String(b.fecha || ''));
  if (cf !== 0) return cf;
  const ch = String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || ''));
  if (ch !== 0) return ch;
  return String(a.id_actuacion || '').localeCompare(String(b.id_actuacion || ''));
}

function toDto(item) {
  const fecha = String(item.fecha || '');
  const virtual = camposFechaVirtuales(fecha);
  return {
    id_actuacion: String(item.id_actuacion || ''),
    artista_nombre_snapshot: String(item.artista_nombre_snapshot || ''),
    local_nombre_snapshot: String(item.local_nombre_snapshot || ''),
    fecha,
    hora_inicio: String(item.hora_inicio || ''),
    fecha_dia_semana: virtual.fecha_dia_semana,
    fecha_dia_numero: virtual.fecha_dia_numero,
    fecha_mes: virtual.fecha_mes,
  };
}

/**
 * GET /api/integraciones/v1/actuaciones
 * Solo lectura. Cabecera: X-Api-Key.
 */
router.get('/integraciones/v1/actuaciones', async (req, res) => {
  const fechaDesde = String(req.query.fechaDesde || '').trim();
  const fechaHasta = String(req.query.fechaHasta || '').trim();

  if (!RE_FECHA.test(fechaDesde) || !RE_FECHA.test(fechaHasta)) {
    return res.status(400).json({
      error: 'fechaDesde y fechaHasta son obligatorios (formato YYYY-MM-DD)',
    });
  }
  if (fechaDesde > fechaHasta) {
    return res.status(400).json({ error: 'fechaDesde no puede ser posterior a fechaHasta' });
  }
  if (diasInclusivos(fechaDesde, fechaHasta) > MAX_RANGO_DIAS) {
    return res.status(400).json({ error: `El rango no puede superar ${MAX_RANGO_DIAS} días` });
  }

  let limit = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const cursorRaw = req.query.cursor;
  const cursor = cursorRaw != null && String(cursorRaw).trim() !== '' ? decodeCursor(cursorRaw) : null;
  if (cursorRaw != null && String(cursorRaw).trim() !== '' && !cursor) {
    return res.status(400).json({ error: 'cursor inválido' });
  }

  const localFiltro = req.query.local != null ? String(req.query.local).trim() : '';
  const localNombreNorm = localFiltro.toLowerCase();
  const filtrarPorId = localFiltro && pareceIdLocal(localFiltro);
  const localIdNorm = filtrarPorId ? normalizeIdLocal(localFiltro) : null;

  let page;
  let nextCursor;
  try {
    ({ page, nextCursor } = await paginaActuaciones({
      fechaDesde,
      fechaHasta,
      limit,
      cursor,
      filtro: { localFiltro, localNombreNorm, filtrarPorId, localIdNorm },
    }));
  } catch (err) {
    console.error('[integraciones actuaciones]', err?.message || err);
    return res.status(500).json({ error: 'Error al leer actuaciones' });
  }

  // Lectura por el GSI Listado-Fecha. El cursor v2 es su ExclusiveStartKey;
  // un cursor v1 (fecha + hora + id) sigue saltando por ese orden.
  return res.json({
    data: page.map(toDto),
    nextCursor,
  });
});

export default router;
