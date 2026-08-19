/**
 * CRUD del calendario informativo de pedidos MIA (v1.1).
 * Tabla Igp_MiaCalendarioPedidos: PK LOCAL# / SK PROVEEDOR#.
 * No conectado al motor calcular ni a jobs.
 */

import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';
import { buildMapaLocalAlmacen } from './localAlmacen.js';
import { normalizeWarehouseId, pkLocal, skProveedor } from './keys.js';

const SIN_PROVEEDOR = 'SIN_PROVEEDOR';

function tableName() {
  return tables.miaCalendarioPedidos;
}

function normalizeLocalId(val) {
  const id = formatId6(val);
  return id && id !== '000000' ? id : '';
}

function normalizeProveedorId(val) {
  return String(val ?? '').trim();
}

function actorLabel(usuario) {
  if (!usuario || typeof usuario !== 'object') return undefined;
  const s = String(
    usuario.email || usuario.Nombre || usuario.nombre || usuario.id_usuario || usuario.sub || '',
  ).trim();
  return s || undefined;
}

function validateDiasSemana(diasSemana) {
  if (!Array.isArray(diasSemana) || diasSemana.length !== 7) {
    throw Object.assign(new Error('diasSemana debe ser un array de 7 booleanos (Lun…Dom)'), {
      status: 400,
    });
  }
  return diasSemana.map((d) => d === true);
}

async function resolveLocalNombre(localId, localNombreHint) {
  const hint = localNombreHint != null ? String(localNombreHint).trim() : '';
  if (hint) return hint;
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.locales,
        Key: { id_Locales: localId },
      }),
    );
    const nombre = String(r.Item?.nombre ?? r.Item?.Nombre ?? '').trim();
    return nombre || '';
  } catch {
    return '';
  }
}

/**
 * Lista entradas de calendario de un local.
 * @param {string|number} localId
 */
export async function listByLocalId(localId) {
  const id = normalizeLocalId(localId);
  const PK = pkLocal(id);
  if (!PK) return [];
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Lista calendario de todos los locales asociados a un almacén (plano).
 * @param {string|number} warehouseId
 */
export async function listByWarehouseId(warehouseId) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') return [];
  const mapa = await buildMapaLocalAlmacen();
  const localIds = mapa.porWarehouseId[wid] || [];
  if (localIds.length === 0) return [];
  const batches = await Promise.all(localIds.map((lid) => listByLocalId(lid)));
  return batches.flat();
}

/**
 * Upsert (Put/merge) de un ítem de calendario.
 * @param {{
 *   localId: string|number,
 *   proveedorId: string|number,
 *   proveedorNombre?: string,
 *   localNombre?: string,
 *   diasSemana: boolean[],
 *   activo?: boolean,
 *   notas?: string,
 * }} input
 * @param {{ usuario?: object }} [opts]
 */
export async function upsert(input, opts = {}) {
  const localId = normalizeLocalId(input?.localId);
  const proveedorId = normalizeProveedorId(input?.proveedorId);
  if (!localId) {
    throw Object.assign(new Error('localId es obligatorio'), { status: 400 });
  }
  if (!proveedorId) {
    throw Object.assign(new Error('proveedorId es obligatorio'), { status: 400 });
  }
  if (proveedorId === SIN_PROVEEDOR) {
    throw Object.assign(new Error('No se puede configurar calendario para SIN_PROVEEDOR'), {
      status: 400,
    });
  }

  const PK = pkLocal(localId);
  const SK = skProveedor(proveedorId);
  if (!PK || !SK) {
    throw Object.assign(new Error('localId o proveedorId inválidos'), { status: 400 });
  }

  const diasSemana = validateDiasSemana(input.diasSemana);

  const existing =
    (
      await docClient.send(
        new GetCommand({ TableName: tableName(), Key: { PK, SK } }),
      )
    ).Item || null;

  const activo = Object.prototype.hasOwnProperty.call(input, 'activo')
    ? input.activo === true || input.activo === 'true'
    : existing
      ? existing.activo !== false
      : true;

  if (activo && !diasSemana.some(Boolean)) {
    throw Object.assign(
      new Error('Si el calendario está activo, debe haber al menos un día de la semana marcado'),
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const LocalNombre = await resolveLocalNombre(localId, input.localNombre);
  const ProveedorNombre =
    input.proveedorNombre != null && String(input.proveedorNombre).trim() !== ''
      ? String(input.proveedorNombre).trim()
      : existing?.ProveedorNombre || proveedorId;

  const Item = {
    ...(existing || {}),
    PK,
    SK,
    LocalId: localId,
    LocalNombre: LocalNombre || existing?.LocalNombre || '',
    ProveedorId: proveedorId,
    ProveedorNombre,
    diasSemana,
    activo,
    updatedAt: now,
    creadoEn: existing?.creadoEn || now,
  };

  if (Object.prototype.hasOwnProperty.call(input, 'notas')) {
    const n = input.notas == null ? '' : String(input.notas).trim();
    if (n) Item.notas = n;
    else delete Item.notas;
  }

  const actor = actorLabel(opts.usuario);
  if (actor) Item.actualizadoPor = actor;

  await docClient.send(new PutCommand({ TableName: tableName(), Item }));
  return Item;
}

/**
 * Elimina un ítem de calendario.
 * @param {string|number} localId
 * @param {string|number} proveedorId
 */
export async function remove(localId, proveedorId) {
  const lid = normalizeLocalId(localId);
  const pid = normalizeProveedorId(proveedorId);
  if (!lid) {
    throw Object.assign(new Error('localId es obligatorio'), { status: 400 });
  }
  if (!pid) {
    throw Object.assign(new Error('proveedorId es obligatorio'), { status: 400 });
  }
  const PK = pkLocal(lid);
  const SK = skProveedor(pid);
  if (!PK || !SK) {
    throw Object.assign(new Error('localId o proveedorId inválidos'), { status: 400 });
  }
  await docClient.send(
    new DeleteCommand({ TableName: tableName(), Key: { PK, SK } }),
  );
  return { ok: true, localId: lid, proveedorId: pid };
}
