import { Router } from 'express';
import crypto from 'node:crypto';
import {
  ScanCommand,
  QueryCommand,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand as S3GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, tables } from '../lib/db.js';
import { queryComprasPorProductos } from '../lib/dynamo/comprasProveedor.js';

const router = Router();
const region = process.env.AWS_REGION || 'eu-west-3';
const tableAcuerdos = tables.acuerdos;
const tableAcuerdosDetalles = tables.acuerdosDetalles;
const tableAcuerdosImagen = tables.acuerdosImagen;
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region });

// Acuerdos con Marcas (Rappel)
// ──────────────────────────────────────────

router.get('/acuerdos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableAcuerdos,
        ConsistentRead: true,
        FilterExpression: '#sk = :meta',
        ExpressionAttributeNames: { '#sk': 'SK' },
        ExpressionAttributeValues: { ':meta': 'META' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[acuerdos GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar acuerdos' });
  }
});

/** Todas las líneas de producto de acuerdos en estado Activo y vigentes por fecha fin. */
router.get('/acuerdos/productos-activos', async (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const acuerdosItems = [];
    let aKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tableAcuerdos,
        ConsistentRead: true,
        FilterExpression: '#sk = :meta',
        ExpressionAttributeNames: { '#sk': 'SK' },
        ExpressionAttributeValues: { ':meta': 'META' },
        ...(aKey && { ExclusiveStartKey: aKey }),
      }));
      acuerdosItems.push(...(r.Items || []));
      aKey = r.LastEvaluatedKey || null;
    } while (aKey);

    const allDetalles = [];
    let dKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tableAcuerdosDetalles,
        ConsistentRead: true,
        ...(dKey && { ExclusiveStartKey: dKey }),
      }));
      allDetalles.push(...(r.Items || []));
      dKey = r.LastEvaluatedKey || null;
    } while (dKey);

    const detallesPorAcuerdo = {};
    for (const d of allDetalles) {
      if (!detallesPorAcuerdo[d.PK]) detallesPorAcuerdo[d.PK] = [];
      detallesPorAcuerdo[d.PK].push(d);
    }

    const activos = acuerdosItems.filter((a) => {
      if (a.Estado !== 'Activo') return false;
      if (a.FechaFin && a.FechaFin < hoy) return false;
      return true;
    });

    const items = [];
    for (const acuerdo of activos) {
      const pk = acuerdo.PK;
      const detalles = detallesPorAcuerdo[pk] || [];
      if (detalles.length === 0) continue;

      let fechaInicio = acuerdo.FechaInicio || '';
      let fechaFin = acuerdo.FechaFin || '';
      if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
        [fechaInicio, fechaFin] = [fechaFin, fechaInicio];
      }

      const productIds = new Set(detalles.map((d) => String(d.ProductId || d.SK || '').trim()));
      const comprasPorProducto = await queryComprasPorProductos(productIds, fechaInicio, fechaFin);

      for (const d of detalles) {
        const pid = String(d.ProductId ?? d.SK ?? '').trim();
        const acordado = d.Cantidad || 0;
        const compradas = comprasPorProducto[pid] || 0;
        const restante = acordado - compradas;
        const porcentaje = acordado > 0 ? Math.round((compradas / acordado) * 1000) / 10 : 0;
        items.push({
          ...d,
          acuerdoPK: pk,
          MarcaAcuerdo: acuerdo.Marca || '',
          NombreAcuerdo: acuerdo.Nombre || '',
          FechaInicioAcuerdo: fechaInicio,
          FechaFinAcuerdo: fechaFin,
          Compradas: compradas,
          Restante: restante,
          Porcentaje: porcentaje,
        });
      }
    }

    items.sort((a, b) => {
      const m = (a.MarcaAcuerdo || '').localeCompare(b.MarcaAcuerdo || '', 'es');
      if (m !== 0) return m;
      return (a.ProductName || '').localeCompare(b.ProductName || '', 'es');
    });

    return res.json({
      ok: true,
      items,
      totalLineas: items.length,
      acuerdosActivosConProductos: activos.filter((a) => (detallesPorAcuerdo[a.PK] || []).length > 0).length,
    });
  } catch (err) {
    console.error('[acuerdos productos-activos]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar productos de acuerdos activos' });
  }
});

