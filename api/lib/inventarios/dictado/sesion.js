/**
 * Sesiones de dictado por voz: una por usuario y por inventario, colgadas del inventario.
 *
 *   PK = INV#<inventarioId>
 *   SK = DICTADO#<usuario>#META            { estado, siguiente, creadoEn, actualizadoEn, usuarioId, usuarioNombre }
 *   SK = DICTADO#<usuario>#LINEA#<000001>  línea dictada (ver CAMPOS_LINEA)
 *
 * `<usuario>` es `usuarioSegmento(usuario)`: dos usuarios del mismo inventario no se pisan.
 * Como cuelgan de INV#<id>, borrarInventario se lleva las sesiones. Sin WarehouseId ni Clave:
 * no entran en el GSI de almacén, y las lecturas del inventario solo miran META, LINE#, FOTO# y
 * LECTURA#, así que la pantalla y el Excel no ven nada del dictado.
 *
 * NUNCA se guarda stock teórico ni audio: cada escritura reconstruye el ítem campo a campo desde
 * una lista blanca, de modo que lo que sobre en la entrada (stockTeorico, exportStocks…) no llega
 * a Dynamo. Las líneas son propuestas: aplicarlas al conteo es cosa de las rutas (fase 4).
 *
 * Estados de la sesión: 'activa' | 'pausada' | 'cerrada'. pausar: activa → pausada;
 * reanudar: pausada | cerrada → activa (reabrir una cerrada está permitido); cerrar: → cerrada,
 * sin borrar líneas. Con la sesión cerrada no se añaden líneas (409), pero sí se pueden revisar.
 *
 * Esta capa no llama a Ágora.
 */

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../db.js';
import {
  BOTELLAS_ABIERTAS,
  errorInventario,
  idSegmento,
  pkInventario,
  prefijoDictado,
  skDictadoLinea,
  skDictadoMeta,
  skMeta,
  texto,
  usuarioSegmento,
} from '../claves.js';
import { tablaInventarios } from '../store.js';

export const MAX_LINEAS_POR_ENVIO = 50;
const MAX_TEXTO = 2000;
const MAX_CANTIDAD = 100000;
const MAX_MOTIVOS = 20;
const MAX_ALTERNATIVAS = 10;

export const ESTADOS_SESION = Object.freeze(['activa', 'pausada', 'cerrada']);
export const ESTADOS_LINEA = Object.freeze(['pendiente', 'confirmada', 'aplicada', 'descartada']);
export const MODOS_LINEA = Object.freeze(['sumar', 'reemplazar', 'borrar']);

/** Destinos permitidos desde cada estado de línea. `aplicada` queda cerrada. */
export const TRANSICIONES_LINEA = Object.freeze({
  pendiente: Object.freeze(['confirmada', 'descartada', 'aplicada']),
  confirmada: Object.freeze(['aplicada', 'descartada', 'pendiente']),
  aplicada: Object.freeze([]),
  descartada: Object.freeze(['pendiente']),
});

/** Únicos atributos que puede tener una línea en Dynamo. */
export const CAMPOS_LINEA = Object.freeze([
  'PK', 'SK', 'n', 'texto', 'orden', 'productId', 'productoNombre', 'cantidad', 'modo',
  'motivos', 'confirmar', 'estado', 'creadoEn', 'creadoPor', 'actualizadoEn', 'actualizadoPor',
]);

/** Únicos atributos que puede tener el META de una sesión en Dynamo. */
export const CAMPOS_META = Object.freeze([
  'PK', 'SK', 'estado', 'siguiente', 'creadoEn', 'actualizadoEn', 'usuarioId', 'usuarioNombre',
]);

const EDITABLES = Object.freeze(['productId', 'productoNombre', 'cantidad', 'modo', 'estado', 'motivos', 'confirmar']);
const TIPOS_ORDEN = new Set(['linea', 'sumar', 'reemplazar', 'corregir', 'borrar', 'pausa', 'sigue']);

