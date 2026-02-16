import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env.local') });
dotenv.config({ path: join(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { exportSystemCloseOuts } from './lib/agora/client.js';
import { upsertBatch } from './lib/dynamo/salesCloseOuts.js';

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

// Health check para verificar que el API está en marcha
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'API ERP OK', port: process.env.PORT || 3001 });
});

const region = process.env.AWS_REGION || 'eu-west-1';
const tableName = process.env.DDB_USUARIOS || process.env.DYNAMODB_TABLE || 'igp_usuarios';
const tableLocalesName = process.env.DDB_LOCALES || 'igp_Locales';
const tableEmpresasName = process.env.DDB_EMPRESAS || 'igp_Empresas';
const tableProductosName = process.env.DDB_PRODUCTOS || 'igp_Productos';
const tableSalesCloseOutsName = process.env.DDB_SALES_CLOSEOUTS_TABLE || 'Igp_SalesCloseouts';
const tableSaleCentersName = process.env.DDB_SALE_CENTERS_TABLE || 'Igp_SaleCenters';
const tableMantenimientoName = process.env.DDB_MANTENIMIENTO_TABLE || 'Igp_Mantenimiento';
const tableRolesPermisosName = process.env.DDB_ROLES_PERMISOS_TABLE || 'Igp_RolesPermisos';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

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

function normalizeCif(val) {
  return String(val ?? '').trim().toUpperCase();
}

// Estructura exacta de la tabla igp_usuarios en AWS: solo estos atributos. No crear otros.
const TABLE_USUARIOS_ATTRS = ['id_usuario', 'Nombre', 'Apellidos', 'Email', 'Password', 'Telefono', 'Rol', 'Local'];

// Estructura exacta de la tabla igp_Locales en AWS (orden: id_Locales, nombre, agoraCode, empresa, ...).
const TABLE_LOCALES_ATTRS = ['id_Locales', 'nombre', 'agoraCode', 'empresa', 'direccion', 'cp', 'municipio', 'provincia', 'almacen origen', 'sede', 'lat', 'lng', 'imagen'];

// Estructura exacta de la tabla igp_Empresas en AWS (clave de partición id_empresa; orden de columnas).
const TABLE_EMPRESAS_ATTRS = ['id_empresa', 'Nombre', 'Cif', 'Iban', 'IbanAlternativo', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Email', 'Telefono', 'Tipo de recibo', 'Vencimiento', 'Etiqueta', 'Cuenta contable', 'Administrador', 'Sede', 'CCC'];

// Estructura de la tabla igp_Productos en AWS (clave de partición id_producto).
const TABLE_PRODUCTOS_ATTRS = ['id_producto', 'Identificacion', 'Nombre', 'CostoPrecio'];

// Tabla DynamoDB: atributos Email, Password; opcionales Nombre, id_usuario
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan email o password' });
  }

  const emailNorm = email.trim().toLowerCase();

  try {
    const cmd = new ScanCommand({
      TableName: tableName,
      FilterExpression: '#Email = :email AND #Password = :password',
      ExpressionAttributeNames: { '#Email': 'Email', '#Password': 'Password' },
      ExpressionAttributeValues: {
        ':email': emailNorm,
        ':password': password,
      },
    });

    const result = await docClient.send(cmd);
    const items = result.Items || [];

    if (items.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = items[0];
    res.json({
      user: {
        id_usuario: user.id_usuario ?? user.Email ?? '',
        email: user.Email ?? '',
        Nombre: user.Nombre ?? user.Email ?? user.email ?? '',
        Rol: user.Rol ?? '',
      },
    });
  } catch (err) {
    console.error('DynamoDB error:', err);
    const message = err.message || 'Error al verificar credenciales';
    res.status(500).json({ error: message });
  }
});

