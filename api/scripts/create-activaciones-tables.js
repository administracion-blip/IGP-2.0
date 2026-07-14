#!/usr/bin/env node
/**
 * Crea las tablas del módulo Activaciones de Marcas:
 *  - Igp_Activaciones (PK = id_activacion)
 *  - Igp_ActivacionSesiones (PK = id_sesion) con GSIs:
 *      · local-fecha-index (id_local, fecha) — sesiones de un local en una jornada
 *      · activacion-index (id_activacion) — sesiones de una activación
 * Uso: node scripts/create-activaciones-tables.js
 *
 * Si una tabla ya existe, se salta y no hace nada con ella.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableActivaciones = process.env.DDB_ACTIVACIONES || 'Igp_Activaciones';
const tableSesiones = process.env.DDB_ACTIVACION_SESIONES || 'Igp_ActivacionSesiones';
const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });

async function tableExists(tableName) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function crearActivaciones() {
  if (await tableExists(tableActivaciones)) {
    console.log(`✓ ${tableActivaciones} ya existe. No se hace nada.`);
    return;
  }
  console.log(`Creando ${tableActivaciones}…`);
  await client.send(
    new CreateTableCommand({
      TableName: tableActivaciones,
      AttributeDefinitions: [{ AttributeName: 'id_activacion', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id_activacion', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
  console.log(`✓ ${tableActivaciones} creada (PK = id_activacion).`);
}

async function crearSesiones() {
  if (await tableExists(tableSesiones)) {
    console.log(`✓ ${tableSesiones} ya existe. No se hace nada.`);
    return;
  }
  console.log(`Creando ${tableSesiones}…`);
  await client.send(
    new CreateTableCommand({
      TableName: tableSesiones,
      AttributeDefinitions: [
        { AttributeName: 'id_sesion', AttributeType: 'S' },
        { AttributeName: 'id_local', AttributeType: 'S' },
        { AttributeName: 'fecha', AttributeType: 'S' },
        { AttributeName: 'id_activacion', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'id_sesion', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'local-fecha-index',
          KeySchema: [
            { AttributeName: 'id_local', KeyType: 'HASH' },
            { AttributeName: 'fecha', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'activacion-index',
          KeySchema: [{ AttributeName: 'id_activacion', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
  console.log(`✓ ${tableSesiones} creada (PK = id_sesion, GSIs local-fecha-index y activacion-index).`);
}

async function run() {
  console.log('Región:', region);
  console.log('');
  await crearActivaciones();
  await crearSesiones();
  console.log('');
  console.log('Listo. Los GSIs pueden tardar unos minutos en estar ACTIVE.');
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
