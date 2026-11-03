/**
 * Documento de conteo del MIA por stock máximo.
 *
 * Cabecera y pedidos de proveedor en Igp_MiaInformes (PK INFORME#id).
 * Líneas en Igp_MiaInformeLineas, igual que el informe de consumo.
 * tipo = stock_maximo para no mezclarlo con el cálculo por consumo.
 * El estado (generado → pedido → confirmado) es de cada proveedor, no del documento.
 */

import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { normalizeProductId, normalizeWarehouseId, pkInforme, skInformeLinea } from './keys.js';

export const TIPO_CONTEO = 'stock_maximo';
export const ESTADOS_PEDIDO = ['generado', 'pedido', 'confirmado'];

const SIGUIENTE = {
  generado: new Set(['pedido', 'confirmado']),
  pedido: new Set(['confirmado']),
  confirmado: new Set(),
};

function fallo(mensaje, status = 400) {
  return Object.assign(new Error(mensaje), { status, expose: true });
}

export function skPedidoProveedor(proveedorId) {
  const id = String(proveedorId ?? '').trim() || 'SIN_PROVEEDOR';
  return `PROV#${id}`;
}

function estadoDe(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!ESTADOS_PEDIDO.includes(e)) throw fallo('Estado de pedido no válido');
  return e;
}

async function leerMeta(informeId) {
  const r = await docClient.send(new GetCommand({
    TableName: tables.miaInformes,
    Key: { PK: pkInforme(informeId), SK: 'META' },
  }));
  return r.Item || null;
}

/**
 * Crea la cabecera, las líneas y un pedido por proveedor en estado generado.
 * La previsión, si viene, se guarda tal cual: este módulo no la recalcula.
 */
