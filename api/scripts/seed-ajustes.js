#!/usr/bin/env node
/**
 * Inserta registros iniciales en Igp_Ajustes (sincronizaciones).
 * Uso: node api/scripts/seed-ajustes.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_AJUSTES || 'Igp_Ajustes';
const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

const SYNC_ITEMS = [
  { SK: 'agora_productos', Nombre: 'Productos Agora', Descripcion: 'Sincroniza productos desde Agora' },
  { SK: 'compras_proveedor', Nombre: 'Compras a Proveedor', Descripcion: 'Importa albaranes de entrada desde Agora' },
  { SK: 'closeouts', Nombre: 'Cierres de Caja', Descripcion: 'Sincroniza cierres de caja desde Agora' },
  { SK: 'almacenes', Nombre: 'Almacenes', Descripcion: 'Sincroniza almacenes desde Agora' },
];

async function run() {
  console.log('Tabla:', tableName);
  console.log('Región:', region);
  console.log(`Insertando ${SYNC_ITEMS.length} registros de sincronización…\n`);

  for (const item of SYNC_ITEMS) {
    const record = {
      PK: 'sincronizaciones',
      SK: item.SK,
      Nombre: item.Nombre,
      Descripcion: item.Descripcion,
      UltimaSync: null,
      Estado: 'pendiente',
      Resultado: null,
      Enabled: false,
      Days: [],
      Times: [],
      FrequencyMinutes: null,
      StartTime: null,
      EndTime: null,
      updatedAt: new Date().toISOString(),
    };

    await docClient.send(new PutCommand({ TableName: tableName, Item: record }));
    console.log(`  ✓ ${item.Nombre} (PK=sincronizaciones, SK=${item.SK})`);
  }

  console.log('\nSeed completado.');
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