// Listar usuarios (campos de la tabla, sin Password)
app.get('/api/usuarios', async (req, res) => {
  try {
    const cmd = new ScanCommand({
      TableName: tableName,
    });
    const result = await docClient.send(cmd);
    const items = result.Items || [];
    const usuarios = items.map((item) => {
      const out = {};
      for (const key of TABLE_USUARIOS_ATTRS) {
        if (key === 'Password') continue;
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

// Crear usuario (guardar en DynamoDB). Solo se escriben atributos de TABLE_USUARIOS_ATTRS.
app.post('/api/usuarios', async (req, res) => {
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
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }

    const cmd = new PutCommand({
      TableName: tableName,
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
app.put('/api/usuarios', async (req, res) => {
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
      TableName: tableName,
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
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }

    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: item,
    }));
    res.json({ ok: true, usuario: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el usuario' });
  }
});

// Borrar usuario por id_usuario (clave de la tabla).
app.delete('/api/usuarios', async (req, res) => {
  const idUsuario = req.body?.id_usuario != null ? String(req.body.id_usuario) : req.query?.id_usuario != null ? String(req.query.id_usuario) : '';
  if (!idUsuario) {
    return res.status(400).json({ error: 'id_usuario es obligatorio para borrar' });
  }

  try {
    await docClient.send(new DeleteCommand({
      TableName: tableName,
      Key: { id_usuario: idUsuario },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el usuario' });
  }
});

// --- Locales (tabla igp_Locales) ---
// Acepta body con claves en minúsculas (API) o PascalCase (frontend).
function bodyLocalesVal(body, key) {
  if (body[key] != null && body[key] !== '') return body[key];
  const cap = key.split(' ').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  return body[cap];
}

app.get('/api/locales', async (req, res) => {
  try {
    const minimal = req.query.minimal === '1' || req.query.minimal === 'true';
    if (minimal && cachedLocalesMinimal != null && (Date.now() - cachedLocalesMinimalTime) < CACHE_LOCALES_TTL_MS) {
      return res.json({ locales: cachedLocalesMinimal });
    }
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableLocalesName,
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

app.post('/api/locales', async (req, res) => {
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
      TableName: tableLocalesName,
      Item: item,
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true, local: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar el local' });
  }
});

app.put('/api/locales', async (req, res) => {
  const body = req.body || {};
  const idLocales = (body.id_Locales ?? body.Id_Locales) != null ? String(body.id_Locales ?? body.Id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para editar' });
  if (!bodyLocalesVal(body, 'nombre') || !String(bodyLocalesVal(body, 'nombre')).trim()) return res.status(400).json({ error: 'nombre es obligatorio' });
  try {
    const getCmd = new GetCommand({
      TableName: tableLocalesName,
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
      TableName: tableLocalesName,
      Item: item,
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true, local: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el local' });
  }
});

app.delete('/api/locales', async (req, res) => {
  const idLocales = req.body?.id_Locales != null ? String(req.body.id_Locales) : req.query?.id_Locales != null ? String(req.query.id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableLocalesName,
      Key: { id_Locales: idLocales },
    }));
    cachedLocalesMinimal = null;
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar el local' });
  }
});

// --- Empresas (tabla igp_Empresas) ---

function normalizarEtiqueta(val) {
  if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
  if (val != null && val !== '') return [String(val).trim()];
  return [];
}

app.get('/api/empresas', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const empresas = items.map((item) => {
      if (!item) return {};
      const out = { ...item };
      if (out.Etiqueta == null && out.Alias != null) out.Etiqueta = normalizarEtiqueta(out.Alias);
      if (out.Etiqueta != null && !Array.isArray(out.Etiqueta)) out.Etiqueta = normalizarEtiqueta(out.Etiqueta);
      return out;
    });
    res.json({ empresas });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar empresas' });
  }
});

// Comprobar si un CIF ya existe (para validación en tiempo real)
app.get('/api/empresas/check-cif', async (req, res) => {
  const cif = normalizeCif(req.query?.cif);
  const excludeId = req.query?.excludeId != null ? String(req.query.excludeId).trim() : '';
  if (!cif) return res.status(400).json({ error: 'cif es obligatorio' });
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const exists = items.some((item) => {
      const itemCif = normalizeCif(item?.Cif);
      return itemCif && itemCif === cif && String(item.id_empresa ?? '') !== excludeId;
    });
    return res.json({ exists });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al comprobar CIF' });
  }
});

app.post('/api/empresas', async (req, res) => {
  const body = req.body || {};
  if (!body.Nombre || !String(body.Nombre).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  if (!body.Cif || !String(body.Cif).trim()) {
    return res.status(400).json({ error: 'CIF es obligatorio' });
  }
  const cifValue = normalizeCif(body.Cif);
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const dup = items.some((item) => normalizeCif(item?.Cif) === cifValue);
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') {
        const v = body.id_empresa;
        item[key] = v != null ? formatId6(v) : '000000';
      } else if (key === 'Etiqueta') {
        item[key] = normalizarEtiqueta(body[key]);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableEmpresasName,
      Item: item,
    }));
    res.json({ ok: true, empresa: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar la empresa' });
  }
});

app.put('/api/empresas', async (req, res) => {
  const body = req.body || {};
  const idEmpresa = body.id_empresa != null ? String(body.id_empresa) : '';
  if (!idEmpresa) return res.status(400).json({ error: 'id_empresa es obligatorio para editar' });
  if (!body.Nombre || !String(body.Nombre).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  if (!body.Cif || !String(body.Cif).trim()) return res.status(400).json({ error: 'CIF es obligatorio' });
  const cifValue = normalizeCif(body.Cif);
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const dup = items.find(
      (item) => normalizeCif(item?.Cif) === cifValue && String(item.id_empresa ?? '') !== idEmpresa
    );
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const getCmd = new GetCommand({
      TableName: tableEmpresasName,
      Key: { id_empresa: idEmpresa },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') item[key] = idEmpresa;
      else if (key === 'Etiqueta') {
        item[key] = body[key] != null ? normalizarEtiqueta(body[key]) : normalizarEtiqueta(existing[key] ?? existing.Alias);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableEmpresasName,
      Item: item,
    }));
    res.json({ ok: true, empresa: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar la empresa' });
  }
});

app.delete('/api/empresas', async (req, res) => {
  const idEmpresa = req.body?.id_empresa != null ? String(req.body.id_empresa) : req.query?.id_empresa != null ? String(req.query.id_empresa) : '';
  if (!idEmpresa) return res.status(400).json({ error: 'id_empresa es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableEmpresasName,
      Key: { id_empresa: idEmpresa },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar la empresa' });
  }
});

// --- Productos (tabla igp_Productos en AWS) ---
app.get('/api/productos', async (req, res) => {
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

app.post('/api/productos', async (req, res) => {
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

app.put('/api/productos', async (req, res) => {
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

app.delete('/api/productos', async (req, res) => {
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

// Autocompletado de direcciones: Google Places (si hay key) + fallback Nominatim (OpenStreetMap)
const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || '';
const NOMINATIM_USER_AGENT = 'Tabolize-ERP/1.0';

async function fetchNominatimSuggestions(input) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(input)}&format=json&addressdetails=1&limit=5`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': NOMINATIM_USER_AGENT },
  });
  const data = await resp.json();
  if (!Array.isArray(data)) return [];
  return data.map((r) => ({
    description: r.display_name || '',
    place_id: `nominatim:${r.osm_type || 'node'}:${r.osm_id || ''}`,
    lat: r.lat != null ? parseFloat(r.lat) : undefined,
    lng: r.lon != null ? parseFloat(r.lon) : undefined,
  }));
}

app.get('/api/places/autocomplete', async (req, res) => {
  const input = (req.query.input || '').toString().trim();
  if (!input || input.length < 2) {
    return res.json({ predictions: [] });
  }

  let predictions = [];
  let configOk = true;

  if (googleMapsKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${googleMapsKey}&language=es`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.status === 'OK' && Array.isArray(data.predictions) && data.predictions.length > 0) {
        predictions = (data.predictions || []).map((p) => ({
          description: p.description || '',
          place_id: p.place_id || '',
        }));
        return res.json({ predictions });
      }
    } catch (err) {
      console.error('Places autocomplete error:', err);
    }
  } else {
    configOk = false;
  }

  try {
    predictions = await fetchNominatimSuggestions(input);
  } catch (err) {
    console.error('Nominatim autocomplete error:', err);
  }

  res.json({ predictions, configOk: configOk ? undefined : false });
});

app.get('/api/places/details', async (req, res) => {
  const placeId = (req.query.place_id || '').toString().trim();
  if (!placeId || !googleMapsKey) {
    return res.json({ lat: null, lng: null });
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=geometry&key=${googleMapsKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const loc = data.result?.geometry?.location;
    if (!loc) return res.json({ lat: null, lng: null });
    res.json({ lat: loc.lat, lng: loc.lng });
  } catch (err) {
    console.error('Places details error:', err);
    res.json({ lat: null, lng: null });
  }
});

// Código postal → municipio y provincia (GeoAPI España o fallback Zippopotam)
const geoApiKey = process.env.GEOAPI_KEY || process.env.GEOAPI_ES_KEY || '';

function getGeoApiName(item) {
  if (!item || typeof item !== 'object') return '';
  return item.NM ?? item.NOMBRE ?? item.name ?? item.nombre ?? '';
}

async function fetchZippopotam(cp) {
  const url = `https://api.zippopotam.us/es/${encodeURIComponent(cp)}`;
  const resp = await fetch(url);
  if (!resp.ok) return { municipio: '', provincia: '' };
  const data = await resp.json();
  const places = data.places;
  if (!Array.isArray(places) || places.length === 0) return { municipio: '', provincia: '' };
  const first = places[0];
  const municipio = (first['place name'] ?? first.place_name ?? '').trim();
  const provincia = (first.state ?? '').trim();
  return { municipio, provincia };
}

app.get('/api/codigo-postal', async (req, res) => {
  const cp = (req.query.cp || '').toString().trim().replace(/\s/g, '');
  if (!cp || !/^\d{5}$/.test(cp)) {
    return res.json({ municipio: '', provincia: '' });
  }
  let municipio = '';
  let provincia = '';

  if (geoApiKey) {
    try {
      const [provResp, muniResp] = await Promise.all([
        fetch(`https://apiv1.geoapi.es/provincias/?CPOS=${encodeURIComponent(cp)}&FORMAT=json&KEY=${encodeURIComponent(geoApiKey)}`),
        fetch(`https://apiv1.geoapi.es/municipios/?CPOS=${encodeURIComponent(cp)}&FORMAT=json&KEY=${encodeURIComponent(geoApiKey)}`),
      ]);
      const provData = await provResp.json();
      const muniData = await muniResp.json();
      const provList = Array.isArray(provData) ? provData : (provData?.data ?? provData?.results ?? []);
      const muniList = Array.isArray(muniData) ? muniData : (muniData?.data ?? muniData?.results ?? []);
      provincia = getGeoApiName(provList[0]) || '';
      municipio = getGeoApiName(muniList[0]) || '';
    } catch (err) {
      console.error('Codigo postal GeoAPI error:', err);
    }
  }

  if (!municipio && !provincia) {
    try {
      const z = await fetchZippopotam(cp);
      municipio = z.municipio;
      provincia = z.provincia;
    } catch (err) {
      console.error('Codigo postal Zippopotam error:', err);
    }
  }

  res.json({ municipio, provincia });
});

// --- Verificación de conexión con la API de Agora (antes de crear tablas/sincronizar) ---
const AGORA_API_BASE_URL = process.env.AGORA_API_BASE_URL || '';
const AGORA_API_TOKEN = process.env.AGORA_API_TOKEN || '';

app.get('/api/agora/test-connection', async (req, res) => {
  const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (AGORA_API_TOKEN || '').trim();

  if (!baseUrl) {
    return res.status(400).json({
      ok: false,
      error: 'Falta AGORA_API_BASE_URL en .env.local (ej: http://192.168.1.100:8984)',
    });
  }
  if (!token) {
    return res.status(400).json({
      ok: false,
      error: 'Falta AGORA_API_TOKEN en .env.local',
    });
  }

  const url = `${baseUrl}/api/export/?limit=1`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Api-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (r.ok) {
      return res.json({ ok: true, message: 'Conexión con Agora correcta' });
    }
    if (r.status === 401) {
      return res.json({
        ok: false,
        error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.',
      });
    }
    const text = await r.text();
    return res.json({
      ok: false,
      error: `Agora respondió ${r.status}: ${text.slice(0, 200)}`,
    });
  } catch (err) {
    const msg = err.message || String(err);
    return res.json({
      ok: false,
      error: `No se pudo conectar con Agora: ${msg}. Comprueba URL y que el servidor esté accesible.`,
    });
  }
});

app.get('/api/agora/products', async (req, res) => {
  const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (AGORA_API_TOKEN || '').trim();

  if (!baseUrl) {
    return res.status(400).json({
      error: 'Falta AGORA_API_BASE_URL en .env.local (ej: http://192.168.1.100:8984)',
    });
  }
  if (!token) {
    return res.status(400).json({
      error: 'Falta AGORA_API_TOKEN en .env.local',
    });
  }

  const url = `${baseUrl}/api/export-master/?DataType=Products`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Api-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (r.status === 401) {
      return res.status(401).json({
        error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.',
      });
    }
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({
        error: `Agora respondió ${r.status}: ${text.slice(0, 200)}`,
      });
    }

    const rawText = await r.text();
    const contentType = r.headers.get('content-type') || '';
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Agora products] content-type:', contentType);
      console.log('[Agora products] raw (first 600 chars):', rawText.slice(0, 600));
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[Agora products] Response is not JSON (maybe XML?). Full length:', rawText.length);
      }
      return res.status(502).json({
        error: 'Agora no devolvió JSON. Revisa la URL y el formato del API (export-master).',
      });
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[Agora products] Top-level keys:', Object.keys(data));
      const arr = data.Products ?? data.productos ?? data.Items ?? data.data;
      console.log('[Agora products] Array length:', Array.isArray(arr) ? arr.length : typeof arr);
    }

    const productos = Array.isArray(data)
      ? data
      : (data.productos ?? data.Products ?? data.Items ?? data.data ?? []);
    return res.json({ productos });
  } catch (err) {
    const msg = err.message || String(err);
    return res.status(500).json({
      error: `No se pudo conectar con Agora: ${msg}. Comprueba URL y que el servidor esté accesible.`,
    });
  }
});

// Listar puntos de venta guardados en DynamoDB (Igp_SaleCenters). PK=GLOBAL. Datos de WorkplacesSummary.
app.get('/api/agora/sale-centers', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableSaleCentersName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'GLOBAL' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    items.sort((a, b) => String(a.SK ?? '').localeCompare(String(b.SK ?? '')));
    const saleCenters = items.map((i) => ({
      Id: i.Id,
      Nombre: i.Nombre,
      Tipo: i.Tipo,
      Local: i.Local,
      Grupo: i.Grupo,
      Activo: i.Activo !== false,
    }));
    res.json({ saleCenters });
  } catch (err) {
    console.error('[agora/sale-centers list]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar puntos de venta' });
  }
});

// Actualizar Activo de un punto de venta.
app.patch('/api/agora/sale-centers', async (req, res) => {
  const { id, Activo } = req.body || {};
  if (id == null) {
    return res.status(400).json({ error: 'Falta id en el body' });
  }
  if (typeof Activo !== 'boolean') {
    return res.status(400).json({ error: 'Activo debe ser true o false' });
  }
  const sk = String(id);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableSaleCentersName,
        Key: { PK: 'GLOBAL', SK: sk },
        UpdateExpression: 'SET Activo = :activo',
        ExpressionAttributeValues: { ':activo': Activo },
        ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
      })
    );
    return res.json({ ok: true, id, Activo });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: `Punto de venta con id ${id} no encontrado` });
    }
    console.error('[agora/sale-centers PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar punto de venta' });
  }
});

