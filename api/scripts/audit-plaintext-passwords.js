#!/usr/bin/env node
/**
 * [SEC S-10] Auditoría de contraseñas en claro (o no-bcrypt) en igp_usuarios.
 *
 * Escanea DynamoDB y lista solo id_usuario + email de usuarios cuya Password
 * NO es un hash bcrypt. NUNCA imprime el valor de Password.
 *
 * Uso (desde api/ o raíz del repo):
 *   node api/scripts/audit-plaintext-passwords.js
 *   node scripts/audit-plaintext-passwords.js
 *
 * Carga variables desde api/.env.local y api/.env si existen.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isBcryptHash } from '../lib/password.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const TABLE = process.env.DDB_USUARIOS || process.env.DYNAMODB_TABLE || 'igp_usuarios';
const REGION = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

async function scanUsuarios() {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: 'id_usuario, Email, #Password',
      ExpressionAttributeNames: { '#Password': 'Password' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function run() {
  console.log('[SEC S-10] Auditoría passwords plaintext / no-bcrypt');
  console.log('Tabla:', TABLE);
  console.log('Región:', REGION);
  console.log('');

  const items = await scanUsuarios();
  const legacy = [];

  for (const u of items) {
    const stored = u.Password ?? '';
    if (!isBcryptHash(stored)) {
      legacy.push({
        id_usuario: u.id_usuario ?? '',
        email: u.Email ?? '',
      });
    }
  }

  console.log(`Total usuarios: ${items.length}`);
  console.log(`Sin hash bcrypt (legacy / vacío / otro): ${legacy.length}`);
  console.log('');

  if (legacy.length === 0) {
    console.log('Ningún usuario con password no-bcrypt.');
    return;
  }

  console.log('id_usuario\temail');
  for (const row of legacy) {
    console.log(`${row.id_usuario}\t${row.email}`);
  }
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
