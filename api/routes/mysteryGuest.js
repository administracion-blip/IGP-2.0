/**
 * Mystery Guest — tabla Igp_MysteryGuest (variable DDB_MISTERY_GUEST)
 * PK en DynamoDB: ud_mysteryguest (string, UUID). En JSON se expone id_MisteryGuest.
 * Atributos: Fecha, LocalId, Respuestas (map id→1–5), ExperienciaGeneral, MediasPorCategoria, MediaGlobal,
 *   ProductoFotos, ProductoComentario, ServicioComentario, LimpiezaComentario, AmbienteComentario,
 *   FechaDia (YYYY-MM-DD, día civil de la visita para filtros), UsuarioId, UsuarioNombre, legado, Notas, CreadoEn.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import {
  mgTodosLosIdsPregunta,
  computeMediasPorCategoria,
  computeMediaGlobalCategorias,
} from '../lib/mysteryGuestCuestionario.js';

const router = express.Router();
const TABLE = tables.mysteryGuest;

/** Partición física en DynamoDB (debe coincidir con la tabla; ej. ud_mysteryguest o id_MisteryGuest). */
const DYNAMO_PK = process.env.DDB_MISTERY_GUEST_PK || 'ud_mysteryguest';

/** Respuesta API: id_MisteryGuest; no duplicar ud_mysteryguest. */
function normalizeItemForApi(it) {
  if (!it || typeof it !== 'object') return it;
  const id = it[DYNAMO_PK] ?? it.id_MisteryGuest;
  const copy = { ...it };
  delete copy[DYNAMO_PK];
  if (id != null && id !== '') copy.id_MisteryGuest = String(id);
  return copy;
}

/** PutItem con clave ud_mysteryguest. */
function toDynamoItem(item) {
  const id = item.id_MisteryGuest != null ? String(item.id_MisteryGuest).trim() : '';
  if (!id) throw new Error('id_MisteryGuest requerido para guardar');
  const { id_MisteryGuest, ...rest } = item;
  return { [DYNAMO_PK]: id, ...rest };
}

