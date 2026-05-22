#!/usr/bin/env node
/**
 * Crea la tabla Igp_AgoraUsuarios en DynamoDB (PK, SK).
 * Uso: node api/scripts/create-agora-users-table.js
 *
 * Si la tabla ya existe, mostrará un mensaje y no hará nada.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_AGORA_USUARIOS_TABLE || 'Igp_AgoraUsuarios';
const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });

async function tableExists() {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function run() {
  console.log('Tabla:', tableName);
  console.log('Región:', region);
  console.log('');

  if (await tableExists()) {
    console.log('✓ La tabla ya existe. No se hace nada.');
    process.exit(0);
  }

  console.log('Creando tabla...');
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );

  console.log('✓ Tabla creada correctamente.');
  console.log('');
  console.log('Estructura: PK = "GLOBAL", SK = Id del usuario.');
  console.log('Sincroniza con: POST /api/agora/users/sync');
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
