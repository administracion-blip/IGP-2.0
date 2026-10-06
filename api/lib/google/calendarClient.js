/**
 * Cliente de Google Calendar para el módulo de reuniones (Fase 1B).
 *
 * Interfaz estable que consume `api/lib/tasks/reuniones.js`.
 *
 * Configuración (api/.env.local):
 * - `GOOGLE_SA_CLIENT_EMAIL` / `GOOGLE_SA_PRIVATE_KEY` — cuenta de servicio
 * - `GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS` — allowlist (ej. `grupoparipe.com`)
 * - `GOOGLE_CALENDAR_IMPERSONATE` — buzón fijo organizador (opción A), o vacío
 *   para usar `organizadorEmail` del convocante (opción B)
 * - `GOOGLE_CALENDAR_ID` — por defecto `primary`
 *
 * Criterio D-21: fallo o ausencia de Google **no tumba** la reunión. Quien llama
 * mira `disponible` / `ok` y sigue con DynamoDB sin `calendar_event_id`.
 *
 * Nunca impersona un email fuera de la allowlist.
 */

import { google } from 'googleapis';
import { randomUUID } from 'node:crypto';
import { rruleConUntil, sumarDias } from '../tasks/recurrencia.js';

/**
 * @typedef {object} DatosEventoReunion
 * @property {string} titulo
 * @property {string} fecha `YYYY-MM-DD`
 * @property {string} [horaInicio] `HH:mm`
 * @property {string} [horaFin] `HH:mm`
 * @property {string} [descripcion]
 * @property {string[]} [asistentesEmails]
 * @property {string} [organizadorEmail] Solo si no hay `GOOGLE_CALENDAR_IMPERSONATE`
 * @property {boolean} [conMeet] Por defecto true: añade enlace Meet
 */

/**
 * @typedef {object} ResultadoEventoCalendar
 * @property {boolean} ok
 * @property {string|null} [eventId]
 * @property {string|null} [calendarId]
 * @property {'presencial'|'remota'|'mixta'|null} [modalidad]
 * @property {string|null} [sala]
 * @property {string|null} [meetCode]
 * @property {string} [error]
 */

const MOTIVO_NO_CONFIGURADO = 'Google Calendar no está configurado';
const TZ = 'Europe/Madrid';

/** @type {null | (() => Promise<{ calendar: object, calendarId: string, subject: string }>)} */
let factoryPruebas = null;

/**
 * Sustituye la fábrica de cliente (pruebas). Devuelve función que restaura.
 * @param {null | (() => Promise<{ calendar: object, calendarId: string, subject: string }>)} fn
 */
export function configurarClienteCalendar(fn) {
  const previo = factoryPruebas;
  factoryPruebas = fn;
  return () => {
    factoryPruebas = previo;
  };
}

function texto(v) {
  return v == null ? '' : String(v).trim();
}

function privateKeyDesdeEnv() {
  let key = texto(process.env.GOOGLE_SA_PRIVATE_KEY);
  if (!key) return '';
  // En .env suele ir con `\n` literales entre comillas.
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return key;
}

