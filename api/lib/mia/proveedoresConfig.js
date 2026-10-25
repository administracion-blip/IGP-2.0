/**
 * Plazo de entrega y frecuencia de pedido por proveedor (stock mínimo/máximo MIA).
 *
 * Persistencia: Igp_Ajustes (mismo patrón que gruposFamilias.js).
 *   PK = 'mia_proveedores'
 *   SK = id del proveedor (SupplierId de Ágora sin ceros a la izquierda)
 *   Campos: proveedorNombre, plazoDias, frecuenciaDias, actualizadoEn, actualizadoPor
 *
 * El valor por producto (Igp_MiaConfigProducto) tiene prioridad sobre este.
 */

import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { queryComprasPorMesFecha } from '../dynamo/comprasProveedor.js';
import { listConfigByWarehouse } from './configProducto.js';
import { addDaysIso, diasValidos } from './demanda.js';
import { normalizeWarehouseId } from './keys.js';

export const PK_MIA_PROVEEDORES = 'mia_proveedores';

const SIN_PROVEEDOR = 'SIN_PROVEEDOR';

/** Días de compras que se miran para listar los proveedores de un almacén. */
const DIAS_COMPRAS_PROVEEDORES = 120;

/** Misma clave para «12», «000012» y 12: así casa el SupplierId de compras con el de config. */
export function claveProveedor(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === SIN_PROVEEDOR) return '';
  if (/^\d+$/.test(s)) return s.replace(/^0+/, '') || '0';
  return s;
}

function mapItem(it) {
  const proveedorId = String(it?.SK ?? '').trim();
  if (!proveedorId) return null;
  return {
    proveedorId,
    proveedorNombre: String(it.proveedorNombre || '').trim(),
    plazoDias: diasValidos(it.plazoDias),
    frecuenciaDias: diasValidos(it.frecuenciaDias),
    actualizadoEn: it.actualizadoEn || null,
  };
}

/** Todos los proveedores con plazo/frecuencia guardados. */
export async function listProveedoresConfig() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.ajustes,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK_MIA_PROVEEDORES },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items.map(mapItem).filter(Boolean);
}

/** @returns {Promise<Map<string, { plazoDias: number|null, frecuenciaDias: number|null }>>} */
export async function mapaProveedoresConfig() {
  const lista = await listProveedoresConfig();
  return new Map(lista.map((p) => [p.proveedorId, p]));
}

function diasDeEntrada(body, campo) {
  const raw = body?.[campo];
  if (raw === null || raw === undefined || raw === '') return null;
  const n = diasValidos(raw);
  if (n == null) {
    throw Object.assign(new Error(`${campo} debe ser un número de días ≥ 0`), { status: 400 });
  }
  return n;
}

/**
 * Guarda plazo y frecuencia de un proveedor (para todos los almacenes). Solo
 * cambia los campos que vienen; vacío o null deja el campo sin valor.
 * @param {{ proveedorId: string, proveedorNombre?: string, plazoDias?: number|null, frecuenciaDias?: number|null }} body
 * @param {object} [usuario]
 */
export async function upsertProveedorConfig(body, usuario = {}) {
  const proveedorId = claveProveedor(body?.proveedorId);
  if (!proveedorId) {
    throw Object.assign(new Error('proveedorId es obligatorio'), { status: 400 });
  }
  const viene = (campo) => Object.prototype.hasOwnProperty.call(body, campo);
  const previo = (
    await docClient.send(
      new GetCommand({ TableName: tables.ajustes, Key: { PK: PK_MIA_PROVEEDORES, SK: proveedorId } }),
    )
  ).Item || {};
  const nombre = String(body?.proveedorNombre || '').trim();
  const Item = {
    PK: PK_MIA_PROVEEDORES,
    SK: proveedorId,
    proveedorNombre: nombre || String(previo.proveedorNombre || '').trim(),
    plazoDias: viene('plazoDias') ? diasDeEntrada(body, 'plazoDias') : diasValidos(previo.plazoDias),
    frecuenciaDias: viene('frecuenciaDias')
      ? diasDeEntrada(body, 'frecuenciaDias')
      : diasValidos(previo.frecuenciaDias),
    actualizadoEn: new Date().toISOString(),
    actualizadoPor: usuario?.email || usuario?.id_usuario || usuario?.sub || null,
  };
  await docClient.send(new PutCommand({ TableName: tables.ajustes, Item }));
  return mapItem(Item);
}

/**
 * Proveedores de un almacén para la pantalla de ajustes: los de la config de
 * producto, los de las compras recientes del almacén y los ya guardados.
 * @param {string|number|null} warehouseId
 */
export async function listProveedoresParaAjustes(warehouseId) {
  const guardados = await listProveedoresConfig();
  /** @type {Map<string, object>} */
  const out = new Map(guardados.map((p) => [p.proveedorId, { ...p, guardado: true }]));

  const anadir = (rawId, rawNombre) => {
    const id = claveProveedor(rawId);
    if (!id) return;
    const nombre = String(rawNombre || '').trim();
    const prev = out.get(id);
    if (prev) {
      if (!prev.proveedorNombre && nombre) prev.proveedorNombre = nombre;
      return;
    }
    out.set(id, {
      proveedorId: id,
      proveedorNombre: nombre,
      plazoDias: null,
      frecuenciaDias: null,
      actualizadoEn: null,
      guardado: false,
    });
  };

  const wid = normalizeWarehouseId(warehouseId);
  if (wid && wid !== '000000') {
    const config = await listConfigByWarehouse(wid);
    for (const c of config) anadir(c.proveedorId, c.proveedorNombre);

    const hoy = new Date().toISOString().slice(0, 10);
    const compras = await queryComprasPorMesFecha(addDaysIso(hoy, -DIAS_COMPRAS_PROVEEDORES), hoy, {
      projection: 'SupplierId, SupplierName, WarehouseId',
    });
    for (const c of compras) {
      if (normalizeWarehouseId(c.WarehouseId) !== wid) continue;
      anadir(c.SupplierId, c.SupplierName);
    }
  }

  return [...out.values()].sort((a, b) =>
    (a.proveedorNombre || a.proveedorId).localeCompare(b.proveedorNombre || b.proveedorId, 'es'),
  );
}
