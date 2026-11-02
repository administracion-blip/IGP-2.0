/**
 * Alias globales del dictado: texto dicho (normalizado) → producto.
 *
 *   PK = ALIAS#GLOBAL   SK = TXT#<normalizarAlias(texto)>
 *   { texto, textoOriginal, productId, productoNombre, usos,
 *     creadoPor, creadoEn, actualizadoPor, actualizadoEn }
 *
 * Son globales (no por almacén ni por usuario): un alias lo aprovechan todos los conteos.
 * Sin WarehouseId ni Clave, así que no entran en el GSI de almacén.
 *
 * Regla de sobrescritura: si el alias ya apunta a OTRO producto, `guardarAlias` lo redirige al
 * nuevo (manda quien lo confirma ahora), conserva creadoPor/creadoEn y reinicia `usos` a 1,
 * porque los usos anteriores eran confirmaciones del producto antiguo. Con el MISMO producto
 * suma 1 a `usos`.
 *
 * Los permisos se comprueban en las rutas (fase 4). Esta capa no llama a Ágora.
 */

import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../db.js';
import { errorInventario, idSegmento, pkAliasGlobal, skAlias, texto } from '../claves.js';
import { queryPk, tablaInventarios } from '../store.js';
import { normalizarAlias } from './matcher.js';

const MAX_INTENTOS = 3;

function esCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

function presentar(it) {
  return {
    texto: it.texto,
    textoOriginal: it.textoOriginal || it.texto,
    productId: it.productId,
    productoNombre: it.productoNombre || '',
    usos: Number(it.usos) || 0,
    creadoPor: it.creadoPor || '',
    creadoEn: it.creadoEn || null,
    actualizadoPor: it.actualizadoPor || '',
    actualizadoEn: it.actualizadoEn || null,
  };
}

/** @returns {Promise<Array<ReturnType<typeof presentar>>>} todos los alias globales. */
export async function listarAlias() {
  const items = await queryPk(pkAliasGlobal());
  return items.filter((it) => String(it.SK || '').startsWith('TXT#')).map(presentar);
}

/**
 * Crea o confirma un alias. `productosActivos` es la lista del almacén ({ productId, nombre,
 * activo? }); el alias solo puede apuntar a uno con `activo !== false`.
 *
 * @param {string} textoDicho
 * @param {string} productId
 * @param {string} quien
 * @param {{ productosActivos?: Array<{ productId: string|number, nombre?: string, activo?: boolean }> }} opciones
 * @throws errorInventario 400 si el texto queda vacío o el producto no está activo;
 *   409 si el alias cambia a la vez tres veces seguidas.
 */
export async function guardarAlias(textoDicho, productId, quien, { productosActivos = [] } = {}) {
  const norm = normalizarAlias(textoDicho);
  const sk = skAlias(norm);
  const textoOriginal = texto(textoDicho, 'texto', { max: 200 });
  const pid = String(productId ?? '').trim();
  const producto = (Array.isArray(productosActivos) ? productosActivos : [])
    .find((p) => p && p.activo !== false && String(p.productId ?? '').trim() === pid);
  if (!pid || !producto) throw errorInventario('El alias debe apuntar a un producto activo del almacén.');
  idSegmento(pid, 'productId');
  const productoNombre = texto(producto.nombre, 'productoNombre', { max: 200 });
  const usuario = String(quien ?? '');
  const tabla = tablaInventarios();
  const clave = { PK: pkAliasGlobal(), SK: sk };

  for (let intento = 0; intento < MAX_INTENTOS; intento += 1) {
    const ahora = new Date().toISOString();
    const { Item: previo } = await docClient.send(new GetCommand({
      TableName: tabla, Key: clave, ConsistentRead: true,
    }));
    try {
      if (previo && previo.productId === pid) {
        const r = await docClient.send(new UpdateCommand({
          TableName: tabla,
          Key: clave,
          UpdateExpression: 'SET textoOriginal = :orig, productoNombre = :nombre, actualizadoPor = :quien, actualizadoEn = :ahora ADD usos :uno',
          ConditionExpression: 'productId = :pid',
          ExpressionAttributeValues: {
            ':orig': textoOriginal, ':nombre': productoNombre, ':quien': usuario, ':ahora': ahora, ':uno': 1, ':pid': pid,
          },
          ReturnValues: 'ALL_NEW',
        }));
        return presentar(r.Attributes);
      }
      const item = {
        ...clave,
        texto: norm,
        textoOriginal,
        productId: pid,
        productoNombre,
        usos: 1,
        creadoPor: previo ? (previo.creadoPor || '') : usuario,
        creadoEn: previo ? (previo.creadoEn || ahora) : ahora,
        actualizadoPor: usuario,
        actualizadoEn: ahora,
      };
      await docClient.send(new PutCommand({
        TableName: tabla,
        Item: item,
        ...(previo
          ? { ConditionExpression: 'productId = :previo', ExpressionAttributeValues: { ':previo': previo.productId } }
          : { ConditionExpression: 'attribute_not_exists(PK)' }),
      }));
      return presentar(item);
    } catch (err) {
      if (!esCondicion(err)) throw err;
    }
  }
  throw errorInventario('El alias ha cambiado; vuelve a intentarlo.', 409);
}

/**
 * Suma un uso a un alias existente. Si no existe (o el texto queda vacío) no hace nada.
 * @returns {Promise<boolean>} true si se sumó.
 */
export async function sumarUso(textoDicho) {
  const norm = normalizarAlias(textoDicho);
  if (!norm) return false;
  try {
    await docClient.send(new UpdateCommand({
      TableName: tablaInventarios(),
      Key: { PK: pkAliasGlobal(), SK: skAlias(norm) },
      UpdateExpression: 'ADD usos :uno',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':uno': 1 },
    }));
    return true;
  } catch (err) {
    if (esCondicion(err)) return false;
    throw err;
  }
}

/** Borra un alias. Idempotente. @throws errorInventario 400 si el texto queda vacío. */
export async function borrarAlias(textoDicho) {
  const sk = skAlias(textoDicho);
  await docClient.send(new DeleteCommand({
    TableName: tablaInventarios(),
    Key: { PK: pkAliasGlobal(), SK: sk },
  }));
  return { ok: true, texto: sk.slice('TXT#'.length) };
}
