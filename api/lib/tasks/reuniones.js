/**
 * Reuniones del módulo de dirección (Fase 1B + 2A): listado, ficha, asistentes,
 * acuerdos, aviso de grabación, conversión de acuerdos a tareas, y captura de
 * audio por subida (presign / marcar pipeline). El STT y el poller son 2B/2D.
 *
 * Decisiones que conviene tener presentes:
 *
 * 1. **D-16 / D-20 / D-21 / D-23.** Lo no visible → `404`. El orden del día se
 *    congela al pasar a `celebrada` (o superior no cancelada) y también al
 *    pedir la URL de subida de audio si aún no había copia. Calendar stub no
 *    tumba la reunión. Acuerdos → tareas lo hace el servidor vía lote.
 * 2. **El acceso no se decide aquí.** `puedeVerReunion` / `puedeGestionarReunion`
 *    de `acceso.js`; esto solo traduce a 403/404.
 * 3. **Sin `Scan`.** Listado por `Listado-index` (o `Proyecto-index` /
 *    `Serie-index` cuando toca). Tareas hijas por `Reunion-index`.
 * 4. **Nombres y `permisos_fila` los resuelve el servidor**, igual que
 *    proyectos/tareas.
 *
 * Ver `docs/tasks/02-modelo-datos.md` y `docs/tasks/03-contrato-api.md`.
 */

import crypto from 'crypto';
import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  crearEvento as calendarCrear,
  actualizarEvento as calendarActualizar,
  borrarEvento as calendarBorrar,
  disponible as calendarDisponible,
} from '../google/calendarClient.js';
import {
  ESTADOS_ACUERDO,
  ESTADOS_REUNION,
  GSI_LISTADO,
  MODALIDADES_REUNION,
  PERMISOS,
  PK,
  SK,
  VISIBILIDADES_REUNION,
  VISIBILIDAD_REUNION,
  enLista,
} from './tipos.js';
import {
  filtrarVisibles,
  puedeGestionarReunion,
  puedeVerReunion,
  tienePermiso,
} from './acceso.js';
import { ACCIONES, listarActividad, registrarActividad } from './actividad.js';
import { responsableDeDepartamento } from './departamentos.js';
import { emailsDeUsuarios, nombreDe, nombresDeUsuarios } from './proyectos.js';
import { crearTareasEnLote, IDX_REUNION } from './tareas.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';

const IDX_LISTADO = 'Listado-index';
const IDX_PROYECTO = 'Proyecto-index';
const IDX_SERIE = 'Serie-index';
const ENTIDAD = 'reunion';
const MAX_LOTE = 25;
const MAX_INTENTOS_LOTE = 3;
const MAX_CLAVES_BATCH_GET = 100;

/** Estados en los que el orden del día ya no se edita (D-20). `cancelada` no cuenta. */
const ESTADOS_ORDEN_BLOQUEADO = Object.freeze(['celebrada', 'acta_borrador', 'acta_validada']);

const ESTADO_INICIAL = 'borrador';
const VISIBILIDAD_POR_DEFECTO = VISIBILIDAD_REUNION.departamento;
const ESTADO_ACUERDO_INICIAL = 'abierto';

if (
  !enLista(ESTADOS_REUNION, ESTADO_INICIAL) ||
  !enLista(VISIBILIDADES_REUNION, VISIBILIDAD_POR_DEFECTO) ||
  !enLista(ESTADOS_ACUERDO, ESTADO_ACUERDO_INICIAL)
) {
  throw new Error('Los valores por defecto de reunión no coinciden con tipos.js');
}

// ─── Utilidades ───

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

function rechazar(status, error) {
  return { ok: false, status, error };
}

function autorDe(ctx) {
  return { id_usuario: ctx?.idUsuario, Nombre: ctx?.nombre };
}

function ordenBloqueado(estado) {
  return ESTADOS_ORDEN_BLOQUEADO.includes(texto(estado));
}

/**
 * Fecha de calendario `YYYY-MM-DD`. Admite instante ISO y se queda con el día.
 * @returns {string|null} `''` si venía vacía, `null` si no es fecha real.
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

/** Hora `HH:mm` o cadena vacía. */
function aHora(valor) {
  const bruto = texto(valor);
  if (!bruto) return '';
  if (!/^\d{2}:\d{2}$/.test(bruto)) return null;
  const [h, m] = bruto.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return bruto;
}

// ─── Lectura de partición ───

async function leerParticion(idReunion) {
  const id = texto(idReunion);
  if (!id) return null;
  const items = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK.reunion(id) },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    items.push(...(res.Items || []));
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  if (items.length === 0) return null;

  const meta = items.find((it) => it.SK === SK.meta);
  if (!meta) return null;

  return {
    reunion: meta,
    asistentes: items.filter((it) => String(it.SK || '').startsWith('ASIST#')),
    acuerdos: items.filter((it) => String(it.SK || '').startsWith('ACUERDO#')),
    puntos: items.filter((it) => String(it.SK || '').startsWith('PUNTO#')),
    vinculos: items.filter((it) => String(it.SK || '').startsWith('VINC#')),
  };
}

async function leerMeta(idReunion) {
  const id = texto(idReunion);
  if (!id) return null;
  const res = await docClient.send(
    new GetCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(id), SK: SK.meta },
    }),
  );
  return res.Item || null;
}

async function auxDeReunion(reunion, asistentes = []) {
  const dep = texto(reunion?.departamento_id);
  if (dep) {
    const responsable = await responsableDeDepartamento(dep);
    return { asistentes, responsableDepartamentoId: responsable };
  }
  return { asistentes, responsableDepartamentoId: '', esResponsableDepartamento: false };
}

function auxConCtx(ctx, auxBase = {}) {
  return {
    ...auxBase,
    esResponsableDepartamento:
      !!texto(auxBase.responsableDepartamentoId) &&
      mismoId(auxBase.responsableDepartamentoId, ctx?.idUsuario),
  };
}

