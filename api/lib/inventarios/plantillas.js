/**
 * Plantillas de inventario por almacén: familias o productos, no las dos cosas.
 */

import { randomUUID } from 'crypto';
import {
  claveListadoPlantilla,
  errorInventario,
  idSegmento,
  pkPlantilla,
  skFamilia,
  skMeta,
  skProducto,
  texto,
  almacenId,
} from './claves.js';
import { actualizar, borrarClave, borrarPk, poner, queryPk, queryPorAlmacen } from './store.js';

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
    warehouseId: meta.WarehouseId,
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

export async function listarPlantillas(warehouseId) {
  const wid = almacenId(warehouseId);
  const metas = await queryPorAlmacen(wid, 'PLANTILLA#');
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

export async function crearPlantilla({ warehouseId, nombre, modo, miembros }, usuario) {
  const wid = almacenId(warehouseId);
  const nombreLimpio = texto(nombre, 'nombre', { obligatorio: true, max: 120 });
  if (!MODOS.has(modo)) throw errorInventario('modo debe ser familias o productos');
  const lista = normalizarMiembros(modo, miembros ?? []);
  const id = randomUUID();
  const ahora = new Date().toISOString();
  const pk = pkPlantilla(id);
  await poner({
    PK: pk,
    SK: skMeta(),
    WarehouseId: wid,
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
        expression: 'SET nombre = :nombre, actualizadoEn = :ahora, actualizadoPor = :quien',
        condition: 'attribute_exists(PK)',
        values: { ':nombre': nombreNuevo, ':ahora': ahora, ':quien': quien },
      },
    );
    return obtenerPlantilla(id);
  }
  const version = Number(meta.miembrosVersion ?? 0);
  await actualizar(
    { PK: pk, SK: skMeta() },
    {
      expression: 'SET nombre = :nombre, modo = :modo, miembrosVersion = :nueva, numMiembros = :num, actualizadoEn = :ahora, actualizadoPor = :quien',
      condition: 'miembrosVersion = :vieja',
      values: {
        ':nombre': nombreNuevo,
        ':modo': modoNuevo,
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
