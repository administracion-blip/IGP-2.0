#!/usr/bin/env node
/**
 * Crea la tabla Igp_VentasProducto en DynamoDB.
 * Uso: node api/scripts/create-ventas-producto-table.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_VENTAS_PRODUCTO_TABLE || 'Igp_VentasProducto';
const region = process.env.AWS_REGION || 'eu-west-3';
const GSI_NAME = 'ProductId-Fecha-index';

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
        { AttributeName: 'ProductId', AttributeType: 'S' },
        { AttributeName: 'Fecha', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: GSI_NAME,
          KeySchema: [
            { AttributeName: 'ProductId', KeyType: 'HASH' },
            { AttributeName: 'Fecha', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );

  console.log('✓ Tabla creada correctamente.');
  console.log('');
  console.log('PK = LOCAL#<localId>');
  console.log('SK = DIA#<YYYY-MM-DD>#PROD#<productId>#USER#<agoraUserId>');
  console.log(`GSI = ${GSI_NAME} (ProductId, Fecha)`);
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
