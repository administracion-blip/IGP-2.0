import express from 'express';
import { ScanCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';
import { validarRolUsuario } from '../lib/roles.js';
import { hashPassword } from '../lib/password.js';

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
// [SEC S-05]
router.get('/usuarios', requirePermission('usuarios.ver'), async (req, res) => {
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
});

function normalizeLocal(val) {
  if (Array.isArray(val)) return val.filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim());
  if (val != null && String(val).trim() !== '') return [String(val).trim()];
  return [];
}

// Crear usuario (guardar en DynamoDB). Solo se escriben atributos de TABLE_USUARIOS_ATTRS.
// [SEC S-05]
router.post('/usuarios', requirePermission('usuarios.crear'), async (req, res) => {
  const body = req.body || {};
  if (!body.Email || !body.Password) {
    return res.status(400).json({ error: 'Email y Password son obligatorios' });
  }
  const valRol = await validarRolUsuario(body.Rol);
  if (!valRol.ok) {
    return res.status(400).json({ error: valRol.error });
  }

  const item = {};
  for (const key of TABLE_USUARIOS_ATTRS) {
    if (key === 'id_usuario') {
      const v = body.id_usuario;
      item[key] = v != null ? formatId6(v) : '000000';
    } else if (key === 'Email') {
      item[key] = String(body.Email ?? '').trim().toLowerCase();
    } else if (key === 'Password') {
      // [SEC S-10]
      item[key] = await hashPassword(String(body.Password ?? ''));
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
  const { Password: _, ...safeItem } = item;
  res.json({ ok: true, usuario: safeItem });
});

// Actualizar usuario (por id_usuario). Si Password viene vacío, se mantiene el actual.
// [SEC S-05]
router.put('/usuarios', requirePermission('usuarios.editar'), async (req, res) => {
  const body = req.body || {};
  const idUsuario = body.id_usuario != null ? String(body.id_usuario) : '';
  if (!idUsuario) {
    return res.status(400).json({ error: 'id_usuario es obligatorio para editar' });
  }
  if (!body.Email || !body.Email.trim()) {
    return res.status(400).json({ error: 'Email es obligatorio' });
  }
  if (body.Rol !== undefined) {
    const valRol = await validarRolUsuario(body.Rol);
    if (!valRol.ok) {
      return res.status(400).json({ error: valRol.error });
    }
  }

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
      // [SEC S-10]
      const rawPass = body.Password != null ? String(body.Password).trim() : '';
      if (rawPass) {
        item[key] = await hashPassword(rawPass);
      } else {
        item[key] = existing.Password ?? '';
      }
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
  const { Password: _, ...safeItem } = item;
  res.json({ ok: true, usuario: safeItem });
});

// Borrar usuario por id_usuario (clave de la tabla).
// [SEC S-05]
router.delete('/usuarios', requirePermission('usuarios.borrar'), async (req, res) => {
  const idUsuario = req.body?.id_usuario != null ? String(req.body.id_usuario) : req.query?.id_usuario != null ? String(req.query.id_usuario) : '';
  if (!idUsuario) {
    return res.status(400).json({ error: 'id_usuario es obligatorio para borrar' });
  }

  await docClient.send(new DeleteCommand({
    TableName: tables.usuarios,
    Key: { id_usuario: idUsuario },
  }));
  res.json({ ok: true });
});

export default router;
