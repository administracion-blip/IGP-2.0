/**
 * Número de pedido a proveedor para la serie fija MIA.
 *
 * Ágora identifica el documento por serie + número. Un número repetido
 * sustituye el pedido anterior. El contador vive en Igp_Ajustes
 * (PK = mia_po_contador, SK = MIA) y sube con condición: si otro proceso
 * se adelanta, se reintenta. Si no hay número, no se envía nada a Ágora.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

export const PK_CONTADOR = 'mia_po_contador';
export const SK_CONTADOR = 'MIA';
export const SERIE_PEDIDO_MIA = 'MIA';
export const INTENTOS_CONTADOR = 5;
export const MENSAJE_SIN_NUMERO = 'No se ha podido reservar el número de pedido. No se envía a Ágora.';

function fallo(mensaje, status) {
  return Object.assign(new Error(mensaje), { status, expose: true });
}

async function leerUltimo() {
  const r = await docClient.send(new GetCommand({
    TableName: tables.ajustes,
    Key: { PK: PK_CONTADOR, SK: SK_CONTADOR },
  }));
  const n = Number(r.Item?.ultimo);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Reserva el siguiente número de la serie MIA.
 * @returns {Promise<number>}
 */
export async function reservarNumeroPedido() {
  for (let intento = 0; intento < INTENTOS_CONTADOR; intento += 1) {
    const actual = await leerUltimo();
    const siguiente = (actual ?? 0) + 1;
    try {
      await docClient.send(new UpdateCommand({
        TableName: tables.ajustes,
        Key: { PK: PK_CONTADOR, SK: SK_CONTADOR },
        UpdateExpression: 'SET ultimo = :siguiente, serie = :serie',
        ConditionExpression: actual == null ? 'attribute_not_exists(ultimo)' : 'ultimo = :esperado',
        ExpressionAttributeValues: {
          ':siguiente': siguiente,
          ':serie': SERIE_PEDIDO_MIA,
          ...(actual == null ? {} : { ':esperado': actual }),
        },
      }));
      return siguiente;
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  throw fallo(MENSAJE_SIN_NUMERO, 409);
}
