/**
 * Cola de validación de propuestas IA (Fase 2F).
 *
 * - Listado global vía `Propuesta-Estado-index` (sin Scan), filtrado por
 *   visibilidad de la reunión origen. Itera el GSI hasta reunir N visibles.
 * - Listado por reunión (partición `PROPUESTA#…`).
 * - Resolución: aceptar tarea → `crearTareasEnLote`; aceptar acuerdo →
 *   `ACUERDO#`; rechazar → marcar. GSI disperso: `propuesta_estado` solo existe
 *   mientras está `pendiente`; al resolver se hace `REMOVE` y el resultado va
 *   en `estado`.
 *
 * Contrato: `docs/tasks/03-contrato-api.md` (cuerpo `decisiones` / `accion`).
 */

import crypto from 'crypto';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import {
  ESTADOS_PROPUESTA,
  PK,
  SK,
  TIPOS_PROPUESTA,
  enLista,
} from '../tipos.js';
import { puedeVerReunion } from '../acceso.js';
import { ACCIONES, registrarActividad } from '../actividad.js';
import { responsableDeDepartamento } from '../departamentos.js';
import { nombreDe, nombresDeUsuarios } from '../proyectos.js';
import { crearTareasEnLote } from '../tareas.js';
import { codificarCursor, decodificarCursor, limiteValido } from '../paginacion.js';
import { cargarParaGestionar, cargarParaVer } from '../reuniones.js';

export const IDX_PROPUESTA_ESTADO = 'Propuesta-Estado-index';

const ENTIDAD = 'reunion';
const MAX_CLAVES_BATCH_GET = 100;
const MAX_DECISIONES = 50;
const ESTADO_ACUERDO_INICIAL = 'abierto';
/** Tope de páginas GSI por petición de cola (evita bucles largos). */
const MAX_PAGINAS_COLA = 20;

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function mismoId(a, b) {
  const x = texto(a);
  return x !== '' && x === texto(b);
}

function ahora() {
  return new Date().toISOString();
}

function rechazar(status, error, extra = {}) {
  return { ok: false, status, error, ...extra };
}

function autorDe(ctx) {
  return { id_usuario: ctx?.idUsuario, Nombre: ctx?.nombre };
}

function idReunionDePk(pk) {
  const bruto = texto(pk);
  return bruto.startsWith('REU#') ? bruto.slice(4) : '';
}

function esErrorCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

/** Pendiente = atributo disperso `propuesta_estado` presente con valor pendiente. */
function esPendiente(item) {
  return texto(item?.propuesta_estado) === 'pendiente';
}

/**
 * Estado efectivo para API y filtros de listado por reunión.
 * Pendiente vive en el atributo disperso; el resto en `estado`.
 */
function estadoEfectivo(item) {
  if (esPendiente(item)) return 'pendiente';
  const resuelto = texto(item?.estado);
  if (resuelto) return resuelto;
  // Compat: ítems antiguos que guardaban el valor resuelto en propuesta_estado.
  const legado = texto(item?.propuesta_estado);
  return legado && legado !== 'pendiente' ? legado : '';
}

function tieneCita(item) {
  return !!texto(item?.cita);
}

function claveGsiPropuesta(item) {
  return {
    PK: item.PK,
    SK: item.SK,
    propuesta_estado: item.propuesta_estado,
    creado_en: item.creado_en,
  };
}

function salidaPropuesta(item, extras = {}) {
  const { PK: _pk, SK: _sk, estado: _estadoPersistido, ...resto } = item;
  return {
    ...resto,
    // Contrato / UI: un solo campo `propuesta_estado` con el valor efectivo.
    propuesta_estado: estadoEfectivo(item),
    id_reunion: extras.id_reunion || idReunionDePk(item.PK) || resto.id_reunion || '',
    ...(extras.reunion_titulo != null && { reunion_titulo: extras.reunion_titulo }),
    ...(extras.responsable_sugerido_nombre !== undefined && {
      responsable_sugerido_nombre: extras.responsable_sugerido_nombre,
    }),
  };
}

/**
 * Quién de la página es asistente de quien pregunta: un `BatchGet` de
 * `ASIST#<yo>`, no una Query por reunión.
 */
