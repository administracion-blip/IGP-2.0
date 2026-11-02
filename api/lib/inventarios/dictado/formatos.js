/**
 * Formatos de caja/pack por producto, para que el dictado entienda «12 cajas» sin «de 24».
 *
 *   PK = FORMATO#GLOBAL   SK = PROD#<productId>
 *   { productId, unidadesCaja (1..1000), unidadesPack? (1..1000), quien, en }
 *
 * Globales: el formato de un producto es el mismo en todos los almacenes. Sin WarehouseId ni
 * Clave, así que no entran en el GSI de almacén.
 *
 * Permisos (se comprueban en las rutas de la fase 4, no aquí): `inventario.contar` puede crear;
 * `inventario.gestionar` puede editar y borrar. Esta capa no llama a Ágora.
 */

import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../db.js';
import { batchGetTodos } from '../../dynamo/lotes.js';
import { errorInventario, idSegmento, pkFormatoGlobal, skFormato } from '../claves.js';
import { tablaInventarios } from '../store.js';

const MIN_UNIDADES = 1;
const MAX_UNIDADES = 1000;

function esCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

function unidades(raw, campo, { obligatorio }) {
  if (raw == null || raw === '') {
    if (obligatorio) throw errorInventario(`${campo} es obligatorio.`);
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : (/^\s*\d+\s*$/.test(String(raw)) ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < MIN_UNIDADES || n > MAX_UNIDADES) {
    throw errorInventario(`${campo} debe ser un número entero entre ${MIN_UNIDADES} y ${MAX_UNIDADES}.`);
  }
  return n;
}

function validar(datos) {
  if (!datos || typeof datos !== 'object') throw errorInventario('Faltan los datos del formato.');
  const unidadesCaja = unidades(datos.unidadesCaja, 'unidadesCaja', { obligatorio: true });
  const unidadesPack = unidades(datos.unidadesPack, 'unidadesPack', { obligatorio: false });
  return { unidadesCaja, ...(unidadesPack !== undefined && { unidadesPack }) };
}

function presentar(it) {
  return {
    productId: it.productId,
    unidadesCaja: it.unidadesCaja,
    ...(it.unidadesPack != null && { unidadesPack: it.unidadesPack }),
  };
}

function itemFormato(productId, datos, quien) {
  const pid = idSegmento(productId, 'productId');
  return {
    PK: pkFormatoGlobal(),
    SK: skFormato(pid),
    productId: pid,
    ...validar(datos),
    quien: String(quien ?? ''),
    en: new Date().toISOString(),
  };
}

/**
 * Formatos de los productos pedidos. BatchGet en lotes de 100 (con reintento de
 * UnprocessedKeys) en vez de Query de toda la PK: el conteo pide los de su almacén
 * y la PK global crecerá con todos los productos del grupo.
 * Los productIds inválidos o repetidos se ignoran.
 *
 * @param {Iterable<string|number>} productIds
 * @returns {Promise<Map<string, { unidadesCaja: number, unidadesPack?: number }>>}
 */
export async function obtenerFormatos(productIds) {
  const ids = new Set();
  for (const raw of productIds ?? []) {
    try {
      ids.add(idSegmento(raw, 'productId'));
    } catch {
      // Ignorado: no puede ser clave.
    }
  }
  const mapa = new Map();
  if (!ids.size) return mapa;
  const items = await batchGetTodos(
    tablaInventarios(),
    [...ids].map((pid) => ({ PK: pkFormatoGlobal(), SK: skFormato(pid) })),
  );
  for (const it of items) {
    const { productId, ...formato } = presentar(it);
    mapa.set(productId, formato);
  }
  return mapa;
}

/** @throws errorInventario 409 «Ese producto ya tiene formato de caja.» si ya existe (no lo sobrescribe). */
export async function crearFormato(productId, datos, quien) {
  const item = itemFormato(productId, datos, quien);
  try {
    await docClient.send(new PutCommand({
      TableName: tablaInventarios(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err) {
    if (esCondicion(err)) throw errorInventario('Ese producto ya tiene formato de caja.', 409);
    throw err;
  }
  return presentar(item);
}

/**
 * Sustituye el formato entero: si `unidadesPack` no viene, se quita.
 * @throws errorInventario 404 si el producto no tiene formato.
 */
export async function editarFormato(productId, datos, quien) {
  const item = itemFormato(productId, datos, quien);
  try {
    await docClient.send(new PutCommand({
      TableName: tablaInventarios(),
      Item: item,
      ConditionExpression: 'attribute_exists(PK)',
    }));
  } catch (err) {
    if (esCondicion(err)) throw errorInventario('Ese producto no tiene formato de caja.', 404);
    throw err;
  }
  return presentar(item);
}

/** Idempotente. */
export async function borrarFormato(productId) {
  const pid = idSegmento(productId, 'productId');
  await docClient.send(new DeleteCommand({
    TableName: tablaInventarios(),
    Key: { PK: pkFormatoGlobal(), SK: skFormato(pid) },
  }));
  return { ok: true, productId: pid };
}
