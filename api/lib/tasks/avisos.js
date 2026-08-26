/**
 * Aviso por email de tareas que vencen (Fase 1A del módulo de dirección).
 *
 * Adelantado de la Fase 3 porque es el refuerzo que sostiene el hábito: una
 * lista de tareas que no avisa se convierte en una lista que nadie mira. En 1A
 * basta el email; la campana y el feed de calendario siguen en la Fase 3.
 *
 * Tres decisiones que conviene no deshacer sin leer esto:
 *
 * 1. **Un solo email por persona**, con su lista entera. Un módulo que manda
 *    quince correos a las nueve de la mañana se silencia el primer día, y
 *    entonces ya no sirve para nada.
 * 2. **Ni un `Scan` de la tabla de tareas.** El índice
 *    `Responsable-Vencimiento-index` se consulta *por responsable*, así que la
 *    lista de personas sale del maestro de usuarios y se hace una Query por
 *    persona acotada por `vencimiento_orden <= '<hoy>#\uffff'`. Es exactamente
 *    lo que el modelo de datos pretende: el índice es disperso —el escritor
 *    borra el atributo de orden al cerrar la tarea y no lo escribe si no hay
 *    responsable—, así que **no hace falta filtrar por estado** y lo que vuelve
 *    son ya solo tareas abiertas de esa persona con fecha límite pasada o de
 *    hoy. Las tareas sin fecha límite ordenan en `9999-12-31` y quedan fuera del
 *    corte solas.
 * 3. **En el correo no viaja la descripción.** Título, proyecto y fecha bastan
 *    para decidir si hay que entrar; el cuerpo de una tarea puede contener cosas
 *    que no deberían salir del ERP por correo. El nombre del proyecto tampoco
 *    viaja si el destinatario no alcanza ese proyecto: tener una tarea asignada
 *    no da acceso al proyecto del que cuelga, y el correo no es una puerta
 *    lateral para leer su nombre.
 *
 * Configuración en `Igp_Ajustes` (PK `tareas`, SK `avisos_vencimiento`), y **nace
 * desactivada**: desplegar esto no debe empezar a mandar correos a nadie.
 */

import crypto from 'node:crypto';
import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { enviarEmail, smtpConfigurado } from '../email.js';
import { logger } from '../logger.js';
import { crearCerrojo } from '../facturacion/facturacionPeriodica.js';
import { cargarContextoAcceso, puedeVerProyecto } from './acceso.js';
import { leerProyectosParaAcceso } from './proyectoLectura.js';

export const AVISOS_AJUSTE_PK = 'tareas';
export const AVISOS_AJUSTE_SK = 'avisos_vencimiento';
/** Hora local (Madrid) a la que sale la tanda si la configuración no dice otra. */
export const HORA_AVISO_POR_DEFECTO = '08:30';

const ETIQUETA = 'tareas-avisos';
const IDX_RESPONSABLE = 'Responsable-Vencimiento-index';
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Evita que dos instancias del API lancen la tanda a la vez. La garantía de «una
 * vez al día» no es esta, es el reclamo del día (ver `reclamarDia`); el cerrojo
 * solo impide que dos tandas se pisen mientras leen.
 */
const cerrojo = crearCerrojo({
  pk: AVISOS_AJUSTE_PK,
  sk: 'avisos_vencimiento_cerrojo',
  etiqueta: ETIQUETA,
  mensajeOcupado: (desde) => `Ya hay una tanda de avisos de vencimiento en curso${desde}.`,
});

// ─── Momento ───

const PARTES_MADRID = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Día y hora locales (`{ dia: 'YYYY-MM-DD', hhmm: 'HH:MM' }`). El día es el
 * mismo criterio que `fechaHoyMadrid()` de `tareas.js`, calculado aquí porque
 * este módulo necesita además la hora y así no depende del router de tareas.
 *
 * Ojo: la fecha de vencimiento de una tarea es **fecha natural**, no jornada de
 * negocio. `fechaJornadaNegocioIso()` es para cajas y cierres, donde el día
 * operativo no acaba a medianoche; una tarea vence el día que vence. Es una
 * confusión fácil en este repositorio y aquí sería un aviso con un día de
 * desfase cada mañana antes de las 09:30.
 */
