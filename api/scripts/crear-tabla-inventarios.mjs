#!/usr/bin/env node
/**
 * Definición de Igp_Inventarios. Por defecto no llama a AWS: imprime la tabla.
 * Para crearla: node api/scripts/crear-tabla-inventarios.mjs --aplicar
 *
 * Claves:
 *   PK (S) HASH
 *   SK (S) RANGE
 *   GSI WarehouseId-Clave-index — HASH WarehouseId (S), RANGE Clave (S), proyección ALL
 *
 * PK = PLANTILLA#<id> | INV#<id>
 * SK = META | FAMILIA#<id> | PRODUCTO#<id> | LINE#<productId>
 * Clave (solo META) = PLANTILLA#<id> | INV#<fecha>#<id>
 */

import { pathToFileURL } from 'url';
import path from 'path';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';

export const NOMBRE_TABLA_INVENTARIOS = 'Igp_Inventarios';

export const DEFINICION_TABLA_INVENTARIOS = {
  TableName: NOMBRE_TABLA_INVENTARIOS,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'WarehouseId', AttributeType: 'S' },
    { AttributeName: 'Clave', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'WarehouseId-Clave-index',
      KeySchema: [
        { AttributeName: 'WarehouseId', KeyType: 'HASH' },
        { AttributeName: 'Clave', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
  ],
};

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  if (!aplicar) {
    console.log(JSON.stringify(DEFINICION_TABLA_INVENTARIOS, null, 2));
    console.log('\nSin --aplicar no se crea nada.');
    return;
  }
  const { client } = await import('../lib/db.js');
  await client.send(new CreateTableCommand(DEFINICION_TABLA_INVENTARIOS));
  console.log(`Tabla creada: ${NOMBRE_TABLA_INVENTARIOS}`);
}

const entrada = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entrada && entrada === import.meta.url) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
}
