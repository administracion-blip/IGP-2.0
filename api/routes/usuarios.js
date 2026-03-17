import express from 'express';
import { ScanCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();

// Formato mínimo 6 dígitos para campos id_ (000001, 000002, ...).
function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

// Estructura exacta de la tabla igp_usuarios en AWS: solo estos atributos. No crear otros.
const TABLE_USUARIOS_ATTRS = ['id_usuario', 'Nombre', 'Apellidos', 'Email', 'Password', 'Telefono', 'Rol', 'Local'];

// Listar usuarios (campos de la tabla, sin Password)
router.get('/usuarios', async (req, res) => {
  try {
    const cmd = new ScanCommand({
      TableName: tables.usuarios,
    });
    const result = await docClient.send(cmd);
    const items = result.Items || [];
    const usuarios = items.map((item) => {
      const out = {};
      for (const key of TABLE_USUARIOS_ATTRS) {
        if (key === 'Password') continue;
        if (key === 'Local') {
          out[key] = normalizeLocal(item[key]);
          continue;
        }
        if (item[key] !== undefined) out[key] = item[key];
      }
      return out;
    });
    res.json({ usuarios });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar usuarios' });
  }
});

function normalizeLocal(val) {
  if (Array.isArray(val)) return val.filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim());
  if (val != null && String(val).trim() !== '') return [String(val).trim()];
  return [];
}

// Crear usuario (guardar en DynamoDB). Solo se escriben atributos de TABLE_USUARIOS_ATTRS.
router.post('/usuarios', async (req, res) => {
  const body = req.body || {};
  if (!body.Email || !body.Password) {
    return res.status(400).json({ error: 'Email y Password son obligatorios' });
  }

  try {
    const item = {};
    for (const key of TABLE_USUARIOS_ATTRS) {
      if (key === 'id_usuario') {
        const v = body.id_usuario;
        item[key] = v != null ? formatId6(v) : '000000';
      } else if (key === 'Email') {
        item[key] = String(body.Email ?? '').trim().toLowerCase();
      } else if (key === 'Password') {
        item[key] = String(body.Password ?? '');
      } else if (key === 'Local') {
        item[key] = normalizeLocal(body.Local);
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }

    const cmd = new PutCommand({
      TableName: tables.usuarios,
      Item: item,
    });

    await docClient.send(cmd);
    res.json({ ok: true, usuario: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el usuario' });
  }
});

// Actualizar usuario (por id_usuario). Si Password viene vacío, se mantiene el actual.
router.put('/usuarios', async (req, res) => {
  const body = req.body || {};
  const idUsuario = body.id_usuario != null ? String(body.id_usuario) : '';
  if (!idUsuario) {
    return res.status(400).json({ error: 'id_usuario es obligatorio para editar' });
  }
  if (!body.Email || !body.Email.trim()) {
    return res.status(400).json({ error: 'Email es obligatorio' });
  }

  try {
    const getCmd = new GetCommand({
      TableName: tables.usuarios,
      Key: { id_usuario: idUsuario },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};

    const item = {};
    for (const key of TABLE_USUARIOS_ATTRS) {
      if (key === 'id_usuario') {
        item[key] = idUsuario;
      } else if (key === 'Email') {
        item[key] = String(body.Email ?? '').trim().toLowerCase();
      } else if (key === 'Password') {
        const newPass = body.Password != null && String(body.Password).trim() !== '' ? String(body.Password) : (existing.Password ?? '');
        item[key] = newPass;
      } else if (key === 'Local') {
        item[key] = body.Local !== undefined ? normalizeLocal(body.Local) : normalizeLocal(existing.Local);
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }

    await docClient.send(new PutCommand({
      TableName: tables.usuarios,
      Item: item,
    }));
    res.json({ ok: true, usuario: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el usuario' });
  }
});

// Borrar usuario por id_usuario (clave de la tabla).
router.delete('/usuarios', async (req, res) => {
  const idUsuario = req.body?.id_usuario != null ? String(req.body.id_usuario) : req.query?.id_usuario != null ? String(req.query.id_usuario) : '';
  if (!idUsuario) {
    return res.status(400).json({ error: 'id_usuario es obligatorio para borrar' });
  }

  try {
    await docClient.send(new DeleteCommand({
      TableName: tables.usuarios,
      Key: { id_usuario: idUsuario },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el usuario' });
  }
});

export default router;
