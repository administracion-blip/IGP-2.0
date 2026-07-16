#!/usr/bin/env node
/**
 * Crea la tabla Igp_Cashflow (movimientos de efectivo fuera de TPV).
 * PK = LOCAL#<id_Locales> · SK = FECHA#<YYYY-MM-DD>#<movimientoId>
 * GSI: EmpresaId-Fecha-index, MovimientoId-index
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_CASHFLOW_TABLE || 'Igp_Cashflow';
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
        { AttributeName: 'empresaId', AttributeType: 'S' },
        { AttributeName: 'fecha', AttributeType: 'S' },
        { AttributeName: 'movimientoId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'EmpresaId-Fecha-index',
          KeySchema: [
            { AttributeName: 'empresaId', KeyType: 'HASH' },
            { AttributeName: 'fecha', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'MovimientoId-index',
          KeySchema: [{ AttributeName: 'movimientoId', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  console.log(`✓ Tabla ${tableName} creada.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
