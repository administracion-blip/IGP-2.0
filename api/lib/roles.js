import {
  QueryCommand,
  ScanCommand,
  PutCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from './db.js';

export const ROL_META_SK = 'META';
export const ROL_SISTEMA = 'Administrador';

const ROLES_LEGACY_INICIALES = [
  'Administrador',
  'SuperUser',
  'Administracion',
  'Local',
  'Socio',
  'Marketing',
];

/** Normaliza y valida el nombre de rol visible en usuarios y permisos. */
export function normalizarNombreRol(val) {
  const nombre = (val ?? '').toString().trim();
  if (!nombre) return { ok: false, error: 'El nombre del rol es obligatorio' };
  if (nombre.length > 64) return { ok: false, error: 'El nombre del rol no puede superar 64 caracteres' };
  if (nombre.includes('#')) return { ok: false, error: 'El nombre del rol no puede contener #' };
  return { ok: true, nombre };
}

function pkRol(nombre) {
  return `ROL#${nombre}`;
}

function itemMeta(nombre) {
  return {
    PK: pkRol(nombre),
    SK: ROL_META_SK,
    nombre,
  };
}

async function queryItemsPorRol(nombre) {
  let items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tables.rolesPermisos,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pkRol(nombre) },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function scanRolesConPermisos() {
  let items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.rolesPermisos,
        FilterExpression: 'begins_with(PK, :pk) AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': 'ROL#', ':sk': 'PERMISO#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function scanMetaRoles() {
  let items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.rolesPermisos,
        FilterExpression: 'begins_with(PK, :pk) AND SK = :sk',
        ExpressionAttributeValues: { ':pk': 'ROL#', ':sk': ROL_META_SK },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

function mapMetaItem(item) {
  const nombre = item.nombre || (item.PK || '').replace(/^ROL#/, '');
  return {
    nombre,
    descripcion: item.descripcion ?? '',
    sistema: nombre === ROL_SISTEMA || item.sistema === true,
    orden: typeof item.orden === 'number' ? item.orden : 999,
    creadoEn: item.creadoEn ?? null,
  };
}

/** Lista catálogo de roles (META + roles legacy solo con permisos). */
export async function listarRolesCatalogo() {
  const [metaItems, permisoItems] = await Promise.all([
    scanMetaRoles(),
    scanRolesConPermisos(),
  ]);

  const map = new Map();

  for (const item of metaItems) {
    const rol = mapMetaItem(item);
    if (rol.nombre) map.set(rol.nombre, { ...rol, permisosCount: 0 });
  }

  for (const item of permisoItems) {
    const nombre = (item.PK || '').replace(/^ROL#/, '');
    if (!nombre) continue;
    const actual = map.get(nombre) || {
      nombre,
      descripcion: '',
      sistema: nombre === ROL_SISTEMA,
      orden: 999,
      creadoEn: null,
      permisosCount: 0,
    };
    actual.permisosCount = (actual.permisosCount || 0) + 1;
    map.set(nombre, actual);
  }

  const roles = [...map.values()].sort(
    (a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre)
  );
  return roles;
}

export async function obtenerRolMeta(nombre) {
  const result = await docClient.send(
    new QueryCommand({
      TableName: tables.rolesPermisos,
      KeyConditionExpression: 'PK = :pk AND SK = :sk',
      ExpressionAttributeValues: { ':pk': pkRol(nombre), ':sk': ROL_META_SK },
    })
  );
  const item = (result.Items || [])[0];
  if (!item) return null;
  return mapMetaItem(item);
}

export async function rolExisteEnCatalogo(nombre) {
  const meta = await obtenerRolMeta(nombre);
  if (meta) return true;
  const items = await queryItemsPorRol(nombre);
  return items.some((i) => (i.SK || '').startsWith('PERMISO#'));
}

export async function contarUsuariosConRol(nombre) {
  let count = 0;
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.usuarios,
        FilterExpression: '#rol = :rol',
        ExpressionAttributeNames: { '#rol': 'Rol' },
        ExpressionAttributeValues: { ':rol': nombre },
        ProjectionExpression: 'id_usuario',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    count += (result.Items || []).length;
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return count;
}

async function batchDeleteItems(keys) {
  const CHUNK = 25;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tables.rolesPermisos]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
        },
      })
    );
  }
}

