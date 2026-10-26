/**
 * Plantillas de inventario comunes a todos los almacenes: familias o productos,
 * no las dos cosas. El almacén entra al abrir el conteo, no aquí.
 *
 * El índice solo lista por almacén, así que las plantillas comunes comparten la
 * clave `COMUN`. Las que se guardaron antes, con un almacén real, se siguen
 * leyendo para no perderlas.
 */

import { randomUUID } from 'crypto';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { normalizeWarehouseId } from '../mia/keys.js';
import {
  claveListadoPlantilla,
  errorInventario,
  idSegmento,
  pkPlantilla,
  skFamilia,
  skMeta,
  skProducto,
  texto,
} from './claves.js';
import { actualizar, borrarClave, borrarPk, poner, queryPk, queryPorAlmacen } from './store.js';

/** Partición del índice para las plantillas que no son de un almacén. */
export const ALMACEN_PLANTILLAS = 'COMUN';

const MODOS = new Set(['familias', 'productos']);

function skMiembro(modo, id) {
  return modo === 'familias' ? skFamilia(id) : skProducto(id);
}

function normalizarMiembros(modo, raw) {
  if (!Array.isArray(raw)) throw errorInventario('miembros debe ser una lista');
  if (raw.length > 500) throw errorInventario('demasiados miembros en la plantilla');
  const vistos = new Set();
  return raw.map((m) => {
    const id = idSegmento(m?.id, modo === 'familias' ? 'familia' : 'producto');
    if (vistos.has(id)) throw errorInventario(`miembro duplicado: ${id}`);
    vistos.add(id);
    return { id, nombre: texto(m?.nombre, 'nombre del miembro', { max: 200 }) };
  });
}

function presentar(meta, miembros) {
  const vista = {
    plantillaId: meta.plantillaId,
    nombre: meta.nombre,
    modo: meta.modo,
    numMiembros: Number.isFinite(Number(meta.numMiembros)) ? Number(meta.numMiembros) : 0,
    creadoEn: meta.creadoEn,
    actualizadoEn: meta.actualizadoEn,
  };
  if (miembros) {
    vista.miembros = miembros
      .map((m) => ({ id: m.refId, nombre: m.nombre || '' }))
      .sort((a, b) => a.id.localeCompare(b.id, 'es'));
  }
  return vista;
}

function partir(items) {
  const meta = items.find((it) => it.SK === skMeta());
  if (!meta) return null;
  const prefijo = meta.modo === 'familias' ? 'FAMILIA#' : 'PRODUCTO#';
  const miembros = items.filter((it) => String(it.SK || '').startsWith(prefijo));
  return presentar(meta, miembros);
}

export async function obtenerPlantilla(plantillaId) {
  const id = idSegmento(plantillaId, 'plantillaId');
  const vista = partir(await queryPk(pkPlantilla(id)));
  if (!vista) throw errorInventario('Plantilla no encontrada', 404);
  return vista;
}

/** Ids de almacén del maestro. Si la tabla no está, la lista común sigue valiendo. */
async function idsAlmacenes() {
  try {
    const ids = [];
    let lastKey;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tables.almacenes,
        ProjectionExpression: 'Id',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const it of r.Items || []) {
        const id = normalizeWarehouseId(it.Id);
        if (id && id !== '000000') ids.push(id);
      }
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
    return ids;
  } catch {
    return [];
  }
}