router.get('/acuerdos/totales', async (req, res) => {
  try {
    const acuerdosItems = [];
    let aKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tableAcuerdos,
        ConsistentRead: true,
        FilterExpression: '#sk = :meta',
        ExpressionAttributeNames: { '#sk': 'SK' },
        ExpressionAttributeValues: { ':meta': 'META' },
        ...(aKey && { ExclusiveStartKey: aKey }),
      }));
      acuerdosItems.push(...(r.Items || []));
      aKey = r.LastEvaluatedKey || null;
    } while (aKey);

    const allDetalles = [];
    let dKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tableAcuerdosDetalles,
        ConsistentRead: true,
        ...(dKey && { ExclusiveStartKey: dKey }),
      }));
      allDetalles.push(...(r.Items || []));
      dKey = r.LastEvaluatedKey || null;
    } while (dKey);

    const detallesPorAcuerdo = {};
    for (const d of allDetalles) {
      if (!detallesPorAcuerdo[d.PK]) detallesPorAcuerdo[d.PK] = [];
      detallesPorAcuerdo[d.PK].push(d);
    }

    const result = {};
    const totalesPromises = acuerdosItems.map(async (acuerdo) => {
      const pk = acuerdo.PK;
      const detalles = detallesPorAcuerdo[pk] || [];
      if (detalles.length === 0) {
        result[pk] = { totalAcordado: 0, totalCompradas: 0, porcentaje: 0 };
        return;
      }
      const productIds = new Set(detalles.map((d) => String(d.ProductId || d.SK || '').trim()));
      const fechaInicio = acuerdo.FechaInicio || '';
      const fechaFin = acuerdo.FechaFin || '';

      const comprasPorProd = await queryComprasPorProductos(productIds, fechaInicio, fechaFin);

      let totalAcordado = 0, totalCompradas = 0;
      for (const d of detalles) {
        const pid = String(d.ProductId ?? d.SK ?? '').trim();
        totalAcordado += d.Cantidad || 0;
        totalCompradas += comprasPorProd[pid] || 0;
      }
      const porcentaje = totalAcordado > 0 ? Math.round((totalCompradas / totalAcordado) * 1000) / 10 : 0;
      result[pk] = { totalAcordado, totalCompradas, porcentaje };
    });
    await Promise.all(totalesPromises);

    return res.json({ ok: true, totales: result });
  } catch (err) {
    console.error('[acuerdos totales]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener totales' });
  }
});
router.get('/acuerdos/:id', async (req, res) => {
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tableAcuerdos,
      Key: { PK: req.params.id, SK: 'META' },
      ConsistentRead: true,
    }));
    if (!got.Item) return res.status(404).json({ error: 'Acuerdo no encontrado' });
    return res.json({ ok: true, item: got.Item });
  } catch (err) {
    console.error('[acuerdos GET :id]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener acuerdo' });
  }
});