/**
 * Traduce la decisión de acceso. Lo no visible → `404` (D-16).
 * @returns {{ ok: false, status: number, error: string }|null}
 */
function comprobarAcceso(ctx, leido, { gestionar = false } = {}) {
  const aux = auxConCtx(ctx, { asistentes: leido.asistentes, ...leido.auxExtra });
  if (!puedeVerReunion(ctx, leido.reunion, leido.asistentes, aux)) {
    return rechazar(404, 'La reunión no existe');
  }
  if (gestionar && !puedeGestionarReunion(ctx, leido.reunion, leido.asistentes, aux)) {
    return rechazar(403, 'No puedes gestionar esta reunión');
  }
  return null;
}

/** Expuesto para propuestas (Fase 2F): misma ACL de lectura que la ficha. */
export async function cargarParaVer(ctx, idReunion) {
  const leido = await leerParticion(idReunion);
  if (!leido) return { ok: false, fallo: rechazar(404, 'La reunión no existe') };
  const auxExtra = await auxDeReunion(leido.reunion, leido.asistentes);
  const conAux = { ...leido, auxExtra };
  const denegado = comprobarAcceso(ctx, conAux);
  if (denegado) return { ok: false, fallo: denegado };
  return { ok: true, ...conAux, aux: auxConCtx(ctx, auxExtra) };
}

/** Expuesto para audio/pipeline (Fase 2): misma ACL que el resto de escrituras. */
export async function cargarParaGestionar(ctx, idReunion) {
  const leido = await leerParticion(idReunion);
  if (!leido) return { ok: false, fallo: rechazar(404, 'La reunión no existe') };
  const auxExtra = await auxDeReunion(leido.reunion, leido.asistentes);
  const conAux = { ...leido, auxExtra };
  const denegado = comprobarAcceso(ctx, conAux, { gestionar: true });
  if (denegado) return { ok: false, fallo: denegado };
  return { ok: true, ...conAux, aux: auxConCtx(ctx, auxExtra) };
}

// ─── Forma pública ───

function permisosFilaReunion(ctx, reunion, asistentes = [], aux = {}) {
  const puede = puedeGestionarReunion(ctx, reunion, asistentes, aux);
  return { editar: puede, borrar: puede };
}

function salidaReunion(item) {
  const {
    PK: _pk,
    SK: _sk,
    gsi_listado: _gsi,
    ...resto
  } = item;
  return resto;
}

/**
 * Campos de audio/pipeline en la ficha (Fase 2A) sin romper 1B: siempre
 * presentes, con valores nulos o `ausente` cuando aún no hay captura.
 */
function camposAudioPipeline(item = {}) {
  return {
    origen_audio: item.origen_audio ?? null,
    audio_estado: item.audio_estado || 'ausente',
    audio_s3_key: item.audio_s3_key ?? null,
    audio_tamano: item.audio_tamano ?? null,
    audio_borrado_en: item.audio_borrado_en ?? null,
    duracion_seg: item.duracion_seg ?? null,
    aviso_grabacion: item.aviso_grabacion ?? null,
    pipeline_estado: item.pipeline_estado ?? null,
    pipeline_desde: item.pipeline_desde ?? null,
    pipeline_error: item.pipeline_error ?? null,
    pipeline_error_fase: item.pipeline_error_fase ?? null,
    transcripcion_job_id: item.transcripcion_job_id ?? null,
  };
}

function reunionConExtras(item, ctx, { asistentes = [], aux = {}, nombres } = {}) {
  const base = salidaReunion(item);
  return {
    ...base,
    ...camposAudioPipeline(base),
    convocado_nombre: nombreDe(nombres, item?.convocada_por),
    permisos_fila: permisosFilaReunion(ctx, item, asistentes, aux),
  };
}

function salidaAsistente(item) {
  const { PK: _pk, SK: _sk, ...resto } = item;
  return resto;
}

function salidaAcuerdo(item, nombres) {
  const { PK: _pk, SK: _sk, ...resto } = item;
  return {
    ...resto,
    responsable_nombre: nombreDe(nombres, item?.responsable_id),
  };
}

function salidaPunto(item) {
  const { PK: _pk, SK: _sk, ...resto } = item;
  return resto;
}

function salidaVinculo(item) {
  const { PK: _pk, SK: _sk, vinculo_clave: _clave, ...resto } = item;
  return resto;
}

function syncCalendarDe(resultado) {
  return {
    calendario_sincronizado: !!(resultado && resultado.ok && resultado.eventId),
    calendar_event_id: resultado?.eventId || null,
    calendar_id: resultado?.calendarId || null,
    modalidad: resultado?.modalidad ?? null,
    sala_recurso_email: resultado?.sala ?? null,
    meet_code: resultado?.meetCode ?? null,
    calendario_error: resultado?.ok ? null : texto(resultado?.error) || null,
  };
}

/**
 * Emails de invitados para Calendar: `email` del ASIST#; si falta y hay
 * `usuario_id`, se resuelve desde `igp_usuarios`. Deduplica y descarta inválidos.
 */
async function emailsDeAsistentes(asistentes = []) {
  const directos = [];
  const idsSinEmail = [];
  for (const a of asistentes) {
    const email = texto(a?.email).toLowerCase();
    if (email && email.includes('@')) {
      directos.push(email);
      continue;
    }
    const uid = texto(a?.usuario_id);
    if (uid) idsSinEmail.push(uid);
  }
  const mapa = idsSinEmail.length > 0 ? await emailsDeUsuarios(idsSinEmail) : new Map();
  const vistos = new Set();
  const out = [];
  for (const email of [...directos, ...mapa.values()]) {
    const e = texto(email).toLowerCase();
    if (!e || !e.includes('@') || vistos.has(e)) continue;
    vistos.add(e);
    out.push(e);
  }
  return out;
}

// ─── Validación ───

const CAMPOS_TEXTO = [
  'titulo',
  'descripcion',
  'departamento_id',
  'local_id',
  'local_nombre',
  'empresa_id',
  'proyecto_id',
  'serie_id',
  'orden_del_dia',
  'sala_recurso_email',
  'meet_code',
];

