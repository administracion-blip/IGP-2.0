import express from 'express';
import { ScanCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';
import { validarRolUsuario } from '../lib/roles.js';
import { hashPassword } from '../lib/password.js';
import { invalidarContextoAcceso } from '../lib/tasks/acceso.js';
import {
  filtrarDepartamentosExistentes,
  normalizarIdsDepartamento,
} from '../lib/tasks/departamentos.js';

const router = express.Router();

// Formato mínimo 6 dígitos para campos id_ (000001, 000002, ...).
function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

// Estructura exacta de la tabla igp_usuarios en AWS: solo estos atributos. No crear otros.
// `Departamentos` queda fuera a propósito: es un atributo **disperso** (D-12), ausente en
// quien no tenga ninguno, y este bucle escribe siempre todo lo que enumera. Se resuelve
// aparte, con `departamentosDelCuerpo`.
const TABLE_USUARIOS_ATTRS = ['id_usuario', 'Nombre', 'Apellidos', 'Email', 'Password', 'Telefono', 'Rol', 'Local'];

/**
 * `Departamentos` es una lista de **IDs** de departamento, al contrario que
 * `Locales`, que guarda nombres (D-12).
 *
 * Los ids que no existan en el maestro se descartan en silencio: no hay
 * integridad referencial y un id fantasma —de un departamento borrado, o de un
 * formulario desfasado— no puede tumbar el alta de un usuario. Los inactivos sí
 * se conservan: siguen siendo una referencia válida de lo ya grabado.
 */
async function departamentosDelCuerpo(valor, existente) {
  if (valor === undefined) return normalizarIdsDepartamento(existente);
  return filtrarDepartamentosExistentes(valor);
}

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
    // Fuera del bucle por ser disperso: la ficha necesita leerlo para poder editarlo.
    if (item.Departamentos !== undefined) {
      out.Departamentos = normalizarIdsDepartamento(item.Departamentos);
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

  const departamentos = await departamentosDelCuerpo(body.Departamentos);
  if (departamentos.length > 0) item.Departamentos = departamentos;

  // El `id_usuario` lo propone el cliente contando la lista que tiene cargada,
  // así que dos altas hechas sobre la misma lista proponen el mismo id. Sin esta
  // condición el segundo `Put` machacaría la ficha entera del primero —email,
  // password, rol, locales y departamentos incluidos— y dejaría a alguien sin
  // poder entrar y sin rastro de por qué.
  const cmd = new PutCommand({
    TableName: tables.usuarios,
    Item: item,
    ConditionExpression: 'attribute_not_exists(id_usuario)',
  });

  try {
    await docClient.send(cmd);
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({
        error: `Ya existe un usuario con el id ${item.id_usuario}. Recarga la lista de usuarios y vuelve a crearlo.`,
      });
    }
    throw err;
  }
  // El contexto de acceso cachea rol, locales y departamentos del usuario.
  invalidarContextoAcceso(item.id_usuario);
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

  // El PUT reconstruye el ítem entero: sin esto, editar el teléfono de alguien
  // le borraría sus departamentos.
  const departamentos = await departamentosDelCuerpo(body.Departamentos, existing.Departamentos);
  if (departamentos.length > 0) item.Departamentos = departamentos;

  await docClient.send(new PutCommand({
    TableName: tables.usuarios,
    Item: item,
  }));
  invalidarContextoAcceso(idUsuario);
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
  invalidarContextoAcceso(idUsuario);
  res.json({ ok: true });
});

export default router;