router.post('/acuerdos', async (req, res) => {
  const body = req.body || {};
  const pk = body.PK || crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    PK: pk,
    SK: 'META',
    Nombre: (body.Nombre || '').trim(),
    Marca: (body.Marca || '').trim(),
    FechaInicio: (body.FechaInicio || '').trim(),
    FechaFin: (body.FechaFin || '').trim(),
    Contacto: (body.Contacto || '').trim(),
    Telefono: (body.Telefono || '').trim(),
    Email: (body.Email || '').trim(),
    Notas: (body.Notas || '').trim(),
    Estado: body.Estado || 'Activo',
    createdAt: now,
    updatedAt: now,
  };
  if (!item.PK) return res.status(400).json({ error: 'El identificador (PK) es obligatorio' });
  if (item.FechaInicio && item.FechaFin && item.FechaInicio > item.FechaFin) {
    return res.status(400).json({ error: 'La fecha de inicio no puede ser mayor que la fecha final' });
  }
  try {
    await docClient.send(new PutCommand({ TableName: tableAcuerdos, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[acuerdos POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear acuerdo' });
  }
});

router.patch('/acuerdos/:id', async (req, res) => {
  const pk = req.params.id;
  const body = req.body || {};
  const FIELDS = ['Nombre', 'Marca', 'FechaInicio', 'FechaFin', 'Contacto', 'Telefono', 'Email', 'Notas', 'Estado'];
  const setParts = ['#updAt = :updAt'];
  const exprNames = { '#updAt': 'updatedAt' };
  const exprValues = { ':updAt': new Date().toISOString() };
  let vi = 0;
  for (const key of FIELDS) {
    if (body[key] === undefined) continue;
    const val = typeof body[key] === 'string' ? body[key].trim() : body[key];
    exprNames[`#f${vi}`] = key;
    exprValues[`:v${vi}`] = val;
    setParts.push(`#f${vi} = :v${vi}`);
    vi++;
  }
  if (vi === 0) return res.status(400).json({ error: 'Indica al menos un campo a actualizar' });
  if (body.FechaInicio !== undefined || body.FechaFin !== undefined) {
    const got = await docClient.send(new GetCommand({ TableName: tableAcuerdos, Key: { PK: pk, SK: 'META' } }));
    const existing = got.Item || {};
    const fechaInicio = body.FechaInicio !== undefined ? String(body.FechaInicio || '').trim() : (existing.FechaInicio || '');
    const fechaFin = body.FechaFin !== undefined ? String(body.FechaFin || '').trim() : (existing.FechaFin || '');
    if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
      return res.status(400).json({ error: 'La fecha de inicio no puede ser mayor que la fecha final' });
    }
  }
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdos,
      Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET ' + setParts.join(', '),
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ConditionExpression: 'attribute_exists(PK)',
    }));
    return res.json({ ok: true, id: pk });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return res.status(404).json({ error: 'Acuerdo no encontrado' });
    console.error('[acuerdos PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar acuerdo' });
  }
});

router.delete('/acuerdos/:id', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({ TableName: tableAcuerdos, Key: { PK: req.params.id, SK: 'META' } }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar acuerdo' });
  }
});

// Detalles de acuerdo (productos asignados)

router.get('/acuerdos/:id/detalles', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAcuerdosDetalles,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': req.params.id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => (a.ProductName || '').localeCompare(b.ProductName || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[acuerdos detalles GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar detalles' });
  }
});

router.get('/acuerdos/:id/detalles-con-compras', async (req, res) => {
  const acuerdoId = req.params.id;
  try {
    const acuerdoRes = await docClient.send(new GetCommand({ TableName: tableAcuerdos, Key: { PK: acuerdoId, SK: 'META' } }));
    const acuerdo = acuerdoRes.Item;
    if (!acuerdo) return res.status(404).json({ error: 'Acuerdo no encontrado' });

    const detalles = [];
    let dKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAcuerdosDetalles,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': acuerdoId },
        ConsistentRead: true,
        ...(dKey && { ExclusiveStartKey: dKey }),
      });
      const r = await docClient.send(cmd);
      detalles.push(...(r.Items || []));
      dKey = r.LastEvaluatedKey || null;
    } while (dKey);

    if (detalles.length === 0) {
      return res.json({ ok: true, items: [], totalAcordado: 0, totalCompradas: 0, totalRestante: 0 });
    }

    const productIds = new Set(detalles.map((d) => String(d.ProductId || d.SK || '').trim()));
    let fechaInicio = acuerdo.FechaInicio || '';
    let fechaFin = acuerdo.FechaFin || '';
    // Garantizar que fechaInicio <= fechaFin para el BETWEEN de DynamoDB
    if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
      [fechaInicio, fechaFin] = [fechaFin, fechaInicio];
    }

    const comprasPorProducto = await queryComprasPorProductos(productIds, fechaInicio, fechaFin);

    let totalAcordado = 0;
    let totalCompradas = 0;
    const items = detalles.map((d) => {
      const acordado = d.Cantidad || 0;
      const pid = String(d.ProductId ?? d.SK ?? '').trim();
      const compradas = comprasPorProducto[pid] || 0;
      const restante = acordado - compradas;
      const porcentaje = acordado > 0 ? Math.round((compradas / acordado) * 1000) / 10 : 0;
      totalAcordado += acordado;
      totalCompradas += compradas;
      return { ...d, Compradas: compradas, Restante: restante, Porcentaje: porcentaje };
    });
    items.sort((a, b) => (a.ProductName || '').localeCompare(b.ProductName || ''));

    return res.json({ ok: true, items, totalAcordado, totalCompradas, totalRestante: totalAcordado - totalCompradas });
  } catch (err) {
    console.error('[acuerdos detalles-con-compras]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener detalles con compras' });
  }
});

