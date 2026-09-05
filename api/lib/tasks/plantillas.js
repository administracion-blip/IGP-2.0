/**
 * Plantillas de proyecto (Fase 4).
 *
 * Viven en la misma tabla `Igp_Proyectos` con PK `PLANTILLA#…`. Instanciar crea
 * el proyecto real y sus tareas **solo** por `crearProyecto` + `crearTareasEnLote`
 * (sin escritor de tareas propio). Sin Scan: listado por `Listado-index` y
 * lectura/borrado por Query de partición.
 *
 * Ver `docs/tasks/02-modelo-datos.md` y `docs/tasks/03-contrato-api.md`.
 */

import crypto from 'crypto';
import {
  BatchWriteCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  GSI_LISTADO,
  MAX_CHECKLIST,
  MAX_TAREAS_LOTE,
  PK,
  SK,
  aNumeroFinito,
} from './tipos.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';
import { borrarProyecto, crearProyecto } from './proyectos.js';
import { crearTareasEnLote } from './tareas.js';

const IDX_LISTADO = 'Listado-index';
const MAX_LOTE = 25;
const MAX_INTENTOS_LOTE = 3;
/** Tope de tareas por plantilla = tope del lote de creación. */
const MAX_TAREAS_PLANTILLA = MAX_TAREAS_LOTE;

// ─── Utilidades ───

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function ahora() {
  return new Date().toISOString();
}

function hoy() {
  return ahora().slice(0, 10);
}

/** @returns {{ ok: false, status: number, error: string }} */
function rechazar(status, error) {
  return { ok: false, status, error };
}

/**
 * Fecha de calendario `YYYY-MM-DD`, o `null` si no es válida.
 * `''` significa «vacía» (no usar).
 */
function aFecha(valor) {
  const bruto = texto(valor);
  if (!bruto) return '';
  const m = bruto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, anio, mes, dia] = m.map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) return null;
  return bruto.slice(0, 10);
}

/** Suma días enteros a una fecha ISO de calendario. */
function sumarDias(fechaIso, dias) {
  const base = aFecha(fechaIso);
  if (!base) return '';
  const n = aNumeroFinito(dias);
  if (n == null) return '';
  const [, anio, mes, dia] = base.match(/^(\d{4})-(\d{2})-(\d{2})$/).map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  fecha.setUTCDate(fecha.getUTCDate() + Math.trunc(n));
  return fecha.toISOString().slice(0, 10);
}

async function escribirLote(peticiones) {
  for (let i = 0; i < peticiones.length; i += MAX_LOTE) {
    let pendientes = peticiones.slice(i, i + MAX_LOTE);
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tables.proyectos]: pendientes } }),
      );
      pendientes = res?.UnprocessedItems?.[tables.proyectos] || [];
    }
    if (pendientes.length > 0) {
      throw new Error('DynamoDB no aceptó parte del lote de escritura de plantillas');
    }
  }
}

// ─── Forma pública ───

function salidaMeta(item) {
  const { PK: _pk, SK: _sk, gsi_listado: _gsi, ...resto } = item;
  return resto;
}

function salidaTarea(item) {
  const { PK: _pk, SK: _sk, ...resto } = item;
  return resto;
}

function plantillaConTareas(meta, tareas) {
  return {
    ...salidaMeta(meta),
    tareas: (tareas || []).map(salidaTarea).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0)),
  };
}

// ─── Checklist de plantilla ───

/**
 * Lista de comprobación de una tarea de plantilla: solo texto (y orden).
 * Al instanciar, `crearTareasEnLote` / `validarDatosTarea` genera ids y `hecho`.
 */
function normalizarChecklistPlantilla(bruto) {
  if (bruto == null) return { ok: true, checklist: [] };
  if (!Array.isArray(bruto)) {
    return { ok: false, error: 'La lista de comprobación debe ser una lista de elementos' };
  }
  if (bruto.length > MAX_CHECKLIST) {
    return {
      ok: false,
      error: `La lista de comprobación no admite más de ${MAX_CHECKLIST} elementos`,
    };
  }
  const checklist = [];
  for (const [i, entrada] of bruto.entries()) {
    const t = texto(typeof entrada === 'string' ? entrada : entrada?.texto);
    if (!t) {
      return { ok: false, error: 'Hay un elemento de la lista de comprobación sin texto' };
    }
    const ordenBruto = typeof entrada === 'string' ? i : aNumeroFinito(entrada?.orden);
    checklist.push({ texto: t, orden: ordenBruto == null ? i : Math.trunc(ordenBruto) });
  }
  return { ok: true, checklist };
}

/**
 * Normaliza el array de tareas de plantilla. Asigna `orden` 0..n-1 en el orden
 * de entrada (o el `orden` explícito si viene y es único/coherente).
 */