export function dominiosPermitidos() {
  return texto(process.env.GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS)
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function emailEnDominioPermitido(email) {
  const e = texto(email).toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const dominio = e.slice(at + 1);
  const lista = dominiosPermitidos();
  if (!lista.length) return false;
  return lista.includes(dominio);
}

/** Credenciales mínimas sin llamar a Google. */
export function credencialesConfiguradas() {
  return Boolean(texto(process.env.GOOGLE_SA_CLIENT_EMAIL) && privateKeyDesdeEnv());
}

/**
 * Email a impersonar. Prioridad: env fijo (opción A) → `organizadorEmail` (B).
 * Debe pertenecer a la allowlist.
 */
export function resolverSubject(datos = {}) {
  const fijo = texto(process.env.GOOGLE_CALENDAR_IMPERSONATE);
  const candidato = fijo || texto(datos.organizadorEmail);
  if (!candidato) return { ok: false, error: 'No hay email de organizador para Calendar' };
  if (!emailEnDominioPermitido(candidato)) {
    return {
      ok: false,
      error: `El organizador «${candidato}» no está en un dominio permitido`,
    };
  }
  return { ok: true, subject: candidato };
}

export function disponible() {
  if (factoryPruebas) return true;
  return credencialesConfiguradas() && dominiosPermitidos().length > 0;
}

function calendarIdDeEnv() {
  return texto(process.env.GOOGLE_CALENDAR_ID) || 'primary';
}

export function calendarIdConfigurado() {
  return calendarIdDeEnv();
}

async function obtenerCliente(datos = {}) {
  if (factoryPruebas) return factoryPruebas();

  if (!credencialesConfiguradas()) {
    throw Object.assign(new Error(MOTIVO_NO_CONFIGURADO), { code: 'NO_CONFIG' });
  }
  const subjectRes = resolverSubject(datos);
  if (!subjectRes.ok) {
    throw Object.assign(new Error(subjectRes.error), { code: 'SUBJECT' });
  }

  const auth = new google.auth.JWT({
    email: texto(process.env.GOOGLE_SA_CLIENT_EMAIL),
    key: privateKeyDesdeEnv(),
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    subject: subjectRes.subject,
  });

  return {
    calendar: google.calendar({ version: 'v3', auth }),
    calendarId: calendarIdDeEnv(),
    subject: subjectRes.subject,
  };
}

/**
 * Construye start/end en zona Madrid. Sin horas → día completo.
 */
export function construirRangoTemporal({ fecha, horaInicio, horaFin }) {
  const dia = texto(fecha);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    throw new Error('La fecha del evento no es válida');
  }
  const hi = texto(horaInicio);
  const hf = texto(horaFin);
  if (hi && hf) {
    return {
      start: { dateTime: `${dia}T${hi.length === 5 ? `${hi}:00` : hi}`, timeZone: TZ },
      end: { dateTime: `${dia}T${hf.length === 5 ? `${hf}:00` : hf}`, timeZone: TZ },
    };
  }
  // Día siguiente civil para all-day (exclusive end de Calendar).
  const [y, m, d] = dia.split('-').map(Number);
  const fin = new Date(Date.UTC(y, m - 1, d + 1));
  const finIso = fin.toISOString().slice(0, 10);
  return {
    start: { date: dia },
    end: { date: finIso },
  };
}

function asistentesDe(datos) {
  const emails = Array.isArray(datos.asistentesEmails) ? datos.asistentesEmails : [];
  const vistos = new Set();
  const out = [];
  for (const raw of emails) {
    const email = texto(raw).toLowerCase();
    if (!email || !email.includes('@') || vistos.has(email)) continue;
    // No filtramos por dominio en asistentes: pueden ser externos.
    // Sí rechazamos impersonar fuera; aquí solo invitamos.
    vistos.add(email);
    out.push({ email });
  }
  return out;
}

/** `all` si hay al menos un email de asistente; si no, `none` (sin invitaciones). */
function sendUpdatesDe(datos) {
  return asistentesDe(datos).length > 0 ? 'all' : 'none';
}

/**
 * @param {DatosEventoReunion} datos
 * @param {{ crearMeet: boolean, incluirAsistentes?: boolean }} opts
 *   `incluirAsistentes: false` en patch sin lista → no tocar attendees existentes.
 */