app.post('/api/agora/sale-centers/sync', async (req, res) => {
  const baseUrl = (AGORA_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (AGORA_API_TOKEN || '').trim();

  if (!baseUrl) {
    return res.status(400).json({ error: 'Falta AGORA_API_BASE_URL en .env.local' });
  }
  if (!token) {
    return res.status(400).json({ error: 'Falta AGORA_API_TOKEN en .env.local' });
  }

  const url = `${baseUrl}/api/export-master/?filter=WorkplacesSummary`;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Api-Token': token, 'Content-Type': 'application/json' },
    });

    if (r.status === 401) {
      return res.status(401).json({ error: 'Token inválido o no autorizado. Revisa AGORA_API_TOKEN en Agora.' });
    }
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: `Agora respondió ${r.status}: ${text.slice(0, 200)}` });
    }

    const rawText = await r.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'Agora no devolvió JSON. Revisa el formato del API (export-master WorkplacesSummary).' });
    }

    const summary = data.WorkplacesSummary ?? data.workplacesSummary ?? (Array.isArray(data) ? data : []);
    const rawList = Array.isArray(summary) ? summary : [];

    const items = [];
    for (const workplace of rawList) {
      const localName = String(workplace.Name ?? workplace.name ?? '').trim();
      const posGroups = workplace.PosGroups ?? workplace.posGroups ?? [];
      const groups = Array.isArray(posGroups) ? posGroups : [];
      for (const posGroup of groups) {
        const grupoName = String(posGroup.Name ?? posGroup.name ?? '').trim();
        const grupoNameLower = grupoName.toLowerCase();
        const tipo = grupoNameLower.includes('comandera') ? 'COMANDERA' : 'TPV';
        const pointsOfSale = posGroup.PointsOfSale ?? posGroup.pointsOfSale ?? [];
        const posList = Array.isArray(pointsOfSale) ? pointsOfSale : [];
        for (const pos of posList) {
          const id = pos.Id ?? pos.id;
          if (id == null) continue;
          const sk = String(id);
          items.push({
            PK: 'GLOBAL',
            SK: sk,
            Id: id,
            Nombre: String(pos.Name ?? pos.name ?? '').trim(),
            Tipo: tipo,
            Local: localName,
            Grupo: grupoName,
          });
        }
      }
    }

    let upserted = 0;
    for (const it of items) {
      await docClient.send(
        new UpdateCommand({
          TableName: tableSaleCentersName,
          Key: { PK: 'GLOBAL', SK: it.SK },
          UpdateExpression: 'SET Id = :id, Nombre = :nombre, Tipo = :tipo, #loc = :local, Grupo = :grupo, Activo = if_not_exists(Activo, :true)',
          ExpressionAttributeNames: { '#loc': 'Local' },
          ExpressionAttributeValues: {
            ':id': it.Id,
            ':nombre': it.Nombre,
            ':tipo': it.Tipo,
            ':local': it.Local,
            ':grupo': it.Grupo,
            ':true': true,
          },
        })
      );
      upserted++;
    }
    return res.json({ ok: true, fetched: items.length, upserted });
  } catch (err) {
    console.error('[agora/sale-centers/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar puntos de venta' });
  }
});