const tiene = (obj, campo) => Object.prototype.hasOwnProperty.call(obj, campo);

function esCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

// ─── Validación (lista blanca) ───

function numeroCantidad(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > MAX_CANTIDAD) {
    throw errorInventario('cantidad no válida.');
  }
  return raw;
}

/** { total, stockReal, botellasAbiertas } | null. Admite negativos (deltas de «quita»). */
function cantidadDe(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw errorInventario('cantidad no válida.');
  const botellasAbiertas = numeroCantidad(raw.botellasAbiertas ?? 0);
  if (!BOTELLAS_ABIERTAS.some((v) => Math.abs(v - Math.abs(botellasAbiertas)) < 1e-9)) {
    throw errorInventario('cantidad no válida.');
  }
  return {
    total: numeroCantidad(raw.total),
    stockReal: numeroCantidad(raw.stockReal),
    botellasAbiertas,
  };
}

function motivosDe(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_MOTIVOS) throw errorInventario('motivos no válidos.');
  return raw.map((m) => {
    if (typeof m !== 'string') throw errorInventario('motivos no válidos.');
    return texto(m, 'motivo', { obligatorio: true, max: 60 });
  });
}

function booleano(raw, campo) {
  if (typeof raw !== 'boolean') throw errorInventario(`${campo} debe ser verdadero o falso.`);
  return raw;
}

function productIdDe(raw) {
  if (raw == null || raw === '') return null;
  return idSegmento(raw, 'productId');
}

function textoONull(raw, campo, max) {
  if (raw == null) return null;
  return texto(raw, campo, { max }) || null;
}

function modoDe(raw) {
  if (raw == null) return null;
  if (!MODOS_LINEA.includes(raw)) throw errorInventario('modo no válido.');
  return raw;
}

function estadoLineaDe(raw) {
  if (!ESTADOS_LINEA.includes(raw)) throw errorInventario('estado de línea no válido.');
  return raw;
}

/** Copia de la orden de `parsearDictado` con solo sus campos conocidos (sin textoOriginal). */
function ordenDe(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw errorInventario('orden no válida.');
  if (!TIPOS_ORDEN.has(raw.tipo)) throw errorInventario('orden no válida.');
  const alternativas = Array.isArray(raw.alternativas) ? raw.alternativas.slice(0, MAX_ALTERNATIVAS) : [];
  const orden = {
    tipo: raw.tipo,
    textoProducto: textoONull(raw.textoProducto, 'textoProducto', 200),
    cantidad: cantidadDe(raw.cantidad),
    confirmar: Boolean(raw.confirmar),
    motivos: motivosDe(raw.motivos),
    alternativas: alternativas.map((a) => ({
      textoProducto: textoONull(a?.textoProducto, 'textoProducto', 200),
      cantidad: cantidadDe(a?.cantidad),
    })),
  };
  if (raw.calculo && typeof raw.calculo === 'object') {
    const total = raw.calculo.total;
    orden.calculo = {
      expresion: texto(raw.calculo.expresion, 'expresion', { max: 200 }),
      total: total == null ? null : numeroCantidad(total),
      faltaFormato: Boolean(raw.calculo.faltaFormato),
    };
  }
  return orden;
}

/** Campos de una línea nueva, validados. El estado inicial siempre es 'pendiente'. */
function lineaNueva(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw errorInventario('Línea de dictado no válida.');
  const orden = ordenDe(raw.orden);
  const motivos = motivosDe(raw.motivos ?? orden?.motivos);
  return {
    texto: texto(raw.texto, 'texto', { obligatorio: true, max: MAX_TEXTO }),
    orden,
    productId: productIdDe(raw.productId),
    productoNombre: textoONull(raw.productoNombre, 'productoNombre', 200),
    cantidad: cantidadDe(raw.cantidad === undefined ? orden?.cantidad : raw.cantidad),
    modo: modoDe(raw.modo),
    motivos,
    confirmar: raw.confirmar === undefined
      ? (orden ? orden.confirmar : true) || motivos.length > 0
      : booleano(raw.confirmar, 'confirmar'),
    estado: 'pendiente',
  };
}