function cuerpoEvento(datos, { crearMeet, incluirAsistentes = true }) {
  // Una serie ya tiene su RRULE: un parche de título o invitados no mueve el inicio.
  if (datos.conservarHorario) {
    const cuerpo = {
      summary: texto(datos.titulo) || 'Reunión',
      description: texto(datos.descripcion) || undefined,
    };
    if (incluirAsistentes) cuerpo.attendees = asistentesDe(datos);
    return cuerpo;
  }
  const rango = construirRangoTemporal(datos);
  const body = {
    summary: texto(datos.titulo) || 'Reunión',
    description: texto(datos.descripcion) || undefined,
    ...rango,
  };
  const reglas = Array.isArray(datos.recurrence) ? datos.recurrence.map(texto).filter(Boolean) : [];
  if (reglas.length > 0) body.recurrence = reglas;
  if (incluirAsistentes) {
    body.attendees = asistentesDe(datos);
  }
  if (crearMeet) {
    body.conferenceData = {
      createRequest: {
        requestId: randomUUID().replace(/-/g, '').slice(0, 16),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }
  return body;
}

/**
 * Deriva modalidad de la respuesta de Calendar (sala recurso + Meet).
 */
export function derivarModalidadDeEvento(evento) {
  const attendees = Array.isArray(evento?.attendees) ? evento.attendees : [];
  let sala = null;
  for (const a of attendees) {
    const email = texto(a?.email).toLowerCase();
    if (!email) continue;
    if (a?.resource === true || email.includes('resource.calendar.google.com')) {
      sala = email;
      break;
    }
  }
  const entryPoints = evento?.conferenceData?.entryPoints || [];
  let meetCode = null;
  for (const ep of entryPoints) {
    if (texto(ep?.entryPointType) === 'video' && texto(ep?.uri)) {
      // hangoutsMeet / meet.google.com/xxx-xxxx-xxx
      const uri = texto(ep.uri);
      const m = uri.match(/meet\.google\.com\/([a-z0-9-]+)/i);
      meetCode = m ? m[1] : uri;
      break;
    }
  }
  if (!meetCode && texto(evento?.hangoutLink)) {
    const m = texto(evento.hangoutLink).match(/meet\.google\.com\/([a-z0-9-]+)/i);
    meetCode = m ? m[1] : texto(evento.hangoutLink);
  }

  let modalidad = null;
  if (sala && meetCode) modalidad = 'mixta';
  else if (sala) modalidad = 'presencial';
  else if (meetCode) modalidad = 'remota';

  return { modalidad, sala, meetCode };
}

function resultadoOk(evento, calendarId) {
  const { modalidad, sala, meetCode } = derivarModalidadDeEvento(evento);
  return {
    ok: true,
    eventId: texto(evento?.id) || null,
    calendarId: calendarId || null,
    modalidad,
    sala,
    meetCode,
  };
}

function resultadoError(err) {
  const msg =
    texto(err?.message) ||
    texto(err?.response?.data?.error?.message) ||
    'Error al sincronizar con Calendar';
  return {
    ok: false,
    eventId: null,
    calendarId: null,
    modalidad: null,
    sala: null,
    meetCode: null,
    error: msg,
  };
}

/**
 * @param {DatosEventoReunion} datos
 * @returns {Promise<ResultadoEventoCalendar>}
 */
export async function crearEvento(datos = {}) {
  if (!disponible() && !factoryPruebas) {
    return resultadoError(new Error(MOTIVO_NO_CONFIGURADO));
  }
  try {
    const { calendar, calendarId } = await obtenerCliente(datos);
    const conMeet = datos.conMeet !== false;
    const res = await calendar.events.insert({
      calendarId,
      conferenceDataVersion: conMeet ? 1 : 0,
      sendUpdates: sendUpdatesDe(datos),
      requestBody: cuerpoEvento(datos, { crearMeet: conMeet }),
    });
    return resultadoOk(res.data, calendarId);
  } catch (err) {
    if (err?.code === 'NO_CONFIG' || err?.code === 'SUBJECT') {
      return resultadoError(err);
    }
    return resultadoError(err);
  }
}

/**
 * @param {string} eventId
 * @param {DatosEventoReunion} [datos]
 * @returns {Promise<ResultadoEventoCalendar>}
 */
export async function actualizarEvento(eventId, datos = {}) {
  const id = texto(eventId);
  if (!id) return resultadoError(new Error('Falta el id del evento de Calendar'));
  if (!disponible() && !factoryPruebas) {
    return resultadoError(new Error(MOTIVO_NO_CONFIGURADO));
  }
  try {
    const { calendar, calendarId } = await obtenerCliente(datos);
    // Patch: no recreamos Meet en cada edición (evita códigos nuevos).
    // Solo tocamos attendees si el caller pasó `asistentesEmails` (array);
    // si no, un PATCH de título/hora no borra invitados ya sincronizados.
    const incluirAsistentes = Array.isArray(datos.asistentesEmails);
    const body = cuerpoEvento(datos, { crearMeet: false, incluirAsistentes });
    delete body.conferenceData;
    const res = await calendar.events.patch({
      calendarId,
      eventId: id,
      // Quien ya está invitado debe enterarse de cambios de hora/título.
      sendUpdates: 'all',
      requestBody: body,
    });
    return resultadoOk(res.data, calendarId);
  } catch (err) {
    return resultadoError(err);
  }
}

/**
 * @param {string} eventId
 * @param {object} [datos] Para resolver subject / calendarId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function borrarEvento(eventId, datos = {}) {
  const id = texto(eventId);
  if (!id) return { ok: false, error: 'Falta el id del evento de Calendar' };
  if (!disponible() && !factoryPruebas) {
    return { ok: false, error: MOTIVO_NO_CONFIGURADO };
  }
  try {
    const { calendar, calendarId } = await obtenerCliente(datos);
    await calendar.events.delete({
      calendarId,
      eventId: id,
      sendUpdates: 'all',
    });
    return { ok: true };
  } catch (err) {
    // 404/410: ya no está; tratamos como OK para no bloquear el borrado local.
    const status = err?.code || err?.response?.status;
    if (status === 404 || status === 410) return { ok: true };
    return {
      ok: false,
      error: texto(err?.message) || 'No se pudo borrar el evento de Calendar',
    };
  }
}

/**
 * Cancela una sola fecha de un evento recurrente. El resto de la serie sigue.
 * Si esa fecha ya no está en Calendar, se da por hecha.
 */
export async function cancelarInstanciaSerie({ eventId, fecha, organizadorEmail, calendarId } = {}) {
  const id = texto(eventId);
  const dia = texto(fecha);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    return { ok: false, error: 'Falta la serie o la fecha a cancelar' };
  }
  if (!disponible() && !factoryPruebas) return { ok: false, error: MOTIVO_NO_CONFIGURADO };
  try {
    const cliente = await obtenerCliente({ organizadorEmail, calendarId });
    const idCalendario = texto(calendarId) || cliente.calendarId;
    const res = await cliente.calendar.events.instances({
      calendarId: idCalendario,
      eventId: id,
      timeMin: `${sumarDias(dia, -1)}T00:00:00Z`,
      timeMax: `${sumarDias(dia, 2)}T00:00:00Z`,
      maxResults: 10,
      showDeleted: false,
    });
    const inst = (res.data?.items || []).find((ev) => {
      const leido = interpretarEventoGoogle(ev);
      return leido && !leido.cancelado && leido.fecha === dia;
    });
    if (!inst?.id) return { ok: true };
    return borrarEvento(inst.id, { organizadorEmail, calendarId: idCalendario });
  } catch (err) {
    const status = err?.code || err?.response?.status;
    if (status === 404 || status === 410) return { ok: true };
    return { ok: false, error: texto(err?.message) || 'No se pudo cancelar esa fecha en Calendar' };
  }
}

/**
 * Corta la serie el día anterior a `fechaDesde`: esa fecha y las posteriores
 * dejan de existir en Google. Las anteriores se quedan.
 */
export async function truncarSerieHasta({ eventId, fechaDesde, organizadorEmail, calendarId } = {}) {
  const id = texto(eventId);
  const dia = texto(fechaDesde);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    return { ok: false, error: 'Falta la serie o la fecha de corte' };
  }
  if (!disponible() && !factoryPruebas) return { ok: false, error: MOTIVO_NO_CONFIGURADO };
  try {
    const cliente = await obtenerCliente({ organizadorEmail, calendarId });
    const idCalendario = texto(calendarId) || cliente.calendarId;
    const got = await cliente.calendar.events.get({ calendarId: idCalendario, eventId: id });
    const reglas = Array.isArray(got.data?.recurrence) ? got.data.recurrence : [];
    const rrule = reglas.find((r) => String(r).startsWith('RRULE')) || 'RRULE:FREQ=DAILY';
    const diaCompleto = Boolean(got.data?.start?.date) && !got.data?.start?.dateTime;
    const nueva = rruleConUntil(rrule, dia, { diaCompleto });
    const resto = reglas.filter((r) => !String(r).startsWith('RRULE'));
    await cliente.calendar.events.patch({
      calendarId: idCalendario,
      eventId: id,
      sendUpdates: 'none',
      requestBody: { recurrence: [nueva, ...resto] },
    });
    return { ok: true };
  } catch (err) {
    const status = err?.code || err?.response?.status;
    if (status === 404 || status === 410) return { ok: true };
    return { ok: false, error: texto(err?.message) || 'No se pudo acortar la serie en Calendar' };
  }
}

