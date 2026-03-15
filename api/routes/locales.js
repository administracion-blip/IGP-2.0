import express from 'express';
import { ScanCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();

// Cache en memoria para listado mínimo de locales (dropdowns). TTL 5 min.
let cachedLocalesMinimal = null;
let cachedLocalesMinimalTime = 0;
const CACHE_LOCALES_TTL_MS = 5 * 60 * 1000;

// Formato mínimo 6 dígitos para campos id_ (000001, 000002, ...).
function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

// Estructura exacta de la tabla igp_Locales en AWS (orden: id_Locales, nombre, agoraCode, empresa, ...).
const TABLE_LOCALES_ATTRS = ['id_Locales', 'nombre', 'agoraCode', 'empresa', 'direccion', 'cp', 'municipio', 'provincia', 'almacen origen', 'sede', 'lat', 'lng', 'imagen'];

// Acepta body con claves en minúsculas (API) o PascalCase (frontend).
function bodyLocalesVal(body, key) {
  if (body[key] != null && body[key] !== '') return body[key];
  const cap = key.split(' ').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  if (body[cap] != null && body[cap] !== '') return body[cap];
  // Fallback: "Almacen origen" (solo primera palabra capitalizada, resto original)
  const alt = key.split(' ').map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p)).join(' ');
  return body[alt];
}

router.get('/locales', async (req, res) => {
  try {
    const minimal = req.query.minimal === '1' || req.query.minimal === 'true';
    if (minimal && cachedLocalesMinimal != null && (Date.now() - cachedLocalesMinimalTime) < CACHE_LOCALES_TTL_MS) {
      return res.json({ locales: cachedLocalesMinimal });
    }
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tables.locales,
        ...(minimal && { ProjectionExpression: 'id_Locales, nombre' }),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const locales = items.map((item) => (item ? { ...item } : {}));
    if (minimal) {
      cachedLocalesMinimal = locales;
      cachedLocalesMinimalTime = Date.now();
    }
    res.json({ locales });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar locales' });
  }
});

router.post('/locales', async (req, res) => {
  const body = req.body || {};
  if (!bodyLocalesVal(body, 'nombre') || !String(bodyLocalesVal(body, 'nombre')).trim()) {
    return res.status(400).json({ error: 'nombre es obligatorio' });
  }
  try {
    const item = {};
    for (const key of TABLE_LOCALES_ATTRS) {
      if (key === 'id_Locales') {
        const v = body.id_Locales ?? body.Id_Locales;
        item[key] = v != null ? formatId6(v) : '000000';
      } else {
        const v = bodyLocalesVal(body, key);
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tables.locales,
      Item: item,
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true, local: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el local' });
  }
});

router.put('/locales', async (req, res) => {
  const body = req.body || {};
  const idLocales = (body.id_Locales ?? body.Id_Locales) != null ? String(body.id_Locales ?? body.Id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para editar' });
  if (!bodyLocalesVal(body, 'nombre') || !String(bodyLocalesVal(body, 'nombre')).trim()) return res.status(400).json({ error: 'nombre es obligatorio' });
  try {
    const getCmd = new GetCommand({
      TableName: tables.locales,
      Key: { id_Locales: idLocales },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = {};
    for (const key of TABLE_LOCALES_ATTRS) {
      if (key === 'id_Locales') item[key] = idLocales;
      else {
        const v = bodyLocalesVal(body, key);
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }
    await docClient.send(new PutCommand({
      TableName: tables.locales,
      Item: item,
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true, local: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el local' });
  }
});

router.delete('/locales', async (req, res) => {
  const idLocales = req.body?.id_Locales != null ? String(req.body.id_Locales) : req.query?.id_Locales != null ? String(req.query.id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tables.locales,
      Key: { id_Locales: idLocales },
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el local' });
  }
});

export default router;
