/**
 * Cliente de Google Calendar para el módulo de reuniones.
 *
 * Interfaz estable que consume `api/lib/tasks/reuniones.js`. En Fase 1B es un
 * **stub**: no llama a Google ni exige `googleapis`. Cuando haya service account,
 * este fichero se sustituye por el adaptador real sin cambiar la firma.
 *
 * Criterio D-21: fallo o ausencia de Google **no tumba** la reunión. Quien llama
 * mira `disponible` / `ok` y sigue con DynamoDB sin `calendar_event_id`.
 */

/**
 * @typedef {object} DatosEventoReunion
 * @property {string} titulo
 * @property {string} fecha `YYYY-MM-DD`
 * @property {string} [horaInicio] `HH:mm`
 * @property {string} [horaFin] `HH:mm`
 * @property {string} [descripcion]
 * @property {string[]} [asistentesEmails]
 */

/**
 * @typedef {object} ResultadoEventoCalendar
 * @property {boolean} ok
 * @property {string} [eventId]
 * @property {string} [calendarId]
 * @property {'presencial'|'remota'|'mixta'|null} [modalidad]
 * @property {string|null} [sala]
 * @property {string|null} [meetCode]
 * @property {string} [error]
 */

const MOTIVO_NO_CONFIGURADO = 'Google Calendar no está configurado';

/** `false` mientras no haya credenciales / adaptador real. */
export function disponible() {
  return false;
}

/**
 * @param {DatosEventoReunion} _datos
 * @returns {Promise<ResultadoEventoCalendar>}
 */
export async function crearEvento(_datos = {}) {
  return {
    ok: false,
    eventId: null,
    calendarId: null,
    modalidad: null,
    sala: null,
    meetCode: null,
    error: MOTIVO_NO_CONFIGURADO,
  };
}

/**
 * @param {string} _eventId
 * @param {DatosEventoReunion} [_datos]
 * @returns {Promise<ResultadoEventoCalendar>}
 */
export async function actualizarEvento(_eventId, _datos = {}) {
  return {
    ok: false,
    eventId: null,
    calendarId: null,
    modalidad: null,
    sala: null,
    meetCode: null,
    error: MOTIVO_NO_CONFIGURADO,
  };
}

/**
 * @param {string} _eventId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function borrarEvento(_eventId) {
  return { ok: false, error: MOTIVO_NO_CONFIGURADO };
}
