#!/usr/bin/env node
/**
 * Crea registros en Igp_Gestionfestivosyestimaciones desde 01/01/2025 hasta 01/01/2027.
 * PK = fecha (YYYY-MM-DD), SK = "0", un registro por día.
 * Uso: node api/scripts/seed-gestion-festivos.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_GESTION_FESTIVOS_TABLE || 'Igp_Gestionfestivosyestimaciones';
const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function run() {
  console.log('Tabla:', tableName);
  console.log('Creando registros desde 2025-01-01 hasta 2027-01-01...');

  const start = new Date('2025-01-01');
  const end = new Date('2027-01-01');
  let count = 0;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const fecha = formatDate(new Date(d));
    const item = {
      PK: fecha,
      SK: '0',
      FechaComparativa: fecha,
      Festivo: '',
      NombreFestivo: '',
    };
    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: item,
    }));
    count++;
    if (count % 100 === 0) console.log('  Progreso:', count, 'registros');
  }

  console.log('✓ Creados', count, 'registros.');
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
