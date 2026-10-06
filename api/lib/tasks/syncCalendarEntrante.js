/**
 * Trae a la app los cambios hechos en Google sobre eventos que la app creó.
 *
 * Un evento que la app ya creó se actualiza aquí. Uno nuevo, solo si cae en el
 * calendario de IGP (el buzón `GOOGLE_CALENDAR_IMPERSONATE`) y llega después de
 * la primera lectura: el historial de esa primera pasada no se convierte en
 * tareas. No reescribe Google, así que no hay bucle.
 *
 * La marca `syncToken` vive en Igp_Ajustes, una por buzón. Un 410 de Google
 * obliga a releer la ventana.
 */

import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { logger } from '../logger.js';
import {
  calendarIdConfigurado,
  disponible as calendarDisponible,
  emailEnDominioPermitido,
  interpretarEventoGoogle,
  listarEventos,
  resolverSubject,
} from '../google/calendarClient.js';
import { GSI_LISTADO, PREFIJO_VENCIMIENTO_HECHA } from './tipos.js';
import {
  aplicarEventoCalendarEnTarea,
  cancelarOcurrenciaDesdeCalendar,
  crearTareaDesdeEventoCalendar,
  fechaHoyMadrid,
} from './tareas.js';
import { aplicarEventoCalendarEnReunion } from './reuniones.js';

const ETIQUETA = 'calendar-entrante';
const AJUSTE_PK = 'tareas';
const IDX_RESPONSABLE = 'Responsable-Vencimiento-index';
const IDX_LISTADO = 'Listado-index';
const DIAS_ATRAS = 90;
const DIAS_ADELANTE = 400;

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d));
  fecha.setUTCDate(fecha.getUTCDate() + days);
  return fecha.toISOString().slice(0, 10);
}

function skToken(subject, calendarId) {
  return `calendar_pull#${subject}#${calendarId}`;
}

async function leerToken(subject, calendarId) {
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.ajustes,
        Key: { PK: AJUSTE_PK, SK: skToken(subject, calendarId) },
      }),
    );
    return texto(r.Item?.sync_token);
  } catch (err) {
    logger.warn({ err }, `[${ETIQUETA}] No se pudo leer la marca de Calendar`);
    return '';
  }
}

async function guardarToken(subject, calendarId, syncToken) {
  const token = texto(syncToken);
  if (!token) return;
  try {
    await docClient.send(
      new PutCommand({
        TableName: tables.ajustes,
        Item: {
          PK: AJUSTE_PK,
          SK: skToken(subject, calendarId),
          sync_token: token,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    logger.warn({ err }, `[${ETIQUETA}] No se pudo guardar la marca de Calendar`);
  }
}

async function mapaEmails() {
  const mapa = new Map();
  let desde = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.usuarios,
        ProjectionExpression: 'id_usuario, Email',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const u of r.Items || []) {
      const id = texto(u.id_usuario);
      const email = texto(u.Email);
      if (id && email) mapa.set(id, email);
    }
    desde = r.LastEvaluatedKey || null;
  } while (desde);
  return mapa;
}

async function tareasConEvento(emails, desdeFecha, hastaFecha) {
  const entidades = [];
  for (const [idUsuario, email] of emails) {
    let desde = null;
    do {
      const r = await docClient.send(
        new QueryCommand({
          TableName: tables.tareas,
          IndexName: IDX_RESPONSABLE,
          KeyConditionExpression: 'responsable_id = :r AND vencimiento_orden < :tope',
          ExpressionAttributeValues: { ':r': idUsuario, ':tope': PREFIJO_VENCIMIENTO_HECHA },
          ProjectionExpression:
            'id_tarea, titulo, fecha_limite, ocurrencia_fecha, hora_inicio, hora_fin, calendar_event_id, calendar_id',
          ...(desde && { ExclusiveStartKey: desde }),
        }),
      );
      for (const t of r.Items || []) {
        const eventId = texto(t.calendar_event_id);
        if (!eventId) continue;
        entidades.push({
          tipo: 'tarea',
          id: texto(t.id_tarea),
          eventId,
          calendarId: texto(t.calendar_id),
          email,
          titulo: texto(t.titulo),
          fecha: texto(t.fecha_limite),
          ocurrenciaFecha: texto(t.ocurrencia_fecha),
          horaInicio: texto(t.hora_inicio),
          horaFin: texto(t.hora_fin),
        });
      }
      desde = r.LastEvaluatedKey || null;
    } while (desde);

    desde = null;
    do {
      const r = await docClient.send(
        new QueryCommand({
          TableName: tables.tareas,
          IndexName: IDX_RESPONSABLE,
          KeyConditionExpression: 'responsable_id = :r AND vencimiento_orden BETWEEN :desde AND :hasta',
          ExpressionAttributeValues: {
            ':r': idUsuario,
            ':desde': `${PREFIJO_VENCIMIENTO_HECHA}${desdeFecha}#`,
            ':hasta': `${PREFIJO_VENCIMIENTO_HECHA}${hastaFecha}#\uffff`,
          },
          ProjectionExpression: 'id_tarea, calendar_event_id',
          ...(desde && { ExclusiveStartKey: desde }),
        }),
      );
      for (const t of r.Items || []) {
        const eventId = texto(t.calendar_event_id);
        if (!eventId) continue;
        entidades.push({
          tipo: 'hecha',
          id: texto(t.id_tarea),
          eventId,
          email,
        });
      }
      desde = r.LastEvaluatedKey || null;
    } while (desde);
  }
  return entidades;
}

async function reunionesConEvento(desdeFecha, hastaFecha) {
  const entidades = [];
  let desde = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.reuniones,
        IndexName: IDX_LISTADO,
        KeyConditionExpression: 'gsi_listado = :g AND #f BETWEEN :d AND :h',
        ExpressionAttributeNames: { '#f': 'fecha', '#est': 'estado' },
        ExpressionAttributeValues: {
          ':g': GSI_LISTADO.reunion,
          ':d': desdeFecha,
          ':h': hastaFecha,
        },
        ProjectionExpression:
          'id_reunion, titulo, fecha, ocurrencia_fecha, hora_inicio, hora_fin, #est, calendar_event_id, calendar_id, convocada_por',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const reunion of r.Items || []) {
      const eventId = texto(reunion.calendar_event_id);
      if (!eventId || texto(reunion.estado) === 'cancelada') continue;
      entidades.push({
        tipo: 'reunion',
        id: texto(reunion.id_reunion),
        eventId,
        calendarId: texto(reunion.calendar_id),
        personaId: texto(reunion.convocada_por),
        titulo: texto(reunion.titulo),
        fecha: texto(reunion.fecha),
        ocurrenciaFecha: texto(reunion.ocurrencia_fecha),
        horaInicio: texto(reunion.hora_inicio),
        horaFin: texto(reunion.hora_fin),
      });
    }
    desde = r.LastEvaluatedKey || null;
  } while (desde);
  return entidades;
}

