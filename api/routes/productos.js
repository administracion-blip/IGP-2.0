import { Router } from 'express';
import { ScanCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = Router();
const tableProductosName = tables.productos;

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

router.get('/productos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableProductosName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    res.json({ productos: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar productos' });
  }
});

router.post('/productos', async (req, res) => {
  const body = req.body || {};
  const nombreVal = body.Nombre ?? body.nombre ?? '';
  if (!String(nombreVal).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  try {
    const item = { id_producto: body.id_producto != null ? formatId6(body.id_producto) : formatId6(1) };
    for (const key of Object.keys(body)) {
      if (key === 'id_producto') continue;
      item[key] = body[key] != null && body[key] !== '' ? String(body[key]) : '';
    }
    await docClient.send(new PutCommand({
      TableName: tableProductosName,
      Item: item,
    }));
    res.json({ ok: true, producto: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el producto' });
  }
});

router.put('/productos', async (req, res) => {
  const body = req.body || {};
  const idProducto = body.id_producto != null ? String(body.id_producto) : '';
  if (!idProducto) return res.status(400).json({ error: 'id_producto es obligatorio para editar' });
  const nombreVal = body.Nombre ?? body.nombre ?? '';
  if (!String(nombreVal).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  try {
    const getCmd = new GetCommand({
      TableName: tableProductosName,
      Key: { id_producto: idProducto },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = { id_producto: idProducto };
    const allKeys = new Set([...Object.keys(existing), ...Object.keys(body)]);
    for (const key of allKeys) {
      if (key === 'id_producto') continue;
      if (body[key] !== undefined) {
        item[key] = body[key] != null && body[key] !== '' ? String(body[key]) : '';
      } else {
        item[key] = existing[key] != null ? String(existing[key]) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableProductosName,
      Item: item,
    }));
    res.json({ ok: true, producto: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el producto' });
  }
});

router.delete('/productos', async (req, res) => {
  const idProducto = req.body?.id_producto != null ? String(req.body.id_producto) : req.query?.id_producto != null ? String(req.query.id_producto) : '';
  if (!idProducto) return res.status(400).json({ error: 'id_producto es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableProductosName,
      Key: { id_producto: idProducto },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el producto' });
  }
});

export default router;