/** Campos que el `PATCH` acepta. */
export const CAMPOS_EDITABLES = [
  ...CAMPOS_TEXTO,
  'fecha',
  'hora_inicio',
  'hora_fin',
  'estado',
  'visibilidad',
  'usuarios_autorizados',
  'modalidad',
];

function normalizarUsuariosAutorizados(valor) {
  if (valor == null) return [];
  if (!Array.isArray(valor)) return null;
  return [...new Set(valor.map(texto).filter(Boolean))];
}

/**
 * @param {object} body
 * @param {{ parcial: boolean }} opciones
 */
function normalizarEntrada(body = {}, { parcial }) {
  const datos = {};

  if (!parcial || body.titulo !== undefined) {
    const titulo = texto(body.titulo).replace(/\s+/g, ' ');
    if (!titulo) return { error: 'El título de la reunión es obligatorio' };
    datos.titulo = titulo;
  }

  if (!parcial || body.fecha !== undefined) {
    const fecha = aFecha(body.fecha);
    if (fecha === null) return { error: 'La fecha debe ser AAAA-MM-DD' };
    if (!parcial && !fecha) return { error: 'La fecha de la reunión es obligatoria' };
    if (fecha !== undefined && fecha !== '') datos.fecha = fecha;
    else if (parcial && body.fecha !== undefined && fecha === '') {
      return { error: 'La fecha de la reunión es obligatoria' };
    }
  }

  for (const campo of ['hora_inicio', 'hora_fin']) {
    if (body[campo] === undefined) continue;
    const hora = aHora(body[campo]);
    if (hora === null) return { error: `La ${campo.replace('_', ' ')} debe ser HH:mm` };
    datos[campo] = hora;
  }

  if (body.estado !== undefined) {
    const estado = texto(body.estado);
    if (!enLista(ESTADOS_REUNION, estado)) {
      return { error: `Estado no válido: admite ${ESTADOS_REUNION.join(', ')}` };
    }
    datos.estado = estado;
  }

  if (body.visibilidad !== undefined) {
    const vis = texto(body.visibilidad);
    if (!enLista(VISIBILIDADES_REUNION, vis)) {
      return { error: `Visibilidad no válida: admite ${VISIBILIDADES_REUNION.join(', ')}` };
    }
    datos.visibilidad = vis;
  }

  if (body.usuarios_autorizados !== undefined) {
    const lista = normalizarUsuariosAutorizados(body.usuarios_autorizados);
    if (lista === null) return { error: 'usuarios_autorizados debe ser una lista de ids' };
    datos.usuarios_autorizados = lista;
  }

  if (body.modalidad !== undefined) {
    const mod = texto(body.modalidad);
    if (mod && !enLista(MODALIDADES_REUNION, mod)) {
      return { error: `Modalidad no válida: admite ${MODALIDADES_REUNION.join(', ')}` };
    }
    datos.modalidad = mod;
  }

  for (const campo of CAMPOS_TEXTO) {
    if (campo === 'titulo' || body[campo] === undefined) continue;
    datos[campo] = texto(body[campo]);
  }

  // Con visibilidad local el nombre es obligatorio para la ACL (comparación por nombre).
  const visFinal = datos.visibilidad;
  if (visFinal === VISIBILIDAD_REUNION.local || (!parcial && !visFinal)) {
    // En create se aplica el default después; aquí solo si ya viene local.
  }

  return { datos };
}

function exigirLocalNombre(datos, actual = {}) {
  const vis = texto(datos.visibilidad ?? actual.visibilidad) || VISIBILIDAD_POR_DEFECTO;
  if (vis !== VISIBILIDAD_REUNION.local) return null;
  const nombre = texto(datos.local_nombre ?? actual.local_nombre);
  if (!nombre) return 'Con visibilidad local hace falta local_nombre';
  return null;
}

// ─── Escritura auxiliar ───

async function escribirEnLotes(tabla, items) {
  for (let i = 0; i < items.length; i += MAX_LOTE) {
    let pendientes = items.slice(i, i + MAX_LOTE).map((Item) => ({ PutRequest: { Item } }));
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tabla]: pendientes } }),
      );
      pendientes = res?.UnprocessedItems?.[tabla] || [];
    }
    if (pendientes.length > 0) {
      throw new Error('DynamoDB no aceptó parte del lote de escritura de reuniones');
    }
  }
}

async function borrarEnLotes(tabla, claves) {
  for (let i = 0; i < claves.length; i += MAX_LOTE) {
    let pendientes = claves.slice(i, i + MAX_LOTE).map((Key) => ({ DeleteRequest: { Key } }));
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tabla]: pendientes } }),
      );
      pendientes = res?.UnprocessedItems?.[tabla] || [];
    }
  }
}

async function clavesDeParticion(idReunion) {
  const claves = [];
  let desde = null;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK.reunion(texto(idReunion)) },
        ProjectionExpression: 'PK, SK',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const item of res.Items || []) claves.push({ PK: item.PK, SK: item.SK });
    desde = res.LastEvaluatedKey || null;
  } while (desde);
  return claves;
}

async function tocarReunion(idReunion, instante) {
  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(idReunion), SK: SK.meta },
      UpdateExpression: 'SET #act = :act',
      ExpressionAttributeNames: { '#act': 'actualizado_en' },
      ExpressionAttributeValues: { ':act': instante },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
}

/**
 * Quién de la página es asistente de quien pregunta: un solo `BatchGet` de
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
      const id = String(item.PK || '').replace(/^REU#/, '');
      if (id) soy.add(id);
    }
  }
  return soy;
}

/** Responsables de departamento de una página, en lote por ids distintos. */
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

// ─── Listado ───

function coincideFiltro(reunion, { desde, hasta, estado }) {
  const fecha = texto(reunion.fecha);
  if (desde && fecha < desde) return false;
  if (hasta && fecha > hasta) return false;
  if (estado && texto(reunion.estado) !== estado) return false;
  return true;
}