export async function listarPlantillas() {
  const origenes = [ALMACEN_PLANTILLAS];
  const ya = new Set(origenes);
  for (const id of await idsAlmacenes()) {
    if (ya.has(id)) continue;
    ya.add(id);
    origenes.push(id);
  }
  const vistos = new Set();
  const metas = [];
  for (const origen of origenes) {
    for (const meta of await queryPorAlmacen(origen, 'PLANTILLA#')) {
      if (!meta.plantillaId || vistos.has(meta.plantillaId)) continue;
      vistos.add(meta.plantillaId);
      metas.push(meta);
    }
  }
  return metas
    .map((meta) => presentar(meta, null))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

async function escribirMiembros(pk, modo, miembros) {
  for (const m of miembros) {
    await poner({
      PK: pk,
      SK: skMiembro(modo, m.id),
      refId: m.id,
      nombre: m.nombre,
    }, { exigir: false });
  }
}

export async function crearPlantilla({ nombre, modo, miembros }, usuario) {
  const nombreLimpio = texto(nombre, 'nombre', { obligatorio: true, max: 120 });
  if (!MODOS.has(modo)) throw errorInventario('modo debe ser familias o productos');
  const lista = normalizarMiembros(modo, miembros ?? []);
  const id = randomUUID();
  const ahora = new Date().toISOString();
  const pk = pkPlantilla(id);
  await poner({
    PK: pk,
    SK: skMeta(),
    WarehouseId: ALMACEN_PLANTILLAS,
    Clave: claveListadoPlantilla(id),
    plantillaId: id,
    nombre: nombreLimpio,
    modo,
    creadoEn: ahora,
    actualizadoEn: ahora,
    actualizadoPor: usuario || '',
    miembrosVersion: 1,
    numMiembros: lista.length,
  }, { crear: true });
  await escribirMiembros(pk, modo, lista);
  return obtenerPlantilla(id);
}

export async function actualizarPlantilla(plantillaId, { nombre, modo, miembros }, usuario) {
  const id = idSegmento(plantillaId, 'plantillaId');
  const pk = pkPlantilla(id);
  const items = await queryPk(pk, { consistente: true });
  const meta = items.find((it) => it.SK === skMeta());
  if (!meta) throw errorInventario('Plantilla no encontrada', 404);
  const modoNuevo = modo ?? meta.modo;
  if (!MODOS.has(modoNuevo)) throw errorInventario('modo debe ser familias o productos');
  const lista = miembros === undefined ? null : normalizarMiembros(modoNuevo, miembros);
  if (modo !== undefined && modo !== meta.modo && lista === null) {
    throw errorInventario('al cambiar el modo hay que enviar los miembros');
  }
  const ahora = new Date().toISOString();
  const nombreNuevo = nombre === undefined ? meta.nombre : texto(nombre, 'nombre', { obligatorio: true, max: 120 });
  const quien = usuario || '';
  if (!lista) {
    await actualizar(
      { PK: pk, SK: skMeta() },
      {
        expression: 'SET nombre = :nombre, WarehouseId = :almacen, actualizadoEn = :ahora, actualizadoPor = :quien',
        condition: 'attribute_exists(PK)',
        values: { ':nombre': nombreNuevo, ':almacen': ALMACEN_PLANTILLAS, ':ahora': ahora, ':quien': quien },
      },
    );
    return obtenerPlantilla(id);
  }
  const version = Number(meta.miembrosVersion ?? 0);
  await actualizar(
    { PK: pk, SK: skMeta() },
    {
      expression: 'SET nombre = :nombre, modo = :modo, WarehouseId = :almacen, miembrosVersion = :nueva, numMiembros = :num, actualizadoEn = :ahora, actualizadoPor = :quien',
      condition: 'miembrosVersion = :vieja',
      values: {
        ':nombre': nombreNuevo,
        ':modo': modoNuevo,
        ':almacen': ALMACEN_PLANTILLAS,
        ':nueva': version + 1,
        ':vieja': version,
        ':num': lista.length,
        ':ahora': ahora,
        ':quien': quien,
      },
    },
  );
  await escribirMiembros(pk, modoNuevo, lista);
  const despues = await queryPk(pk, { consistente: true });
  const quedan = new Set(lista.map((m) => skMiembro(modoNuevo, m.id)));
  for (const it of despues) {
    if (it.SK !== skMeta() && !quedan.has(it.SK)) await borrarClave(pk, it.SK);
  }
  return obtenerPlantilla(id);
}

export async function borrarPlantilla(plantillaId) {
  const actual = await obtenerPlantilla(plantillaId);
  await borrarPk(pkPlantilla(actual.plantillaId));
  return { ok: true, plantillaId: actual.plantillaId };
}