/** Ítem de línea construido solo con CAMPOS_LINEA. */
function itemLinea(clave, n, c) {
  return {
    PK: clave.PK,
    SK: clave.SK,
    n,
    texto: c.texto,
    orden: c.orden,
    productId: c.productId,
    productoNombre: c.productoNombre,
    cantidad: c.cantidad,
    modo: c.modo,
    motivos: c.motivos,
    confirmar: c.confirmar,
    estado: c.estado,
    creadoEn: c.creadoEn,
    creadoPor: c.creadoPor,
    actualizadoEn: c.actualizadoEn,
    actualizadoPor: c.actualizadoPor,
  };
}

function presentarLinea(it) {
  return {
    n: Number(it.n),
    texto: it.texto || '',
    orden: it.orden ?? null,
    productId: it.productId ?? null,
    productoNombre: it.productoNombre ?? null,
    cantidad: it.cantidad ?? null,
    modo: it.modo ?? null,
    motivos: Array.isArray(it.motivos) ? it.motivos : [],
    confirmar: Boolean(it.confirmar),
    estado: it.estado,
    creadoEn: it.creadoEn || null,
    actualizadoEn: it.actualizadoEn || null,
  };
}

function presentarMeta(it) {
  return {
    estado: it.estado,
    siguiente: Number(it.siguiente) || 0,
    creadoEn: it.creadoEn || null,
    actualizadoEn: it.actualizadoEn || null,
    usuarioId: it.usuarioId || '',
    usuarioNombre: it.usuarioNombre || '',
  };
}

function claves(inventarioId, usuario) {
  const id = idSegmento(inventarioId, 'inventarioId');
  const u = usuarioSegmento(usuario);
  return { id, u, pk: pkInventario(id) };
}

async function exigirInventario(pk) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: tablaInventarios(),
    Key: { PK: pk, SK: skMeta() },
    ConsistentRead: true,
    ProjectionExpression: 'PK',
  }));
  if (!Item) throw errorInventario('Inventario no encontrado.', 404);
}

// ─── API ───

/**
 * Sesión de un usuario en un inventario. No comprueba que el inventario exista.
 * @returns {Promise<{ meta: ReturnType<typeof presentarMeta>|null, lineas: Array<ReturnType<typeof presentarLinea>> }>}
 */
