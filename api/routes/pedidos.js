import express from 'express';
import { ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();

// GET /pedidos
router.get('/pedidos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tables.pedidos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    // Calcular TotalAlbaran como suma de TotalLinea del detalle de cada pedido
    const lineasItems = [];
    let lineasLastKey = null;
    do {
      const lineasResult = await docClient.send(new ScanCommand({
        TableName: tables.pedidosLineas,
        ...(lineasLastKey && { ExclusiveStartKey: lineasLastKey }),
      }));
      lineasItems.push(...(lineasResult.Items || []));
      lineasLastKey = lineasResult.LastEvaluatedKey || null;
    } while (lineasLastKey);

    const totalesPorPedido = {};
    for (const linea of lineasItems) {
      const pid = String(linea.PedidoId ?? '');
      if (!pid) continue;
      const totalLinea = Number(linea.TotalLinea ?? 0);
      totalesPorPedido[pid] = (totalesPorPedido[pid] ?? 0) + totalLinea;
    }

    for (const p of items) {
      const pid = String(p.Id ?? '');
      p.TotalAlbaran = totalesPorPedido[pid] ?? 0;
    }

    items.sort((a, b) => String(b.Fecha ?? b.Id ?? '').localeCompare(String(a.Fecha ?? a.Id ?? '')));
    res.json({ pedidos: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar pedidos' });
  }
});

// POST /pedidos
router.post('/pedidos', async (req, res) => {
  const body = req.body || {};
  const id = body.Id != null ? String(body.Id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio' });
  try {
    const ahora = new Date().toISOString();
    const item = {
      Id: id,
      LocalId: String(body.LocalId ?? '').trim(),
      AlmacenOrigenId: String(body.AlmacenOrigenId ?? '').trim(),
      AlmacenDestinoId: String(body.AlmacenDestinoId ?? '').trim(),
      TotalAlbaran: typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran ?? 0)) || 0,
      Fecha: String(body.Fecha ?? '').trim(),
      Estado: String(body.Estado ?? 'Borrador').trim() || 'Borrador',
      CreadoEn: body.CreadoEn ?? ahora,
      CreadoPor: String(body.CreadoPor ?? '').trim(),
      Notas: String(body.Notas ?? '').trim(),
    };
    await docClient.send(new PutCommand({ TableName: tables.pedidos, Item: item }));
    res.json({ ok: true, pedido: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear pedido' });
  }
});

// PUT /pedidos
router.put('/pedidos', async (req, res) => {
  const body = req.body || {};
  const id = body.Id != null ? String(body.Id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para editar' });
  try {
    const got = await docClient.send(new GetCommand({ TableName: tables.pedidos, Key: { Id: id } }));
    const existing = got.Item || {};
    const item = {
      Id: id,
      LocalId: body.LocalId != null ? String(body.LocalId).trim() : String(existing.LocalId ?? ''),
      AlmacenOrigenId: body.AlmacenOrigenId != null ? String(body.AlmacenOrigenId).trim() : String(existing.AlmacenOrigenId ?? ''),
      AlmacenDestinoId: body.AlmacenDestinoId != null ? String(body.AlmacenDestinoId).trim() : String(existing.AlmacenDestinoId ?? ''),
      TotalAlbaran: body.TotalAlbaran != null ? (typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran)) || 0) : (existing.TotalAlbaran ?? 0),
      Fecha: body.Fecha != null ? String(body.Fecha).trim() : String(existing.Fecha ?? ''),
      Estado: body.Estado != null ? String(body.Estado).trim() : String(existing.Estado ?? 'Borrador'),
      CreadoEn: existing.CreadoEn,
      CreadoPor: existing.CreadoPor,
      Notas: body.Notas != null ? String(body.Notas).trim() : String(existing.Notas ?? ''),
    };
    await docClient.send(new PutCommand({ TableName: tables.pedidos, Item: item }));
    res.json({ ok: true, pedido: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar pedido' });
  }
});

// DELETE /pedidos — borra también todas las líneas (evita huérfanas si se reutiliza el mismo Id)
router.delete('/pedidos', async (req, res) => {
  const id = req.body?.Id != null ? String(req.body.Id).trim() : req.query?.id != null ? String(req.query.id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para borrar' });
  try {
    let lastKey = null;
    do {
      const q = await docClient.send(new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ExpressionAttributeValues: { ':pid': id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const linea of q.Items || []) {
        const pid = String(linea.PedidoId ?? id);
        const li = linea.LineaIndex != null ? String(linea.LineaIndex).trim() : '';
        if (!li) continue;
        await docClient.send(new DeleteCommand({
          TableName: tables.pedidosLineas,
          Key: { PedidoId: pid, LineaIndex: li },
        }));
      }
      lastKey = q.LastEvaluatedKey || null;
    } while (lastKey);

    await docClient.send(new DeleteCommand({ TableName: tables.pedidos, Key: { Id: id } }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar pedido' });
  }
});

// GET /pedidos/:pedidoId/lineas
router.get('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ lineas: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar líneas del pedido' });
  }
});

// GET /pedidos/:pedidoId/details
router.get('/pedidos/:pedidoId/details', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ details: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar detalles del pedido' });
  }
});

// POST /pedidos/:pedidoId/lineas
router.post('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  const body = req.body || {};
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const existing = result.Items || [];
    const maxIdx = existing.reduce((m, i) => {
      const n = parseInt(String(i.LineaIndex ?? '-1'), 10);
      return Number.isNaN(n) ? m : Math.max(m, n);
    }, -1);
    const lineaIndex = String(maxIdx + 1);
    const cantidad = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad ?? 0)) || 0;
    const precioUnitario = typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario ?? 0)) || 0;
    const totalLinea = cantidad * precioUnitario;
    const vatRate = body.VatRate != null ? (typeof body.VatRate === 'number' ? body.VatRate : parseFloat(String(body.VatRate)) || 0) : undefined;
    const totalRappel = body.TotalRappel != null ? (typeof body.TotalRappel === 'number' ? body.TotalRappel : parseFloat(String(body.TotalRappel)) || 0) : undefined;
    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: String(body.ProductId ?? '').trim(),
      ProductoNombre: String(body.ProductoNombre ?? '').trim(),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      TotalLinea: totalLinea,
      Preparada: false,
      ...(vatRate != null && !Number.isNaN(vatRate) && { VatRate: vatRate }),
      ...(totalRappel != null && !Number.isNaN(totalRappel) && { TotalRappel: totalRappel }),
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : undefined,
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : undefined,
      Notas: body.Notas != null ? String(body.Notas).trim() : undefined,
    };
    await docClient.send(new PutCommand({ TableName: tables.pedidosLineas, Item: item }));
    res.json({ ok: true, linea: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear línea' });
  }
});

