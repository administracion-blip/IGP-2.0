#!/usr/bin/env node
/**
 * Crea la tabla Igp_Remesas (PK = remesaId).
 * Uso: node scripts/create-remesas-table.js
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_REMESAS_TABLE || 'Igp_Remesas';
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
      AttributeDefinitions: [{ AttributeName: 'remesaId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'remesaId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  console.log(`✓ Tabla ${tableName} creada.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