/**
 * Página del listado, ya filtrada por visibilidad.
 *
 * Con `proyecto` usa `Proyecto-index`; si no, `Listado-index` con rango de fechas
 * cuando vienen `desde`/`hasta`. `estado` se filtra en memoria.
 */
export async function listarReunionesVisibles(ctx, opciones = {}) {
  const { limite, cursor, desde: desdeQ, hasta: hastaQ, proyecto, estado } = opciones;
  const filtroEstado = texto(estado);
  if (filtroEstado && !enLista(ESTADOS_REUNION, filtroEstado)) {
    return rechazar(400, `Estado de reunión no válido: admite ${ESTADOS_REUNION.join(', ')}`);
  }
  const desdeFecha = texto(desdeQ);
  const hastaFecha = texto(hastaQ);
  if (desdeFecha && aFecha(desdeFecha) === null) return rechazar(400, 'desde debe ser AAAA-MM-DD');
  if (hastaFecha && aFecha(hastaFecha) === null) return rechazar(400, 'hasta debe ser AAAA-MM-DD');

  const proyectoId = texto(proyecto);
  const startKey = decodificarCursor(cursor);
  const limit = limiteValido(limite);

  let res;
  if (proyectoId) {
    const valores = { ':p': proyectoId };
    let keyCond = 'proyecto_id = :p';
    if (desdeFecha && hastaFecha) {
      keyCond += ' AND #f BETWEEN :d AND :h';
      valores[':d'] = desdeFecha;
      valores[':h'] = hastaFecha;
    } else if (desdeFecha) {
      keyCond += ' AND #f >= :d';
      valores[':d'] = desdeFecha;
    } else if (hastaFecha) {
      keyCond += ' AND #f <= :h';
      valores[':h'] = hastaFecha;
    }
    res = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        IndexName: IDX_PROYECTO,
        KeyConditionExpression: keyCond,
        ...(keyCond.includes('#f') && { ExpressionAttributeNames: { '#f': 'fecha' } }),
        ExpressionAttributeValues: valores,
        ScanIndexForward: false,
        Limit: limit,
        ...(startKey && { ExclusiveStartKey: startKey }),
      }),
    );
  } else {
    const valores = { ':g': GSI_LISTADO.reunion };
    let keyCond = 'gsi_listado = :g';
    if (desdeFecha && hastaFecha) {
      keyCond += ' AND #f BETWEEN :d AND :h';
      valores[':d'] = desdeFecha;
      valores[':h'] = hastaFecha;
    } else if (desdeFecha) {
      keyCond += ' AND #f >= :d';
      valores[':d'] = desdeFecha;
    } else if (hastaFecha) {
      keyCond += ' AND #f <= :h';
      valores[':h'] = hastaFecha;
    }
    res = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        IndexName: IDX_LISTADO,
        KeyConditionExpression: keyCond,
        ...(keyCond.includes('#f') && { ExpressionAttributeNames: { '#f': 'fecha' } }),
        ExpressionAttributeValues: valores,
        ScanIndexForward: false,
        Limit: limit,
        ...(startKey && { ExclusiveStartKey: startKey }),
      }),
    );
  }

  const pagina = res.Items || [];
  const soyAsistente = await mapaAsistenciaPropia(
    ctx,
    pagina.map((r) => r.id_reunion),
  );
  const responsablesDep = await mapaResponsablesDepartamento(
    pagina.map((r) => r.departamento_id),
  );

  const visibles = filtrarVisibles(ctx, ENTIDAD, pagina, (item) => {
    const id = texto(item.id_reunion);
    const dep = texto(item.departamento_id);
    const responsableDep = dep ? responsablesDep.get(dep) || '' : '';
    return {
      asistentes: soyAsistente.has(id) ? [{ usuario_id: ctx.idUsuario }] : [],
      esResponsableDepartamento: !!responsableDep && mismoId(responsableDep, ctx.idUsuario),
    };
  });

  const filtrados = visibles.filter((r) =>
    coincideFiltro(r, { desde: desdeFecha, hasta: hastaFecha, estado: filtroEstado }),
  );

  const nombres = await nombresDeUsuarios(filtrados.map((r) => r.convocada_por));

  return {
    ok: true,
    reuniones: filtrados.map((r) => {
      const id = texto(r.id_reunion);
      const dep = texto(r.departamento_id);
      const responsableDep = dep ? responsablesDep.get(dep) || '' : '';
      const asistentes = soyAsistente.has(id) ? [{ usuario_id: ctx.idUsuario }] : [];
      const aux = {
        asistentes,
        esResponsableDepartamento: !!responsableDep && mismoId(responsableDep, ctx.idUsuario),
      };
      return reunionConExtras(r, ctx, { asistentes, aux, nombres });
    }),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

// ─── Ficha ───

export async function obtenerFichaReunion(ctx, idReunion) {
  const cargado = await cargarParaVer(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const idsNombres = [
    cargado.reunion.convocada_por,
    ...cargado.asistentes.map((a) => a.usuario_id),
    ...cargado.acuerdos.map((a) => a.responsable_id),
  ];
  const nombres = await nombresDeUsuarios(idsNombres);

  return {
    ok: true,
    reunion: reunionConExtras(cargado.reunion, ctx, {
      asistentes: cargado.asistentes,
      aux: cargado.aux,
      nombres,
    }),
    asistentes: cargado.asistentes.map((a) => ({
      ...salidaAsistente(a),
      usuario_nombre: a.es_externo ? texto(a.nombre) || null : nombreDe(nombres, a.usuario_id),
    })),
    acuerdos: cargado.acuerdos.map((a) => salidaAcuerdo(a, nombres)),
    puntos: cargado.puntos.map(salidaPunto),
    vinculos: cargado.vinculos.map(salidaVinculo),
  };
}

// ─── Crear / actualizar / borrar ───

function itemMeta(reunion) {
  const item = {
    PK: PK.reunion(reunion.id_reunion),
    SK: SK.meta,
    gsi_listado: GSI_LISTADO.reunion,
  };
  for (const [campo, valor] of Object.entries(reunion)) {
    if (valor === undefined || valor === null) continue;
    if (typeof valor === 'string' && valor === '' && [
      'proyecto_id',
      'serie_id',
      'departamento_id',
      'local_id',
      'local_nombre',
      'empresa_id',
      'calendar_event_id',
      'calendar_id',
      'modalidad',
      'meet_code',
      'sala_recurso_email',
    ].includes(campo)) {
      continue;
    }
    item[campo] = valor;
  }
  return item;
}

export async function crearReunion(ctx, body = {}) {
  if (!tienePermiso(ctx, PERMISOS.reunionesGestionar) && !ctx?.esAdmin) {
    return rechazar(403, 'No tienes permiso para gestionar reuniones');
  }

  const normalizado = normalizarEntrada(body, { parcial: false });
  if (normalizado.error) return rechazar(400, normalizado.error);

  const datos = normalizado.datos;
  if (!datos.visibilidad) datos.visibilidad = VISIBILIDAD_POR_DEFECTO;
  if (!datos.estado) datos.estado = ESTADO_INICIAL;

  const errorLocal = exigirLocalNombre(datos);
  if (errorLocal) return rechazar(400, errorLocal);

  const instante = ahora();
  const id = crypto.randomUUID();
  const reunion = {
    id_reunion: id,
    titulo: datos.titulo,
    fecha: datos.fecha,
    hora_inicio: datos.hora_inicio || '',
    hora_fin: datos.hora_fin || '',
    estado: datos.estado,
    visibilidad: datos.visibilidad,
    usuarios_autorizados:
      datos.visibilidad === VISIBILIDAD_REUNION.restringida
        ? datos.usuarios_autorizados || []
        : [],
    departamento_id: datos.departamento_id || '',
    local_id: datos.local_id || '',
    local_nombre: datos.local_nombre || '',
    empresa_id: datos.empresa_id || '',
    proyecto_id: datos.proyecto_id || '',
    serie_id: datos.serie_id || '',
    orden_del_dia: datos.orden_del_dia || '',
    modalidad: datos.modalidad || '',
    sala_recurso_email: datos.sala_recurso_email || '',
    meet_code: datos.meet_code || '',
    convocada_por: texto(ctx.idUsuario),
    creado_en: instante,
    actualizado_en: instante,
  };

  // D-21: Calendar no tumba la reunión.
  let sync = syncCalendarDe({ ok: false, error: 'Google Calendar no está configurado' });
  try {
    const cal = await calendarCrear({
      titulo: reunion.titulo,
      fecha: reunion.fecha,
      horaInicio: reunion.hora_inicio,
      horaFin: reunion.hora_fin,
      descripcion: reunion.orden_del_dia,
      asistentesEmails: [],
    });
    sync = syncCalendarDe(cal);
    if (cal.ok && cal.eventId) {
      reunion.calendar_event_id = cal.eventId;
      if (cal.calendarId) reunion.calendar_id = cal.calendarId;
      if (cal.modalidad) reunion.modalidad = cal.modalidad;
      if (cal.sala) reunion.sala_recurso_email = cal.sala;
      if (cal.meetCode) reunion.meet_code = cal.meetCode;
    }
  } catch (err) {
    sync = syncCalendarDe({ ok: false, error: err?.message || 'Error al sincronizar con Calendar' });
  }

  await docClient.send(new PutCommand({ TableName: tables.reuniones, Item: itemMeta(reunion) }));
  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: id,
    accion: ACCIONES.creada,
    usuario: autorDe(ctx),
    detalle: {
      titulo: reunion.titulo,
      fecha: reunion.fecha,
      visibilidad: reunion.visibilidad,
      calendario_sincronizado: sync.calendario_sincronizado,
    },
  });

  const nombres = await nombresDeUsuarios([reunion.convocada_por]);
  return {
    ok: true,
    reunion: reunionConExtras(itemMeta(reunion), ctx, {
      asistentes: [],
      aux: {},
      nombres,
    }),
    ...sync,
    calendar_disponible: calendarDisponible(),
  };
}

