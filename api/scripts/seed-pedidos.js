#!/usr/bin/env node
/**
 * Inserta un pedido de ejemplo en Igp_Pedidos con todos los campos.
 * Uso: node api/scripts/seed-pedidos.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_PEDIDOS || 'Igp_Pedidos';
const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

async function run() {
  const fecha = new Date().toISOString().slice(0, 10);
  const año = fecha.slice(0, 4);
  const ahora = new Date().toISOString();

  const item = {
    Id: `PED-${año}-00001`,
    LocalId: '1',
    AlmacenOrigenId: '1',
    AlmacenDestinoId: '2',
    TotalAlbaran: 0,
    Fecha: fecha,
    Estado: 'Borrador',
    CreadoEn: ahora,
    CreadoPor: '1',
    Notas: 'Pedido de ejemplo',
  };

  console.log('Tabla:', tableName);
  console.log('Insertando pedido de ejemplo...');
  console.log('Item:', JSON.stringify(item, null, 2));

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );

  console.log('✓ Pedido creado correctamente (Id:', item.Id, ')');
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