export function momentoMadrid(ahora = new Date()) {
  const partes = {};
  for (const p of PARTES_MADRID.formatToParts(ahora)) {
    if (p.type !== 'literal') partes[p.type] = p.value;
  }
  return {
    dia: `${partes.year}-${partes.month}-${partes.day}`,
    hhmm: `${partes.hour}:${partes.minute}`,
  };
}

/** Días naturales entre dos fechas ISO; `0` si alguna no es una fecha. */
function diasEntre(desde, hasta) {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** `2026-08-26` → `26/08/2026`, que es como se le enseñan las fechas al usuario. */
function fechaEs(iso) {
  if (!RE_FECHA.test(String(iso ?? ''))) return String(iso ?? '');
  const [anio, mes, dia] = String(iso).split('-');
  return `${dia}/${mes}/${anio}`;
}

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

// ─── Configuración ───

/**
 * Ajustes del aviso, tolerante a que el ítem no exista o a que la lectura falle:
 * en los dos casos, desactivado. Nadie debe empezar a recibir correos porque el
 * ítem de configuración todavía no esté escrito.
 *
 * @returns {Promise<{ enabled: boolean, hora: string, ultimo_dia_enviado: string }>}
 */
export async function leerAjustesAvisos() {
  const defecto = { enabled: false, hora: HORA_AVISO_POR_DEFECTO, ultimo_dia_enviado: '' };
  let item = null;
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.ajustes,
        Key: { PK: AVISOS_AJUSTE_PK, SK: AVISOS_AJUSTE_SK },
      }),
    );
    item = r.Item || null;
  } catch (err) {
    logger.warn({ err }, `[${ETIQUETA}] No se pudieron leer los ajustes`);
    return defecto;
  }
  if (!item) return defecto;
  const hora = texto(item.hora);
  return {
    enabled: item.Enabled === true,
    hora: RE_HORA.test(hora) ? hora : HORA_AVISO_POR_DEFECTO,
    ultimo_dia_enviado: texto(item.ultimo_dia_enviado),
  };
}

/**
 * ¿Toca lanzar la tanda ahora mismo?
 *
 * La comparación es «ya ha pasado la hora» y no «es exactamente esta hora» a
 * propósito: con igualdad exacta, un reinicio del servidor a las 08:30 deja a
 * todo el mundo sin aviso ese día. Repetir no es un riesgo porque el reclamo del
 * día es atómico, y `ultimo_dia_enviado` corta aquí para no intentarlo cada
 * minuto del resto de la jornada.
 */
export function esHoraDeAvisar(ajustes, ahora = new Date()) {
  if (!ajustes?.enabled) return false;
  const { dia, hhmm } = momentoMadrid(ahora);
  if (ajustes.ultimo_dia_enviado === dia) return false;
  return hhmm >= (RE_HORA.test(texto(ajustes.hora)) ? ajustes.hora : HORA_AVISO_POR_DEFECTO);
}

/**
 * Reclama el día **antes** de mandar nada, con la misma escritura condicional
 * que usa `marcarPeriodoGenerado` para no facturar dos veces un periodo: si otra
 * ejecución ya lo tiene, la condición falla y esta se retira.
 *
 * El orden importa. Reclamar después de enviar dejaría la puerta abierta a la
 * tanda duplicada justo en el caso que se quiere evitar (dos instancias, o un
 * reinicio a mitad). El precio es que una tanda que se caiga por la mitad no se
 * reintenta hoy: preferible a que media plantilla reciba el correo dos veces.
 */
