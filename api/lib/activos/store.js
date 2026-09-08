/**
 * Acceso a DynamoDB del módulo de activos. Solo Get/Query/Put/Update.
 * Sin Scan sobre las tablas de este módulo.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  GSI,
  GSI_LISTADO_ACTIVO,
  GSI_LISTADO_CAT,
  GSI_LISTADO_MOD,
  GSI_LISTADO_PLANT,
  PREFIJO_ASSET,
  PREFIJO_CAT,
  PREFIJO_EVT,
  PREFIJO_MOD,
  PREFIJO_PLANT,
  SK_CONTADOR,
  SK_META,
  errorHttp,
} from './tipos.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';
import { acumularDisponiblePorModelo, acumularDisponiblePorTalla } from './stockDisponible.js';
import { mismoLocalImputado } from './localImputado.js';

function ahora() {
  return new Date().toISOString();
}

function pkCat(id) {
  return `${PREFIJO_CAT}${id}`;
}
function pkMod(id) {
  return `${PREFIJO_MOD}${id}`;
}
function pkPlant(id) {
  return `${PREFIJO_PLANT}${id}`;
}
function pkEvento(assetId) {
  return `${PREFIJO_ASSET}${assetId}`;
}

export function claveEstadoCatEtiqueta(estado, categoriaId, etiqueta) {
  return `${estado}#${categoriaId}#${etiqueta}`;
}

async function queryPagina({
  TableName,
  IndexName,
  KeyConditionExpression,
  ExpressionAttributeValues,
  ExpressionAttributeNames,
  ExclusiveStartKey,
  ScanIndexForward,
  Limit,
  FilterExpression,
}) {
  const r = await docClient.send(
    new QueryCommand({
      TableName,
      ...(IndexName && { IndexName }),
      KeyConditionExpression,
      ExpressionAttributeValues,
      ...(ExpressionAttributeNames && { ExpressionAttributeNames }),
      ...(ExclusiveStartKey && { ExclusiveStartKey }),
      ...(ScanIndexForward === false && { ScanIndexForward: false }),
      ...(Limit && { Limit }),
      ...(FilterExpression && { FilterExpression }),
    }),
  );
  return {
    items: r.Items || [],
    cursor: codificarCursor(r.LastEvaluatedKey || null),
  };
}

// ─── Catálogo ───

export async function getCategoria(categoriaId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.activosCatalogo,
      Key: { PK: pkCat(categoriaId), SK: SK_META },
    }),
  );
  return r.Item || null;
}

export async function putCategoria(item) {
  await docClient.send(
    new PutCommand({
      TableName: tables.activosCatalogo,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

export async function updateCategoria(categoriaId, expresion) {
  await docClient.send(
    new UpdateCommand({
      TableName: tables.activosCatalogo,
      Key: { PK: pkCat(categoriaId), SK: SK_META },
      ...expresion,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

export async function listarCategorias({ cursor, limite, soloActivas = false } = {}) {
  return queryPagina({
    TableName: tables.activosCatalogo,
    IndexName: GSI.listadoCatalogo,
    KeyConditionExpression: 'gsi_listado = :g',
    ExpressionAttributeValues: { ':g': GSI_LISTADO_CAT },
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite),
    ...(soloActivas && {
      FilterExpression: 'activo = :si',
      ExpressionAttributeValues: { ':g': GSI_LISTADO_CAT, ':si': true },
    }),
  });
}

/** Recorre el catálogo de categorías (volumen bajo) y dice si el prefijo ya existe. */
export async function prefijoCategoriaEnUso(prefijo, exceptoId = null) {
  let cursor = null;
  do {
    const r = await listarCategorias({ cursor, limite: 200 });
    for (const it of r.items) {
      if (exceptoId && it.categoria_id === exceptoId) continue;
      if (it.prefijo_etiqueta === prefijo) return true;
    }
    cursor = r.cursor;
  } while (cursor);
  return false;
}

export async function getModelo(modeloId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.activosCatalogo,
      Key: { PK: pkMod(modeloId), SK: SK_META },
    }),
  );
  return r.Item || null;
}