// Mapea un SystemCloseOut de Ágora a ítem DynamoDB (PK=workplaceId, SK=businessDay#closeOutNumber).
function mapCloseOutToItem(raw) {
  const workplaceId = String(raw?.WorkplaceId ?? raw?.WokrplaceId ?? '');
  const businessDay = raw?.BusinessDay ?? '';
  const number = raw?.Number ?? '';
  const sk = businessDay && number ? `${businessDay}#${number}` : '';
  const now = new Date().toISOString();
  const amounts = raw?.Amounts ?? {};
  const documents = Array.isArray(raw?.Documents) ? raw.Documents : [];
  const invoicePayments = Array.isArray(raw?.InvoicePayments) ? raw.InvoicePayments : [];
  const ticketPayments = Array.isArray(raw?.TicketPayments) ? raw.TicketPayments : [];
  const deliveryNotePayments = Array.isArray(raw?.DeliveryNotePayments) ? raw.DeliveryNotePayments : [];
  const salesOrderPayments = Array.isArray(raw?.SalesOrderPayments) ? raw.SalesOrderPayments : [];
  return {
    PK: workplaceId,
    SK: sk,
    Number: number,
    BusinessDay: businessDay,
    OpenDate: raw?.OpenDate ?? null,
    CloseDate: raw?.CloseDate ?? null,
    WorkplaceId: workplaceId,
    Amounts: {
      GrossAmount: amounts?.GrossAmount ?? null,
      NetAmount: amounts?.NetAmount ?? null,
      VatAmount: amounts?.VatAmount ?? null,
      SurchargeAmount: amounts?.SurchargeAmount ?? null,
    },
    Documents: documents.map((d) => ({
      Serie: d?.Serie ?? null,
      FirstNumber: d?.FirstNumber ?? null,
      LastNumber: d?.LastNumber ?? null,
      Count: d?.Count ?? null,
      Amount: d?.Amount ?? null,
    })),
    InvoicePayments: invoicePayments.map((p) => ({ MethodName: p?.MethodName ?? null, Amount: p?.Amount ?? null })),
    TicketPayments: ticketPayments.map((p) => ({ MethodName: p?.MethodName ?? null, Amount: p?.Amount ?? null })),
    DeliveryNotePayments: deliveryNotePayments.map((p) => ({ MethodName: p?.MethodName ?? null, Amount: p?.Amount ?? null })),
    SalesOrderPayments: salesOrderPayments.map((p) => ({ MethodName: p?.MethodName ?? null, Amount: p?.Amount ?? null })),
    createdAt: now,
    updatedAt: now,
    source: 'agora',
  };
}