export async function obtenerSesion(inventarioId, usuario) {
  const { u, pk } = claves(inventarioId, usuario);
  const items = [];
  let lastKey;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tablaInventarios(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': pk, ':p': prefijoDictado(u) },
      ConsistentRead: true,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  const meta = items.find((it) => it.SK === skDictadoMeta(u));
  const lineas = items
    .filter((it) => it.SK.startsWith(`${prefijoDictado(u)}LINEA#`))
    .map(presentarLinea)
    .sort((a, b) => a.n - b.n);
  return { meta: meta ? presentarMeta(meta) : null, lineas };
}

/**
 * Añade líneas a la sesión del usuario (la crea si no existe). Reserva los números con un
 * ADD atómico sobre el META, así dos envíos en paralelo nunca repiten `n`; luego escribe
 * todas las líneas en una transacción que exige que el inventario siga existiendo.
 *
 * @param {string} inventarioId
 * @param {string} usuario id del usuario (sub o email); se guarda tal cual en usuarioId.
 * @param {Array<object>} lineas 1..50 líneas { texto, orden?, productId?, productoNombre?,
 *   cantidad?, modo?, motivos?, confirmar? }. Cualquier otro campo se descarta.
 * @param {string} quien nombre visible; queda en usuarioNombre y en creadoPor.
 * @throws errorInventario 400 (validación), 404 «Inventario no encontrado.», 409 si la sesión está cerrada.
 */
export async function anadirLineas(inventarioId, usuario, lineas, quien) {
  const { u, pk } = claves(inventarioId, usuario);
  if (!Array.isArray(lineas) || lineas.length === 0) {
    throw errorInventario('lineas debe ser una lista con al menos una línea.');
  }
  if (lineas.length > MAX_LINEAS_POR_ENVIO) {
    throw errorInventario(`Como máximo ${MAX_LINEAS_POR_ENVIO} líneas por envío.`);
  }
  const datos = lineas.map(lineaNueva);
  await exigirInventario(pk);

  const tabla = tablaInventarios();
  const ahora = new Date().toISOString();
  const nombre = texto(quien, 'quien', { max: 120 });
  let fin;
  try {
    const r = await docClient.send(new UpdateCommand({
      TableName: tabla,
      Key: { PK: pk, SK: skDictadoMeta(u) },
      UpdateExpression: 'SET estado = if_not_exists(estado, :activa), creadoEn = if_not_exists(creadoEn, :ahora), usuarioId = if_not_exists(usuarioId, :uid), usuarioNombre = :nombre, actualizadoEn = :ahora ADD siguiente :k',
      ConditionExpression: 'attribute_not_exists(estado) OR estado <> :cerrada',
      ExpressionAttributeValues: {
        ':activa': 'activa',
        ':cerrada': 'cerrada',
        ':ahora': ahora,
        ':uid': String(usuario).trim(),
        ':nombre': nombre,
        ':k': datos.length,
      },
      ReturnValues: 'UPDATED_NEW',
    }));
    fin = Number(r.Attributes?.siguiente);
  } catch (err) {
    if (esCondicion(err)) throw errorInventario('La sesión de dictado está cerrada.', 409);
    throw err;
  }
  if (!Number.isInteger(fin)) throw new Error('No se ha podido reservar la numeración del dictado');
  const inicio = fin - datos.length + 1;

  const items = datos.map((c, i) => itemLinea(
    { PK: pk, SK: skDictadoLinea(u, inicio + i) },
    inicio + i,
    { ...c, creadoEn: ahora, creadoPor: nombre, actualizadoEn: ahora, actualizadoPor: nombre },
  ));
  try {
    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: tabla,
            Key: { PK: pk, SK: skMeta() },
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
        ...items.map((Item) => ({
          Put: { TableName: tabla, Item, ConditionExpression: 'attribute_not_exists(PK)' },
        })),
      ],
    }));
  } catch (err) {
    if (err?.name === 'TransactionCanceledException') {
      if (err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        throw errorInventario('Inventario no encontrado.', 404);
      }
      throw errorInventario('El dictado ha cambiado; vuelve a intentarlo.', 409);
    }
    throw err;
  }
  return items.map(presentarLinea);
}

/**
 * Cambia los campos editables de una línea (productId, productoNombre, cantidad, modo, estado,
 * motivos, confirmar). Lo demás que venga en `cambios` se ignora.
 * Transiciones: pendiente → confirmada|descartada|aplicada; confirmada → aplicada|descartada|pendiente;
 * descartada → pendiente; aplicada → ninguna.
 *
 * @throws errorInventario 404 «Línea de dictado no encontrada.», 409 si está aplicada, la
 *   transición no vale o la línea cambió a la vez.
 */