router.post('/acuerdos/:id/detalles', async (req, res) => {
  const pk = req.params.id;
  const body = req.body || {};
  const productId = (body.ProductId || '').trim();
  const productName = (body.ProductName || '').trim();
  const cantidad = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(body.Cantidad) || 0;
  if (!productId) return res.status(400).json({ error: 'ProductId es obligatorio' });
  const now = new Date().toISOString();
  const aportacion = typeof body.Aportacion === 'number' ? body.Aportacion : parseFloat(body.Aportacion) || 0;
  const rappel = typeof body.Rappel === 'number' ? body.Rappel : parseFloat(body.Rappel) || 0;
  const descuentoExtra = typeof body.DescuentoExtra === 'number' ? body.DescuentoExtra : parseFloat(body.DescuentoExtra) || 0;
  const item = {
    PK: pk,
    SK: productId,
    ProductId: productId,
    ProductName: productName,
    Cantidad: cantidad,
    Aportacion: aportacion,
    Rappel: rappel,
    DescuentoExtra: descuentoExtra,
    createdAt: now,
  };
  try {
    await docClient.send(new PutCommand({ TableName: tableAcuerdosDetalles, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[acuerdos detalles POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al añadir producto' });
  }
});

router.patch('/acuerdos/:id/detalles/:productId', async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = {};
  if (body.Cantidad !== undefined) { const v = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(body.Cantidad) || 0; updates.push('Cantidad = :c'); values[':c'] = v; }
  if (body.Aportacion !== undefined) { const v = typeof body.Aportacion === 'number' ? body.Aportacion : parseFloat(body.Aportacion) || 0; updates.push('Aportacion = :ap'); values[':ap'] = v; }
  if (body.Rappel !== undefined) { const v = typeof body.Rappel === 'number' ? body.Rappel : parseFloat(body.Rappel) || 0; updates.push('Rappel = :ra'); values[':ra'] = v; }
  if (body.DescuentoExtra !== undefined) { const v = typeof body.DescuentoExtra === 'number' ? body.DescuentoExtra : parseFloat(body.DescuentoExtra) || 0; updates.push('DescuentoExtra = :de'); values[':de'] = v; }
  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdosDetalles,
      Key: { PK: req.params.id, SK: req.params.productId },
      UpdateExpression: 'SET ' + updates.join(', '),
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(PK)',
    }));
    return res.json({ ok: true });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return res.status(404).json({ error: 'Detalle no encontrado' });
    console.error('[acuerdos detalles PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar detalle' });
  }
});

router.delete('/acuerdos/:id/detalles/:productId', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableAcuerdosDetalles,
      Key: { PK: req.params.id, SK: req.params.productId },
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos detalles DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar producto' });
  }
});