async function reclamarDia(dia) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.ajustes,
        Key: { PK: AVISOS_AJUSTE_PK, SK: AVISOS_AJUSTE_SK },
        UpdateExpression: 'SET ultimo_dia_enviado = :dia, ultimo_envio_en = :ahora, updatedAt = :ahora',
        ConditionExpression: 'attribute_not_exists(ultimo_dia_enviado) OR ultimo_dia_enviado < :dia',
        ExpressionAttributeValues: { ':dia': dia, ':ahora': new Date().toISOString() },
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    // Sin la marca no se puede garantizar que no se repita: no se envía.
    logger.error({ err, dia }, `[${ETIQUETA}] No se pudo reclamar el día: se cancela la tanda`);
    return false;
  }
}

/** Resumen del último envío, para que la pantalla de ajustes pueda enseñarlo. */
async function anotarResumen(resumen) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.ajustes,
        Key: { PK: AVISOS_AJUSTE_PK, SK: AVISOS_AJUSTE_SK },
        UpdateExpression: 'SET ultimo_envio_resumen = :res, updatedAt = :ahora',
        ExpressionAttributeValues: { ':res': JSON.stringify(resumen), ':ahora': new Date().toISOString() },
      }),
    );
  } catch (err) {
    // El aviso ya salió: que no se pueda anotar no es motivo para dar error.
    logger.warn({ err }, `[${ETIQUETA}] No se pudo anotar el resumen del envío`);
  }
}

// ─── A quién avisar y de qué ───

/**
 * Personas con email, desde el maestro de usuarios.
 *
 * Es la única lectura completa de una tabla que hace este módulo, y es la del
 * maestro de usuarios (decenas de filas, sin índice de «todos los usuarios»),
 * igual que hace el informe diario. La tabla que **no** se recorre entera es la
 * de tareas: para eso está la Query por responsable.
 */
async function personasConEmail() {
  const personas = [];
  let desde = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.usuarios,
        ProjectionExpression: '#id, #email, #nombre',
        ExpressionAttributeNames: { '#id': 'id_usuario', '#email': 'Email', '#nombre': 'Nombre' },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const u of r.Items || []) {
      const id = texto(u.id_usuario);
      const email = texto(u.Email);
      // Sin email no hay a dónde escribir: se salta sin ruido y sin gastar una
      // Query en sus tareas.
      if (!id || !email) continue;
      personas.push({ id_usuario: id, email, nombre: texto(u.Nombre) || email });
    }
    desde = r.LastEvaluatedKey || null;
  } while (desde);
  return personas;
}

/**
 * Tareas abiertas de una persona vencidas o que vencen hoy.
 *
 * El corte `'<hoy>#\uffff'` incluye todo el día de hoy y deja fuera lo posterior
 * y las tareas sin fecha límite (`9999-12-31`). Las cerradas y las que no tienen
 * responsable ni siquiera están en el índice.
 */
async function tareasQueVencen(idUsuario, hoy) {
  const items = [];
  let desde = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.tareas,
        IndexName: IDX_RESPONSABLE,
        KeyConditionExpression: 'responsable_id = :r AND vencimiento_orden <= :corte',
        ExpressionAttributeValues: { ':r': idUsuario, ':corte': `${hoy}#\uffff` },
        ProjectionExpression: 'id_tarea, titulo, fecha_limite, proyecto_id',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    items.push(...(r.Items || []));
    desde = r.LastEvaluatedKey || null;
  } while (desde);

  return items
    .filter((t) => RE_FECHA.test(texto(t.fecha_limite)) && texto(t.fecha_limite) <= hoy)
    .map((t) => ({
      id_tarea: texto(t.id_tarea),
      titulo: texto(t.titulo) || 'Tarea sin título',
      fecha_limite: texto(t.fecha_limite),
      proyecto_id: texto(t.proyecto_id),
      dias_vencida: diasEntre(texto(t.fecha_limite), hoy),
    }))
    .sort((a, b) => (a.fecha_limite < b.fecha_limite ? -1 : a.fecha_limite > b.fecha_limite ? 1 : 0));
}

