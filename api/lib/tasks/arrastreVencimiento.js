/**
 * Pasa al día de hoy las tareas abiertas cuya fecha límite ya quedó atrás.
 *
 * Corre una vez por día natural de Madrid. Guarda la fecha nueva, así que Google
 * Calendar y el feed de vencimientos siguen el mismo día que la agenda. No usa
 * la jornada de hostelería: a medianoche, no a las 09:30.
 *
 * No recorre la tabla de tareas. Sale del maestro de usuarios y consulta el
 * índice `Responsable-Vencimiento-index` con `vencimiento_orden < hoy`, que ya
 * deja fuera hechas, canceladas y las que no tienen fecha.
 */

import { QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { logger } from '../logger.js';
import { arrastrarFechaLimiteAHoy, fechaHoyMadrid } from './tareas.js';

const ETIQUETA = 'tareas-arrastre';
const AJUSTE_PK = 'tareas';
const AJUSTE_SK = 'arrastre_vencimiento';
const IDX_RESPONSABLE = 'Responsable-Vencimiento-index';

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

/**
 * Reclama el día antes de mover fechas. Si otra instancia ya lo tiene, esta se
 * retira: mover dos veces el mismo día no aporta y sí duplicaría el parche de
 * Calendar si la primera tanda aún no hubiera terminado de escribir.
 */
async function reclamarDia(dia) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.ajustes,
        Key: { PK: AJUSTE_PK, SK: AJUSTE_SK },
        UpdateExpression: 'SET ultimo_dia = :dia, updatedAt = :ahora',
        ConditionExpression: 'attribute_not_exists(ultimo_dia) OR ultimo_dia < :dia',
        ExpressionAttributeValues: { ':dia': dia, ':ahora': new Date().toISOString() },
      }),
    );
    return { ok: true };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { ok: false, motivo: 'ya' };
    logger.error({ err, dia }, `[${ETIQUETA}] No se pudo reclamar el día`);
    return { ok: false, motivo: 'error' };
  }
}

async function idsDeUsuarios() {
  const ids = [];
  let desde = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.usuarios,
        ProjectionExpression: 'id_usuario',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const u of r.Items || []) {
      const id = texto(u.id_usuario);
      if (id) ids.push(id);
    }
    desde = r.LastEvaluatedKey || null;
  } while (desde);
  return ids;
}

/** Tareas abiertas de esa persona con vencimiento anterior a `hoy`. */
async function idsVencidas(idUsuario, hoy) {
  const ids = [];
  let desde = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.tareas,
        IndexName: IDX_RESPONSABLE,
        KeyConditionExpression: 'responsable_id = :r AND vencimiento_orden < :hoy',
        ExpressionAttributeValues: { ':r': idUsuario, ':hoy': hoy },
        ProjectionExpression: 'id_tarea',
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );
    for (const t of r.Items || []) {
      const id = texto(t.id_tarea);
      if (id) ids.push(id);
    }
    desde = r.LastEvaluatedKey || null;
  } while (desde);
  return ids;
}

/**
 * @param {{ hoy?: string }} [opts]
 * @returns {Promise<{ dia: string, reclamado: boolean, motivo?: string, arrastradas: number, fallidas: number, calendarioFallido: number }>}
 */
export async function arrastrarTareasVencidas({ hoy } = {}) {
  const dia = texto(hoy) || fechaHoyMadrid();
  const reclamo = await reclamarDia(dia);
  if (!reclamo.ok) {
    return {
      dia,
      reclamado: false,
      motivo: reclamo.motivo,
      arrastradas: 0,
      fallidas: 0,
      calendarioFallido: 0,
    };
  }

  let arrastradas = 0;
  let fallidas = 0;
  let calendarioFallido = 0;
  const usuarios = await idsDeUsuarios();
  for (const idUsuario of usuarios) {
    const tareas = await idsVencidas(idUsuario, dia);
    for (const idTarea of tareas) {
      try {
        const r = await arrastrarFechaLimiteAHoy(idTarea, dia);
        if (!r.ok) {
          fallidas += 1;
          continue;
        }
        if (r.arrastrada) arrastradas += 1;
        if (r.calendario_error) calendarioFallido += 1;
      } catch (err) {
        fallidas += 1;
        logger.error({ err, idTarea }, `[${ETIQUETA}] No se pudo pasar la tarea al día`);
      }
    }
  }

  return { dia, reclamado: true, arrastradas, fallidas, calendarioFallido };
}