// Listar cierres de ventas guardados (Igp_SalesCloseouts). Query: businessDay (YYYY-MM-DD), workplaceId (PK).
app.get('/api/agora/closeouts', async (req, res) => {
  const businessDay = (req.query.businessDay && String(req.query.businessDay).trim()) || '';
  const workplaceId = (req.query.workplaceId && String(req.query.workplaceId).trim()) || '';
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableSalesCloseOutsName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    let list = items;
    if (workplaceId) list = list.filter((i) => i.PK === workplaceId);
    if (businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      list = list.filter((i) => i.SK && i.SK.startsWith(businessDay));
    }
    list.sort((a, b) => (a.SK || '').localeCompare(b.SK || ''));
    res.json({ closeouts: list });
  } catch (err) {
    console.error('[agora/closeouts list]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar cierres' });
  }
});

app.post('/api/agora/closeouts/sync', async (req, res) => {
  const body = req.body || {};
  const businessDay = body.businessDay ? String(body.businessDay).trim() : '';
  const workplaces = body.workplaces != null ? (Array.isArray(body.workplaces) ? body.workplaces : [body.workplaces]) : null;

  if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'body.businessDay es obligatorio y debe ser YYYY-MM-DD' });
  }

  try {
    const data = await exportSystemCloseOuts(businessDay, workplaces ?? undefined);
    const list = data?.SystemCloseOuts ?? data?.SystemCloseouts ?? data?.systemCloseOuts ?? (Array.isArray(data) ? data : []);
    const rawList = Array.isArray(list) ? list : [];
    const items = rawList.filter((r) => (r?.WorkplaceId ?? r?.WokrplaceId) != null).map(mapCloseOutToItem);
    const upserted = await upsertBatch(docClient, tableSalesCloseOutsName, items);
    return res.json({ ok: true, fetched: rawList.length, upserted, businessDay });
  } catch (err) {
    console.error('[agora/closeouts/sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al sincronizar cierres' });
  }
});

