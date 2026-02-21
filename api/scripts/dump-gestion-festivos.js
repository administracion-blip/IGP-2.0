#!/usr/bin/env node
/**
 * Dump estructura de la tabla Igp_Gestionfestivosyestimaciones.
 * Muestra los campos que existen en los registros.
 * Uso: node api/scripts/dump-gestion-festivos.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_GESTION_FESTIVOS_TABLE || 'Igp_Gestionfestivosyestimaciones';
const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

async function run() {
  console.log('Tabla:', tableName);
  console.log('');

  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tableName,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  if (items.length === 0) {
    console.log('La tabla está vacía. Campos definidos en la API: Fecha, EsFestivo, Descripcion, EstimacionVentas, Observaciones');
    process.exit(0);
  }

  const allKeys = new Set();
  for (const item of items) {
    for (const k of Object.keys(item)) allKeys.add(k);
  }

  console.log('Campos encontrados en DynamoDB:', [...allKeys].sort().join(', '));
  console.log('');
  console.log('Ejemplo primer registro:');
  console.log(JSON.stringify(items[0], null, 2));
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
