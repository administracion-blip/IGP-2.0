#!/usr/bin/env node
/**
 * Crea la tabla Igp_Notificaciones (campana Fase 3).
 * PK = USER#<id_usuario> · SK = NOTIF#<iso>#<uuid>
 * GSI disperso: NoLeidas-index (HASH usuario_no_leida, RANGE creado_en, KEYS_ONLY)
 * TTL en atributo `ttl` (epoch).
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_NOTIFICACIONES || 'Igp_Notificaciones';
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

async function main() {
  if (await tableExists()) {
    console.log(`✓ ${tableName} ya existe. No se hace nada.`);
    return;
  }
  console.log(`Creando ${tableName}…`);
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'usuario_no_leida', AttributeType: 'S' },
        { AttributeName: 'creado_en', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'NoLeidas-index',
          KeySchema: [
            { AttributeName: 'usuario_no_leida', KeyType: 'HASH' },
            { AttributeName: 'creado_en', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  console.log(`✓ Tabla ${tableName} creada.`);
  console.log('  Activa TTL en la consola AWS sobre el atributo `ttl` (epoch segundos).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