// PUT /pedidos/:pedidoId/lineas
router.put('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  const body = req.body || {};
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tables.pedidosLineas,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    const existing = got.Item || {};
    const cantidad = body.Cantidad != null ? (typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad)) || 0) : (existing.Cantidad ?? 0);
    const precioUnitario = body.PrecioUnitario != null ? (typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario)) || 0) : (existing.PrecioUnitario ?? 0);
    const totalLinea = cantidad * precioUnitario;
    const preparada = body.Preparada != null ? !!body.Preparada : !!(existing.Preparada ?? false);
    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: body.ProductId != null ? String(body.ProductId).trim() : String(existing.ProductId ?? ''),
      ProductoNombre: body.ProductoNombre != null ? String(body.ProductoNombre).trim() : String(existing.ProductoNombre ?? ''),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      TotalLinea: totalLinea,
      Preparada: preparada,
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : (existing.PurchaseUnitId ?? undefined),
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : (existing.PurchaseUnitName ?? undefined),
      Notas: body.Notas != null ? String(body.Notas).trim() : (existing.Notas ?? undefined),
    };
    await docClient.send(new PutCommand({ TableName: tables.pedidosLineas, Item: item }));
    res.json({ ok: true, linea: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar línea' });
  }
});

// DELETE /pedidos/:pedidoId/lineas
router.delete('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : req.query?.lineaIndex != null ? String(req.query.lineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tables.pedidosLineas,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar línea' });
  }
});

export default router;