const PARTES_MADRID_EVENTO = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Fecha y hora de un instante ISO en Madrid. `hora` es `HH:mm`. */
export function partesMadridDeInstante(iso) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return null;
  const partes = {};
  for (const p of PARTES_MADRID_EVENTO.formatToParts(fecha)) {
    if (p.type !== 'literal') partes[p.type] = p.value;
  }
  let hora = partes.hour;
  if (hora === '24') hora = '00';
  return {
    fecha: `${partes.year}-${partes.month}-${partes.day}`,
    hora: `${hora}:${partes.minute}`,
  };
}

function fechaDeInicioGoogle(start) {
  if (!start) return '';
  if (texto(start.date) && !texto(start.dateTime)) return texto(start.date);
  if (!texto(start.dateTime)) return '';
  return partesMadridDeInstante(start.dateTime)?.fecha || '';
}

/** Marcas de serie: instancia (`recurringEventId`) o el evento maestro (RRULE). */
function marcasSerie(evento) {
  const extra = {};
  const serie = texto(evento?.recurringEventId);
  if (serie) extra.recurringEventId = serie;
  const reglas = Array.isArray(evento?.recurrence) ? evento.recurrence : [];
  if (!serie && reglas.some((r) => String(r).startsWith('RRULE'))) extra.esMaestra = true;
  return extra;
}

