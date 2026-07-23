import crypto from 'node:crypto';
import express from 'express';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();

const ZONAS = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'];
const CATEGORIAS = ['electricidad', 'fontanería', 'frío', 'mobiliario', 'limpieza técnica', 'IT', 'plagas', 'otros'];
const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'];

/** Redondeo a 2 decimales estable para importes. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Sanitiza y recalcula las líneas de valoración de una reparación.
 * Descarta líneas incompletas. Devuelve { lineas, base, iva, total }.
 */
function sanitizarValoracion(rawLineas) {
  const lineas = [];
  for (const l of Array.isArray(rawLineas) ? rawLineas : []) {
    const articulo = (l?.articulo ?? '').toString().trim();
    const cantidad = Number(l?.cantidad);
    const precio = Number(l?.precio);
    const tipoIvaRaw = l?.tipo_iva;
    const tipoIva =
      tipoIvaRaw === undefined || tipoIvaRaw === null || tipoIvaRaw === ''
        ? 21
        : Number(tipoIvaRaw);
    if (!articulo) continue;
    if (!Number.isFinite(cantidad) || cantidad <= 0) continue;
    if (!Number.isFinite(precio) || precio < 0) continue;
    const iva = Number.isFinite(tipoIva) && tipoIva >= 0 ? tipoIva : 21;
    const baseLinea = round2(cantidad * precio);
    const ivaLinea = round2((baseLinea * iva) / 100);
    const totalLinea = round2(baseLinea + ivaLinea);
    lineas.push({
      ...(l?.id_producto ? { id_producto: String(l.id_producto).trim() } : {}),
      articulo,
      cantidad,
      precio,
      tipo_iva: iva,
      base_linea: baseLinea,
      iva_linea: ivaLinea,
      total_linea: totalLinea,
    });
  }
  const base = round2(lineas.reduce((s, l) => s + l.base_linea, 0));
  const iva = round2(lineas.reduce((s, l) => s + l.iva_linea, 0));
  const total = round2(base + iva);
  return { lineas, base, iva, total };
}

/**
 * Si el error indica que la tabla mantenimiento no existe, lanza Error con
 * status 404 y mensaje custom para el operador. Resto se re-lanza.
 */
function throwSiTablaMantenimientoFalta(err) {
  const msg = err?.message || String(err);
  if (
    err?.name === 'ResourceNotFoundException' ||
    msg.includes('Requested resource not found') ||
    msg.includes('ResourceNotFoundException')
  ) {
    const e = new Error(
      `La tabla ${tables.mantenimiento} no existe en DynamoDB. Créala en AWS con PK (String) y SK (String). Ver api/MANTENIMIENTO.md`,
    );
    e.status = 404;
    e.code = 'TABLE_NOT_FOUND';
    throw e;
  }
  throw err;
}

router.post('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? body.id_Locales ?? '').toString().trim();
  const zona = (body.zona ?? '').toString().trim().toLowerCase();
  const categoria = (body.categoria ?? '').toString().trim().toLowerCase();
  const titulo = (body.titulo ?? '').toString().trim();
  const descripcion = (body.descripcion ?? '').toString().trim();
  const prioridadReportada = (body.prioridad_reportada ?? 'media').toString().trim().toLowerCase();
  const fotos = Array.isArray(body.fotos) ? body.fotos.filter((f) => typeof f === 'string' && f.length > 0).slice(0, 3) : [];
  const creadoPor = (body.creado_por_id_usuario ?? req.headers['x-user-id'] ?? '').toString().trim();

  if (!localId) return res.status(400).json({ error: 'local_id es obligatorio' });
  if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });
  if (!ZONAS.includes(zona)) return res.status(400).json({ error: 'zona no válida' });
  if (!CATEGORIAS.includes(categoria)) return res.status(400).json({ error: 'categoria no válida' });
  if (!PRIORIDADES.includes(prioridadReportada)) return res.status(400).json({ error: 'prioridad_reportada no válida' });

  const getLocal = await docClient.send(
    new GetCommand({
      TableName: tables.locales,
      Key: { id_Locales: localId },
    })
  );
  if (!getLocal.Item) {
    return res.status(400).json({ error: 'Local no encontrado' });
  }

  const uuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const sk = `INC#${now}#${uuid}`;
  const pk = `LOCAL#${localId}`;
  const item = {
    PK: pk,
    SK: sk,
    tipo: 'INC',
    id_incidencia: uuid,
    fecha_creacion: now,
    creado_por_id_usuario: creadoPor || undefined,
    local_id: localId,
    zona,
    categoria,
    titulo,
    descripcion,
    prioridad_reportada: prioridadReportada,
    estado: 'Nuevo',
    ...(fotos.length > 0 && { fotos }),
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: tables.mantenimiento,
        Item: item,
      })
    );
  } catch (err) {
    throwSiTablaMantenimientoFalta(err);
  }
  return res.json({ ok: true, incidencia: item });
});