function normalizarTareasPlantilla(bruto) {
  if (bruto == null) return { ok: true, tareas: [] };
  if (!Array.isArray(bruto)) {
    return { ok: false, error: 'Las tareas de la plantilla deben ser una lista' };
  }
  if (bruto.length > MAX_TAREAS_PLANTILLA) {
    return {
      ok: false,
      error: `Una plantilla no admite más de ${MAX_TAREAS_PLANTILLA} tareas`,
    };
  }
  const tareas = [];
  for (const [i, entrada] of bruto.entries()) {
    const titulo = texto(entrada?.titulo);
    if (!titulo) {
      return { ok: false, error: `La tarea ${i + 1} de la plantilla necesita un título` };
    }
    const checklist = normalizarChecklistPlantilla(entrada?.checklist);
    if (!checklist.ok) {
      return { ok: false, error: `Tarea ${i + 1}: ${checklist.error}` };
    }
    let dias = null;
    if (entrada?.dias_desde_inicio !== undefined && entrada?.dias_desde_inicio !== null && texto(entrada.dias_desde_inicio) !== '') {
      const n = aNumeroFinito(entrada.dias_desde_inicio);
      if (n == null || !Number.isInteger(n) || n < 0) {
        return {
          ok: false,
          error: `Tarea ${i + 1}: dias_desde_inicio debe ser un entero ≥ 0`,
        };
      }
      dias = Math.trunc(n);
    }
    const ordenBruto = aNumeroFinito(entrada?.orden);
    tareas.push({
      titulo,
      descripcion: texto(entrada?.descripcion) || undefined,
      dias_desde_inicio: dias,
      rol_responsable_sugerido: texto(entrada?.rol_responsable_sugerido) || undefined,
      checklist: checklist.checklist,
      orden: ordenBruto == null ? i : Math.trunc(ordenBruto),
    });
  }
  // Orden estable por `orden`, y reasignar 0..n-1 para que el SK padded sea denso.
  tareas.sort((a, b) => a.orden - b.orden);
  tareas.forEach((t, i) => {
    t.orden = i;
  });
  return { ok: true, tareas };
}

function filasTareas(idPlantilla, tareas) {
  return tareas.map((t) => {
    const item = {
      PK: PK.plantilla(idPlantilla),
      SK: SK.tareaPlantilla(t.orden),
      titulo: t.titulo,
      orden: t.orden,
      checklist: t.checklist || [],
    };
    if (t.descripcion) item.descripcion = t.descripcion;
    if (t.dias_desde_inicio != null) item.dias_desde_inicio = t.dias_desde_inicio;
    if (t.rol_responsable_sugerido) item.rol_responsable_sugerido = t.rol_responsable_sugerido;
    return item;
  });
}

// ─── Lectura ───

/**
 * Partición completa de una plantilla: META + tareas.
 * @returns {Promise<{ meta: object, tareas: object[] }|null>}
 */
async function leerPlantillaCompleta(idPlantilla) {
  const id = texto(idPlantilla);
  if (!id) return null;
  const items = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.proyectos,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK.plantilla(id) },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    items.push(...(res.Items || []));
    desde = res.LastEvaluatedKey || null;
  } while (desde);

  const meta = items.find((it) => it.SK === SK.meta);
  if (!meta) return null;
  const tareas = items
    .filter((it) => typeof it.SK === 'string' && it.SK.startsWith('TAREA#'))
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  return { meta, tareas };
}

async function clavesDeParticionPlantilla(idPlantilla) {
  const claves = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.proyectos,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK.plantilla(texto(idPlantilla)) },
        ProjectionExpression: 'PK, SK',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const item of res.Items || []) claves.push({ PK: item.PK, SK: item.SK });
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  return claves;
}

/** Claves solo de filas `TAREA#` (para sustituir el set en PATCH). */
async function clavesTareasPlantilla(idPlantilla) {
  const todas = await clavesDeParticionPlantilla(idPlantilla);
  return todas.filter((k) => typeof k.SK === 'string' && k.SK.startsWith('TAREA#'));
}

// ─── Listado ───

/**
 * Listado paginado de plantillas vía `Listado-index` (`gsi_listado = PLANTILLA`),
 * cada una con `tareas[]` embebidas (Query de partición por plantilla).
 */