async function mapaAsistenciaPropia(ctx, idsReunion) {
  const yo = texto(ctx?.idUsuario);
  const ids = [...new Set((idsReunion || []).map(texto).filter(Boolean))];
  const soy = new Set();
  if (!yo || ids.length === 0) return soy;

  for (let i = 0; i < ids.length; i += MAX_CLAVES_BATCH_GET) {
    const Keys = ids.slice(i, i + MAX_CLAVES_BATCH_GET).map((id) => ({
      PK: PK.reunion(id),
      SK: SK.asistente(yo),
    }));
    const res = await docClient.send(
      new BatchGetCommand({
        RequestItems: { [tables.reuniones]: { Keys, ProjectionExpression: 'PK' } },
      }),
    );
    for (const item of res?.Responses?.[tables.reuniones] || []) {
      const id = idReunionDePk(item.PK);
      if (id) soy.add(id);
    }
  }
  return soy;
}

async function mapaMetasReunion(idsReunion) {
  const ids = [...new Set((idsReunion || []).map(texto).filter(Boolean))];
  const mapa = new Map();
  if (ids.length === 0) return mapa;

  for (let i = 0; i < ids.length; i += MAX_CLAVES_BATCH_GET) {
    const Keys = ids.slice(i, i + MAX_CLAVES_BATCH_GET).map((id) => ({
      PK: PK.reunion(id),
      SK: SK.meta,
    }));
    const res = await docClient.send(
      new BatchGetCommand({
        RequestItems: { [tables.reuniones]: { Keys } },
      }),
    );
    for (const item of res?.Responses?.[tables.reuniones] || []) {
      const id = texto(item.id_reunion) || idReunionDePk(item.PK);
      if (id) mapa.set(id, item);
    }
  }
  return mapa;
}

async function mapaResponsablesDepartamento(idsDepartamento) {
  const unicos = [...new Set((idsDepartamento || []).map(texto).filter(Boolean))];
  const mapa = new Map();
  await Promise.all(
    unicos.map(async (id) => {
      mapa.set(id, texto(await responsableDeDepartamento(id)));
    }),
  );
  return mapa;
}

async function tocarReunion(idReunion, instante) {
  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(texto(idReunion)), SK: SK.meta },
      UpdateExpression: 'SET actualizado_en = :a',
      ExpressionAttributeValues: { ':a': instante },
    }),
  );
}

async function leerPropuesta(idReunion, idPropuesta) {
  const res = await docClient.send(
    new GetCommand({
      TableName: tables.reuniones,
      Key: {
        PK: PK.reunion(texto(idReunion)),
        SK: SK.propuesta(texto(idPropuesta)),
      },
    }),
  );
  return res.Item || null;
}

/**
 * Cola global de propuestas pendientes. Query al GSI; filtra cita/visibilidad
 * e itera hasta reunir `limite` ítems visibles o agotar el índice.
 */
