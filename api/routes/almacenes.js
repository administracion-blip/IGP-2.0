import { Router } from 'express';
import { ScanCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';
import { invalidarMapaAlmacenes } from '../lib/alcanceAlmacenes.js';

const router = Router();
const tableAlmacenesName = tables.almacenes;

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

const TABLE_ALMACENES_ATTRS = ['Id', 'Nombre', 'NombreFiscal', 'Cif', 'Descripcion', 'Direccion'];

router.get('/almacenes', async (req, res) => {
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
});

router.post('/almacenes', requirePermission('almacenes.crear'), async (req, res) => {
  const body = req.body || {};
  if (!body.Nombre || !String(body.Nombre).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  if (body.Id == null || String(body.Id).trim() === '') {
    return res.status(400).json({ error: 'Id es obligatorio para crear un almacén' });
  }
  const item = {};
  for (const key of TABLE_ALMACENES_ATTRS) {
    if (key === 'Id') {
      item[key] = formatId6(body.Id);
    } else {
      const v = body[key];
      item[key] = v != null && v !== '' ? String(v) : '';
    }
  }
  try {
    await docClient.send(new PutCommand({
      TableName: tableAlmacenesName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(Id)',
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({
        error: `El identificador de almacén ${item.Id} ya está en uso. Recarga la pantalla de almacenes y vuelve a crearlo.`,
      });
    }
    throw err;
  }
  invalidarMapaAlmacenes();
  res.json({ ok: true, almacen: item });
});

router.put('/almacenes', requirePermission('almacenes.editar'), async (req, res) => {
  const body = req.body || {};
  const idAlmacenes = body.Id != null ? String(body.Id) : '';
  if (!idAlmacenes) return res.status(400).json({ error: 'Id es obligatorio para editar' });
  if (!body.Nombre || !String(body.Nombre).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  const getCmd = new GetCommand({
    TableName: tableAlmacenesName,
    Key: { Id: idAlmacenes },
  });
  const got = await docClient.send(getCmd);
  if (!got.Item) return res.status(404).json({ error: 'Almacén no encontrado' });
  const existing = got.Item;
  const item = {};
  for (const key of TABLE_ALMACENES_ATTRS) {
    if (key === 'Id') item[key] = idAlmacenes;
    else {
      const v = body[key];
      item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
    }
  }
  // Sin la condición, un borrado entre el Get y el Put volvería a crear el almacén con solo almacenes.editar.
  try {
    await docClient.send(new PutCommand({
      TableName: tableAlmacenesName,
      Item: item,
      ConditionExpression: 'attribute_exists(Id)',
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: 'Almacén no encontrado' });
    }
    throw err;
  }
  invalidarMapaAlmacenes();
  res.json({ ok: true, almacen: item });
});

router.delete('/almacenes', requirePermission('almacenes.borrar'), async (req, res) => {
  const idAlmacenes = req.body?.Id != null ? String(req.body.Id) : req.query?.Id != null ? String(req.query.Id) : '';
  if (!idAlmacenes) return res.status(400).json({ error: 'Id es obligatorio para borrar' });
  await docClient.send(new DeleteCommand({
    TableName: tableAlmacenesName,
    Key: { Id: idAlmacenes },
  }));
  invalidarMapaAlmacenes();
  res.json({ ok: true });
});

export default router;