// --- Mantenimiento: Incidencias ---
const ZONAS = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'];
const CATEGORIAS = ['electricidad', 'fontanería', 'frío', 'mobiliario', 'limpieza técnica', 'IT', 'plagas', 'otros'];
const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'];

app.post('/api/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? body.id_Locales ?? '').toString().trim();
  const zona = (body.zona ?? '').toString().trim().toLowerCase();
  const categoria = (body.categoria ?? '').toString().trim().toLowerCase();
  const titulo = (body.titulo ?? '').toString().trim();
  const descripcion = (body.descripcion ?? '').toString().trim();
  const prioridadReportada = (body.prioridad_reportada ?? 'media').toString().trim().toLowerCase();
  const fotos = Array.isArray(body.fotos) ? body.fotos.filter((f) => typeof f === 'string' && f.length > 0).slice(0, 3) : [];
  const creadoPor = (body.creado_por_id_usuario ?? req.headers['x-user-id'] ?? '').toString().trim();

  if (!localId) return res.status(400).json({ error: 'local_id es obligatorio' });
  if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });
  if (!ZONAS.includes(zona)) return res.status(400).json({ error: 'zona no válida' });
  if (!CATEGORIAS.includes(categoria)) return res.status(400).json({ error: 'categoria no válida' });
  if (!PRIORIDADES.includes(prioridadReportada)) return res.status(400).json({ error: 'prioridad_reportada no válida' });

  try {
    const getLocal = await docClient.send(
      new GetCommand({
        TableName: tableLocalesName,
        Key: { id_Locales: localId },
      })
    );
    if (!getLocal.Item) {
      return res.status(400).json({ error: 'Local no encontrado' });
    }

    const uuid = crypto.randomUUID();
    const now = new Date().toISOString();
    const sk = `INC#${now}#${uuid}`;
    const pk = `LOCAL#${localId}`;
    const item = {
      PK: pk,
      SK: sk,
      tipo: 'INC',
      id_incidencia: uuid,
      fecha_creacion: now,
      creado_por_id_usuario: creadoPor || undefined,
      local_id: localId,
      zona,
      categoria,
      titulo,
      descripcion,
      prioridad_reportada: prioridadReportada,
      estado: 'Nuevo',
      ...(fotos.length > 0 && { fotos }),
    };

    await docClient.send(
      new PutCommand({
        TableName: tableMantenimientoName,
        Item: item,
      })
    );
    return res.json({ ok: true, incidencia: item });
  } catch (err) {
    console.error('[mantenimiento/incidencias POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear incidencia' });
  }
});