export async function listarPlantillas({ limite, cursor } = {}) {
  const desde = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.proyectos,
      IndexName: IDX_LISTADO,
      KeyConditionExpression: 'gsi_listado = :g',
      ExpressionAttributeValues: { ':g': GSI_LISTADO.plantilla },
      ScanIndexForward: false,
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  const metas = res.Items || [];
  const plantillas = [];
  for (const meta of metas) {
    const id = texto(meta.id_plantilla);
    const completa = id ? await leerPlantillaCompleta(id) : null;
    if (completa) {
      plantillas.push(plantillaConTareas(completa.meta, completa.tareas));
    } else {
      // Ítem del GSI sin partición legible: devolver al menos la META pública.
      plantillas.push(plantillaConTareas(meta, []));
    }
  }

  return {
    ok: true,
    plantillas,
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

// ─── Alta / edición / borrado ───

/**
 * Crea una plantilla (META + tareas).
 * Body: `{ nombre, descripcion?, departamento_id?, tareas? }`
 */
export async function crearPlantilla(body = {}) {
  const nombre = texto(body.nombre).replace(/\s+/g, ' ');
  if (!nombre) return rechazar(400, 'El nombre de la plantilla es obligatorio');

  const tareasNorm = normalizarTareasPlantilla(body.tareas);
  if (!tareasNorm.ok) return rechazar(400, tareasNorm.error);

  const id = crypto.randomUUID();
  const instante = ahora();
  const meta = {
    PK: PK.plantilla(id),
    SK: SK.meta,
    id_plantilla: id,
    nombre,
    creado_en: instante,
    actualizado_en: instante,
    gsi_listado: GSI_LISTADO.plantilla,
  };
  const descripcion = texto(body.descripcion);
  if (descripcion) meta.descripcion = descripcion;
  const departamentoId = texto(body.departamento_id);
  if (departamentoId) meta.departamento_id = departamentoId;

  const filas = filasTareas(id, tareasNorm.tareas);
  await escribirLote([
    { PutRequest: { Item: meta } },
    ...filas.map((Item) => ({ PutRequest: { Item } })),
  ]);

  return { ok: true, plantilla: plantillaConTareas(meta, filas) };
}

/**
 * Actualiza META y, si viene `tareas`, sustituye el set completo de `TAREA#`.
 */
export async function actualizarPlantilla(idPlantilla, body = {}) {
  const leido = await leerPlantillaCompleta(idPlantilla);
  if (!leido) return rechazar(404, 'La plantilla no existe');

  const id = texto(idPlantilla);
  const instante = ahora();
  const sets = ['#act = :act'];
  const removes = [];
  const nombres = { '#act': 'actualizado_en' };
  const valores = { ':act': instante };
  let i = 0;
  let tocoMeta = false;

  if (body.nombre !== undefined) {
    const nombre = texto(body.nombre).replace(/\s+/g, ' ');
    if (!nombre) return rechazar(400, 'El nombre de la plantilla es obligatorio');
    nombres[`#c${i}`] = 'nombre';
    valores[`:v${i}`] = nombre;
    sets.push(`#c${i} = :v${i}`);
    i += 1;
    tocoMeta = true;
  }

  for (const campo of ['descripcion', 'departamento_id']) {
    if (body[campo] === undefined) continue;
    const valor = texto(body[campo]);
    nombres[`#c${i}`] = campo;
    if (!valor) {
      removes.push(`#c${i}`);
    } else {
      valores[`:v${i}`] = valor;
      sets.push(`#c${i} = :v${i}`);
    }
    i += 1;
    tocoMeta = true;
  }

  let tareasNuevas = null;
  if (body.tareas !== undefined) {
    const tareasNorm = normalizarTareasPlantilla(body.tareas);
    if (!tareasNorm.ok) return rechazar(400, tareasNorm.error);
    tareasNuevas = tareasNorm.tareas;
    tocoMeta = true; // refrescar actualizado_en aunque solo cambien tareas
  }

  if (!tocoMeta && tareasNuevas == null) {
    return rechazar(400, 'No hay nada que actualizar');
  }

  // Sustituir tareas: Put de las nuevas primero (mismos SK `TAREA#orden`) y
  // luego borrar las SK que ya no estén en el set. Así un fallo de escritura
  // no deja la plantilla sin tareas (ni META actualizado a medias).
  if (tareasNuevas != null) {
    const filas = filasTareas(id, tareasNuevas);
    const skNuevos = new Set(filas.map((f) => f.SK));
    if (filas.length > 0) {
      await escribirLote(filas.map((Item) => ({ PutRequest: { Item } })));
    }
    const viejas = await clavesTareasPlantilla(id);
    const sobrantes = viejas.filter((k) => !skNuevos.has(k.SK));
    if (sobrantes.length > 0) {
      await escribirLote(sobrantes.map((Key) => ({ DeleteRequest: { Key } })));
    }
  }

  let metaFinal = leido.meta;
  try {
    const actualizado = await docClient.send(
      new UpdateCommand({
        TableName: tables.proyectos,
        Key: { PK: PK.plantilla(id), SK: SK.meta },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ExpressionAttributeNames: nombres,
        ExpressionAttributeValues: valores,
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    metaFinal = actualizado.Attributes || leido.meta;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return rechazar(404, 'La plantilla no existe');
    }
    throw err;
  }

  const completa = await leerPlantillaCompleta(id);
  return {
    ok: true,
    plantilla: plantillaConTareas(completa?.meta || metaFinal, completa?.tareas || []),
  };
}

/** Borrado físico de la partición completa de la plantilla. */
export async function borrarPlantilla(idPlantilla) {
  const leido = await leerPlantillaCompleta(idPlantilla);
  if (!leido) return rechazar(404, 'La plantilla no existe');

  const claves = await clavesDeParticionPlantilla(idPlantilla);
  if (claves.length > 0) {
    await escribirLote(claves.map((Key) => ({ DeleteRequest: { Key } })));
  }
  return { ok: true };
}

// ─── Instanciar ───

/**
 * Crea un proyecto a partir de la plantilla y sus tareas vía lote.
 *
 * Body: `{ nombre?, responsable_id?, departamento_id?, fecha_inicio?, estado?, prioridad? }`
 *
 * Si el lote falla tras crear el proyecto, se compensa con `borrarProyecto`.
 *
 * @returns {Promise<{ ok: true, proyecto: object, creadas: object[], omitidas: object[] } | { ok: false, status: number, error: string, fallos?: object[] }>}
 */
export async function instanciarPlantilla(ctx, idPlantilla, body = {}) {
  const leido = await leerPlantillaCompleta(idPlantilla);
  if (!leido) return rechazar(404, 'La plantilla no existe');

  const nombre =
    texto(body.nombre).replace(/\s+/g, ' ') || texto(leido.meta.nombre);
  if (!nombre) return rechazar(400, 'El nombre del proyecto es obligatorio');

  const fechaInicioBruto = body.fecha_inicio !== undefined ? aFecha(body.fecha_inicio) : hoy();
  if (fechaInicioBruto === null) {
    return rechazar(400, 'La fecha de inicio debe ir en formato AAAA-MM-DD');
  }
  const fechaInicio = fechaInicioBruto || hoy();

  const departamentoId =
    texto(body.departamento_id) || texto(leido.meta.departamento_id) || undefined;

  const alta = await crearProyecto(
    ctx,
    {
      nombre,
      descripcion: texto(leido.meta.descripcion) || undefined,
      responsable_id: texto(body.responsable_id) || undefined,
      departamento_id: departamentoId,
      fecha_inicio: fechaInicio,
      estado: body.estado,
      prioridad: body.prioridad,
    },
    { plantillaOrigenId: texto(leido.meta.id_plantilla) },
  );
  if (!alta.ok) return alta;

  const proyecto = alta.proyecto;
  const responsableId = texto(proyecto.responsable_id) || texto(ctx?.idUsuario);

  if (!leido.tareas.length) {
    return { ok: true, proyecto, creadas: [], omitidas: [] };
  }

  const tareasLote = leido.tareas.map((t) => {
    const entrada = {
      titulo: t.titulo,
      responsable_id: responsableId,
      checklist: Array.isArray(t.checklist) ? t.checklist.map((c) => (typeof c === 'string' ? c : c?.texto)).filter(Boolean) : [],
    };
    if (t.descripcion) entrada.descripcion = t.descripcion;
    if (t.dias_desde_inicio != null) {
      const fechaLimite = sumarDias(fechaInicio, t.dias_desde_inicio);
      if (fechaLimite) entrada.fecha_limite = fechaLimite;
    }
    return entrada;
  });

  let lote;
  try {
    lote = await crearTareasEnLote({
      ctx,
      datos: { proyecto_id: proyecto.id_proyecto, tareas: tareasLote },
    });
  } catch (err) {
    await compensarBorrandoProyecto(ctx, proyecto.id_proyecto);
    throw err;
  }

  if (!lote.ok) {
    // Compensar: no dejar un proyecto a medias sin las tareas de la plantilla.
    await compensarBorrandoProyecto(ctx, proyecto.id_proyecto);
    return lote;
  }

  const creadas = lote.creadas || [];
  // `crearTareasEnLote` puede devolver ok con escritura parcial (UnprocessedItems).
  // Tratarlo igual que un fallo de lote: no dejar el proyecto a medias.
  if (creadas.length !== tareasLote.length) {
    await compensarBorrandoProyecto(ctx, proyecto.id_proyecto);
    return rechazar(500, 'No se pudieron crear todas las tareas de la plantilla');
  }

  return {
    ok: true,
    proyecto,
    creadas,
    omitidas: lote.omitidas || [],
  };
}

/** Compensación tras fallo/parcial del lote de tareas al instanciar. */
async function compensarBorrandoProyecto(ctx, idProyecto) {
  try {
    await borrarProyecto(ctx, idProyecto);
  } catch (err) {
    console.error('[plantillas] Falló la compensación al borrar el proyecto tras error de lote', err);
  }
}
