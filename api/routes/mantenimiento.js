import crypto from 'node:crypto';
import express from 'express';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();

const ZONAS = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'];
const CATEGORIAS = ['electricidad', 'fontanería', 'frío', 'mobiliario', 'limpieza técnica', 'IT', 'plagas', 'otros'];
const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'];

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

  try {
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

    await docClient.send(
      new PutCommand({
        TableName: tables.mantenimiento,
        Item: item,
      })
    );
    return res.json({ ok: true, incidencia: item });
  } catch (err) {
    console.error('[mantenimiento/incidencias POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear incidencia' });
  }
});

router.get('/mantenimiento/incidencias', async (req, res) => {
  const localId = (req.query.local_id ?? '').toString().trim();
  const creadoPor = (req.query.creado_por ?? '').toString().trim();
  const estado = (req.query.estado ?? '').toString().trim().toUpperCase();

  try {
    let items = [];
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
    }));
    return res.json({ incidencias });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tables.mantenimiento} no existe en DynamoDB. Créala en AWS con PK (String) y SK (String). Ver api/MANTENIMIENTO.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al listar incidencias' });
  }
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

  try {
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
          errores.push(`${localId}/${fecha}: ${err.message}`);
        }
      }
    }

    return res.json({ ok: true, creados, total: localIds.length * fechas.length, errores });
  } catch (err) {
    console.error('[mantenimiento/incidencias/lote POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear lote' });
  }
});

router.patch('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();
  const fechaProgramada = (body.fecha_programada ?? '').toString().trim();
  const marcarReparado = body.marcar_reparado === true;
  const editarCampos = body.editar_campos === true;

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  try {
    const pk = `LOCAL#${localId}`;
    const sk = `INC#${fechaCreacion}#${idIncidencia}`;

    if (marcarReparado) {
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
      const names = {};
      const values = {};
      const titulo = (body.titulo ?? '').toString().trim();
      const descripcion = (body.descripcion ?? '').toString().trim();
      const zona = (body.zona ?? '').toString().trim().toLowerCase();
      const categoria = (body.categoria ?? '').toString().trim().toLowerCase();
      const prioridadReportada = (body.prioridad_reportada ?? '').toString().trim().toLowerCase();

      if (titulo) { sets.push('#tit = :tit'); names['#tit'] = 'titulo'; values[':tit'] = titulo; }
      if (descripcion !== undefined && body.descripcion !== undefined) { sets.push('#desc = :desc'); names['#desc'] = 'descripcion'; values[':desc'] = descripcion; }
      if (zona && ZONAS.includes(zona)) { sets.push('zona = :zona'); values[':zona'] = zona; }
      if (categoria && CATEGORIAS.includes(categoria)) { sets.push('categoria = :cat'); values[':cat'] = categoria; }
      if (prioridadReportada && PRIORIDADES.includes(prioridadReportada)) { sets.push('prioridad_reportada = :pr'); values[':pr'] = prioridadReportada; }

      const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
      const item = current.Item || {};
      const tieneFechaProgramada = item.fecha_programada && String(item.fecha_programada).trim() !== '';
      if (!tieneFechaProgramada && (item.estado === 'Programado')) {
        sets.push('#est = :est');
        names['#est'] = 'estado';
        values[':est'] = 'Nuevo';
      }

      if (sets.length === 0) return res.status(400).json({ error: 'No hay campos válidos para editar' });

      await docClient.send(
        new UpdateCommand({
          TableName: tables.mantenimiento,
          Key: { PK: pk, SK: sk },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
          ExpressionAttributeValues: values,
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
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias PATCH]', msg);
    return res.status(500).json({ error: msg || 'Error al actualizar incidencia' });
  }
});

router.delete('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  try {
    const pk = `LOCAL#${localId}`;
    const sk = `INC#${fechaCreacion}#${idIncidencia}`;

    await docClient.send(
      new DeleteCommand({
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias DELETE]', msg);
    return res.status(500).json({ error: msg || 'Error al borrar incidencia' });
  }
});

export default router;