app.get('/api/mantenimiento/incidencias', async (req, res) => {
  const localId = (req.query.local_id ?? '').toString().trim();
  const creadoPor = (req.query.creado_por ?? '').toString().trim();
  const estado = (req.query.estado ?? '').toString().trim().toUpperCase();

  try {
    let items = [];
    if (localId) {
      let lastKey = null;
      do {
        const cmd = new QueryCommand({
          TableName: tableMantenimientoName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `LOCAL#${localId}`, ':sk': 'INC#' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    } else {
      let lastKey = null;
      do {
        const cmd = new ScanCommand({
          TableName: tableMantenimientoName,
          FilterExpression: 'tipo = :tipo',
          ExpressionAttributeValues: { ':tipo': 'INC' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    }
    if (creadoPor) items = items.filter((i) => (i.creado_por_id_usuario ?? '') === creadoPor);
    if (estado) items = items.filter((i) => (i.estado ?? '') === estado);
    items.sort((a, b) => (b.fecha_creacion || '').localeCompare(a.fecha_creacion || ''));
    const incidencias = items.map((i) => ({
      id_incidencia: i.id_incidencia,
      fecha_creacion: i.fecha_creacion,
      fecha_programada: i.fecha_programada,
      creado_por_id_usuario: i.creado_por_id_usuario,
      local_id: i.local_id,
      zona: i.zona,
      categoria: i.categoria,
      titulo: i.titulo,
      descripcion: i.descripcion,
      prioridad_reportada: i.prioridad_reportada,
      estado: i.estado,
      fotos: i.fotos ?? [],
      fecha_completada: i.FechaCompletada ?? null,
      estado_valoracion: i.EstadoValoracion ?? null,
    }));
    return res.json({ incidencias });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tableMantenimientoName} no existe en DynamoDB. Créala en AWS con PK (String) y SK (String). Ver api/MANTENIMIENTO.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al listar incidencias' });
  }
});

app.patch('/api/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();
  const fechaProgramada = (body.fecha_programada ?? '').toString().trim();
  const marcarReparado = body.marcar_reparado === true;

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  try {
    const pk = `LOCAL#${localId}`;
    const sk = `INC#${fechaCreacion}#${idIncidencia}`;

    if (marcarReparado) {
      const fechaCompletada = new Date().toISOString();
      await docClient.send(
        new UpdateCommand({
          TableName: tableMantenimientoName,
          Key: { PK: pk, SK: sk },
          UpdateExpression: 'SET FechaCompletada = :fc, EstadoValoracion = :ev, #est = :est',
          ExpressionAttributeNames: { '#est': 'estado' },
          ExpressionAttributeValues: { ':fc': fechaCompletada, ':ev': 'Reparado', ':est': 'Reparacion' },
        })
      );
      return res.json({ ok: true });
    }

    if (!fechaProgramada || !/^\d{4}-\d{2}-\d{2}$/.test(fechaProgramada)) {
      await docClient.send(
        new UpdateCommand({
          TableName: tableMantenimientoName,
          Key: { PK: pk, SK: sk },
          UpdateExpression: 'REMOVE fecha_programada',
        })
      );
      return res.json({ ok: true });
    }

    const programada = new Date(fechaProgramada + 'T12:00:00');
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    programada.setHours(0, 0, 0, 0);
    if (programada.getTime() < hoy.getTime()) {
      return res.status(400).json({ error: 'No se puede asignar una fecha anterior al día actual' });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: tableMantenimientoName,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'SET fecha_programada = :fp, #est = :est',
        ExpressionAttributeNames: { '#est': 'estado' },
        ExpressionAttributeValues: { ':fp': fechaProgramada, ':est': 'Programado' },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias PATCH]', msg);
    return res.status(500).json({ error: msg || 'Error al actualizar incidencia' });
  }
});

app.delete('/api/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  try {
    const pk = `LOCAL#${localId}`;
    const sk = `INC#${fechaCreacion}#${idIncidencia}`;

    await docClient.send(
      new DeleteCommand({
        TableName: tableMantenimientoName,
        Key: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[mantenimiento/incidencias DELETE]', msg);
    return res.status(500).json({ error: msg || 'Error al borrar incidencia' });
  }
});

// --- Roles y permisos (tabla Igp_RolesPermisos: PK = ROL#<rol>, SK = PERMISO#<codigo>) ---
app.get('/api/permisos', async (req, res) => {
  const rol = (req.query.rol ?? '').toString().trim();
  if (!rol) {
    return res.json({ permisos: [] });
  }
  const pk = `ROL#${rol}`;
  try {
    let items = [];
    let lastKey = null;
    do {
      const cmd = new QueryCommand({
        TableName: tableRolesPermisosName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': pk, ':sk': 'PERMISO#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const permisos = items.map((i) => (i.SK || '').replace(/^PERMISO#/, '')).filter(Boolean);
    return res.json({ permisos });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tableRolesPermisosName} no existe. Créala en DynamoDB con PK (String) y SK (String). Ver api/ROLES-PERMISOS.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al obtener permisos' });
  }
});

// Listar todos los ítems rol-permiso (para la tabla del módulo Permisos)
app.get('/api/permisos/todos', async (req, res) => {
  try {
    let items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableRolesPermisosName,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: { ':pk': 'ROL#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const list = items.map((i) => ({
      rol: (i.PK || '').replace(/^ROL#/, ''),
      permiso: (i.SK || '').replace(/^PERMISO#/, ''),
    })).filter((x) => x.rol && x.permiso);
    list.sort((a, b) => (a.rol + a.permiso).localeCompare(b.rol + b.permiso));
    return res.json({ items: list });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos/todos GET]', msg);
    if (msg.includes('Requested resource not found') || msg.includes('ResourceNotFoundException')) {
      return res.status(404).json({
        error: `La tabla ${tableRolesPermisosName} no existe. Ver api/ROLES-PERMISOS.md`,
      });
    }
    return res.status(500).json({ error: msg || 'Error al listar permisos' });
  }
});

// Añadir permiso a un rol
app.post('/api/permisos', async (req, res) => {
  const rol = (req.body?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  try {
    await docClient.send(
      new PutCommand({
        TableName: tableRolesPermisosName,
        Item: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos POST]', msg);
    return res.status(500).json({ error: msg || 'Error al añadir permiso' });
  }
});

// Quitar permiso de un rol
app.delete('/api/permisos', async (req, res) => {
  const rol = (req.body?.rol ?? req.query?.rol ?? '').toString().trim();
  const permiso = (req.body?.permiso ?? req.query?.permiso ?? '').toString().trim();
  if (!rol || !permiso) {
    return res.status(400).json({ error: 'rol y permiso son obligatorios' });
  }
  const pk = `ROL#${rol}`;
  const sk = `PERMISO#${permiso}`;
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: tableRolesPermisosName,
        Key: { PK: pk, SK: sk },
      })
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[permisos DELETE]', msg);
    return res.status(500).json({ error: msg || 'Error al borrar permiso' });
  }
});

const port = process.env.PORT || 3001;
const host = '0.0.0.0';
app.listen(port, host, () => {
  console.log(`API ERP escuchando en http://localhost:${port} (también http://127.0.0.1:${port})`);
  console.log(`Tabla usuarios: ${tableName} | Tabla locales: ${tableLocalesName} | Tabla empresas: ${tableEmpresasName} | Tabla productos: ${tableProductosName} | Cierres ventas: ${tableSalesCloseOutsName} | Centros venta: ${tableSaleCentersName} | Mantenimiento: ${tableMantenimientoName} | Roles/permisos: ${tableRolesPermisosName}`);
});
