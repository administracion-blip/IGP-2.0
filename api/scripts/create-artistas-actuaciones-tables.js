#!/usr/bin/env node
/**
 * Crea Igp_Artistas (PK id_artista) e Igp_Actuaciones (PK id_actuacion).
 * Uso: node api/scripts/create-artistas-actuaciones-tables.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const region = process.env.AWS_REGION || 'eu-west-3';
const client = new DynamoDBClient({ region });

const tableArtistas = process.env.DDB_ARTISTAS || 'Igp_Artistas';
const tableActuaciones = process.env.DDB_ACTUACIONES || 'Igp_Actuaciones';

async function exists(name) {
  try {
    await client.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return false;
    throw e;
  }
}

async function createSimple(name, pkName) {
  if (await exists(name)) {
    console.log(`✓ ${name} ya existe.`);
    return;
  }
  console.log(`Creando ${name}…`);
  await client.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [{ AttributeName: pkName, AttributeType: 'S' }],
      KeySchema: [{ AttributeName: pkName, KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
  console.log(`✓ ${name} creada.`);
}

async function run() {
  console.log('Región:', region);
  await createSimple(tableArtistas, 'id_artista');
  await createSimple(tableActuaciones, 'id_actuacion');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