export async function actualizarReunion(ctx, idReunion, cambios = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const presentes = {};
  for (const campo of CAMPOS_EDITABLES) {
    if (cambios[campo] !== undefined) presentes[campo] = cambios[campo];
  }
  if (Object.keys(presentes).length === 0) {
    return rechazar(400, 'No hay campos que actualizar');
  }

  const normalizado = normalizarEntrada(presentes, { parcial: true });
  if (normalizado.error) return rechazar(400, normalizado.error);
  const datos = normalizado.datos;

  // D-20: el orden del día no se edita tras celebrada (o superior no cancelada).
  if (datos.orden_del_dia !== undefined && ordenBloqueado(cargado.reunion.estado)) {
    return rechazar(409, 'El orden del día ya no se puede editar: la reunión ya se celebró');
  }

  const errorLocal = exigirLocalNombre(datos, cargado.reunion);
  if (errorLocal) return rechazar(400, errorLocal);

  const instante = ahora();
  const actualizado = { ...salidaReunion(cargado.reunion), ...datos, actualizado_en: instante };

  // Congelar orden al pasar a celebrada / acta_* si aún no había copia.
  const estadoNuevo = texto(actualizado.estado);
  const estadoAntes = texto(cargado.reunion.estado);
  if (
    ordenBloqueado(estadoNuevo) &&
    !ordenBloqueado(estadoAntes) &&
    !texto(actualizado.orden_del_dia_congelado)
  ) {
    actualizado.orden_del_dia_congelado = texto(actualizado.orden_del_dia) || texto(cargado.reunion.orden_del_dia);
    actualizado.orden_del_dia_congelado_en = instante;
  }

  if (actualizado.visibilidad !== VISIBILIDAD_REUNION.restringida) {
    actualizado.usuarios_autorizados = [];
  } else if (!Array.isArray(actualizado.usuarios_autorizados)) {
    actualizado.usuarios_autorizados = cargado.reunion.usuarios_autorizados || [];
  }

  let sync = {
    calendario_sincronizado: true,
    calendar_event_id: actualizado.calendar_event_id || null,
    calendar_id: actualizado.calendar_id || null,
    modalidad: actualizado.modalidad || null,
    sala_recurso_email: actualizado.sala_recurso_email || null,
    meet_code: actualizado.meet_code || null,
    calendario_error: null,
  };

  if (texto(actualizado.calendar_event_id)) {
    try {
      const cal = await calendarActualizar(actualizado.calendar_event_id, {
        titulo: actualizado.titulo,
        fecha: actualizado.fecha,
        horaInicio: actualizado.hora_inicio,
        horaFin: actualizado.hora_fin,
        descripcion: actualizado.orden_del_dia,
      });
      if (!cal.ok) {
        sync.calendario_sincronizado = false;
        sync.calendario_error = texto(cal.error) || 'No se pudo actualizar el evento de Calendar';
      }
    } catch (err) {
      sync.calendario_sincronizado = false;
      sync.calendario_error = err?.message || 'Error al sincronizar con Calendar';
    }
  } else if (!calendarDisponible()) {
    sync.calendario_sincronizado = false;
    sync.calendario_error = 'Google Calendar no está configurado';
  }

  await docClient.send(
    new PutCommand({
      TableName: tables.reuniones,
      Item: itemMeta({ ...actualizado, id_reunion: texto(idReunion) }),
    }),
  );

  const detalle = { campos: Object.keys(datos) };
  if (datos.visibilidad && datos.visibilidad !== texto(cargado.reunion.visibilidad)) {
    detalle.visibilidad_antes = cargado.reunion.visibilidad;
    detalle.visibilidad_despues = datos.visibilidad;
  }
  if (datos.estado && datos.estado !== estadoAntes) {
    detalle.estado_antes = estadoAntes;
    detalle.estado_despues = datos.estado;
  }

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: datos.estado && datos.estado !== estadoAntes ? ACCIONES.estadoCambiado : ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle,
  });

  const nombres = await nombresDeUsuarios([actualizado.convocada_por]);
  return {
    ok: true,
    reunion: reunionConExtras(itemMeta({ ...actualizado, id_reunion: texto(idReunion) }), ctx, {
      asistentes: cargado.asistentes,
      aux: cargado.aux,
      nombres,
    }),
    ...sync,
    calendar_disponible: calendarDisponible(),
  };
}

