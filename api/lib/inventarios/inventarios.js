/**
 * Cabecera y líneas de un inventario.
 * El stock real se guarda con decimales. El teórico es la copia del momento
 * en que se creó la línea: esta capa no llama a Ágora.
 */

import { randomUUID } from 'crypto';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../db.js';
import {
  ESTADOS,
  TRANSICIONES,
  almacenId,
  botellasAbiertasDe,
  claveListadoInventario,
  errorInventario,
  fechaIso,
  idSegmento,
  numeroNoNegativo,
  pkInventario,
  skLinea,
  skMeta,
  stockRealDe,
  texto,
} from './claves.js';
import { obtenerPlantilla } from './plantillas.js';
import {
  actualizar,
  borrarClave,
  borrarSi,
  poner,
  queryPk,
  queryPorAlmacen,
  tablaInventarios,
  transaccion,
} from './store.js';

const ESTADOS_CONTEO = new Set(['borrador', 'contado']);

function presentarLinea(it) {
  return {
    productId: it.productId,
    nombre: it.nombre || '',
    familiaNombre: it.familiaNombre || '',
    unidad: it.unidad || '',
    stockTeorico: it.stockTeorico,
    stockReal: it.stockReal ?? null,
    botellasAbiertas: it.botellasAbiertas ?? 0,
  };
}

function presentarMeta(meta, lineas) {
  return {
    inventarioId: meta.inventarioId,
    warehouseId: meta.WarehouseId,
    fecha: meta.fecha,
    employeeId: meta.employeeId,
    employeeNombre: meta.employeeNombre || '',
    plantillaId: meta.plantillaId,
    plantillaNombre: meta.plantillaNombre || '',
    estado: meta.estado,
    creadoEn: meta.creadoEn,
    actualizadoEn: meta.actualizadoEn,
    estadoEn: meta.estadoEn || null,
    estadoPor: meta.estadoPor || '',
    exportaciones: Number(meta.exportaciones) || 0,
    ultimaExportacionEn: meta.ultimaExportacionEn || null,
    ultimaExportacionPor: meta.ultimaExportacionPor || '',
    ...(lineas && { lineas }),
  };
}

function partir(items) {
  const meta = items.find((it) => it.SK === skMeta());
  if (!meta) return null;
  const lineas = items
    .filter((it) => String(it.SK || '').startsWith('LINE#'))
    .map(presentarLinea)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.productId.localeCompare(b.productId, 'es'));
  return { meta, vista: presentarMeta(meta, lineas) };
}

/** Ítem exacto con lectura consistente, o null. */
async function leerClave(pk, sk) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: tablaInventarios(),
    Key: { PK: pk, SK: sk },
    ConsistentRead: true,
  }));
  return Item || null;
}

