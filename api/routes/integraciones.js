/**
 * Namespace de integración externa: SOLO LECTURA.
 * Montar en server.js ANTES de requireAuth.
 * Auth: X-Api-Key (middleware propio; no JWT).
 */
import { Router } from 'express';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { camposFechaVirtuales } from '../lib/actuacionFechaVirtual.js';
import {
  rejectNonGetIntegraciones,
  requireIntegracionApiKey,
} from '../middleware/integracionApiKey.js';

const router = Router();

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

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

async function scanAllActuaciones() {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.actuaciones,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

function compareActuacion(a, b) {
  const cf = String(a.fecha || '').localeCompare(String(b.fecha || ''));
  if (cf !== 0) return cf;
  const ch = String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || ''));
  if (ch !== 0) return ch;
  return String(a.id_actuacion || '').localeCompare(String(b.id_actuacion || ''));
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  try {
    const o = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object') return null;
    return {
      fecha: String(o.fecha || ''),
      hora_inicio: String(o.hora_inicio || ''),
      id_actuacion: String(o.id_actuacion || ''),
    };
  } catch {
    return null;
  }
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

  let items;
  try {
    items = await scanAllActuaciones();
  } catch (err) {
    console.error('[integraciones actuaciones]', err?.message || err);
    return res.status(500).json({ error: 'Error al leer actuaciones' });
  }

  // Filtros de negocio: rango inclusivo por fecha; NO por estado;
  // excluir huecos (sin artista); fecha válida.
  items = items.filter((x) => {
    const fecha = String(x.fecha || '').trim();
    if (!RE_FECHA.test(fecha)) return false;
    if (fecha < fechaDesde || fecha > fechaHasta) return false;
    if (isBlank(x.id_artista) && isBlank(x.artista_nombre_snapshot)) return false;

    if (localFiltro) {
      const nombreOk =
        String(x.local_nombre_snapshot || '')
          .trim()
          .toLowerCase() === localNombreNorm;
      const idOk = filtrarPorId && normalizeIdLocal(x.id_local) === localIdNorm;
      if (!nombreOk && !idOk) return false;
    }
    return true;
  });

  items.sort(compareActuacion);

  if (cursor) {
    items = items.filter((x) => compareActuacion(x, cursor) > 0);
  }

  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          fecha: String(last.fecha || ''),
          hora_inicio: String(last.hora_inicio || ''),
          id_actuacion: String(last.id_actuacion || ''),
        })
      : null;

  // Solo Scan/Get implícito vía Scan: sin Put/Update/Delete/TransactWrite sobre actuaciones.
  return res.json({
    data: page.map(toDto),
    nextCursor,
  });
});

export default router;