export async function borrarReunion(ctx, idReunion) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const eventId = texto(cargado.reunion.calendar_event_id);
  let sync = {
    calendario_sincronizado: !eventId,
    calendario_error: null,
  };
  if (eventId) {
    try {
      const cal = await calendarBorrar(eventId);
      sync.calendario_sincronizado = !!cal.ok;
      if (!cal.ok) sync.calendario_error = texto(cal.error) || 'No se pudo borrar el evento de Calendar';
    } catch (err) {
      sync.calendario_sincronizado = false;
      sync.calendario_error = err?.message || 'Error al borrar el evento de Calendar';
    }
  }

  const claves = await clavesDeParticion(idReunion);
  await borrarEnLotes(tables.reuniones, claves);

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: ACCIONES.borrada,
    usuario: autorDe(ctx),
    detalle: { titulo: cargado.reunion.titulo, calendario_sincronizado: sync.calendario_sincronizado },
  });

  return { ok: true, ...sync, calendar_disponible: calendarDisponible() };
}

// ─── Asistentes ───

export async function anadirAsistentes(ctx, idReunion, body = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const lista = Array.isArray(body.asistentes) ? body.asistentes : body.usuario_id ? [body] : null;
  if (!lista || lista.length === 0) {
    return rechazar(400, 'Envía al menos un asistente');
  }

  const instante = ahora();
  const items = [];
  const salida = [];

  for (const entrada of lista) {
    const esExterno = entrada?.es_externo === true;
    const usuarioId = texto(entrada?.usuario_id);
    const nombre = texto(entrada?.nombre);
    const email = texto(entrada?.email);

    if (!esExterno && !usuarioId) {
      return rechazar(400, 'Cada asistente interno necesita usuario_id');
    }
    if (esExterno && !nombre && !email) {
      return rechazar(400, 'Un asistente externo necesita nombre o email');
    }

    const skId = esExterno ? `ext-${crypto.randomUUID()}` : usuarioId;
    const item = {
      PK: PK.reunion(texto(idReunion)),
      SK: SK.asistente(skId),
      usuario_id: esExterno ? '' : usuarioId,
      nombre: nombre || '',
      email: email || '',
      asistio: entrada?.asistio !== false,
      es_externo: esExterno,
      rol_en_reunion: texto(entrada?.rol_en_reunion),
      añadido_por: texto(ctx.idUsuario),
      añadido_en: instante,
    };
    items.push(item);
    salida.push(salidaAsistente(item));
  }

  await escribirEnLotes(tables.reuniones, items);
  await tocarReunion(idReunion, instante);
  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: { asistentes_anadidos: salida.length },
  });

  // D-21: sincronizar attendees en Calendar no tumba el alta local.
  let sync = null;
  const eventId = texto(cargado.reunion.calendar_event_id);
  if (eventId && calendarDisponible()) {
    const porSk = new Map();
    for (const a of cargado.asistentes) porSk.set(texto(a.SK), a);
    for (const a of items) porSk.set(texto(a.SK), a);
    const asistentesEmails = await emailsDeAsistentes([...porSk.values()]);
    try {
      const cal = await calendarActualizar(eventId, {
        titulo: cargado.reunion.titulo,
        fecha: cargado.reunion.fecha,
        horaInicio: cargado.reunion.hora_inicio,
        horaFin: cargado.reunion.hora_fin,
        descripcion: cargado.reunion.orden_del_dia,
        asistentesEmails,
      });
      sync = {
        calendario_sincronizado: !!cal.ok,
        calendario_error: cal.ok ? null : texto(cal.error) || 'No se pudo sincronizar asistentes con Calendar',
      };
    } catch (err) {
      sync = {
        calendario_sincronizado: false,
        calendario_error: err?.message || 'Error al sincronizar asistentes con Calendar',
      };
    }
  }

  const nombres = await nombresDeUsuarios(salida.map((a) => a.usuario_id));
  return {
    ok: true,
    asistentes: salida.map((a) => ({
      ...a,
      usuario_nombre: a.es_externo ? texto(a.nombre) || null : nombreDe(nombres, a.usuario_id),
    })),
    ...(sync || {}),
  };
}

