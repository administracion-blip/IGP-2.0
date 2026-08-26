/**
 * Lecturas de la tabla de proyectos que necesitan **los dos** routers del módulo:
 * el de proyectos, para pintar la ficha, y el de tareas, para decidir visibilidad.
 *
 * Vive aparte de la lógica de escritura porque `api/routes/tareas.js` no tiene por
 * qué depender del CRUD de proyectos para responder «¿puede esta persona ver esta
 * tarea?».
 *
 * Ver `docs/tasks/02-modelo-datos.md` y `docs/tasks/04-permisos-y-acceso.md`.
 */

import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { PK, SK } from './tipos.js';

const IDX_MIEMBRO = 'Miembro-index';
/** Tope de `BatchGetItem`. */
const MAX_CLAVES_BATCH = 100;
const MAX_INTENTOS_BATCH = 3;

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

/** Fuera las claves de DynamoDB: no salen hacia el cliente ni hacen falta dentro. */
function sinClaves(item) {
  if (!item) return item;
  const { PK: _pk, SK: _sk, ...resto } = item;
  return resto;
}

/** `PROY#<id>` → `<id>`. */
function idDesdePk(pk) {
  const bruto = texto(pk);
  const corte = bruto.indexOf('#');
  return corte === -1 ? bruto : bruto.slice(corte + 1);
}

/** Recorre todas las páginas de una Query. Las particiones del módulo son pequeñas. */
async function consultarTodo(entrada) {
  const items = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({ ...entrada, ...(desde && { ExclusiveStartKey: desde }) }),
    );
    items.push(...(res.Items || []));
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  return items;
}

/**
 * Un `BatchGet` por trozos de 100, reintentando lo que DynamoDB devuelva sin
 * procesar. El reintento está acotado: es mejor devolver el proyecto sin una de sus
 * filas que girar indefinidamente ante throttling.
 */
async function leerPorClaves(claves) {
  if (claves.length === 0) return [];
  const encontrados = [];
  for (let i = 0; i < claves.length; i += MAX_CLAVES_BATCH) {
    let pendientes = claves.slice(i, i + MAX_CLAVES_BATCH);
    for (let intento = 0; intento < MAX_INTENTOS_BATCH && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchGetCommand({ RequestItems: { [tables.proyectos]: { Keys: pendientes } } }),
      );
      encontrados.push(...(res?.Responses?.[tables.proyectos] || []));
      pendientes = res?.UnprocessedKeys?.[tables.proyectos]?.Keys || [];
    }
  }
  return encontrados;
}

/**
 * Reparte las filas de una partición de proyecto por su tipo de `SK`.
 *
 * @param {object[]} items
 */
function agruparFilas(items) {
  const grupos = { proyecto: null, miembros: [], compras: [], vinculos: [] };
  for (const item of items) {
    const sk = texto(item?.SK);
    if (sk === SK.meta) grupos.proyecto = sinClaves(item);
    else if (sk.startsWith('MIEMBRO#')) grupos.miembros.push(sinClaves(item));
    else if (sk.startsWith('COMPRA#')) grupos.compras.push(sinClaves(item));
    else if (sk.startsWith('VINC#')) grupos.vinculos.push(sinClaves(item));
  }
  return grupos;
}

/**
 * Ficha completa de un proyecto en **una sola Query**: `META`, miembros, líneas de
 * compra y vínculos comparten partición justamente para esto.
 *
 * Devuelve `null` si no existe el ítem `META`. Que aparezcan filas hijas sin `META`
 * solo puede ser un borrado a medias, y tratarlo como «no existe» es lo correcto:
 * un proyecto sin cabecera no se puede mostrar.
 *
 * @param {string} idProyecto
 * @returns {Promise<{ proyecto: object, miembros: object[], compras: object[], vinculos: object[] }|null>}
 */
export async function leerProyectoCompleto(idProyecto) {
  const id = texto(idProyecto);
  if (!id) return null;
  const items = await consultarTodo({
    TableName: tables.proyectos,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': PK.proyecto(id) },
  });
  const grupos = agruparFilas(items);
  return grupos.proyecto ? grupos : null;
}

/**
 * Cabecera y miembros de un proyecto, que es lo que consumen las funciones de
 * `acceso.js`. Se apoya en la misma Query que la ficha completa: leer la partición
 * entera y quedarse con dos grupos cuesta lo mismo que pedir solo esos dos.
 */
