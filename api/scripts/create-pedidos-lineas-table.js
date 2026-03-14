#!/usr/bin/env node
/**
 * Crea la tabla Igp_PedidosLineas en DynamoDB (PK=PedidoId, SK=LineaIndex).
 * Uso: node scripts/create-pedidos-lineas-table.js
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

const tableName = process.env.DDB_PEDIDOS_LINEAS || 'Igp_PedidosLineas';
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
        { AttributeName: 'PedidoId', AttributeType: 'S' },
        { AttributeName: 'LineaIndex', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PedidoId', KeyType: 'HASH' },
        { AttributeName: 'LineaIndex', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );

  console.log('✓ Tabla creada correctamente.');
  console.log('');
  console.log('Estructura: PK = PedidoId, SK = LineaIndex (0, 1, 2...)');
  console.log('Atributos: ProductId, ProductoNombre, Cantidad, PrecioUnitario, TotalLinea');
  console.log('Opcionales: PurchaseUnitId, PurchaseUnitName, Notas');
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
