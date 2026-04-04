import { Router } from 'express';
import { ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = Router();
const tableAjustesName = tables.ajustes;

router.get('/ajustes', async (req, res) => {
  try {
    const { categoria } = req.query;
    let items = [];
    let lastKey = null;
    if (categoria) {
      do {
        const r = await docClient.send(new QueryCommand({
          TableName: tableAjustesName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': categoria },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        items.push(...(r.Items || []));
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
    } else {
      do {
        const r = await docClient.send(new ScanCommand({ TableName: tableAjustesName, ...(lastKey && { ExclusiveStartKey: lastKey }) }));
        items.push(...(r.Items || []));
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
    }
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[ajustes GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar ajustes' });
  }
});

router.get('/ajustes/:pk/:sk', async (req, res) => {
  try {
    const { pk, sk } = req.params;
    const r = await docClient.send(new GetCommand({ TableName: tableAjustesName, Key: { PK: pk, SK: sk } }));
    if (!r.Item) return res.status(404).json({ error: 'Ajuste no encontrado' });
    return res.json({ ok: true, item: r.Item });
  } catch (err) {
    console.error('[ajustes GET/:pk/:sk]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener ajuste' });
  }
});

router.post('/ajustes', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.PK || !body.SK) return res.status(400).json({ error: 'PK y SK son obligatorios' });
    const item = { ...body, updatedAt: new Date().toISOString() };
    await docClient.send(new PutCommand({ TableName: tableAjustesName, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[ajustes POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear ajuste' });
  }
});

router.patch('/ajustes/:pk/:sk', async (req, res) => {
  try {
    const { pk, sk } = req.params;
    const body = req.body || {};
    const keys = Object.keys(body).filter((k) => k !== 'PK' && k !== 'SK');
    if (keys.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    const exprParts = [];
    const exprValues = {};
    const exprNames = {};
    keys.forEach((k, i) => {
      const alias = `#f${i}`;
      const val = `:v${i}`;
      exprNames[alias] = k;
      exprValues[val] = body[k];
      exprParts.push(`${alias} = ${val}`);
    });
    exprNames['#upd'] = 'updatedAt';
    exprValues[':upd'] = new Date().toISOString();
    exprParts.push('#upd = :upd');

    const r = await docClient.send(new UpdateCommand({
      TableName: tableAjustesName,
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET ' + exprParts.join(', '),
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: 'ALL_NEW',
    }));
    return res.json({ ok: true, item: r.Attributes });
  } catch (err) {
    console.error('[ajustes PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar ajuste' });
  }
});

router.delete('/ajustes/:pk/:sk', async (req, res) => {
  try {
    const { pk, sk } = req.params;
    await docClient.send(new DeleteCommand({ TableName: tableAjustesName, Key: { PK: pk, SK: sk } }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[ajustes DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar ajuste' });
  }
});

export default router;