export async function leerProyectoConMiembros(idProyecto) {
  const completo = await leerProyectoCompleto(idProyecto);
  if (!completo) return null;
  return { proyecto: completo.proyecto, miembros: completo.miembros };
}

/**
 * Proyectos en los que participa una persona, con el dato justo para decidir acceso.
 *
 * **Por qué existe:** filtrar un listado de tareas exige saber, por cada tarea con
 * proyecto, si quien mira alcanza ese proyecto. Resolverlo leyendo la partición de
 * cada proyecto son tantas Query como proyectos distintos aparezcan en la página —
 * veinte tareas de veinte proyectos, veinte lecturas. Así son dos: una al
 * `Miembro-index` y un `BatchGet`.
 *
 * **`miembros` contiene solo la fila de esta persona.** Es todo lo que miran
 * `rolEnProyecto`, `puedeVerProyecto` y `puedeEditarProyecto`; traer el resto del
 * equipo para decidir sobre uno mismo sería leer de más. Si algún día hace falta la
 * lista completa, es `leerProyectoCompleto`.
 *
 * @param {string} idUsuario
 * @returns {Promise<Map<string, { proyecto: object, miembros: object[] }>>}
 */
export async function proyectosDelUsuario(idUsuario) {
  const usuario = texto(idUsuario);
  const mapa = new Map();
  if (!usuario) return mapa;

  // El índice es KEYS_ONLY: da las particiones, no el rol.
  const filas = await consultarTodo({
    TableName: tables.proyectos,
    IndexName: IDX_MIEMBRO,
    KeyConditionExpression: 'usuario_id = :u',
    ExpressionAttributeValues: { ':u': usuario },
  });

  const pks = [...new Set(filas.map((f) => texto(f?.PK)).filter(Boolean))];
  if (pks.length === 0) return mapa;

  // La cabecera trae `responsable_id`; la fila de miembro, `rol_proyecto`. Hacen
  // falta las dos y se piden juntas.
  const claves = pks.flatMap((pk) => [
    { PK: pk, SK: SK.meta },
    { PK: pk, SK: SK.miembro(usuario) },
  ]);

  for (const item of await leerPorClaves(claves)) {
    const pk = texto(item?.PK);
    const id = idDesdePk(pk);
    if (!id) continue;
    if (!mapa.has(id)) mapa.set(id, { proyecto: null, miembros: [] });
    const entrada = mapa.get(id);
    if (texto(item.SK) === SK.meta) entrada.proyecto = sinClaves(item);
    else entrada.miembros.push(sinClaves(item));
  }

  // Una partición cuya cabecera ya no está no es un proyecto visible.
  for (const [id, entrada] of mapa) {
    if (!entrada.proyecto) mapa.delete(id);
  }
  return mapa;
}

/**
 * Los mismos datos que `proyectosDelUsuario` pero para una lista concreta de
 * proyectos. La usa quien tiene `tareas.ver_todas`: alcanza tareas de proyectos en
 * los que no participa, así que su conjunto no sale del `Miembro-index`.
 *
 * @param {string[]} idsProyecto
 * @param {string} idUsuario Para traer su fila de miembro, si la tiene.
 */
export async function leerProyectosParaAcceso(idsProyecto, idUsuario) {
  const usuario = texto(idUsuario);
  const ids = [...new Set((Array.isArray(idsProyecto) ? idsProyecto : []).map(texto).filter(Boolean))];
  const mapa = new Map();
  if (ids.length === 0) return mapa;

  const claves = ids.flatMap((id) => {
    const pk = PK.proyecto(id);
    const suyas = [{ PK: pk, SK: SK.meta }];
    if (usuario) suyas.push({ PK: pk, SK: SK.miembro(usuario) });
    return suyas;
  });

  for (const item of await leerPorClaves(claves)) {
    const id = idDesdePk(item?.PK);
    if (!id) continue;
    if (!mapa.has(id)) mapa.set(id, { proyecto: null, miembros: [] });
    const entrada = mapa.get(id);
    if (texto(item.SK) === SK.meta) entrada.proyecto = sinClaves(item);
    else entrada.miembros.push(sinClaves(item));
  }

  for (const [id, entrada] of mapa) {
    if (!entrada.proyecto) mapa.delete(id);
  }
  return mapa;
}