export async function listarPropuestasPendientes(ctx, { limite, cursor } = {}) {
  const objetivo = limiteValido(limite);
  const visibles = [];
  let desde = decodificarCursor(cursor);
  let cursorSalida = null;
  let paginas = 0;

  while (visibles.length < objetivo && paginas < MAX_PAGINAS_COLA) {
    paginas += 1;
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        IndexName: IDX_PROPUESTA_ESTADO,
        KeyConditionExpression: 'propuesta_estado = :e',
        ExpressionAttributeValues: { ':e': 'pendiente' },
        ScanIndexForward: true,
        Limit: objetivo,
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );

    const pagina = res.Items || [];
    if (pagina.length === 0) {
      cursorSalida = null;
      break;
    }

    // Recorremos la página cruda para poder dejar el cursor tras el último
    // ítem consumido (aunque se haya descartado por cita/visibilidad).
    const idsPagina = pagina.map((p) => idReunionDePk(p.PK)).filter(Boolean);
    const metas = await mapaMetasReunion(idsPagina);
    const soyAsistente = await mapaAsistenciaPropia(ctx, idsPagina);
    const responsablesDep = await mapaResponsablesDepartamento(
      [...metas.values()].map((m) => m.departamento_id),
    );

    let lleno = false;
    for (let i = 0; i < pagina.length; i += 1) {
      const prop = pagina[i];
      const clave = claveGsiPropuesta(prop);

      let aceptada = false;
      if (tieneCita(prop)) {
        const idReu = idReunionDePk(prop.PK);
        const meta = metas.get(idReu);
        if (meta) {
          const dep = texto(meta.departamento_id);
          const responsableDep = dep ? responsablesDep.get(dep) || '' : '';
          const asistentes = soyAsistente.has(idReu) ? [{ usuario_id: ctx.idUsuario }] : [];
          const aux = {
            asistentes,
            esResponsableDepartamento: !!responsableDep && mismoId(responsableDep, ctx.idUsuario),
          };
          if (puedeVerReunion(ctx, meta, asistentes, aux)) {
            visibles.push(
              salidaPropuesta(prop, {
                id_reunion: idReu,
                reunion_titulo: texto(meta.titulo) || null,
              }),
            );
            aceptada = true;
          }
        }
      }

      const hayMasEnPagina = i < pagina.length - 1;
      const hayMasPaginas = !!res.LastEvaluatedKey;

      if (aceptada && visibles.length >= objetivo) {
        cursorSalida = hayMasEnPagina || hayMasPaginas ? clave : null;
        lleno = true;
        break;
      }

      // Ítem descartado: el cursor de continuación sigue siendo tras él si
      // acabamos la página sin llenar y hay más en Dynamo.
      if (!lleno && i === pagina.length - 1) {
        cursorSalida = hayMasPaginas ? res.LastEvaluatedKey : null;
      }
    }

    if (lleno) break;
    if (!res.LastEvaluatedKey) {
      cursorSalida = null;
      break;
    }
    desde = res.LastEvaluatedKey;
  }

  const nombres = await nombresDeUsuarios(visibles.map((p) => p.responsable_sugerido_id));
  return {
    ok: true,
    propuestas: visibles.map((p) => ({
      ...p,
      responsable_sugerido_nombre: nombreDe(nombres, p.responsable_sugerido_id),
    })),
    cursor: codificarCursor(cursorSalida),
  };
}

/**
 * Propuestas de una reunión. Por defecto todas; `?estado=pendiente` filtra.
 * Sin cita no se muestran.
 */
export async function listarPropuestasDeReunion(ctx, idReunion, { estado } = {}) {
  const cargado = await cargarParaVer(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const filtro = texto(estado);
  if (filtro && !enLista(ESTADOS_PROPUESTA, filtro)) {
    return rechazar(400, `Estado de propuesta no válido: admite ${ESTADOS_PROPUESTA.join(', ')}`);
  }

  const items = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
        ExpressionAttributeValues: {
          ':pk': PK.reunion(texto(idReunion)),
          ':pref': 'PROPUESTA#',
        },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    items.push(...(res.Items || []));
    desde = res.LastEvaluatedKey || null;
  } while (desde);

  let lista = items.filter(tieneCita);
  if (filtro) {
    lista = lista.filter((p) => estadoEfectivo(p) === filtro);
  }

  lista.sort((a, b) => texto(a.creado_en).localeCompare(texto(b.creado_en)));

  const nombres = await nombresDeUsuarios(lista.map((p) => p.responsable_sugerido_id));
  return {
    ok: true,
    propuestas: lista.map((p) =>
      salidaPropuesta(p, {
        id_reunion: texto(idReunion),
        responsable_sugerido_nombre: nombreDe(nombres, p.responsable_sugerido_id),
      }),
    ),
  };
}

function camposEditadosRespecto(prop, decision) {
  const overrides = [];
  if (decision.titulo !== undefined && texto(decision.titulo) !== texto(prop.titulo)) {
    overrides.push('titulo');
  }
  if (decision.descripcion !== undefined && texto(decision.descripcion) !== texto(prop.descripcion)) {
    overrides.push('descripcion');
  }
  if (
    decision.responsable_id !== undefined &&
    texto(decision.responsable_id) !== texto(prop.responsable_sugerido_id)
  ) {
    overrides.push('responsable_id');
  }
  if (
    decision.fecha_limite !== undefined &&
    texto(decision.fecha_limite) !== texto(prop.fecha_limite_sugerida)
  ) {
    overrides.push('fecha_limite');
  }
  return overrides;
}