export async function crearRol({ nombre, descripcion = '', clonarDe = '', orden = 999 }) {
  const norm = normalizarNombreRol(nombre);
  if (!norm.ok) {
    const err = new Error(norm.error);
    err.status = 400;
    throw err;
  }

  const existe = await obtenerRolMeta(norm.nombre);
  if (existe) {
    const err = new Error('Ya existe un rol con ese nombre');
    err.status = 409;
    throw err;
  }

  const ahora = new Date().toISOString();
  await docClient.send(
    new PutCommand({
      TableName: tables.rolesPermisos,
      Item: {
        ...itemMeta(norm.nombre),
        descripcion: String(descripcion ?? '').trim(),
        sistema: norm.nombre === ROL_SISTEMA,
        orden,
        creadoEn: ahora,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );

  const origen = String(clonarDe ?? '').trim();
  if (origen && origen !== norm.nombre) {
    const origenItems = await queryItemsPorRol(origen);
    const permisos = origenItems
      .map((i) => (i.SK || '').replace(/^PERMISO#/, ''))
      .filter(Boolean);
    for (const permiso of permisos) {
      await docClient.send(
        new PutCommand({
          TableName: tables.rolesPermisos,
          Item: { PK: pkRol(norm.nombre), SK: `PERMISO#${permiso}` },
        })
      );
    }
  }

  return obtenerRolMeta(norm.nombre);
}

export async function actualizarRolMeta(nombre, { descripcion, orden }) {
  const meta = await obtenerRolMeta(nombre);
  if (!meta) {
    const err = new Error('Rol no encontrado');
    err.status = 404;
    throw err;
  }
  if (meta.sistema && nombre === ROL_SISTEMA) {
    // Administrador: solo descripción editable si se desea; orden fijo
  }

  const item = {
    ...itemMeta(nombre),
    descripcion:
      descripcion !== undefined ? String(descripcion).trim() : meta.descripcion,
    sistema: meta.sistema,
    orden: orden !== undefined ? Number(orden) : meta.orden,
    creadoEn: meta.creadoEn,
  };

  await docClient.send(
    new PutCommand({
      TableName: tables.rolesPermisos,
      Item: item,
    })
  );

  return mapMetaItem(item);
}

export async function eliminarRol(nombre) {
  const norm = normalizarNombreRol(nombre);
  if (!norm.ok) {
    const err = new Error(norm.error);
    err.status = 400;
    throw err;
  }

  if (norm.nombre === ROL_SISTEMA) {
    const err = new Error('No se puede eliminar el rol Administrador');
    err.status = 403;
    throw err;
  }

  const meta = await obtenerRolMeta(norm.nombre);
  const items = await queryItemsPorRol(norm.nombre);
  if (!meta && items.length === 0) {
    const err = new Error('Rol no encontrado');
    err.status = 404;
    throw err;
  }

  const usuarios = await contarUsuariosConRol(norm.nombre);
  if (usuarios > 0) {
    const err = new Error(
      `No se puede eliminar: ${usuarios} usuario(s) tienen asignado este rol`
    );
    err.status = 409;
    throw err;
  }

  const keys = items.map((i) => ({ PK: i.PK, SK: i.SK }));
  if (keys.length > 0) await batchDeleteItems(keys);

  return { ok: true };
}

/** Inserta META para roles iniciales si no existen (migración). */
export async function seedRolesCatalogoInicial() {
  const resultados = [];
  for (let i = 0; i < ROLES_LEGACY_INICIALES.length; i += 1) {
    const nombre = ROLES_LEGACY_INICIALES[i];
    const existe = await obtenerRolMeta(nombre);
    if (existe) {
      resultados.push({ nombre, accion: 'omitido' });
      continue;
    }
    await docClient.send(
      new PutCommand({
        TableName: tables.rolesPermisos,
        Item: {
          ...itemMeta(nombre),
          descripcion: '',
          sistema: nombre === ROL_SISTEMA,
          orden: i + 1,
          creadoEn: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    resultados.push({ nombre, accion: 'creado' });
  }
  return resultados;
}

export async function validarRolUsuario(rol) {
  const nombre = (rol ?? '').toString().trim();
  if (!nombre) return { ok: true };
  const existe = await rolExisteEnCatalogo(nombre);
  if (!existe) {
    return { ok: false, error: 'Rol no válido o no registrado en el catálogo' };
  }
  return { ok: true };
}