function agrupar(entidades, emails) {
  const grupos = new Map();
  for (const ent of entidades) {
    const emailPersona = ent.email || emails.get(ent.personaId) || '';
    const destino = resolverSubject({ organizadorEmail: emailPersona });
    if (!destino.ok) continue;
    const calendarId = ent.calendarId || calendarIdConfigurado();
    const clave = `${destino.subject}\n${calendarId}`;
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = { subject: destino.subject, calendarId, entidades: [] };
      grupos.set(clave, grupo);
    }
    grupo.entidades.push(ent);
  }
  return grupos;
}

function calendarioDeEntrada() {
  const subject = texto(process.env.GOOGLE_CALENDAR_IMPERSONATE);
  if (!subject || !emailEnDominioPermitido(subject)) return null;
  return { subject, calendarId: calendarIdConfigurado() };
}

function esCalendarioDeEntrada(grupo) {
  const entrada = calendarioDeEntrada();
  if (!entrada) return false;
  return (
    grupo.subject.toLowerCase() === entrada.subject.toLowerCase() &&
    grupo.calendarId === entrada.calendarId
  );
}

function responsableDelBuzon(emails, subject) {
  const buscado = texto(subject).toLowerCase();
  for (const [id, email] of emails) {
    if (texto(email).toLowerCase() === buscado) return id;
  }
  return '';
}

async function leerVentana(grupo, timeMin, timeMax) {
  const token = await leerToken(grupo.subject, grupo.calendarId);
  let lista = await listarEventos({
    organizadorEmail: grupo.subject,
    calendarId: grupo.calendarId,
    syncToken: token || undefined,
    timeMin,
    timeMax,
  });
  let incremental = Boolean(token);
  if (lista.resync) {
    lista = await listarEventos({
      organizadorEmail: grupo.subject,
      calendarId: grupo.calendarId,
      timeMin,
      timeMax,
    });
    incremental = false;
  }
  return { lista, incremental };
}

async function aplicar(ent, remoto) {
  if (ent.tipo === 'hecha') return false;
  if (ent.tipo === 'tarea') {
    if (remoto.cancelado) return false;
    const r = await aplicarEventoCalendarEnTarea(ent.id, remoto);
    return r.aplicada === true;
  }
  const r = await aplicarEventoCalendarEnReunion(ent.id, remoto);
  return r.aplicada === true;
}

/**
 * @returns {Promise<{ ok: boolean, aplicadas: number, ignoradas: number, fallidas: number, motivo?: string }>}
 */
