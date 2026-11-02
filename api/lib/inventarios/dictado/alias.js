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
import { normalizarAlias, normalizarTexto } from './matcher.js';

const MAX_INTENTOS = 3;

/** Tope al aprender: un alias de conteo es un nombre corto, no una frase con la cuenta. */
export const MAX_ALIAS_DICTADO = 40;

const PALABRAS_CUENTA = new Set(['por', 'fila', 'filas', 'caja', 'cajas']);

/**
 * Un alias se puede guardar si no es una cuenta dictada.
 * El número se permite solo cuando ese mismo número está en el nombre del producto
 * («818» → 818 Tequila, «Ballantines 10» → Ballantines 10).
 * Siempre se rechaza `por`, `fila(s)`, `caja(s)`, cualquier `multiplica…` y más de 40 caracteres.
 *
 * @param {unknown} textoDicho
 * @param {unknown} nombreProducto
 * @returns {boolean}
 */
export function aliasAceptable(textoDicho, nombreProducto) {
  const norm = normalizarAlias(textoDicho);
  if (!norm || norm.length > MAX_ALIAS_DICTADO) return false;
  const tokens = norm.split(' ');
  if (tokens.some((t) => PALABRAS_CUENTA.has(t) || t.startsWith('multiplica'))) return false;
  const numerosNombre = new Set(
    normalizarTexto(nombreProducto).split(' ').filter((t) => /^\d+$/.test(t)),
  );
  return tokens.every((t) => !/^\d+$/.test(t) || numerosNombre.has(t));
}

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
 * `noReasignar`: si el alias ya apunta a otro producto de `productosActivos` no lo toca (409,
 *   code 'alias_existente'); uno que apunta a un producto que ya no está activo sí se reasigna.
 *   Lo usan las rutas para quien solo tiene inventario.contar.
 * @throws errorInventario 400 si el texto queda vacío o el producto no está activo;
 *   409 si el alias cambia a la vez tres veces seguidas.
 */
export async function guardarAlias(textoDicho, productId, quien, { productosActivos = [], noReasignar = false } = {}) {
  const norm = normalizarAlias(textoDicho);
  const sk = skAlias(norm);
  const textoOriginal = texto(textoDicho, 'texto', { max: 200 });
  const pid = String(productId ?? '').trim();
  const producto = (Array.isArray(productosActivos) ? productosActivos : [])
    .find((p) => p && p.activo !== false && String(p.productId ?? '').trim() === pid);
  if (!pid || !producto) throw errorInventario('El alias debe apuntar a un producto activo del almacén.');
  if (!aliasAceptable(textoDicho, producto.nombre)) {
    throw Object.assign(
      errorInventario('Ese alias no se puede guardar: parece una cuenta o es demasiado largo.'),
      { code: 'alias_no_valido' },
    );
  }
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
      const previoActivo = previo && (Array.isArray(productosActivos) ? productosActivos : [])
        .some((p) => p && p.activo !== false && String(p.productId ?? '').trim() === previo.productId);
      if (noReasignar && previoActivo) {
        throw Object.assign(errorInventario('Ese alias ya apunta a otro producto.', 409), { code: 'alias_existente' });
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