// ─── Aviso de grabación ───

export async function registrarAvisoGrabacion(ctx, idReunion, body = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const informados = Array.isArray(body.informados)
    ? [...new Set(body.informados.map(texto).filter(Boolean))]
    : [];
  if (informados.length === 0 && body.aceptado !== true && !texto(body.aceptado_por)) {
    return rechazar(400, 'Indica quiénes han sido informados o la aceptación del aviso');
  }

  const instante = ahora();
  const previo = cargado.reunion.aviso_grabacion && typeof cargado.reunion.aviso_grabacion === 'object'
    ? cargado.reunion.aviso_grabacion
    : {};

  const aviso = {
    informados: informados.length > 0 ? informados : previo.informados || [],
    aceptado_por: texto(body.aceptado_por) || (body.aceptado === true ? texto(ctx.idUsuario) : previo.aceptado_por || ''),
    aceptado_en:
      body.aceptado === true || texto(body.aceptado_por)
        ? instante
        : previo.aceptado_en || '',
  };

  await docClient.send(
    new UpdateCommand({
      TableName: tables.reuniones,
      Key: { PK: PK.reunion(texto(idReunion)), SK: SK.meta },
      UpdateExpression: 'SET aviso_grabacion = :a, actualizado_en = :act',
      ExpressionAttributeValues: { ':a': aviso, ':act': instante },
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );

  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: { aviso_grabacion: aviso },
  });

  return { ok: true, aviso_grabacion: aviso };
}

// ─── Sugerencia de orden del día ───

export async function sugerenciaOrdenDelDia(ctx, idReunion) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const serieId = texto(cargado.reunion.serie_id);
  if (!serieId) {
    return {
      ok: true,
      texto: '',
      origen_reunion_id: null,
      mensaje: 'Esta reunión no pertenece a una serie; no hay sugerencia automática',
    };
  }

  const fechaActual = texto(cargado.reunion.fecha) || '9999-12-31';
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.reuniones,
      IndexName: IDX_SERIE,
      KeyConditionExpression: 'serie_id = :s AND #f < :f',
      ExpressionAttributeNames: { '#f': 'fecha' },
      ExpressionAttributeValues: { ':s': serieId, ':f': fechaActual },
      ScanIndexForward: false,
      Limit: 5,
    }),
  );

  const candidatas = (res.Items || []).filter((it) => texto(it.id_reunion) !== texto(idReunion));
  const anterior = candidatas[0];
  if (!anterior) {
    return {
      ok: true,
      texto: '',
      origen_reunion_id: null,
      mensaje: 'No hay reunión anterior en la serie',
    };
  }

  const part = await leerParticion(anterior.id_reunion);
  const lineas = [];
  const acuerdosAbiertos = (part?.acuerdos || []).filter((a) => texto(a.estado) === 'abierto');
  for (const a of acuerdosAbiertos) {
    lineas.push(`· Acuerdo pendiente: ${texto(a.texto)}`);
  }
  for (const p of part?.puntos || []) {
    if (p.aplazado === true || p.candidato_siguiente === true) {
      lineas.push(`· Aplazado: ${texto(p.texto_punto || p.texto)}`);
    }
  }

  return {
    ok: true,
    texto: lineas.join('\n'),
    origen_reunion_id: anterior.id_reunion,
    acuerdos_abiertos: acuerdosAbiertos.length,
    puntos_aplazados: (part?.puntos || []).filter((p) => p.aplazado || p.candidato_siguiente).length,
  };
}

// ─── Acuerdos ───

function normalizarAcuerdo(body = {}, { parcial }) {
  const datos = {};
  if (!parcial || body.texto !== undefined) {
    const t = texto(body.texto);
    if (!t) return { error: 'El texto del acuerdo es obligatorio' };
    datos.texto = t;
  }
  if (body.responsable_id !== undefined) datos.responsable_id = texto(body.responsable_id);
  if (body.fecha_limite !== undefined) {
    const f = aFecha(body.fecha_limite);
    if (f === null) return { error: 'La fecha límite debe ser AAAA-MM-DD' };
    datos.fecha_limite = f;
  }
  if (body.estado !== undefined) {
    const e = texto(body.estado);
    if (!enLista(ESTADOS_ACUERDO, e)) {
      return { error: `Estado de acuerdo no válido: admite ${ESTADOS_ACUERDO.join(', ')}` };
    }
    datos.estado = e;
  }
  if (body.cita !== undefined) datos.cita = texto(body.cita);
  return { datos };
}

export async function crearAcuerdo(ctx, idReunion, body = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const normalizado = normalizarAcuerdo(body, { parcial: false });
  if (normalizado.error) return rechazar(400, normalizado.error);

  const instante = ahora();
  const id = crypto.randomUUID();
  const item = {
    PK: PK.reunion(texto(idReunion)),
    SK: SK.acuerdo(id),
    id_acuerdo: id,
    texto: normalizado.datos.texto,
    responsable_id: normalizado.datos.responsable_id || '',
    fecha_limite: normalizado.datos.fecha_limite || '',
    estado: normalizado.datos.estado || ESTADO_ACUERDO_INICIAL,
    cita: normalizado.datos.cita || '',
    tarea_id: '',
    creado_por: texto(ctx.idUsuario),
    creado_en: instante,
    actualizado_en: instante,
  };

  await docClient.send(new PutCommand({ TableName: tables.reuniones, Item: item }));
  await tocarReunion(idReunion, instante);
  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: { acuerdo_creado: id, texto: item.texto },
  });

  const nombres = await nombresDeUsuarios([item.responsable_id]);
  return { ok: true, acuerdo: salidaAcuerdo(item, nombres) };
}