router.get('/acuerdos/:id/seguimiento', async (req, res) => {
  const id = req.params.id;
  try {
    const getRes = await docClient.send(new GetCommand({ TableName: tableAcuerdos, Key: { PK: id, SK: 'META' } }));
    const acuerdo = getRes.Item;
    if (!acuerdo) return res.status(404).json({ error: 'Acuerdo no encontrado' });

    const detallesItems = [];
    let dKey = null;
    do {
      const dCmd = new QueryCommand({
        TableName: tableAcuerdosDetalles,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': id },
        ...(dKey && { ExclusiveStartKey: dKey }),
      });
      const dResult = await docClient.send(dCmd);
      detallesItems.push(...(dResult.Items || []));
      dKey = dResult.LastEvaluatedKey || null;
    } while (dKey);

    const productIds = new Set(detallesItems.map((p) => String(p.ProductId || p.SK || '').trim()).filter(Boolean));
    if (productIds.size === 0) {
      return res.json({ ok: true, acuerdo, compras: [], resumenProductos: [], totalUnidades: 0, objetivo: acuerdo.ObjetivoUnidades || 0, porcentaje: 0 });
    }

    const fechaInicio = acuerdo.FechaInicio || '';
    const fechaFin = acuerdo.FechaFin || '';

    const comprasPorProd = await queryComprasPorProductos(productIds, fechaInicio, fechaFin);

    const totalUnidades = Object.values(comprasPorProd).reduce((sum, qty) => sum + qty, 0);
    const objetivo = acuerdo.ObjetivoUnidades || 0;
    const porcentaje = objetivo > 0 ? Math.min((totalUnidades / objetivo) * 100, 100) : 0;

    const resumenProductos = [...productIds].map((pid) => {
      const det = detallesItems.find((d) => String(d.ProductId || d.SK || '').trim() === pid);
      return {
        ProductId: pid,
        ProductName: det?.ProductName || pid,
        totalUnidades: comprasPorProd[pid] || 0,
        totalImporte: 0,
      };
    }).filter((r) => r.totalUnidades > 0);

    return res.json({
      ok: true,
      acuerdo,
      compras: [],
      resumenProductos,
      totalUnidades,
      objetivo,
      porcentaje: Math.round(porcentaje * 100) / 100,
    });
  } catch (err) {
    console.error('[acuerdos seguimiento]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener seguimiento' });
  }
});

// ──────────────────────────────────────────
// Acuerdos - Pagos por Imagen
// ──────────────────────────────────────────

router.get('/acuerdos/:id/imagen', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableAcuerdosImagen,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': req.params.id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const r = await docClient.send(cmd);
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[acuerdos imagen GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener pagos por imagen' });
  }
});

router.post('/acuerdos/:id/imagen', async (req, res) => {
  const body = req.body || {};
  const sk = crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    PK: req.params.id,
    SK: sk,
    Locales: Array.isArray(body.Locales) ? body.Locales : [],
    Acciones: Array.isArray(body.Acciones) ? body.Acciones : [],
    Importe: typeof body.Importe === 'number' ? body.Importe : parseFloat(body.Importe) || 0,
    Justificantes: Array.isArray(body.Justificantes) ? body.Justificantes : [],
    Descripcion: body.Descripcion || '',
    Realizado: body.Realizado === true,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await docClient.send(new PutCommand({ TableName: tableAcuerdosImagen, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[acuerdos imagen POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear pago por imagen' });
  }
});

router.patch('/acuerdos/:id/imagen/:sk', async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = {};
  const names = {};
  if (body.Locales !== undefined) { updates.push('#lo = :lo'); values[':lo'] = Array.isArray(body.Locales) ? body.Locales : []; names['#lo'] = 'Locales'; }
  if (body.Acciones !== undefined) { updates.push('#ac = :ac'); values[':ac'] = Array.isArray(body.Acciones) ? body.Acciones : []; names['#ac'] = 'Acciones'; }
  if (body.Importe !== undefined) { updates.push('Importe = :im'); values[':im'] = typeof body.Importe === 'number' ? body.Importe : parseFloat(body.Importe) || 0; }
  if (body.Justificantes !== undefined) { updates.push('Justificantes = :ju'); values[':ju'] = Array.isArray(body.Justificantes) ? body.Justificantes : []; }
  if (body.Descripcion !== undefined) { updates.push('Descripcion = :de'); values[':de'] = body.Descripcion || ''; }
  if (body.Realizado !== undefined) { updates.push('Realizado = :re'); values[':re'] = body.Realizado === true; }
  updates.push('updatedAt = :ua'); values[':ua'] = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdosImagen,
      Key: { PK: req.params.id, SK: req.params.sk },
      UpdateExpression: 'SET ' + updates.join(', '),
      ExpressionAttributeValues: values,
      ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos imagen PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar pago por imagen' });
  }
});

router.delete('/acuerdos/:id/imagen/:sk', async (req, res) => {
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableAcuerdosImagen,
      Key: { PK: req.params.id, SK: req.params.sk },
    }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[acuerdos imagen DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar pago por imagen' });
  }
});