export async function putModelo(item) {
  await docClient.send(
    new PutCommand({
      TableName: tables.activosCatalogo,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

export async function updateModelo(modeloId, expresion) {
  await docClient.send(
    new UpdateCommand({
      TableName: tables.activosCatalogo,
      Key: { PK: pkMod(modeloId), SK: SK_META },
      ...expresion,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

export async function getPlantilla(plantillaId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.activosCatalogo,
      Key: { PK: pkPlant(plantillaId), SK: SK_META },
    }),
  );
  return r.Item || null;
}

export async function putPlantilla(item) {
  await docClient.send(
    new PutCommand({
      TableName: tables.activosCatalogo,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

export async function updatePlantilla(plantillaId, expresion) {
  await docClient.send(
    new UpdateCommand({
      TableName: tables.activosCatalogo,
      Key: { PK: pkPlant(plantillaId), SK: SK_META },
      ...expresion,
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

export async function listarPlantillas({ cursor, limite, soloActivas = false } = {}) {
  return queryPagina({
    TableName: tables.activosCatalogo,
    IndexName: GSI.listadoCatalogo,
    KeyConditionExpression: 'gsi_listado = :g',
    ExpressionAttributeValues: { ':g': GSI_LISTADO_PLANT },
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite),
    ...(soloActivas && {
      FilterExpression: 'activo = :si',
      ExpressionAttributeValues: { ':g': GSI_LISTADO_PLANT, ':si': true },
    }),
  });
}

export async function listarModelos({ categoriaId, marcaNorm, cursor, limite, soloActivos = false } = {}) {
  const limit = limiteValido(limite);
  const start = decodificarCursor(cursor);
  const soloMod = 'begins_with(PK, :mod)';
  if (categoriaId) {
    const filter = [soloMod];
    const values = { ':c': categoriaId, ':mod': PREFIJO_MOD };
    if (soloActivos) {
      filter.push('activo = :si');
      values[':si'] = true;
    }
    return queryPagina({
      TableName: tables.activosCatalogo,
      IndexName: GSI.categoria,
      KeyConditionExpression: 'categoria_id = :c',
      FilterExpression: filter.join(' AND '),
      ExpressionAttributeValues: values,
      ExclusiveStartKey: start,
      Limit: limit,
    });
  }
  if (marcaNorm) {
    return queryPagina({
      TableName: tables.activosCatalogo,
      IndexName: GSI.marca,
      KeyConditionExpression: 'marca_norm = :m',
      ExpressionAttributeValues: {
        ':m': marcaNorm,
        ...(soloActivos ? { ':si': true } : {}),
      },
      ExclusiveStartKey: start,
      Limit: limit,
      ...(soloActivos && { FilterExpression: 'activo = :si' }),
    });
  }
  return queryPagina({
    TableName: tables.activosCatalogo,
    IndexName: GSI.listadoCatalogo,
    KeyConditionExpression: 'gsi_listado = :g',
    ExpressionAttributeValues: {
      ':g': GSI_LISTADO_MOD,
      ...(soloActivos ? { ':si': true } : {}),
    },
    ExclusiveStartKey: start,
    Limit: limit,
    ...(soloActivos && { FilterExpression: 'activo = :si' }),
  });
}

export async function contarModelosActivosDeCategoria(categoriaId) {
  const r = await docClient.send(
    new QueryCommand({
      TableName: tables.activosCatalogo,
      IndexName: GSI.categoria,
      KeyConditionExpression: 'categoria_id = :c',
      FilterExpression: 'begins_with(PK, :mod) AND activo = :si',
      ExpressionAttributeValues: { ':c': categoriaId, ':si': true, ':mod': PREFIJO_MOD },
      Select: 'COUNT',
    }),
  );
  return r.Count || 0;
}

export async function hayActivosDeModelo(modeloId) {
  const r = await docClient.send(
    new QueryCommand({
      TableName: tables.activos,
      IndexName: GSI.modelo,
      KeyConditionExpression: 'modelo_id = :m',
      FilterExpression: 'estado <> :baja',
      Limit: 1,
      ExpressionAttributeValues: { ':m': modeloId, ':baja': 'baja' },
    }),
  );
  return (r.Items || []).length > 0;
}

// ─── Contador ───

/**
 * Reserva el siguiente correlativo de la categoría. ADD es atómico: dos altas
 * simultáneas no pueden llevarse el mismo número. Si el ítem no existe, Dynamo
 * lo crea y parte de 0+1.
 */
export async function reservarCorrelativo(categoriaId) {
  const r = await docClient.send(
    new UpdateCommand({
      TableName: tables.activosContadores,
      Key: { PK: pkCat(categoriaId), SK: SK_CONTADOR },
      UpdateExpression: 'SET actualizado_en = :now ADD ultimo_numero :uno',
      ExpressionAttributeValues: { ':uno': 1, ':now': ahora() },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const n = Number(r.Attributes?.ultimo_numero);
  if (!Number.isInteger(n) || n < 1) {
    throw errorHttp(500, 'No se pudo reservar el número de etiqueta');
  }
  return n;
}

export async function leerContador(categoriaId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.activosContadores,
      Key: { PK: pkCat(categoriaId), SK: SK_CONTADOR },
      ConsistentRead: true,
    }),
  );
  return r.Item || null;
}

// ─── Activos ───

export async function getActivo(assetId) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.activos,
      Key: { asset_id: assetId },
    }),
  );
  return r.Item || null;
}

export async function putActivoNuevo(item) {
  await docClient.send(
    new PutCommand({
      TableName: tables.activos,
      Item: item,
      ConditionExpression: 'attribute_not_exists(asset_id)',
    }),
  );
}

export async function updateActivo(assetId, expresion) {
  const r = await docClient.send(
    new UpdateCommand({
      TableName: tables.activos,
      Key: { asset_id: assetId },
      ...expresion,
      ConditionExpression: expresion.ConditionExpression
        ? `attribute_exists(asset_id) AND (${expresion.ConditionExpression})`
        : 'attribute_exists(asset_id)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return r.Attributes || null;
}

export async function buscarPorEtiqueta(prefijo, etiqueta, { exacta = false } = {}) {
  const r = await docClient.send(
    new QueryCommand({
      TableName: tables.activos,
      IndexName: GSI.etiqueta,
      KeyConditionExpression: exacta
        ? 'prefijo_etiqueta = :p AND etiqueta_legible = :e'
        : 'prefijo_etiqueta = :p AND begins_with(etiqueta_legible, :e)',
      ExpressionAttributeValues: exacta
        ? { ':p': prefijo, ':e': etiqueta }
        : { ':p': prefijo, ':e': etiqueta },
      Limit: exacta ? 5 : 20,
    }),
  );
  return r.Items || [];
}

export async function buscarPorSerie(serieNorm) {
  const r = await docClient.send(
    new QueryCommand({
      TableName: tables.activos,
      IndexName: GSI.serie,
      KeyConditionExpression: 'numero_serie_norm = :s',
      ExpressionAttributeValues: { ':s': serieNorm },
      Limit: 20,
    }),
  );
  return r.Items || [];
}

export async function listarActivosPorLocal({
  idLocal,
  estado,
  categoriaId,
  cursor,
  limite,
} = {}) {
  let kce = 'id_local = :loc';
  const values = { ':loc': idLocal };
  if (estado && categoriaId) {
    kce += ' AND begins_with(gsi_estado_cat_etiqueta, :pref)';
    values[':pref'] = `${estado}#${categoriaId}#`;
  } else if (estado) {
    kce += ' AND begins_with(gsi_estado_cat_etiqueta, :pref)';
    values[':pref'] = `${estado}#`;
  } else if (categoriaId) {
    return queryPagina({
      TableName: tables.activos,
      IndexName: GSI.centroEstado,
      KeyConditionExpression: 'id_local = :loc',
      FilterExpression: 'categoria_id = :cat',
      ExpressionAttributeValues: { ':loc': idLocal, ':cat': categoriaId },
      ExclusiveStartKey: decodificarCursor(cursor),
      Limit: limiteValido(limite),
    });
  }
  return queryPagina({
    TableName: tables.activos,
    IndexName: GSI.centroEstado,
    KeyConditionExpression: kce,
    ExpressionAttributeValues: values,
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite),
  });
}

export async function listarActivosGlobal({ cursor, limite, estado, categoriaId } = {}) {
  const filter = [];
  const values = { ':g': GSI_LISTADO_ACTIVO };
  if (estado) {
    filter.push('estado = :est');
    values[':est'] = estado;
  }
  if (categoriaId) {
    filter.push('categoria_id = :cat');
    values[':cat'] = categoriaId;
  }
  return queryPagina({
    TableName: tables.activos,
    IndexName: GSI.listadoActivos,
    KeyConditionExpression: 'gsi_listado = :g',
    ExpressionAttributeValues: values,
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite),
    ...(filter.length && { FilterExpression: filter.join(' AND ') }),
  });
}

export async function listarPendientesVerificacion({ idLocal, cursor, limite } = {}) {
  return queryPagina({
    TableName: tables.activos,
    IndexName: GSI.pendienteVerificacion,
    KeyConditionExpression: 'id_local = :loc',
    FilterExpression: 'etiqueta_verificada = :no AND estado <> :baja',
    ExpressionAttributeValues: { ':loc': idLocal, ':no': false, ':baja': 'baja' },
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite),
  });
}

export async function listarActivosDeModelo(modeloId, { cursor, limite } = {}) {
  return queryPagina({
    TableName: tables.activos,
    IndexName: GSI.modelo,
    KeyConditionExpression: 'modelo_id = :m',
    ExpressionAttributeValues: { ':m': modeloId },
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite),
  });
}

/** Recorre el listado global (Query, no Scan) y suma stock en almacén por modelo y talla. */
export async function sumarDisponiblePorModelo() {
  const totales = new Map();
  const porTalla = new Map();
  let cursor;
  do {
    const r = await listarActivosGlobal({ cursor, limite: 100, estado: 'en_almacen' });
    acumularDisponiblePorModelo(r.items, totales);
    acumularDisponiblePorTalla(r.items, porTalla);
    cursor = r.cursor;
  } while (cursor);
  return { totales, porTalla };
}

async function queryLotesModeloLocal(modeloId, idLocal, atributosNorm) {
  const r = await docClient.send(
    new QueryCommand({
      TableName: tables.activos,
      IndexName: GSI.modelo,
      KeyConditionExpression: 'modelo_id = :m',
      FilterExpression: 'id_local = :loc AND granularidad = :g AND estado <> :baja AND atributos_norm = :a',
      ExpressionAttributeValues: {
        ':m': modeloId,
        ':loc': idLocal,
        ':g': 'lote',
        ':baja': 'baja',
        ':a': atributosNorm,
      },
    }),
  );
  return r.Items || [];
}

/** Lote de almacén (sin trabajador). No mezcla filas ya entregadas. */
export async function buscarLoteEnLocal(modeloId, idLocal, atributosNorm) {
  const items = await queryLotesModeloLocal(modeloId, idLocal, atributosNorm);
  return items.find((it) => !it.custodio_id && it.estado === 'en_almacen') || null;
}

/**
 * Lote ya entregado a ese trabajador (mismo modelo, talla y local). Si se
 * indica `localImputadoId`, solo fusiona con el lote que impute a ese local.
 */
export async function buscarLoteAsignado(modeloId, idLocal, atributosNorm, custodioId, localImputadoId = null) {
  const cid = String(custodioId || '');
  if (!cid) return null;
  const items = await queryLotesModeloLocal(modeloId, idLocal, atributosNorm);
  return items.find((it) => (
    String(it.custodio_id || '') === cid
    && it.estado === 'asignado'
    && (localImputadoId == null || mismoLocalImputado(it, localImputadoId))
  )) || null;
}

export async function listarAsignados({ cursor, limite } = {}) {
  return queryPagina({
    TableName: tables.activos,
    IndexName: GSI.listadoActivos,
    KeyConditionExpression: 'gsi_listado = :g',
    FilterExpression: 'estado = :est',
    ExpressionAttributeValues: { ':g': GSI_LISTADO_ACTIVO, ':est': 'asignado' },
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite),
  });
}

// ─── Eventos ───

export function itemEvento({ assetId, eventoId, tipo, usuario, antes, despues, notas, fotos, loteAltaId }) {
  const creadoEn = ahora();
  return {
    PK: pkEvento(assetId),
    SK: `${PREFIJO_EVT}${creadoEn}#${eventoId}`,
    evento_id: eventoId,
    asset_id: assetId,
    tipo,
    usuario_id: usuario?.id || usuario?.sub || '',
    usuario_nombre: usuario?.nombre || usuario?.email || '',
    creado_en: creadoEn,
    antes: antes ?? null,
    despues: despues ?? null,
    notas: notas || null,
    fotos: fotos || [],
    lote_alta_id: loteAltaId || null,
  };
}

export async function putEvento(item) {
  await docClient.send(
    new PutCommand({
      TableName: tables.activosEventos,
      Item: item,
    }),
  );
}

export async function listarEventos(assetId, { cursor, limite } = {}) {
  return queryPagina({
    TableName: tables.activosEventos,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
    ExpressionAttributeValues: { ':pk': pkEvento(assetId), ':pref': PREFIJO_EVT },
    ExclusiveStartKey: decodificarCursor(cursor),
    Limit: limiteValido(limite, { porDefecto: 50, maximo: 200 }),
    ScanIndexForward: false,
  });
}