function isoDateOk(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/** Puntuación 1–5 o null si inválido */
function score1to5(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

/** Hasta 6 data URLs o URLs http(s) de imágenes (Mystery Guest — categoría Producto). */
function parseProductoFotos(body) {
  const raw = body.ProductoFotos;
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 6)
    .map((x) => String(x).trim())
    .filter((s) => s.startsWith('data:image/') || /^https?:\/\//i.test(s));
}

function parseProductoComentario(body) {
  const s = body.ProductoComentario != null ? String(body.ProductoComentario).trim() : '';
  return s.slice(0, 8000);
}

function parseComentarioCategoria(body, key) {
  const s = body[key] != null ? String(body[key]).trim() : '';
  return s.slice(0, 4000);
}

/** Quién realiza el registro (cliente envía sesión actual). */
function parseUsuarioVisitante(body) {
  const UsuarioId = body.UsuarioId != null ? String(body.UsuarioId).trim().slice(0, 128) : '';
  const UsuarioNombre = body.UsuarioNombre != null ? String(body.UsuarioNombre).trim().slice(0, 256) : '';
  return {
    ...(UsuarioId && { UsuarioId }),
    ...(UsuarioNombre && { UsuarioNombre }),
  };
}

/** Extrae YYYY-MM-DD de Fecha (solo fecha o ISO con hora). */
function fechaDiaDesdeItem(f) {
  const s = String(f ?? '').trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

/** YYYY-MM-DD desde cualquier valor típico en Dynamo (string ISO, solo fecha, timestamp ms). */
function fechaDiaYYYYMMDDDesdeValor(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    const dt = new Date(v > 1e12 ? v : v * 1000);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return '';
}

/** Día usado para filtrar por rango (evita desfase UTC vs día local del visitante). */
function parseFechaDiaGuardada(body) {
  const s = body.FechaDia != null ? String(body.FechaDia).trim().slice(0, 10) : '';
  return isoDateOk(s) ? s : '';
}

function fechaDiaParaFiltro(it) {
  const fdRaw = it.FechaDia ?? it.fechadia;
  const fd = fdRaw != null ? String(fdRaw).trim().slice(0, 10) : '';
  if (isoDateOk(fd)) return fd;
  const desdeFecha = fechaDiaYYYYMMDDDesdeValor(it.Fecha ?? it.fecha ?? it.FECHA);
  if (isoDateOk(desdeFecha)) return desdeFecha;
  const desdeCreado = fechaDiaYYYYMMDDDesdeValor(it.CreadoEn ?? it.creadoEn);
  if (isoDateOk(desdeCreado)) return desdeCreado;
  return '';
}

function localIdItem(it) {
  return String(it.LocalId ?? it.localId ?? '').trim();
}

/** GET /mystery-guest — lista valoraciones; query: fechaDesde, fechaHasta (YYYY-MM-DD), localId (opcional) */
router.get('/mystery-guest', async (req, res) => {
  const fechaDesde = req.query.fechaDesde != null ? String(req.query.fechaDesde).trim() : '';
  const fechaHasta = req.query.fechaHasta != null ? String(req.query.fechaHasta).trim() : '';
  const localId = req.query.localId != null ? String(req.query.localId).trim() : '';

  if (!isoDateOk(fechaDesde) || !isoDateOk(fechaHasta)) {
    return res.status(400).json({ error: 'fechaDesde y fechaHasta son obligatorias (YYYY-MM-DD)' });
  }
  if (fechaDesde > fechaHasta) {
    return res.status(400).json({ error: 'fechaDesde debe ser <= fechaHasta' });
  }

  try {
    const items = [];
    let lastKey = null;
    do {
      const r = await docClient.send(
        new ScanCommand({
          TableName: TABLE,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        })
      );
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);

    const filtrados = items.filter((it) => {
      const f = fechaDiaParaFiltro(it);
      if (isoDateOk(f)) {
        if (f < fechaDesde || f > fechaHasta) return false;
      }
      /** Sin fecha parseable: se muestra igual (p. ej. datos incompletos en Dynamo). */
      if (localId && localIdItem(it) !== localId.trim()) return false;
      return true;
    });

    // Orden de llegada: primero el que envió antes (CreadoEn ascendente)
    filtrados.sort((a, b) => {
      const ca = String(a.CreadoEn ?? '');
      const cb = String(b.CreadoEn ?? '');
      const cmp = ca.localeCompare(cb);
      if (cmp !== 0) return cmp;
      const ida = String(a[DYNAMO_PK] ?? a.id_MisteryGuest ?? '');
      const idb = String(b[DYNAMO_PK] ?? b.id_MisteryGuest ?? '');
      return ida.localeCompare(idb);
    });

    res.json({ valoraciones: filtrados.map(normalizeItemForApi) });
  } catch (err) {
    console.error('[mystery-guest GET]', err);
    res.status(500).json({ error: err.message || 'Error al listar Mystery Guest' });
  }
});

/** POST /mystery-guest — alta: Respuestas (cuestionario) + ExperienciaGeneral, o legado tres puntuaciones. */
router.post('/mystery-guest', async (req, res) => {
  const body = req.body || {};
  const rawFecha = body.Fecha != null ? String(body.Fecha).trim() : '';
  const LocalId = body.LocalId != null ? String(body.LocalId).trim() : '';
  /** Fecha de visita: ISO 8601 con hora, o legado solo yyyy-mm-dd. */
  let Fecha = '';
  if (isoDateOk(rawFecha)) {
    Fecha = rawFecha;
  } else {
    const d = new Date(rawFecha);
    if (!Number.isNaN(d.getTime())) {
      Fecha = d.toISOString();
    }
  }
  if (!Fecha) {
    return res.status(400).json({ error: 'Fecha obligatoria (fecha y hora de la visita en ISO)' });
  }
  if (!LocalId) {
    return res.status(400).json({ error: 'LocalId es obligatorio' });
  }
  const FechaDia =
    parseFechaDiaGuardada(body) ||
    (isoDateOk(fechaDiaDesdeItem(Fecha)) ? fechaDiaDesdeItem(Fecha) : '');
  const Notas = body.Notas != null ? String(body.Notas).trim() : '';
  const ahora = new Date().toISOString();

  const idsPregunta = mgTodosLosIdsPregunta();
  const inputRespuestas = body.Respuestas != null && typeof body.Respuestas === 'object' ? body.Respuestas : null;

  let item;

  if (inputRespuestas) {
    const Respuestas = {};
    for (const id of idsPregunta) {
      const s = score1to5(inputRespuestas[id]);
      if (s == null) {
        return res.status(400).json({ error: `Cada pregunta debe tener puntuación 1–5 (falta o inválida: ${id})` });
      }
      Respuestas[id] = s;
    }
    const MediasPorCategoria = computeMediasPorCategoria(Respuestas);
    const MediaGlobal = computeMediaGlobalCategorias(MediasPorCategoria);
    /** Misma escala 1–5 que la media global redondeada (estrellas no editables en cliente). */
    const ExperienciaGeneral = Math.min(5, Math.max(1, Math.round(MediaGlobal)));
    const ProductoFotos = parseProductoFotos(body);
    const ProductoComentario = parseProductoComentario(body);
    const ServicioComentario = parseComentarioCategoria(body, 'ServicioComentario');
    const LimpiezaComentario = parseComentarioCategoria(body, 'LimpiezaComentario');
    const AmbienteComentario = parseComentarioCategoria(body, 'AmbienteComentario');
    const usuarioV = parseUsuarioVisitante(body);

    item = {
      id_MisteryGuest: body.id_MisteryGuest != null ? String(body.id_MisteryGuest).trim() : randomUUID(),
      Fecha,
      ...(FechaDia && { FechaDia }),
      LocalId,
      Respuestas,
      ExperienciaGeneral,
      MediasPorCategoria,
      MediaGlobal,
      ...(ProductoFotos.length > 0 && { ProductoFotos }),
      ...(ProductoComentario && { ProductoComentario }),
      ...(ServicioComentario && { ServicioComentario }),
      ...(LimpiezaComentario && { LimpiezaComentario }),
      ...(AmbienteComentario && { AmbienteComentario }),
      ...usuarioV,
      ...(Notas && { Notas }),
      CreadoEn: body.CreadoEn != null ? String(body.CreadoEn) : ahora,
    };
  } else {
    const Servicio = score1to5(body.Servicio);
    const Producto = score1to5(body.Producto);
    const Limpieza = score1to5(body.Limpieza);
    if (Servicio == null || Producto == null || Limpieza == null) {
      return res.status(400).json({
        error: 'Envía Respuestas (cuestionario) o bien Servicio, Producto y Limpieza (legado)',
      });
    }
    const Valoracion =
      body.Valoracion != null
        ? typeof body.Valoracion === 'number'
          ? body.Valoracion
          : parseFloat(String(body.Valoracion).replace(',', '.'))
        : null;

    const usuarioV = parseUsuarioVisitante(body);

    item = {
      id_MisteryGuest: body.id_MisteryGuest != null ? String(body.id_MisteryGuest).trim() : randomUUID(),
      Fecha,
      ...(FechaDia && { FechaDia }),
      LocalId,
      Servicio,
      Producto,
      Limpieza,
      ...(Valoracion != null && !Number.isNaN(Valoracion) && { Valoracion }),
      ...usuarioV,
      ...(Notas && { Notas }),
      CreadoEn: body.CreadoEn != null ? String(body.CreadoEn) : ahora,
    };
  }

  try {
    const ddbItem = toDynamoItem(item);
    await docClient.send(new PutCommand({ TableName: TABLE, Item: ddbItem }));
    res.json({ ok: true, valoracion: normalizeItemForApi(ddbItem) });
  } catch (err) {
    console.error('[mystery-guest POST]', err);
    res.status(500).json({ error: err.message || 'Error al guardar Mystery Guest' });
  }
});

export default router;