export async function actualizarLinea(inventarioId, usuario, n, cambios, quien) {
  const { u, pk } = claves(inventarioId, usuario);
  const clave = { PK: pk, SK: skDictadoLinea(u, n) };
  const tabla = tablaInventarios();
  const { Item: previo } = await docClient.send(new GetCommand({ TableName: tabla, Key: clave, ConsistentRead: true }));
  if (!previo) throw errorInventario('Línea de dictado no encontrada.', 404);
  if (previo.estado === 'aplicada') throw errorInventario('La línea ya está aplicada y no se puede cambiar.', 409);

  const c = cambios && typeof cambios === 'object' ? cambios : {};
  const nuevo = {
    texto: previo.texto,
    orden: previo.orden ?? null,
    productId: previo.productId ?? null,
    productoNombre: previo.productoNombre ?? null,
    cantidad: previo.cantidad ?? null,
    modo: previo.modo ?? null,
    motivos: Array.isArray(previo.motivos) ? previo.motivos : [],
    confirmar: Boolean(previo.confirmar),
    estado: previo.estado,
    creadoEn: previo.creadoEn,
    creadoPor: previo.creadoPor,
  };
  const validadores = {
    productId: productIdDe,
    productoNombre: (v) => textoONull(v, 'productoNombre', 200),
    cantidad: cantidadDe,
    modo: modoDe,
    estado: estadoLineaDe,
    motivos: motivosDe,
    confirmar: (v) => booleano(v, 'confirmar'),
  };
  for (const campo of EDITABLES) {
    if (tiene(c, campo)) nuevo[campo] = validadores[campo](c[campo]);
  }
  if (nuevo.estado !== previo.estado && !TRANSICIONES_LINEA[previo.estado]?.includes(nuevo.estado)) {
    throw errorInventario(`No se puede pasar de ${previo.estado} a ${nuevo.estado}.`, 409);
  }

  const ahora = new Date().toISOString();
  const item = itemLinea(clave, Number(previo.n), {
    ...nuevo,
    actualizadoEn: ahora,
    actualizadoPor: texto(quien, 'quien', { max: 120 }),
  });
  try {
    await docClient.send(new PutCommand({
      TableName: tabla,
      Item: item,
      ConditionExpression: 'estado = :estado AND actualizadoEn = :act',
      ExpressionAttributeValues: { ':estado': previo.estado, ':act': previo.actualizadoEn },
    }));
  } catch (err) {
    if (esCondicion(err)) throw errorInventario('La línea de dictado ha cambiado; vuelve a intentarlo.', 409);
    throw err;
  }
  return presentarLinea(item);
}

export function descartarLinea(inventarioId, usuario, n, quien) {
  return actualizarLinea(inventarioId, usuario, n, { estado: 'descartada' }, quien);
}

async function cambiarEstadoSesion(inventarioId, usuario, nuevo, desde) {
  const { u, pk } = claves(inventarioId, usuario);
  const clave = { PK: pk, SK: skDictadoMeta(u) };
  const tabla = tablaInventarios();
  const valores = Object.fromEntries(desde.map((e, i) => [`:d${i}`, e]));
  try {
    const r = await docClient.send(new UpdateCommand({
      TableName: tabla,
      Key: clave,
      UpdateExpression: 'SET estado = :nuevo, actualizadoEn = :ahora',
      ConditionExpression: `attribute_exists(PK) AND estado IN (${Object.keys(valores).join(', ')})`,
      ExpressionAttributeValues: { ...valores, ':nuevo': nuevo, ':ahora': new Date().toISOString() },
      ReturnValues: 'ALL_NEW',
    }));
    return presentarMeta(r.Attributes);
  } catch (err) {
    if (!esCondicion(err)) throw err;
  }
  const { Item } = await docClient.send(new GetCommand({ TableName: tabla, Key: clave, ConsistentRead: true }));
  if (!Item) throw errorInventario('Sesión de dictado no encontrada.', 404);
  throw errorInventario(`La sesión de dictado está ${Item.estado}.`, 409);
}

/** activa → pausada (idempotente). 404 sin sesión; 409 si está cerrada. */
export function pausarSesion(inventarioId, usuario) {
  return cambiarEstadoSesion(inventarioId, usuario, 'pausada', ['activa', 'pausada']);
}

/** pausada | cerrada → activa (idempotente). 404 sin sesión. */
export function reanudarSesion(inventarioId, usuario) {
  return cambiarEstadoSesion(inventarioId, usuario, 'activa', ['pausada', 'cerrada', 'activa']);
}

/** → cerrada (idempotente). No borra líneas. 404 sin sesión. */
export function cerrarSesion(inventarioId, usuario) {
  return cambiarEstadoSesion(inventarioId, usuario, 'cerrada', ['activa', 'pausada', 'cerrada']);
}