export async function crearConteoStock(input) {
  const informeId = String(input?.informeId || '').trim() || randomUUID();
  const warehouseId = normalizeWarehouseId(input?.warehouseId);
  if (!warehouseId || warehouseId === '000000') throw fallo('warehouseId es obligatorio');
  if (await leerMeta(informeId)) throw fallo('Ya existe un conteo con ese id', 409);

  const ahora = new Date().toISOString();
  const lineasIn = Array.isArray(input?.lineas) ? input.lineas : [];
  const PK = pkInforme(informeId);
  const lineas = lineasIn.map((ln) => {
    const productId = normalizeProductId(ln?.productId);
    if (!productId) throw fallo('Cada línea necesita productId');
    const proveedorId = String(ln?.proveedorId || 'SIN_PROVEEDOR').trim() || 'SIN_PROVEEDOR';
    const stockVacio = ln?.stockReal == null || ln?.stockReal === '';
    const stockReal = stockVacio ? null : Number(ln.stockReal);
    if (stockReal != null && !Number.isFinite(stockReal)) throw fallo('Stock real no válido');
    return {
      PK,
      SK: skInformeLinea(proveedorId, productId),
      informeId,
      productId,
      nombre: String(ln?.nombre || '').trim(),
      proveedorId,
      proveedorNombre: String(ln?.proveedorNombre || '').trim(),
      stockReal,
      maximo: ln?.maximo == null || ln?.maximo === '' ? null : Number(ln.maximo),
      maximoFinal: ln?.maximoFinal == null || ln?.maximoFinal === '' ? null : Number(ln.maximoFinal),
      maximoManual: ln?.maximoManual === true,
      cantidadManual: ln?.cantidadManual === true,
      cantidadPedida: ln?.cantidadPedida == null || ln?.cantidadPedida === '' ? null : Number(ln.cantidadPedida),
      formatoCompra: ln?.formatoCompra == null || ln?.formatoCompra === '' ? null : Number(ln.formatoCompra),
      purchaseUnitId: ln?.purchaseUnitId == null ? '' : String(ln.purchaseUnitId),
      unit: String(ln?.unit || '').trim(),
      costeUnitario: ln?.costeUnitario == null || ln?.costeUnitario === '' ? null : Number(ln.costeUnitario),
      costeLinea: ln?.costeLinea == null || ln?.costeLinea === '' ? null : Number(ln.costeLinea),
    };
  });

  const proveedores = new Map();
  for (const ln of lineas) {
    if (!proveedores.has(ln.proveedorId)) {
      proveedores.set(ln.proveedorId, {
        proveedorId: ln.proveedorId,
        proveedorNombre: ln.proveedorNombre,
      });
    }
  }

  const meta = {
    PK,
    SK: 'META',
    informeId,
    tipo: TIPO_CONTEO,
    estado: 'generado',
    WarehouseId: warehouseId,
    warehouseId,
    CreadoEn: ahora,
    creadoEn: ahora,
    semanasDesde: String(input?.semanasDesde || '').trim() || null,
    semanasHasta: String(input?.semanasHasta || '').trim() || null,
    ficheroNombre: String(input?.ficheroNombre || '').trim() || null,
    lineasLeidas: lineas.length,
    previsionImporte: input?.previsionImporte == null ? null : Number(input.previsionImporte),
    tramoDesde: input?.tramoDesde == null ? null : Number(input.tramoDesde),
    tramoHasta: input?.tramoHasta == null ? null : Number(input.tramoHasta),
    multiplicador: input?.multiplicador == null ? null : Number(input.multiplicador),
    previsionAviso: String(input?.previsionAviso || '').trim() || null,
  };
  await docClient.send(new PutCommand({ TableName: tables.miaInformes, Item: meta }));

  for (const ln of lineas) {
    await docClient.send(new PutCommand({ TableName: tables.miaInformeLineas, Item: ln }));
  }

  const pedidos = [];
  for (const p of proveedores.values()) {
    const item = {
      PK,
      SK: skPedidoProveedor(p.proveedorId),
      informeId,
      tipo: TIPO_CONTEO,
      proveedorId: p.proveedorId,
      proveedorNombre: p.proveedorNombre,
      estado: 'generado',
      serie: null,
      number: null,
      importe: null,
      creadoEn: ahora,
    };
    await docClient.send(new PutCommand({ TableName: tables.miaInformes, Item: item }));
    pedidos.push(item);
  }

  return { meta, lineas, pedidos };
}

export async function listarPedidosProveedor(informeId) {
  const PK = pkInforme(informeId);
  if (!PK) return [];
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.miaInformes,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
      ExpressionAttributeValues: { ':pk': PK, ':pref': 'PROV#' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Pasa un pedido de proveedor al estado siguiente y guarda serie y número si ya está en Ágora.
 */
export async function marcarPedidoProveedor(informeId, proveedorId, patch) {
  const id = String(informeId || '').trim();
  const meta = await leerMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const SK = skPedidoProveedor(proveedorId);
  const r = await docClient.send(new GetCommand({
    TableName: tables.miaInformes,
    Key: { PK: pkInforme(id), SK },
  }));
  const actual = r.Item;
  if (!actual) throw fallo('Pedido de proveedor no encontrado', 404);

  const destino = estadoDe(patch?.estado);
  if (destino !== actual.estado && !SIGUIENTE[actual.estado]?.has(destino)) {
    throw fallo(`No se puede pasar de ${actual.estado} a ${destino}`);
  }
  const serie = patch?.serie != null ? String(patch.serie).trim() : actual.serie;
  const number = patch?.number != null ? Number(patch.number) : actual.number;
  if ((destino === 'pedido' || destino === 'confirmado') && (!serie || !Number.isInteger(number) || number <= 0)) {
    throw fallo('Un pedido enviado a Ágora necesita serie y número');
  }
  const item = {
    ...actual,
    estado: destino,
    serie: serie || null,
    number: Number.isInteger(number) ? number : null,
    importe: patch?.importe == null ? actual.importe : Number(patch.importe),
    actualizadoEn: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: tables.miaInformes, Item: item }));
  return item;
}