function valoresEfectivos(prop, decision) {
  return {
    titulo: decision.titulo !== undefined ? texto(decision.titulo) : texto(prop.titulo),
    descripcion:
      decision.descripcion !== undefined ? texto(decision.descripcion) : texto(prop.descripcion),
    responsable_id:
      decision.responsable_id !== undefined
        ? texto(decision.responsable_id)
        : texto(prop.responsable_sugerido_id),
    fecha_limite:
      decision.fecha_limite !== undefined
        ? texto(decision.fecha_limite)
        : texto(prop.fecha_limite_sugerida),
  };
}

/**
 * Marca resuelta: SET `estado`, REMOVE `propuesta_estado` (sale del GSI),
 * `resuelta_por` / `resuelta_en`. Solo si seguía pendiente (condición).
 *
 * @returns {{ ok: true, propuesta: object, condicionFallo?: false } | { ok: true, condicionFallo: true }}
 */
async function marcarPropuestaResuelta(prop, { estado, usuarioId, instante, extras = {} }) {
  const nombres = {
    '#pe': 'propuesta_estado',
    '#est': 'estado',
    '#rp': 'resuelta_por',
    '#re': 'resuelta_en',
  };
  const valores = {
    ':pendiente': 'pendiente',
    ':est': estado,
    ':rp': texto(usuarioId),
    ':re': instante,
  };
  const sets = ['#est = :est', '#rp = :rp', '#re = :re'];
  let i = 0;
  for (const [campo, valor] of Object.entries(extras)) {
    if (valor === undefined || valor === null || valor === '') continue;
    const alias = `#x${i}`;
    const placeholder = `:x${i}`;
    nombres[alias] = campo;
    valores[placeholder] = valor;
    sets.push(`${alias} = ${placeholder}`);
    i += 1;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.reuniones,
        Key: { PK: prop.PK, SK: prop.SK },
        UpdateExpression: `SET ${sets.join(', ')} REMOVE #pe`,
        ConditionExpression: '#pe = :pendiente',
        ExpressionAttributeNames: nombres,
        ExpressionAttributeValues: valores,
      }),
    );
  } catch (err) {
    if (esErrorCondicion(err)) {
      return { ok: true, condicionFallo: true };
    }
    throw err;
  }

  const fusion = {
    ...prop,
    estado,
    resuelta_por: texto(usuarioId),
    resuelta_en: instante,
    ...extras,
  };
  delete fusion.propuesta_estado;

  return {
    ok: true,
    condicionFallo: false,
    propuesta: salidaPropuesta(fusion),
  };
}

async function respuestaIdempotenteTarea(prop) {
  return {
    ok: true,
    propuesta: salidaPropuesta(prop),
    tarea_id: texto(prop.tarea_id) || null,
    omitida: true,
  };
}

async function respuestaIdempotenteAcuerdo(prop) {
  return {
    ok: true,
    propuesta: salidaPropuesta(prop),
    acuerdo_id: texto(prop.acuerdo_id) || null,
    omitida: true,
  };
}

async function aceptarComoTarea(ctx, idReunion, reunion, prop, decision, instante) {
  const valores = valoresEfectivos(prop, decision);
  if (!valores.titulo) {
    return rechazar(400, `La propuesta ${prop.id_propuesta} no tiene título`);
  }
  if (!valores.responsable_id) {
    return rechazar(
      400,
      `La propuesta ${prop.id_propuesta} necesita un responsable para crear la tarea`,
    );
  }

  const editada = camposEditadosRespecto(prop, decision).length > 0;
  const estadoFinal = editada ? 'editada_y_aceptada' : 'aceptada';

  if (!esPendiente(prop) && texto(prop.tarea_id)) {
    return respuestaIdempotenteTarea(prop);
  }
  if (!esPendiente(prop)) {
    const actual = estadoEfectivo(prop);
    if (actual === 'aceptada' || actual === 'editada_y_aceptada') {
      return respuestaIdempotenteTarea(prop);
    }
    return rechazar(
      409,
      `La propuesta ${prop.id_propuesta} ya está resuelta como «${actual || 'desconocido'}»`,
    );
  }

  const lote = await crearTareasEnLote({
    ctx,
    datos: {
      proyecto_id: texto(reunion.proyecto_id) || undefined,
      reunion_origen_id: texto(idReunion),
      tareas: [
        {
          titulo: valores.titulo.slice(0, 200),
          descripcion: valores.descripcion || valores.titulo,
          responsable_id: valores.responsable_id,
          fecha_limite: valores.fecha_limite || undefined,
          propuesta_origen_id: texto(prop.id_propuesta),
          cita_origen: texto(prop.cita),
        },
      ],
    },
  });
  if (!lote.ok) return lote;

  const creada = lote.creadas[0] || lote.omitidas?.[0]?.tarea;
  const tareaId = texto(creada?.id_tarea);
  if (!tareaId) {
    return rechazar(500, `No se pudo crear la tarea de la propuesta ${prop.id_propuesta}`);
  }

  const marcado = await marcarPropuestaResuelta(prop, {
    estado: estadoFinal,
    usuarioId: ctx.idUsuario,
    instante,
    extras: { tarea_id: tareaId },
  });
  if (marcado.condicionFallo) {
    const actual = await leerPropuesta(idReunion, prop.id_propuesta);
    return respuestaIdempotenteTarea(actual || { ...prop, tarea_id: tareaId, estado: estadoFinal });
  }

  return {
    ok: true,
    propuesta: marcado.propuesta,
    tarea_id: tareaId,
    tarea: creada,
    omitida: !!(lote.omitidas && lote.omitidas.length > 0 && lote.creadas.length === 0),
  };
}