router.get('/mantenimiento/incidencias', async (req, res) => {
  const localId = (req.query.local_id ?? '').toString().trim();
  const creadoPor = (req.query.creado_por ?? '').toString().trim();
  const estado = (req.query.estado ?? '').toString().trim().toUpperCase();

  let items = [];
  try {
    if (localId) {
      let lastKey = null;
      do {
        const cmd = new QueryCommand({
          TableName: tables.mantenimiento,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `LOCAL#${localId}`, ':sk': 'INC#' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    } else {
      let lastKey = null;
      do {
        const cmd = new ScanCommand({
          TableName: tables.mantenimiento,
          FilterExpression: 'tipo = :tipo',
          ExpressionAttributeValues: { ':tipo': 'INC' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    }
  } catch (err) {
    throwSiTablaMantenimientoFalta(err);
  }
  if (creadoPor) items = items.filter((i) => (i.creado_por_id_usuario ?? '') === creadoPor);
  if (estado) items = items.filter((i) => (i.estado ?? '') === estado);
  items.sort((a, b) => (b.fecha_creacion || '').localeCompare(a.fecha_creacion || ''));
  const incidencias = items.map((i) => ({
    id_incidencia: i.id_incidencia,
    fecha_creacion: i.fecha_creacion,
    fecha_programada: i.fecha_programada,
    creado_por_id_usuario: i.creado_por_id_usuario,
    local_id: i.local_id,
    zona: i.zona,
    categoria: i.categoria,
    titulo: i.titulo,
    descripcion: i.descripcion,
    prioridad_reportada: i.prioridad_reportada,
    estado: i.estado,
    fotos: i.fotos ?? [],
    fecha_completada: i.FechaCompletada ?? null,
    estado_valoracion: i.EstadoValoracion ?? null,
    fecha_valoracion: i.fecha_valoracion ?? null,
    valoracion_lineas: i.valoracion_lineas ?? [],
    valoracion_base: i.valoracion_base ?? null,
    valoracion_iva: i.valoracion_iva ?? null,
    valoracion_total: i.valoracion_total ?? null,
  }));
  return res.json({ incidencias });
});

router.post('/mantenimiento/incidencias/lote', async (req, res) => {
  const body = req.body || {};
  const localIds = Array.isArray(body.local_ids) ? body.local_ids.map((v) => String(v).trim()).filter(Boolean) : [];
  const fechas = Array.isArray(body.fechas_programadas) ? body.fechas_programadas.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f))) : [];
  const zona = (body.zona ?? '').toString().trim().toLowerCase();
  const categoria = (body.categoria ?? 'otros').toString().trim().toLowerCase();
  const titulo = (body.titulo ?? '').toString().trim();
  const descripcion = (body.descripcion ?? '').toString().trim();
  const prioridadReportada = (body.prioridad_reportada ?? 'media').toString().trim().toLowerCase();
  const creadoPor = (body.creado_por_id_usuario ?? req.headers['x-user-id'] ?? '').toString().trim();
  const idSerie = body.id_serie || crypto.randomUUID();

  if (localIds.length === 0) return res.status(400).json({ error: 'Se necesita al menos un local_id' });
  if (fechas.length === 0) return res.status(400).json({ error: 'Se necesita al menos una fecha' });
  if (localIds.length * fechas.length > 500) return res.status(400).json({ error: 'Máximo 500 registros por lote' });
  if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });
  if (!ZONAS.includes(zona)) return res.status(400).json({ error: 'zona no válida' });
  if (!CATEGORIAS.includes(categoria)) return res.status(400).json({ error: 'categoria no válida' });
  if (!PRIORIDADES.includes(prioridadReportada)) return res.status(400).json({ error: 'prioridad_reportada no válida' });

  let creados = 0;
  const errores = [];
  const now = new Date().toISOString();

  for (const localId of localIds) {
    for (const fecha of fechas) {
      try {
        const uuid = crypto.randomUUID();
        const sk = `INC#${now}#${uuid}`;
        const pk = `LOCAL#${localId}`;
        await docClient.send(
          new PutCommand({
            TableName: tables.mantenimiento,
            Item: {
              PK: pk,
              SK: sk,
              tipo: 'INC',
              id_incidencia: uuid,
              fecha_creacion: now,
              creado_por_id_usuario: creadoPor || undefined,
              local_id: localId,
              zona,
              categoria,
              titulo,
              descripcion,
              prioridad_reportada: prioridadReportada,
              estado: 'Programado',
              fecha_programada: fecha,
              id_serie: idSerie,
              origen: 'recurrente',
            },
          })
        );
        creados++;
      } catch (err) {
        // Acumulamos fallos por par localId/fecha y seguimos: respuesta tolerante.
        errores.push(`${localId}/${fecha}: ${err.message}`);
      }
    }
  }

  return res.json({ ok: true, creados, total: localIds.length * fechas.length, errores });
});

router.patch('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();
  const fechaProgramada = (body.fecha_programada ?? '').toString().trim();
  const marcarReparado = body.marcar_reparado === true;
  const valorar = body.valorar === true;
  const editarCampos = body.editar_campos === true;

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  const pk = `LOCAL#${localId}`;
  const sk = `INC#${fechaCreacion}#${idIncidencia}`;

  // Valorar = reparar con líneas de cobro (obligatorio al menos una línea).
  if (valorar) {
    const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
    const item = current.Item || {};
    const tieneProgramacion =
      (item.fecha_programada && String(item.fecha_programada).trim() !== '') ||
      item.estado === 'Programado';
    if (!tieneProgramacion) {
      return res.status(400).json({ error: 'La incidencia debe estar programada antes de valorarla' });
    }

    const { lineas, base, iva, total } = sanitizarValoracion(body.lineas);
    if (lineas.length === 0) {
      return res.status(400).json({ error: 'La valoración debe incluir al menos una línea válida (artículo, cantidad y precio)' });
    }

    const fechaCompletada = new Date().toISOString();
    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression:
          'SET FechaCompletada = :fc, fecha_valoracion = :fv, EstadoValoracion = :ev, #est = :est, valoracion_lineas = :ln, valoracion_base = :vb, valoracion_iva = :vi, valoracion_total = :vt',
        ExpressionAttributeNames: { '#est': 'estado' },
        ExpressionAttributeValues: {
          ':fc': fechaCompletada,
          ':fv': fechaCompletada,
          ':ev': 'Valorado',
          ':est': 'Reparacion',
          ':ln': lineas,
          ':vb': base,
          ':vi': iva,
          ':vt': total,
        },
      })
    );
    return res.json({ ok: true, valoracion: { lineas, base, iva, total } });
  }

  if (marcarReparado) {
    const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
    const item = current.Item || {};
    const tieneProgramacion =
      (item.fecha_programada && String(item.fecha_programada).trim() !== '') ||
      item.estado === 'Programado';
    if (!tieneProgramacion) {
      return res.status(400).json({ error: 'La incidencia debe estar programada antes de marcarla como reparada' });
    }

    const fechaCompletada = new Date().toISOString();
    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'SET FechaCompletada = :fc, EstadoValoracion = :ev, #est = :est',
        ExpressionAttributeNames: { '#est': 'estado' },
        ExpressionAttributeValues: { ':fc': fechaCompletada, ':ev': 'Reparado', ':est': 'Reparacion' },
      })
    );
    return res.json({ ok: true });
  }

  if (editarCampos) {
    const sets = [];
    const removes = [];
    const names = {};
    const values = {};
    const titulo = (body.titulo ?? '').toString().trim();
    const descripcion = (body.descripcion ?? '').toString().trim();
    const zona = (body.zona ?? '').toString().trim().toLowerCase();
    const categoria = (body.categoria ?? '').toString().trim().toLowerCase();
    const prioridadReportada = (body.prioridad_reportada ?? '').toString().trim().toLowerCase();
    const editarFechaProgramada = Object.prototype.hasOwnProperty.call(body, 'fecha_programada');

    if (titulo) { sets.push('#tit = :tit'); names['#tit'] = 'titulo'; values[':tit'] = titulo; }
    if (descripcion !== undefined && body.descripcion !== undefined) { sets.push('#desc = :desc'); names['#desc'] = 'descripcion'; values[':desc'] = descripcion; }
    if (zona && ZONAS.includes(zona)) { sets.push('zona = :zona'); values[':zona'] = zona; }
    if (categoria && CATEGORIAS.includes(categoria)) { sets.push('categoria = :cat'); values[':cat'] = categoria; }
    if (prioridadReportada && PRIORIDADES.includes(prioridadReportada)) { sets.push('prioridad_reportada = :pr'); values[':pr'] = prioridadReportada; }

    if (editarFechaProgramada) {
      const fpRaw = body.fecha_programada;
      const fp = fpRaw === null || fpRaw === undefined ? '' : String(fpRaw).trim();
      const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
      const item = current.Item || {};
      const esReparacion = item.estado === 'Reparacion';
      if (!fp) {
        removes.push('fecha_programada');
        if (!esReparacion) {
          sets.push('#est = :estNuevo');
          names['#est'] = 'estado';
          values[':estNuevo'] = 'Nuevo';
        }
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(fp)) {
        return res.status(400).json({ error: 'fecha_programada debe ser yyyy-mm-dd' });
      } else {
        const programada = new Date(fp + 'T12:00:00');
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        programada.setHours(0, 0, 0, 0);
        if (programada.getTime() < hoy.getTime()) {
          return res.status(400).json({ error: 'No se puede asignar una fecha anterior al día actual' });
        }
        sets.push('fecha_programada = :fp');
        if (!esReparacion) {
          sets.push('#est = :estProg');
          names['#est'] = 'estado';
          values[':estProg'] = 'Programado';
        }
        values[':fp'] = fp;
      }
    } else {
      const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
      const item = current.Item || {};
      const tieneFechaProgramada = item.fecha_programada && String(item.fecha_programada).trim() !== '';
      if (!tieneFechaProgramada && item.estado === 'Programado') {
        sets.push('#est = :est');
        names['#est'] = 'estado';
        values[':est'] = 'Nuevo';
      }
    }

    if (sets.length === 0 && removes.length === 0) {
      return res.status(400).json({ error: 'No hay campos válidos para editar' });
    }

    const parts = [];
    if (sets.length > 0) parts.push(`SET ${sets.join(', ')}`);
    if (removes.length > 0) parts.push(`REMOVE ${removes.join(', ')}`);

    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression: parts.join(' '),
        ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
        ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
      })
    );
    return res.json({ ok: true });
  }

  if (!fechaProgramada || !/^\d{4}-\d{2}-\d{2}$/.test(fechaProgramada)) {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'REMOVE fecha_programada SET #est = :est',
        ExpressionAttributeNames: { '#est': 'estado' },
        ExpressionAttributeValues: { ':est': 'Nuevo' },
      })
    );
    return res.json({ ok: true });
  }

  const programada = new Date(fechaProgramada + 'T12:00:00');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  programada.setHours(0, 0, 0, 0);
  if (programada.getTime() < hoy.getTime()) {
    return res.status(400).json({ error: 'No se puede asignar una fecha anterior al día actual' });
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tables.mantenimiento,
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET fecha_programada = :fp, #est = :est',
      ExpressionAttributeNames: { '#est': 'estado' },
      ExpressionAttributeValues: { ':fp': fechaProgramada, ':est': 'Programado' },
    })
  );
  return res.json({ ok: true });
});

router.delete('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  const pk = `LOCAL#${localId}`;
  const sk = `INC#${fechaCreacion}#${idIncidencia}`;

  await docClient.send(
    new DeleteCommand({
      TableName: tables.mantenimiento,
      Key: { PK: pk, SK: sk },
    })
  );
  return res.json({ ok: true });
});

export default router;