/**
 * Lo que la agenda puede copiar de un evento de Google.
 * Día completo → horas vacías. `cancelled` no trae título; si es una instancia,
 * conserva la serie y la fecha original para no borrar el resto.
 */
export function interpretarEventoGoogle(evento) {
  const eventId = texto(evento?.id);
  if (!eventId) return null;
  if (texto(evento?.status) === 'cancelled') {
    const out = { eventId, cancelado: true, ...marcasSerie(evento) };
    const fecha = fechaDeInicioGoogle(evento?.originalStartTime) || fechaDeInicioGoogle(evento?.start);
    if (fecha) out.fecha = fecha;
    return out;
  }
  const titulo = texto(evento?.summary);
  const start = evento?.start || {};
  const end = evento?.end || {};
  if (texto(start.date) && !texto(start.dateTime)) {
    return {
      eventId,
      cancelado: false,
      titulo,
      fecha: texto(start.date),
      horaInicio: '',
      horaFin: '',
      ...marcasSerie(evento),
    };
  }
  if (!texto(start.dateTime)) return null;
  const ini = partesMadridDeInstante(start.dateTime);
  if (!ini) return null;
  const fin = texto(end.dateTime) ? partesMadridDeInstante(end.dateTime) : null;
  return {
    eventId,
    cancelado: false,
    titulo,
    fecha: ini.fecha,
    horaInicio: ini.hora,
    horaFin: fin?.hora || '',
    ...marcasSerie(evento),
  };
}

/**
 * Cambios de eventos desde la última lectura (`syncToken`) o, la primera vez,
 * los que caen entre `timeMin` y `timeMax`. Un 410 pide relectura completa.
 *
 * @returns {Promise<{ ok: true, eventos: object[], nextSyncToken: string|null, calendarId: string }
 *   | { ok: false, resync?: boolean, error: string }>}
 */
export async function listarEventos({ organizadorEmail, calendarId, syncToken, timeMin, timeMax } = {}) {
  if (!disponible() && !factoryPruebas) {
    return { ok: false, error: MOTIVO_NO_CONFIGURADO };
  }
  try {
    const cliente = await obtenerCliente({ organizadorEmail });
    const idCalendario = texto(calendarId) || cliente.calendarId;
    const params = {
      calendarId: idCalendario,
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
    };
    if (texto(syncToken)) params.syncToken = texto(syncToken);
    else {
      if (timeMin) params.timeMin = timeMin;
      if (timeMax) params.timeMax = timeMax;
    }
    const eventos = [];
    let pageToken;
    let nextSyncToken = null;
    do {
      const res = await cliente.calendar.events.list({ ...params, pageToken });
      eventos.push(...(res.data?.items || []));
      pageToken = res.data?.nextPageToken;
      if (res.data?.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
    } while (pageToken);
    return { ok: true, eventos, nextSyncToken, calendarId: idCalendario };
  } catch (err) {
    const status = err?.code || err?.response?.status;
    if (status === 410) return { ok: false, resync: true, error: 'La marca de sincronización de Calendar ha caducado' };
    if (err?.code === 'NO_CONFIG' || err?.code === 'SUBJECT') return { ok: false, error: err.message };
    return { ok: false, error: texto(err?.message) || 'No se pudieron leer los eventos de Calendar' };
  }
}
