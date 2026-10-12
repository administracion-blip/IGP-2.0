/**
 * Lecturas de Igp_Actuaciones por los GSI Listado-Fecha y Artista-Fecha.
 * `gsi_fecha` es `YYYY-MM-DD#HH:MM` (ver clavesActuacion). Sin Scan de respaldo.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from './db.js';

export const GSI_ACTUACIONES_LISTADO = 'Listado-Fecha-index';
export const GSI_ACTUACIONES_ARTISTA = 'Artista-Fecha-index';

async function queryTodas(params) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      ...params,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Actuaciones del listado. Sin fechas, todas las que tienen gsi_listado.
 * Con fechas, `gsi_fecha` BETWEEN `desde#` y `hasta#\uffff`.
 */
export async function queryActuacionesListado(desde = '', hasta = '') {
  const conRango = Boolean(desde);
  const fin = hasta || desde;
  return queryTodas({
    TableName: tables.actuaciones,
    IndexName: GSI_ACTUACIONES_LISTADO,
    KeyConditionExpression: conRango
      ? 'gsi_listado = :t AND gsi_fecha BETWEEN :a AND :b'
      : 'gsi_listado = :t',
    ExpressionAttributeValues: conRango
      ? { ':t': 'ACTUACION', ':a': `${desde}#`, ':b': `${fin}#\uffff` }
      : { ':t': 'ACTUACION' },
  });
}

/** Actuaciones de un artista. Con fecha, solo ese día (`begins_with`). */
export async function queryActuacionesArtista(idArtista, fechaIso = '') {
  const id = String(idArtista || '').trim();
  if (!id) return [];
  const conDia = Boolean(fechaIso);
  return queryTodas({
    TableName: tables.actuaciones,
    IndexName: GSI_ACTUACIONES_ARTISTA,
    KeyConditionExpression: conDia
      ? 'gsi_artista = :a AND begins_with(gsi_fecha, :d)'
      : 'gsi_artista = :a',
    ExpressionAttributeValues: conDia
      ? { ':a': id, ':d': `${fechaIso}#` }
      : { ':a': id },
  });
}
