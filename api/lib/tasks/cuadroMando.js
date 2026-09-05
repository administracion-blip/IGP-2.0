/**
 * Cuadro de mando de dirección (Fase 4).
 *
 * Agrega, sin `Scan` y sin GSI nuevo:
 * - proyectos visibles (`Listado-index` + ACL);
 * - carga de tareas abiertas (`Proyecto-index`, prefijo `abierta#`);
 * - acuerdos `incumplido` de las reuniones visibles más recientes.
 *
 * La visibilidad la decide siempre el servidor (`puedeVerProyecto` /
 * `puedeVerReunion` vía los listados existentes). Ver
 * `docs/tasks/03-contrato-api.md`.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  ESTADOS_PROYECTO,
  PK,
  esEstadoTareaTerminal,
} from './tipos.js';
import { listarDepartamentos } from './departamentos.js';
import { nombreDe, nombresDeUsuarios, listarProyectosVisibles } from './proyectos.js';
import { listarReunionesVisibles } from './reuniones.js';
import { fechaHoyMadrid, IDX_PROYECTO } from './tareas.js';

/**
 * Tope de reuniones **visibles** que se revisan al buscar acuerdos incumplidos
 * (Listado-index, más recientes primero). Si el listado sigue, la respuesta marca
 * truncado.
 */
export const MAX_REUNIONES_INCUMPLIDOS = 100;

/** Tamaño de página interno al recorrer índices. */
const TAM_PAGINA = 100;

/** Estados de proyecto que no alimentan la carga de trabajo actual. */
const ESTADOS_PROYECTO_TERMINALES = new Set(['cerrado', 'cancelado']);

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function contadoresVacios() {
  return { abiertas: 0, vencidas: 0, bloqueadas: 0 };
}

function bump(mapa, clave, campo) {
  const id = texto(clave);
  if (!id) return;
  if (!mapa.has(id)) mapa.set(id, contadoresVacios());
  mapa.get(id)[campo] += 1;
}

/** Recorre todas las páginas del listado de proyectos visibles. */
async function todosProyectosVisibles(ctx) {
  const proyectos = [];
  let cursor = null;
  do {
    const r = await listarProyectosVisibles(ctx, { limite: TAM_PAGINA, cursor });
    if (!r.ok) return r;
    proyectos.push(...(r.proyectos || []));
    cursor = r.cursor;
  } while (cursor);
  return { ok: true, proyectos };
}

/**
 * Tareas abiertas de un proyecto vía `Proyecto-index` (`begins_with abiertas`).
 * Sin `Scan`.
 */
async function tareasAbiertasDeProyecto(idProyecto) {
  const id = texto(idProyecto);
  if (!id) return [];
  const items = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.tareas,
        IndexName: IDX_PROYECTO,
        KeyConditionExpression: 'proyecto_id = :p AND begins_with(sk_proyecto, :pref)',
        ExpressionAttributeValues: { ':p': id, ':pref': 'abierta#' },
        ProjectionExpression:
          'id_tarea, titulo, #e, responsable_id, departamento_id, fecha_limite, sk_proyecto',
        ExpressionAttributeNames: { '#e': 'estado' },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    items.push(...(res.Items || []));
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  return items;
}

/** Acuerdos de una reunión (partición), sin cargar asistentes ni puntos. */
async function acuerdosDeReunion(idReunion) {
  const id = texto(idReunion);
  if (!id) return [];
  const items = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': PK.reunion(id),
          ':sk': 'ACUERDO#',
        },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    items.push(...(res.Items || []));
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  return items;
}

/**
 * Reuniones visibles más recientes, con tope documentado.
 * @returns {Promise<{ ok: true, reuniones: object[], truncado: boolean } | { ok: false, status: number, error: string }>}
 */
async function reunionesVisiblesConTope(ctx) {
  const reuniones = [];
  let cursor = null;
  let truncado = false;

  for (;;) {
    const quedan = MAX_REUNIONES_INCUMPLIDOS - reuniones.length;
    if (quedan <= 0) {
      truncado = true;
      break;
    }
    const r = await listarReunionesVisibles(ctx, {
      limite: Math.min(TAM_PAGINA, quedan),
      cursor,
    });
    if (!r.ok) return r;
    reuniones.push(...(r.reuniones || []));
    if (!r.cursor) {
      truncado = false;
      break;
    }
    cursor = r.cursor;
    if (reuniones.length >= MAX_REUNIONES_INCUMPLIDOS) {
      truncado = true;
      break;
    }
  }

  return { ok: true, reuniones, truncado };
}

function agregarProyectos(proyectos) {
  const por_estado = Object.fromEntries(ESTADOS_PROYECTO.map((e) => [e, 0]));
  const activos = [];
  const noTerminales = [];

  for (const p of proyectos) {
    const estado = texto(p.estado);
    if (estado && Object.prototype.hasOwnProperty.call(por_estado, estado)) {
      por_estado[estado] += 1;
    }
    if (estado === 'activo') {
      activos.push({
        id_proyecto: texto(p.id_proyecto),
        nombre: texto(p.nombre) || null,
        responsable_id: texto(p.responsable_id) || null,
        responsable_nombre: p.responsable_nombre ?? null,
        departamento_id: texto(p.departamento_id) || null,
        estado,
      });
    }
    if (!ESTADOS_PROYECTO_TERMINALES.has(estado)) {
      noTerminales.push(p);
    }
  }

  return { por_estado, activos, noTerminales };
}