export async function actualizarAcuerdo(ctx, idReunion, acuerdoId, body = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const id = texto(acuerdoId);
  const existente = cargado.acuerdos.find((a) => texto(a.id_acuerdo) === id);
  if (!existente) return rechazar(404, 'El acuerdo no existe');

  const normalizado = normalizarAcuerdo(body, { parcial: true });
  if (normalizado.error) return rechazar(400, normalizado.error);
  if (Object.keys(normalizado.datos).length === 0) {
    return rechazar(400, 'No hay campos que actualizar');
  }

  const instante = ahora();
  const actualizado = {
    ...salidaAcuerdo(existente, new Map()),
    ...normalizado.datos,
    actualizado_en: instante,
  };
  // salidaAcuerdo mete responsable_nombre; no persistirlo.
  delete actualizado.responsable_nombre;

  const item = {
    PK: PK.reunion(texto(idReunion)),
    SK: SK.acuerdo(id),
    ...actualizado,
    id_acuerdo: id,
  };

  await docClient.send(new PutCommand({ TableName: tables.reuniones, Item: item }));
  await tocarReunion(idReunion, instante);
  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: { acuerdo_editado: id, campos: Object.keys(normalizado.datos) },
  });

  const nombres = await nombresDeUsuarios([item.responsable_id]);
  return { ok: true, acuerdo: salidaAcuerdo(item, nombres) };
}

/**
 * D-23: convierte acuerdos abiertos (o los indicados) en tareas vía el lote
 * del servidor y enlaza `tarea_id` en cada acuerdo.
 *
 * Cuerpo: `{ acuerdo_ids?: string[] }` — si no viene, todos los abiertos sin
 * `tarea_id` que tengan `responsable_id`.
 */
export async function crearTareasDesdeAcuerdos(ctx, idReunion, body = {}) {
  const cargado = await cargarParaGestionar(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const idsPedidos = Array.isArray(body.acuerdo_ids)
    ? new Set(body.acuerdo_ids.map(texto).filter(Boolean))
    : null;

  const candidatos = cargado.acuerdos.filter((a) => {
    if (texto(a.tarea_id)) return false;
    if (texto(a.estado) !== 'abierto') return false;
    if (!texto(a.responsable_id)) return false;
    if (idsPedidos && !idsPedidos.has(texto(a.id_acuerdo))) return false;
    return true;
  });

  if (candidatos.length === 0) {
    return rechazar(400, 'No hay acuerdos abiertos sin tarea (con responsable) para convertir');
  }

  const lote = await crearTareasEnLote({
    ctx,
    datos: {
      proyecto_id: texto(cargado.reunion.proyecto_id) || undefined,
      reunion_origen_id: texto(idReunion),
      tareas: candidatos.map((a) => ({
        titulo: texto(a.texto).slice(0, 200),
        descripcion: texto(a.texto),
        responsable_id: a.responsable_id,
        fecha_limite: texto(a.fecha_limite) || undefined,
      })),
    },
  });
  if (!lote.ok) return lote;

  const instante = ahora();
  const enlazados = [];
  for (let i = 0; i < candidatos.length; i += 1) {
    const acuerdo = candidatos[i];
    const creada = lote.creadas[i];
    if (!creada?.id_tarea) continue;
    const item = {
      ...salidaAcuerdo(acuerdo, new Map()),
      tarea_id: creada.id_tarea,
      actualizado_en: instante,
    };
    delete item.responsable_nombre;
    await docClient.send(
      new PutCommand({
        TableName: tables.reuniones,
        Item: {
          PK: PK.reunion(texto(idReunion)),
          SK: SK.acuerdo(texto(acuerdo.id_acuerdo)),
          ...item,
          id_acuerdo: texto(acuerdo.id_acuerdo),
        },
      }),
    );
    enlazados.push({
      id_acuerdo: acuerdo.id_acuerdo,
      tarea_id: creada.id_tarea,
      tarea: creada,
    });
  }

  await tocarReunion(idReunion, instante);
  await registrarActividad({
    tipo: ENTIDAD,
    entidadId: idReunion,
    accion: ACCIONES.editada,
    usuario: autorDe(ctx),
    detalle: {
      acuerdos_a_tareas: enlazados.map((e) => ({
        id_acuerdo: e.id_acuerdo,
        tarea_id: e.tarea_id,
      })),
    },
  });

  return {
    ok: true,
    creadas: lote.creadas,
    omitidas: lote.omitidas || [],
    enlazados,
  };
}

// ─── Tareas nacidas de la reunión ───

export async function listarTareasDeReunion(ctx, idReunion, { limite, cursor } = {}) {
  const cargado = await cargarParaVer(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;

  const startKey = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      IndexName: IDX_REUNION,
      KeyConditionExpression: 'reunion_origen_id = :r',
      ExpressionAttributeValues: { ':r': texto(idReunion) },
      ScanIndexForward: false,
      Limit: limiteValido(limite),
      ...(startKey && { ExclusiveStartKey: startKey }),
    }),
  );

  const items = res.Items || [];
  const nombres = await nombresDeUsuarios(items.map((t) => t.responsable_id));

  return {
    ok: true,
    tareas: items.map((t) => {
      const { PK: _pk, SK: _sk, vencimiento_orden: _vo, sk_proyecto: _skp, ...resto } = t;
      return {
        ...resto,
        responsable_nombre: nombreDe(nombres, t.responsable_id),
      };
    }),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}

// ─── Historial ───

export async function listarActividadReunion(ctx, idReunion, { limite, cursor } = {}) {
  const cargado = await cargarParaVer(ctx, idReunion);
  if (!cargado.ok) return cargado.fallo;
  const { actividad, cursor: siguiente } = await listarActividad({
    tipo: ENTIDAD,
    entidadId: texto(idReunion),
    limite,
    cursor,
  });
  return { ok: true, actividad, cursor: siguiente };
}
