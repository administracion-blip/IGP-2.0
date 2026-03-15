import { Router } from 'express';
import { ScanCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = Router();
const tableAlmacenesName = tables.almacenes;

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

const TABLE_ALMACENES_ATTRS = ['Id', 'Nombre', 'Descripcion', 'Direccion'];

router.get('/almacenes', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableAlmacenesName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    res.json({ almacenes: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar almacenes' });
  }
});

router.post('/almacenes', async (req, res) => {
  const body = req.body || {};
  if (!body.Nombre || !String(body.Nombre).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  try {
    const item = {};
    for (const key of TABLE_ALMACENES_ATTRS) {
      if (key === 'Id') {
        item[key] = body.Id != null ? formatId6(body.Id) : '000000';
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableAlmacenesName,
      Item: item,
    }));
    res.json({ ok: true, almacen: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el almacén' });
  }
});

router.put('/almacenes', async (req, res) => {
  const body = req.body || {};
  const idAlmacenes = body.Id != null ? String(body.Id) : '';
  if (!idAlmacenes) return res.status(400).json({ error: 'Id es obligatorio para editar' });
  if (!body.Nombre || !String(body.Nombre).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  try {
    const getCmd = new GetCommand({
      TableName: tableAlmacenesName,
      Key: { Id: idAlmacenes },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = {};
    for (const key of TABLE_ALMACENES_ATTRS) {
      if (key === 'Id') item[key] = idAlmacenes;
      else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableAlmacenesName,
      Item: item,
    }));
    res.json({ ok: true, almacen: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el almacén' });
  }
});

router.delete('/almacenes', async (req, res) => {
  const idAlmacenes = req.body?.Id != null ? String(req.body.Id) : req.query?.Id != null ? String(req.query.Id) : '';
  if (!idAlmacenes) return res.status(400).json({ error: 'Id es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableAlmacenesName,
      Key: { Id: idAlmacenes },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el almacén' });
  }
});

export default router;