// ──────────────────────────────────────────
// ──────────────────────────────────────────
// Archivos de Acuerdos  (S3 + metadata en DynamoDB)
// ──────────────────────────────────────────

router.post('/acuerdos/:id/files/presign-upload', async (req, res) => {
  try {
    const { id } = req.params;
    const { fileName, contentType } = req.body;
    if (!fileName || !contentType) return res.status(400).json({ error: 'fileName y contentType requeridos' });

    const fileKey = `acuerdos/${id}/${Date.now()}_${fileName}`;
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: fileKey,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    res.json({ uploadUrl, fileKey });
  } catch (err) {
    console.error('presign-upload error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/acuerdos/:id/files', async (req, res) => {
  try {
    const { id } = req.params;
    const { fileKey, fileName, contentType, size } = req.body;
    if (!fileKey || !fileName) return res.status(400).json({ error: 'fileKey y fileName requeridos' });

    const acuerdoRes = await docClient.send(new GetCommand({
      TableName: tableAcuerdos,
      Key: { PK: id, SK: 'META' },
    }));
    const acuerdo = acuerdoRes.Item;
    if (!acuerdo) return res.status(404).json({ error: 'Acuerdo no encontrado' });

    const archivos = acuerdo.Archivos || [];
    archivos.push({ fileKey, fileName, contentType: contentType || '', size: size || 0, uploadedAt: new Date().toISOString() });

    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdos,
      Key: { PK: id, SK: 'META' },
      UpdateExpression: 'SET Archivos = :a',
      ExpressionAttributeValues: { ':a': archivos },
    }));

    res.json({ archivos });
  } catch (err) {
    console.error('save file meta error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/acuerdos/:id/files', async (req, res) => {
  try {
    const { id } = req.params;
    const acuerdoRes = await docClient.send(new GetCommand({
      TableName: tableAcuerdos,
      Key: { PK: id, SK: 'META' },
    }));
    const archivos = acuerdoRes.Item?.Archivos || [];

    const withUrls = await Promise.all(archivos.map(async (f) => {
      const cmd = new S3GetObjectCommand({ Bucket: S3_BUCKET, Key: f.fileKey });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      return { ...f, url };
    }));

    res.json(withUrls);
  } catch (err) {
    console.error('list files error', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/acuerdos/:id/files/:encodedKey', async (req, res) => {
  try {
    const { id, encodedKey } = req.params;
    const fileKey = decodeURIComponent(encodedKey);

    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: fileKey }));

    const acuerdoRes = await docClient.send(new GetCommand({
      TableName: tableAcuerdos,
      Key: { PK: id, SK: 'META' },
    }));
    const archivos = (acuerdoRes.Item?.Archivos || []).filter(f => f.fileKey !== fileKey);

    await docClient.send(new UpdateCommand({
      TableName: tableAcuerdos,
      Key: { PK: id, SK: 'META' },
      UpdateExpression: 'SET Archivos = :a',
      ExpressionAttributeValues: { ':a': archivos },
    }));

    res.json({ ok: true, archivos });
  } catch (err) {
    console.error('delete file error', err);
    res.status(500).json({ error: err.message });
  }
});


export default router;