/** Solo las LINE# de la partición: no lee fotos, lecturas ni sesiones de dictado. */
async function leerLineas(pk) {
  const items = [];
  let lastKey;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tablaInventarios(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': pk, ':p': 'LINE#' },
      ConsistentRead: true,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function cargar(inventarioId) {
  const id = idSegmento(inventarioId, 'inventarioId');
  const pk = pkInventario(id);
  const meta = await leerClave(pk, skMeta());
  if (!meta) throw errorInventario('Inventario no encontrado', 404);
  return partir([meta, ...(await leerLineas(pk))]);
}

/** LINE#<productId> tal cual está en Dynamo (con stockTeorico), o null. Uso interno del backend. */
export async function leerLineaConteo(inventarioId, productId) {
  const id = idSegmento(inventarioId, 'inventarioId');
  return leerClave(pkInventario(id), skLinea(idSegmento(productId, 'productId')));
}

function exigirEditable(meta) {
  if (meta.estado === 'importado') {
    throw errorInventario('El inventario importado no se puede modificar', 409);
  }
}

/** Mismas reglas que guardarLinea: importado → 409; quien solo cuenta, solo en borrador/contado (403). */
export function exigirConteo(meta, soloContar) {
  exigirEditable(meta);
  if (soloContar && !ESTADOS_CONTEO.has(meta.estado)) {
    throw errorInventario('El conteo ya no se puede modificar', 403);
  }
}

function lineaDesde(raw, { previa, soloContar }) {
  const productId = idSegmento(raw?.productId, 'productId');
  let stockTeorico;
  if (previa && soloContar) {
    stockTeorico = previa.stockTeorico;
  } else if (raw?.stockTeorico == null && previa) {
    stockTeorico = previa.stockTeorico;
  } else {
    stockTeorico = numeroNoNegativo(raw?.stockTeorico, 'stockTeorico');
  }
  const stockReal = raw && Object.prototype.hasOwnProperty.call(raw, 'stockReal')
    ? stockRealDe(raw.stockReal)
    : (previa ? (previa.stockReal ?? null) : null);
  const botellasAbiertas = raw && Object.prototype.hasOwnProperty.call(raw, 'botellasAbiertas')
    ? botellasAbiertasDe(raw.botellasAbiertas)
    : (previa ? (previa.botellasAbiertas ?? 0) : 0);
  return {
    productId,
    nombre: raw?.nombre === undefined && previa ? (previa.nombre || '') : texto(raw?.nombre, 'nombre', { max: 200 }),
    familiaNombre: raw?.familiaNombre === undefined && previa
      ? (previa.familiaNombre || '')
      : texto(raw?.familiaNombre, 'familiaNombre', { max: 200 }),
    unidad: raw?.unidad === undefined && previa
      ? (previa.unidad || '')
      : texto(raw?.unidad, 'unidad', { max: 200 }),
    stockTeorico,
    stockReal,
    botellasAbiertas,
  };
}

function itemLinea(pk, linea) {
  const item = {
    PK: pk,
    SK: skLinea(linea.productId),
    productId: linea.productId,
    nombre: linea.nombre,
    familiaNombre: linea.familiaNombre,
    unidad: linea.unidad,
    stockTeorico: linea.stockTeorico,
    botellasAbiertas: linea.botellasAbiertas,
  };
  if (linea.stockReal != null) item.stockReal = linea.stockReal;
  return item;
}

export async function obtenerInventario(inventarioId) {
  return (await cargar(inventarioId)).vista;
}

export async function listarInventarios(warehouseId) {
  const wid = almacenId(warehouseId);
  const metas = await queryPorAlmacen(wid, 'INV#');
  return metas
    .map((meta) => presentarMeta(meta))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.creadoEn.localeCompare(a.creadoEn));
}

/**
 * Último inventario importado de un almacén. Solo fecha y estado: sin líneas
 * ni stock. MIA podrá usarlo más adelante para ver si tiene más de 7 días;
 * esta función no calcula ese plazo y no llama a MIA.
 */
export async function ultimoImportado(warehouseId) {
  const wid = almacenId(warehouseId);
  const metas = await queryPorAlmacen(wid, 'INV#');
  const importados = metas.filter((meta) => meta.estado === 'importado');
  importados.sort((a, b) => {
    const porFecha = String(b.fecha || '').localeCompare(String(a.fecha || ''));
    if (porFecha !== 0) return porFecha;
    const porCierre = String(b.estadoEn || '').localeCompare(String(a.estadoEn || ''));
    if (porCierre !== 0) return porCierre;
    return String(b.inventarioId || '').localeCompare(String(a.inventarioId || ''));
  });
  const meta = importados[0];
  if (!meta) return { warehouseId: wid, inventario: null };
  return {
    warehouseId: wid,
    inventario: {
      inventarioId: meta.inventarioId,
      fecha: meta.fecha,
      estado: meta.estado,
      estadoEn: meta.estadoEn || null,
      estadoPor: meta.estadoPor || '',
    },
  };
}

export async function crearInventario(body, usuario) {
  const wid = almacenId(body?.warehouseId);
  const fecha = fechaIso(body?.fecha);
  const employeeId = idSegmento(body?.employeeId, 'employeeId');
  const employeeNombre = texto(body?.employeeNombre, 'employeeNombre', { max: 120 });
  const plantilla = await obtenerPlantilla(body?.plantillaId);
  const lineasRaw = body?.lineas ?? [];
  if (!Array.isArray(lineasRaw)) throw errorInventario('lineas debe ser una lista');
  const id = randomUUID();
  const ahora = new Date().toISOString();
  const pk = pkInventario(id);
  await poner({
    PK: pk,
    SK: skMeta(),
    WarehouseId: wid,
    Clave: claveListadoInventario(fecha, id),
    inventarioId: id,
    fecha,
    employeeId,
    employeeNombre,
    plantillaId: plantilla.plantillaId,
    plantillaNombre: plantilla.nombre,
    estado: 'borrador',
    creadoEn: ahora,
    actualizadoEn: ahora,
    actualizadoPor: usuario || '',
  }, { crear: true });
  for (const raw of lineasRaw) {
    const linea = lineaDesde({ ...raw }, { previa: null, soloContar: false });
    await poner(itemLinea(pk, linea), { exigir: false });
  }
  return obtenerInventario(id);
}

export async function actualizarCabecera(inventarioId, body, usuario) {
  const { meta } = await cargar(inventarioId);
  exigirEditable(meta);
  const fecha = body?.fecha === undefined ? meta.fecha : fechaIso(body.fecha);
  const employeeId = body?.employeeId === undefined ? meta.employeeId : idSegmento(body.employeeId, 'employeeId');
  const employeeNombre = body?.employeeNombre === undefined
    ? (meta.employeeNombre || '')
    : texto(body.employeeNombre, 'employeeNombre', { max: 120 });
  const ahora = new Date().toISOString();
  const pk = pkInventario(meta.inventarioId);
  await actualizar(
    { PK: pk, SK: skMeta() },
    {
      expression: 'SET fecha = :fecha, employeeId = :employeeId, employeeNombre = :employeeNombre, Clave = :clave, actualizadoEn = :ahora, actualizadoPor = :quien',
      condition: 'estado = :actual AND estado <> :importado',
      values: {
        ':fecha': fecha,
        ':employeeId': employeeId,
        ':employeeNombre': employeeNombre,
        ':clave': claveListadoInventario(fecha, meta.inventarioId),
        ':ahora': ahora,
        ':quien': usuario || '',
        ':actual': meta.estado,
        ':importado': 'importado',
      },
    },
  );
  return obtenerInventario(meta.inventarioId);
}

export async function cambiarEstado(inventarioId, estado, usuario, { soloContar = false } = {}) {
  if (!ESTADOS.includes(estado)) throw errorInventario('estado no válido');
  const { meta } = await cargar(inventarioId);
  if (meta.estado === estado) return obtenerInventario(meta.inventarioId);
  if (soloContar) {
    if (!(meta.estado === 'borrador' && estado === 'contado')) {
      throw errorInventario('El conteo solo puede marcar el inventario como contado', 403);
    }
  } else if (!TRANSICIONES[meta.estado].includes(estado)) {
    throw errorInventario(`No se puede pasar de ${meta.estado} a ${estado}`);
  }
  const ahora = new Date().toISOString();
  await actualizar(
    { PK: pkInventario(meta.inventarioId), SK: skMeta() },
    {
      expression: 'SET estado = :nuevo, estadoEn = :ahora, estadoPor = :quien, actualizadoEn = :ahora, actualizadoPor = :quien',
      condition: 'estado = :actual AND estado <> :importado',
      values: {
        ':nuevo': estado,
        ':ahora': ahora,
        ':quien': usuario || '',
        ':actual': meta.estado,
        ':importado': 'importado',
      },
    },
  );
  return obtenerInventario(meta.inventarioId);
}

/** Anota otra descarga del Excel. El estado sigue siendo exportado. */
export async function anotarExportacion(inventarioId, usuario, veces) {
  const { meta } = await cargar(inventarioId);
  if (meta.estado !== 'exportado') {
    throw errorInventario('Solo se anota la exportación de un inventario exportado');
  }
  const n = Number.isInteger(veces) && veces > 0 ? veces : (Number(meta.exportaciones) || 0) + 1;
  const ahora = new Date().toISOString();
  await actualizar(
    { PK: pkInventario(meta.inventarioId), SK: skMeta() },
    {
      expression: 'SET exportaciones = :veces, ultimaExportacionEn = :ahora, ultimaExportacionPor = :quien, actualizadoEn = :ahora, actualizadoPor = :quien',
      condition: 'estado = :exportado',
      values: {
        ':veces': n,
        ':ahora': ahora,
        ':quien': usuario || '',
        ':exportado': 'exportado',
      },
    },
  );
  return obtenerInventario(meta.inventarioId);
}

export async function guardarLinea(inventarioId, productId, body, usuario, { soloContar = false, crear = false } = {}) {
  const { meta } = await cargar(inventarioId);
  exigirConteo(meta, soloContar);
  const pid = idSegmento(productId, 'productId');
  const pk = pkInventario(meta.inventarioId);
  const previa = await leerClave(pk, skLinea(pid));
  if (crear && meta.estado !== 'borrador' && meta.estado !== 'contado') {
    throw errorInventario('El conteo ya no se puede modificar', 403);
  }
  if (previa && crear) throw errorInventario('Este producto ya está en el conteo', 409);
  if (!previa && !crear) throw errorInventario('La línea no está en el conteo', 404);
  const { linea, operaciones } = escrituraLinea(meta, previa, { ...body, productId: pid }, usuario, { soloContar });
  await transaccion(operaciones);
  return linea;
}

/**
 * Operaciones de TransactWrite que guardan una línea del conteo: Update del META (exige que
 * siga en el mismo estado y no importado) + Put de LINE#. guardarLinea y el dictado escriben
 * con esto, así que ambos guardan exactamente los mismos campos.
 *
 * `condicionExtra` ({ expresion, valores }) se añade con AND a la condición del Put.
 * @returns {{ linea: ReturnType<typeof lineaDesde>, operaciones: object[] }}
 */
export function escrituraLinea(meta, previa, body, usuario, { soloContar = false, condicionExtra = null } = {}) {
  const pk = pkInventario(meta.inventarioId);
  const linea = lineaDesde(body, { previa, soloContar });
  const ahora = new Date().toISOString();
  const tabla = tablaInventarios();
  const base = previa
    ? (soloContar ? 'stockTeorico = :teorico' : 'attribute_exists(PK)')
    : 'attribute_not_exists(PK)';
  const valores = {
    ...(previa && soloContar && { ':teorico': previa.stockTeorico }),
    ...(condicionExtra?.valores || {}),
  };
  const operaciones = [
    {
      Update: {
        TableName: tabla,
        Key: { PK: pk, SK: skMeta() },
        UpdateExpression: 'SET actualizadoEn = :ahora, actualizadoPor = :quien',
        ConditionExpression: 'estado = :estado AND estado <> :importado',
        ExpressionAttributeValues: {
          ':ahora': ahora,
          ':quien': usuario || '',
          ':estado': meta.estado,
          ':importado': 'importado',
        },
      },
    },
    {
      Put: {
        TableName: tabla,
        Item: itemLinea(pk, linea),
        ConditionExpression: condicionExtra ? `(${base}) AND (${condicionExtra.expresion})` : base,
        ...(Object.keys(valores).length > 0 && { ExpressionAttributeValues: valores }),
      },
    },
  ];
  return { linea, operaciones };
}

export async function borrarLinea(inventarioId, productId) {
  const { meta } = await cargar(inventarioId);
  exigirEditable(meta);
  const pid = idSegmento(productId, 'productId');
  const pk = pkInventario(meta.inventarioId);
  const tabla = tablaInventarios();
  await transaccion([
    {
      ConditionCheck: {
        TableName: tabla,
        Key: { PK: pk, SK: skMeta() },
        ConditionExpression: 'attribute_exists(PK) AND estado <> :importado',
        ExpressionAttributeValues: { ':importado': 'importado' },
      },
    },
    {
      Delete: {
        TableName: tabla,
        Key: { PK: pk, SK: skLinea(pid) },
      },
    },
  ]);
  return { ok: true, productId: pid };
}

export async function borrarInventario(inventarioId) {
  const { meta } = await cargar(inventarioId);
  if (meta.estado === 'importado') {
    throw errorInventario('El inventario importado no se puede borrar', 409);
  }
  const pk = pkInventario(meta.inventarioId);
  await borrarSi(pk, skMeta(), 'attribute_exists(PK) AND estado <> :importado', { ':importado': 'importado' });
  const restos = await queryPk(pk, { consistente: true });
  for (const it of restos) {
    await borrarClave(pk, it.SK);
  }
  return { ok: true, inventarioId: meta.inventarioId };
}