async function aceptarComoAcuerdo(ctx, idReunion, prop, decision, instante) {
  const valores = valoresEfectivos(prop, decision);
  const textoAcuerdo = valores.titulo || valores.descripcion;
  if (!textoAcuerdo) {
    return rechazar(400, `La propuesta ${prop.id_propuesta} no tiene texto de acuerdo`);
  }

  const editada = camposEditadosRespecto(prop, decision).length > 0;
  const estadoFinal = editada ? 'editada_y_aceptada' : 'aceptada';

  // Idempotencia antes del Put: ya enlazada o ya no pendiente.
  if (texto(prop.acuerdo_id) || !esPendiente(prop)) {
    const actual = estadoEfectivo(prop);
    if (texto(prop.acuerdo_id) || actual === 'aceptada' || actual === 'editada_y_aceptada') {
      return respuestaIdempotenteAcuerdo(prop);
    }
    return rechazar(
      409,
      `La propuesta ${prop.id_propuesta} ya está resuelta como «${actual || 'desconocido'}»`,
    );
  }

  const idAcuerdo = crypto.randomUUID();
  const acuerdo = {
    PK: PK.reunion(texto(idReunion)),
    SK: SK.acuerdo(idAcuerdo),
    id_acuerdo: idAcuerdo,
    texto: textoAcuerdo,
    responsable_id: valores.responsable_id || '',
    fecha_limite: valores.fecha_limite || '',
    estado: ESTADO_ACUERDO_INICIAL,
    cita: texto(prop.cita),
    tarea_id: '',
    propuesta_origen_id: texto(prop.id_propuesta),
    validado_por: texto(ctx.idUsuario),
    validado_en: instante,
    creado_por: texto(ctx.idUsuario),
    creado_en: instante,
    actualizado_en: instante,
  };

  await docClient.send(new PutCommand({ TableName: tables.reuniones, Item: acuerdo }));

  const marcado = await marcarPropuestaResuelta(prop, {
    estado: estadoFinal,
    usuarioId: ctx.idUsuario,
    instante,
    extras: { acuerdo_id: idAcuerdo },
  });

  if (marcado.condicionFallo) {
    const actual = await leerPropuesta(idReunion, prop.id_propuesta);
    return respuestaIdempotenteAcuerdo(actual || prop);
  }

  const { PK: _pk, SK: _sk, ...acuerdoOut } = acuerdo;
  return {
    ok: true,
    propuesta: marcado.propuesta,
    acuerdo_id: idAcuerdo,
    acuerdo: acuerdoOut,
    omitida: false,
  };
}

