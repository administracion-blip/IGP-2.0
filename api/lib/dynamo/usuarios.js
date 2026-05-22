/**
 * Infraestructura compartida de usuarios (igp_usuarios).
 *
 * Gestiona el GSI `Email-index` y expone `findUsuarioByEmail()` para que
 * `auth.js` (login) y `scripts/reset-password.js` puedan resolver un email a
 * usuario sin recorrer la tabla con un Scan + FilterExpression.
 *
 * Patrón calcado de `comprasProveedor.js`: ensure on boot + flag de readiness
 * + fallback a Scan mientras DynamoDB termina de crear el índice (~1-5 min).
 */

import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { client, docClient, tables } from '../db.js';

const TABLE_NAME = tables.usuarios;


export const GSI_USUARIOS_EMAIL_NAME = 'Email-index';

let gsiReady = false;

export function isUsuariosEmailGsiReady() {
  return gsiReady;
}

/**
 * Verifica/crea el GSI `Email-index` sobre `igp_usuarios` con projection ALL.
 * Idempotente: si ya existe lo marca como activo cuando lo está, si no lo crea.
 * Nunca lanza: en caso de error solo deja `gsiReady=false` y se loguea, para
 * que el login siga funcionando con el Scan de fallback.
 */
export async function ensureUsuariosEmailGSI() {
  try {
    const desc = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    const gsis = desc.Table?.GlobalSecondaryIndexes || [];
    const existing = gsis.find((g) => g.IndexName === GSI_USUARIOS_EMAIL_NAME);
    if (existing) {
      gsiReady = existing.IndexStatus === 'ACTIVE';
      if (!gsiReady) console.log(`[GSI] ${GSI_USUARIOS_EMAIL_NAME} existe pero está en estado ${existing.IndexStatus}, usando Scan como fallback`);
      else console.log(`[GSI] ${GSI_USUARIOS_EMAIL_NAME} activo y listo`);
      return;
    }
    console.log(`[GSI] Creando ${GSI_USUARIOS_EMAIL_NAME} en ${TABLE_NAME}…`);
    await client.send(new UpdateTableCommand({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: 'Email', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexUpdates: [{
        Create: {
          IndexName: GSI_USUARIOS_EMAIL_NAME,
          KeySchema: [
            { AttributeName: 'Email', KeyType: 'HASH' },
          ],
          // Projection ALL: el login necesita devolver el user completo (Password
          // incluida para verificar bcrypt) sin un Get extra. La tabla es pequeña
          // (decenas-cientos de filas) así que el coste de almacenamiento es
          // despreciable.
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: desc.Table?.BillingModeSummary?.BillingMode === 'PAY_PER_REQUEST' ? undefined : { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      }],
    }));
    console.log(`[GSI] ${GSI_USUARIOS_EMAIL_NAME} creación iniciada. Estará activo en unos minutos. Usando Scan como fallback mientras tanto.`);
  } catch (err) {
    console.warn('[GSI] No se pudo crear/verificar el GSI Email-index:', err.message || err);
  }
}

/**
 * Busca usuarios por email exacto. El email debe venir ya normalizado
 * (`.trim().toLowerCase()`) por el caller — el guardado en `usuarios.js`
 * (POST/PUT) hace esa normalización al persistir.
 *
 * Devuelve un array porque la tabla no garantiza unicidad de Email a nivel
 * de schema (el caller en /login y reset-password ya manejan el caso "más de
 * un match" como error/warning).
 */
export async function findUsuarioByEmail(emailNorm) {
  if (!emailNorm) return [];
  if (gsiReady) {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: GSI_USUARIOS_EMAIL_NAME,
      KeyConditionExpression: '#Email = :email',
      ExpressionAttributeNames: { '#Email': 'Email' },
      ExpressionAttributeValues: { ':email': emailNorm },
    }));
    return r.Items || [];
  }
  // Fallback: mismo Scan que existía antes del GSI. Se usa solo durante los
  // minutos que tarda DynamoDB en activar el índice tras un primer arranque.
  const r = await docClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: '#Email = :email',
    ExpressionAttributeNames: { '#Email': 'Email' },
    ExpressionAttributeValues: { ':email': emailNorm },
  }));
  return r.Items || [];
}