/**
 * Carga por persona y departamento a partir de tareas abiertas de proyectos
 * visibles no terminales.
 */
async function agregarCarga(proyectosNoTerminales) {
  const porPersona = new Map();
  const porDepartamento = new Map();
  const hoy = fechaHoyMadrid();

  for (const p of proyectosNoTerminales) {
    const tareas = await tareasAbiertasDeProyecto(p.id_proyecto);
    for (const t of tareas) {
      // Defensa: el índice debería traer solo abiertas.
      if (esEstadoTareaTerminal(texto(t.estado))) continue;

      bump(porPersona, t.responsable_id, 'abiertas');
      bump(porDepartamento, t.departamento_id, 'abiertas');

      if (texto(t.estado) === 'bloqueada') {
        bump(porPersona, t.responsable_id, 'bloqueadas');
        bump(porDepartamento, t.departamento_id, 'bloqueadas');
      }

      const limite = texto(t.fecha_limite);
      if (/^\d{4}-\d{2}-\d{2}$/.test(limite) && limite < hoy) {
        bump(porPersona, t.responsable_id, 'vencidas');
        bump(porDepartamento, t.departamento_id, 'vencidas');
      }
    }
  }

  const nombresUsuarios = await nombresDeUsuarios([...porPersona.keys()]);
  const deps = await listarDepartamentos({ soloActivos: false });
  const nombreDep = new Map(deps.map((d) => [texto(d.id), texto(d.nombre) || null]));

  const ordenar = (a, b) =>
    b.abiertas - a.abiertas || String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');

  const carga_personas = [...porPersona.entries()]
    .map(([usuario_id, c]) => ({
      usuario_id,
      nombre: nombreDe(nombresUsuarios, usuario_id),
      abiertas: c.abiertas,
      vencidas: c.vencidas,
      bloqueadas: c.bloqueadas,
    }))
    .sort(ordenar);

  const carga_departamentos = [...porDepartamento.entries()]
    .map(([departamento_id, c]) => ({
      departamento_id,
      nombre: nombreDep.get(departamento_id) ?? null,
      abiertas: c.abiertas,
      vencidas: c.vencidas,
      bloqueadas: c.bloqueadas,
    }))
    .sort(ordenar);

  return { carga_personas, carga_departamentos };
}

async function agregarIncumplidos(ctx) {
  const r = await reunionesVisiblesConTope(ctx);
  if (!r.ok) return r;

  const filas = [];
  const idsNombres = [];

  for (const reunion of r.reuniones) {
    const idReunion = texto(reunion.id_reunion);
    const titulo = texto(reunion.titulo) || null;
    const acuerdos = await acuerdosDeReunion(idReunion);
    for (const a of acuerdos) {
      if (texto(a.estado) !== 'incumplido') continue;
      const responsableId = texto(a.responsable_id) || null;
      if (responsableId) idsNombres.push(responsableId);
      filas.push({
        id_reunion: idReunion,
        reunion_titulo: titulo,
        id_acuerdo: texto(a.id_acuerdo),
        texto: texto(a.texto) || null,
        responsable_id: responsableId,
        fecha_limite: texto(a.fecha_limite) || null,
        tarea_id: texto(a.tarea_id) || null,
      });
    }
  }

  const nombres = await nombresDeUsuarios(idsNombres);
  const acuerdos_incumplidos = filas.map((f) => ({
    ...f,
    responsable_nombre: nombreDe(nombres, f.responsable_id),
  }));

  return {
    ok: true,
    acuerdos_incumplidos,
    acuerdos_incumplidos_truncado: r.truncado,
  };
}

/**
 * Agregado del cuadro de mando para quien pregunta.
 *
 * @param {object} ctx — contexto de acceso (`cargarContextoAcceso`)
 * @returns {Promise<{ ok: true, generado_en: string, proyectos: object, acuerdos_incumplidos: object[], acuerdos_incumplidos_truncado?: boolean, carga_personas: object[], carga_departamentos: object[] } | { ok: false, status: number, error: string }>}
 */
export async function obtenerCuadroMando(ctx) {
  const listado = await todosProyectosVisibles(ctx);
  if (!listado.ok) return listado;

  const { por_estado, activos, noTerminales } = agregarProyectos(listado.proyectos);
  const { carga_personas, carga_departamentos } = await agregarCarga(noTerminales);
  const incumplidos = await agregarIncumplidos(ctx);
  if (!incumplidos.ok) return incumplidos;

  const cuerpo = {
    ok: true,
    generado_en: new Date().toISOString(),
    proyectos: { por_estado, activos },
    acuerdos_incumplidos: incumplidos.acuerdos_incumplidos,
    carga_personas,
    carga_departamentos,
  };
  if (incumplidos.acuerdos_incumplidos_truncado) {
    cuerpo.acuerdos_incumplidos_truncado = true;
    cuerpo.acuerdos_incumplidos_aviso = `Solo se revisaron las ${MAX_REUNIONES_INCUMPLIDOS} reuniones visibles más recientes`;
  }
  return cuerpo;
}
