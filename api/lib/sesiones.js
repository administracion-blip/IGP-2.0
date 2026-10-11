/**
 * Revocación de sesiones (JWT) por usuario.
 *
 * El login firma `tv` = `tokenVersion` de la ficha; `requireAuth` rechaza los
 * tokens cuyo `tv` no coincide. Subir la versión invalida todos los tokens
 * emitidos hasta ahora para ese usuario.
 *
 * Con varias instancias del API, la invalidación de la caché del contexto solo
 * es local: en las demás el token revocado sigue entrando hasta que caduque su
 * entrada (`CACHE_TTL_MS` de `tasks/acceso.js`, 60 s).
 */

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from './db.js';
import { invalidarContextoAcceso } from './tasks/acceso.js';

/**
 * Incrementa `tokenVersion` de forma atómica. Devuelve la versión nueva, o
 * `null` si el usuario no existe (no se crea una ficha fantasma).
 */
export async function revocarSesionesUsuario(idUsuario) {
  const id = String(idUsuario ?? '').trim();
  if (!id) return null;
  try {
    const r = await docClient.send(new UpdateCommand({
      TableName: tables.usuarios,
      Key: { id_usuario: id },
      UpdateExpression: 'ADD tokenVersion :uno',
      ConditionExpression: 'attribute_exists(id_usuario)',
      ExpressionAttributeValues: { ':uno': 1 },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(r?.Attributes?.tokenVersion ?? 0);
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  } finally {
    invalidarContextoAcceso(id);
  }
}