async function rechazarPropuesta(ctx, prop, instante) {
  const actual = estadoEfectivo(prop);
  if (actual === 'rechazada') {
    return { ok: true, propuesta: salidaPropuesta(prop), omitida: true };
  }
  if (!esPendiente(prop)) {
    return rechazar(
      409,
      `La propuesta ${prop.id_propuesta} ya está resuelta como «${actual || 'desconocido'}»`,
    );
  }

  const marcado = await marcarPropuestaResuelta(prop, {
    estado: 'rechazada',
    usuarioId: ctx.idUsuario,
    instante,
  });
  if (marcado.condicionFallo) {
    const idReu = idReunionDePk(prop.PK);
    const relectura = await leerPropuesta(idReu, prop.id_propuesta);
    const estado = estadoEfectivo(relectura || prop);
    if (estado === 'rechazada') {
      return { ok: true, propuesta: salidaPropuesta(relectura || prop), omitida: true };
    }
    return rechazar(
      409,
      `La propuesta ${prop.id_propuesta} ya está resuelta como «${estado || 'desconocido'}»`,
    );
  }
  return { ok: true, propuesta: marcado.propuesta, omitida: false };
}

/**
 * Resuelve varias propuestas de una reunión.
 *
 * Cuerpo (contrato): `{ decisiones: [{ id_propuesta, accion: 'aceptar'|'rechazar',
 * titulo?, descripcion?, responsable_id?, fecha_limite? }] }`
 */
export async function resolverPropuestas(ctx, idReunion, body = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const decisiones = Array.isArray(body.decisiones) ? body.decisiones : null;
  if (!decisiones || decisiones.length === 0) {
    return rechazar(400, 'Envía al menos una decisión');
  }
  if (decisiones.length > MAX_DECISIONES) {
    return rechazar(400, `No se pueden resolver más de ${MAX_DECISIONES} propuestas de golpe`);
  }

  // Validación previa: si alguna es inválida, no se aplica ninguna.
  const preparadas = [];
  const fallos = [];
  for (const [indice, d] of decisiones.entries()) {
    const idProp = texto(d?.id_propuesta);
    const accion = texto(d?.accion);
    if (!idProp) {
      fallos.push({ indice, error: 'Falta id_propuesta' });
      continue;
    }
    if (accion !== 'aceptar' && accion !== 'rechazar') {
      fallos.push({ indice, error: "accion debe ser 'aceptar' o 'rechazar'" });
      continue;
    }
    const prop = await leerPropuesta(idReunion, idProp);
    if (!prop || !tieneCita(prop)) {
      fallos.push({ indice, error: `Propuesta no encontrada: ${idProp}` });
      continue;
    }
    if (!enLista(TIPOS_PROPUESTA, texto(prop.tipo))) {
      fallos.push({ indice, error: `Tipo de propuesta no válido: ${prop.tipo}` });
      continue;
    }
    preparadas.push({ indice, decision: d, prop, accion });
  }
  if (fallos.length > 0) {
    return rechazar(400, `No se ha resuelto ninguna: ${fallos.length} decisión(es) inválida(s)`, {
      fallos,
    });
  }

  const instante = ahora();
  const resueltas = [];

  for (const { decision, prop, accion } of preparadas) {
    let resultado;
    if (accion === 'rechazar') {
      resultado = await rechazarPropuesta(ctx, prop, instante);
    } else if (texto(prop.tipo) === 'acuerdo') {
      resultado = await aceptarComoAcuerdo(ctx, idReunion, prop, decision, instante);
    } else {
      resultado = await aceptarComoTarea(
        ctx,
        idReunion,
        cargado.reunion,
        prop,
        decision,
        instante,
      );
    }
    if (!resultado.ok) return resultado;
    resueltas.push({
      id_propuesta: texto(prop.id_propuesta),
      accion,
      propuesta_estado: resultado.propuesta?.propuesta_estado,
      tarea_id: resultado.tarea_id || null,
      acuerdo_id: resultado.acuerdo_id || null,
      omitida: !!resultado.omitida,
      propuesta: resultado.propuesta,
      ...(resultado.tarea && { tarea: resultado.tarea }),
      ...(resultado.acuerdo && { acuerdo: resultado.acuerdo }),
    });
  }

  await tocarReunion(idReunion, instante);
  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: {
      propuestas_resueltas: resueltas.map((r) => ({
        id_propuesta: r.id_propuesta,
        accion: r.accion,
        propuesta_estado: r.propuesta_estado,
        tarea_id: r.tarea_id,
        acuerdo_id: r.acuerdo_id,
      })),
    },
  });

  return { ok: true, resueltas };
}