export async function traerCambiosDesdeCalendar() {
  if (!calendarDisponible()) return { ok: false, motivo: 'no_configurado', aplicadas: 0, ignoradas: 0, fallidas: 0 };

  const hoy = fechaHoyMadrid();
  const desdeFecha = addDaysIso(hoy, -DIAS_ATRAS);
  const hastaFecha = addDaysIso(hoy, DIAS_ADELANTE);
  const timeMin = `${desdeFecha}T00:00:00Z`;
  const timeMax = `${hastaFecha}T00:00:00Z`;

  const emails = await mapaEmails();
  const tareas = await tareasConEvento(emails, desdeFecha, hastaFecha);
  const reuniones = await reunionesConEvento(desdeFecha, hastaFecha);
  const grupos = agrupar([...tareas, ...reuniones], emails);
  const entrada = calendarioDeEntrada();
  if (entrada) {
    const clave = `${entrada.subject}\n${entrada.calendarId}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, { subject: entrada.subject, calendarId: entrada.calendarId, entidades: [] });
    }
  }

  let aplicadas = 0;
  let ignoradas = 0;
  let fallidas = 0;

  for (const grupo of grupos.values()) {
    const mapa = new Map(grupo.entidades.map((e) => [e.eventId, e]));
    const porSerie = new Map();
    for (const ent of grupo.entidades) {
      if (!ent.eventId || ent.tipo === 'hecha') continue;
      const lista = porSerie.get(ent.eventId) || [];
      lista.push(ent);
      porSerie.set(ent.eventId, lista);
    }
    let leido;
    try {
      leido = await leerVentana(grupo, timeMin, timeMax);
    } catch (err) {
      fallidas += 1;
      logger.error({ err, subject: grupo.subject }, `[${ETIQUETA}] No se pudo leer Calendar`);
      continue;
    }
    const lista = leido.lista;
    if (!lista.ok) {
      fallidas += 1;
      logger.warn({ subject: grupo.subject, error: lista.error }, `[${ETIQUETA}] Lectura de Calendar fallida`);
      continue;
    }
    const puedeCrear = leido.incremental && esCalendarioDeEntrada(grupo);
    const responsableEntrada = puedeCrear ? responsableDelBuzon(emails, grupo.subject) : '';
    const fallidasAntes = fallidas;
    for (const evento of lista.eventos) {
      const remoto = interpretarEventoGoogle(evento);
      if (!remoto) continue;
      if (remoto.esMaestra) {
        ignoradas += 1;
        continue;
      }
      if (remoto.recurringEventId) {
        const candidatas = porSerie.get(remoto.recurringEventId) || [];
        const local =
          candidatas.find((e) => e.ocurrenciaFecha && e.ocurrenciaFecha === remoto.fecha) ||
          candidatas.find((e) => e.fecha === remoto.fecha);
        if (!local) {
          ignoradas += 1;
          continue;
        }
        try {
          if (remoto.cancelado && local.tipo === 'tarea') {
            const r = await cancelarOcurrenciaDesdeCalendar(local.id);
            if (r.aplicada) aplicadas += 1;
          } else if (await aplicar(local, remoto)) {
            aplicadas += 1;
          }
        } catch (err) {
          fallidas += 1;
          logger.error({ err, eventId: remoto.eventId }, `[${ETIQUETA}] No se pudo copiar la instancia`);
        }
        continue;
      }
      const local = mapa.get(remoto.eventId);
      if (!local) {
        if (!puedeCrear || !responsableEntrada || remoto.cancelado || !texto(remoto.titulo) || !texto(remoto.fecha)) {
          ignoradas += 1;
          continue;
        }
        try {
          const creada = await crearTareaDesdeEventoCalendar({
            responsableId: responsableEntrada,
            eventId: remoto.eventId,
            calendarId: grupo.calendarId,
            titulo: remoto.titulo,
            fecha: remoto.fecha,
            horaInicio: remoto.horaInicio,
            horaFin: remoto.horaFin,
          });
          if (!creada.ok || !creada.creada) {
            fallidas += 1;
            continue;
          }
          aplicadas += 1;
          mapa.set(remoto.eventId, { tipo: 'tarea', id: creada.id_tarea, eventId: remoto.eventId });
        } catch (err) {
          fallidas += 1;
          logger.error({ err, eventId: remoto.eventId }, `[${ETIQUETA}] No se pudo crear la tarea desde Calendar`);
        }
        continue;
      }
      try {
        if (await aplicar(local, remoto)) aplicadas += 1;
      } catch (err) {
        fallidas += 1;
        logger.error({ err, eventId: remoto.eventId }, `[${ETIQUETA}] No se pudo copiar el evento`);
      }
    }
    if (fallidas === fallidasAntes) {
      await guardarToken(grupo.subject, grupo.calendarId, lista.nextSyncToken);
    }
  }

  return { ok: true, aplicadas, ignoradas, fallidas };
}