/**
 * Nombre de los proyectos que esta persona **puede ver**, de entre los que
 * aparecen en su correo.
 *
 * Se resuelve por destinatario y no de una vez para toda la tanda porque la
 * respuesta depende de quién mira: tener una tarea asignada no da acceso al
 * proyecto del que cuelga, y el nombre de un proyecto es un dato («Despido de
 * J. P.»). Quien no lo alcanza recibe su tarea sin decirle de qué proyecto es,
 * que es exactamente lo que hace la vista personal. El precio son dos lecturas
 * más por persona con tareas y proyecto, sobre una tanda diaria de decenas de
 * correos.
 */
async function nombresDeProyectoVisibles(idUsuario, ids) {
  const nombres = new Map();
  if (ids.length === 0) return nombres;
  const ctx = await cargarContextoAcceso({ id_usuario: idUsuario });
  const proyectos = await leerProyectosParaAcceso(ids, idUsuario);
  for (const [id, entrada] of proyectos) {
    if (!puedeVerProyecto(ctx, entrada.proyecto, entrada.miembros)) continue;
    const nombre = texto(entrada?.proyecto?.nombre);
    if (nombre) nombres.set(id, nombre);
  }
  return nombres;
}

// ─── El correo ───

function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Enlace a la vista personal, si el servidor sabe en qué URL vive la app. */
function urlMisTareas() {
  const base = texto(process.env.APP_PUBLIC_URL).replace(/\/+$/, '');
  return base ? `${base}/proyectos/mis-tareas` : '';
}

function estadoDeTarea(tarea) {
  if (tarea.dias_vencida <= 0) return 'vence hoy';
  return `vencida hace ${tarea.dias_vencida} ${tarea.dias_vencida === 1 ? 'día' : 'días'}`;
}

function lineaTarea(tarea, nombreProyecto) {
  const partes = [tarea.titulo];
  if (nombreProyecto) partes.push(`proyecto: ${nombreProyecto}`);
  partes.push(`fecha límite: ${fechaEs(tarea.fecha_limite)}`);
  partes.push(estadoDeTarea(tarea));
  return partes.join(' · ');
}

function asuntoDe(tareas) {
  const vencidas = tareas.filter((t) => t.dias_vencida > 0).length;
  const hoy = tareas.length - vencidas;
  const partes = [];
  if (vencidas > 0) partes.push(`${vencidas} ${vencidas === 1 ? 'tarea vencida' : 'tareas vencidas'}`);
  if (hoy > 0) partes.push(`${hoy} ${hoy === 1 ? 'vence hoy' : 'vencen hoy'}`);
  return `Tus tareas: ${partes.join(' y ')}`;
}

/**
 * El correo de una persona: su lista entera, en español y sin la descripción de
 * las tareas.
 *
 * @param {{ persona: { nombre: string }, tareas: object[], hoy: string,
 *           nombresProyecto: Map<string, string> }} datos
 * @returns {{ subject: string, html: string, text: string }}
 */
