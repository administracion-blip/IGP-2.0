import { Router } from 'express';
import { ScanCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';

const router = Router();
const tableProductosName = tables.productos;

// Campos que lee la app (selector de productos de factura-detalle). El resto del body se descarta.
const CAMPOS_PRODUCTO = ['Nombre', 'nombre', 'referencia', 'precio_venta', 'tipo_iva'];

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

function valorCampo(v) {
  return v != null && v !== '' ? String(v) : '';
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

router.post('/productos', requirePermission('productos.editar'), async (req, res) => {
  const body = req.body || {};
  const nombreVal = body.Nombre ?? body.nombre ?? '';
  if (!String(nombreVal).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  const idProducto = formatId6(body.id_producto);
  if (idProducto === '000000') {
    return res.status(400).json({ error: 'id_producto es obligatorio para crear un producto' });
  }
  try {
    const item = { id_producto: idProducto };
    for (const key of CAMPOS_PRODUCTO) {
      if (body[key] !== undefined) item[key] = valorCampo(body[key]);
    }
    await docClient.send(new PutCommand({
      TableName: tableProductosName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(id_producto)',
    }));
    res.json({ ok: true, producto: item });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({ error: `Ya existe un producto con el identificador ${idProducto}. Recarga la lista y usa otro identificador.` });
    }
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el producto' });
  }
});

router.put('/productos', requirePermission('productos.editar'), async (req, res) => {
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
    if (!got.Item) return res.status(404).json({ error: 'Producto no encontrado' });
    const existing = got.Item;
    const item = { id_producto: idProducto };
    for (const key of Object.keys(existing)) {
      if (key === 'id_producto') continue;
      item[key] = existing[key] != null ? String(existing[key]) : '';
    }
    for (const key of CAMPOS_PRODUCTO) {
      if (body[key] !== undefined) item[key] = valorCampo(body[key]);
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

router.delete('/productos', requirePermission('productos.editar'), async (req, res) => {
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