export function construirAvisoEmail({ persona, tareas, hoy, nombresProyecto = new Map() }) {
  const url = urlMisTareas();
  const lineas = tareas.map((t) => lineaTarea(t, nombresProyecto.get(t.proyecto_id) || ''));
  const cabecera =
    tareas.length === 1
      ? `Tienes 1 tarea que requiere tu atención (${fechaEs(hoy)}):`
      : `Tienes ${tareas.length} tareas que requieren tu atención (${fechaEs(hoy)}):`;

  const text = [
    `Hola ${persona.nombre}:`,
    '',
    cabecera,
    ...lineas.map((l) => `- ${l}`),
    '',
    url ? `Ver mis tareas: ${url}` : 'Puedes verlas en la app, en Proyectos → Mis tareas.',
    '',
    'Un saludo,',
    'IPG Hostelería',
  ].join('\n');

  const html = `
            <p>Hola <strong>${escaparHtml(persona.nombre)}</strong>,</p>
            <p>${escaparHtml(cabecera)}</p>
            <ul>${lineas.map((l) => `<li>${escaparHtml(l)}</li>`).join('')}</ul>
            <p>${
              url
                ? `<a href="${escaparHtml(url)}">Ver mis tareas</a>`
                : 'Puedes verlas en la app, en Proyectos → Mis tareas.'
            }</p>
            <p>Un saludo,<br/>IPG Hostelería</p>
          `;

  return { subject: asuntoDe(tareas), html, text };
}

// ─── Tanda ───

/**
 * Manda a cada responsable **un** correo con sus tareas vencidas o que vencen
 * hoy. Idempotente por día: la segunda ejecución del mismo día no manda nada.
 *
 * @param {{ origen?: string, hoy?: string,
 *           enviar?: (mensaje: object) => Promise<unknown> }} [opciones]
 *   `enviar` existe para las pruebas: por defecto es el SMTP compartido del ERP.
 * @returns {Promise<{ ok: boolean, motivo: string, dia: string, destinatarios: number,
 *                     enviados: number, fallidos: number, tareas: number }>}
 */
export async function enviarAvisosVencimiento({ origen = 'programado', hoy, enviar } = {}) {
  const dia = texto(hoy) || momentoMadrid().dia;
  const enviarCorreo = enviar || enviarEmail;
  const vacio = { ok: true, dia, destinatarios: 0, enviados: 0, fallidos: 0, tareas: 0 };

  const ajustes = await leerAjustesAvisos();
  if (!ajustes.enabled) return { ...vacio, motivo: 'desactivado' };
  if (enviarCorreo === enviarEmail && !smtpConfigurado()) {
    logger.warn({}, `[${ETIQUETA}] Aviso activado pero SMTP sin configurar: no se envía nada`);
    return { ...vacio, motivo: 'sin_smtp' };
  }

  const ejecucion = crypto.randomUUID();
  const tomado = await cerrojo.adquirir(ejecucion, origen);
  if (!tomado.ok) return { ...vacio, motivo: 'en_curso' };

  try {
    if (!(await reclamarDia(dia))) return { ...vacio, motivo: 'ya_enviado' };

    const personas = await personasConEmail();
    const pendientes = [];
    let totalTareas = 0;
    for (const persona of personas) {
      const tareas = await tareasQueVencen(persona.id_usuario, dia);
      if (tareas.length === 0) continue;
      totalTareas += tareas.length;
      pendientes.push({ persona, tareas });
    }

    let enviados = 0;
    let fallidos = 0;
    for (const { persona, tareas } of pendientes) {
      const nombresProyecto = await nombresDeProyectoVisibles(
        persona.id_usuario,
        [...new Set(tareas.map((t) => t.proyecto_id).filter(Boolean))],
      );
      const { subject, html, text } = construirAvisoEmail({ persona, tareas, hoy: dia, nombresProyecto });
      try {
        await enviarCorreo({ to: persona.email, subject, html, text });
        enviados += 1;
      } catch (err) {
        // Un buzón que rechaza no puede dejar a los demás sin aviso.
        fallidos += 1;
        logger.error(
          { err, id_usuario: persona.id_usuario },
          `[${ETIQUETA}] No se pudo enviar el aviso a un destinatario`,
        );
      }
    }

    const resumen = {
      dia,
      origen,
      destinatarios: pendientes.length,
      enviados,
      fallidos,
      tareas: totalTareas,
    };
    await anotarResumen(resumen);
    return { ok: true, motivo: 'enviado', ...resumen };
  } finally {
    await cerrojo.liberar(ejecucion);
  }
}
