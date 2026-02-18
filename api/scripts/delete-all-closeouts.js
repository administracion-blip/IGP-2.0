#!/usr/bin/env node
/**
 * Borra TODOS los registros de la tabla Igp_SalesCloseouts en DynamoDB.
 * Uso: node scripts/delete-all-closeouts.js
 * Requiere confirmación: pasar --yes para ejecutar sin preguntar.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'node:readline';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const tableName = process.env.DDB_SALES_CLOSEOUTS_TABLE || 'Igp_SalesCloseouts';
const region = process.env.AWS_REGION || 'eu-west-1';

const client = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(client);

function confirm(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, (ans) => {
      rl.close();
      resolve(/^s|si|y|yes$/i.test(ans?.trim() || ''));
    });
  });
}

async function run() {
  const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

  console.log('Tabla:', tableName);
  console.log('Región:', region);
  console.log('');
  console.log('⚠️  ATENCIÓN: Se borrarán TODOS los registros de Igp_SalesCloseouts.');
  console.log('');

  if (!skipConfirm) {
    const ok = await confirm('¿Continuar? (s/n): ');
    if (!ok) {
      console.log('Cancelado.');
      process.exit(0);
    }
  }

  const keys = [];
  let lastKey = null;

  console.log('Escaneando tabla...');
  do {
    const res = await docClient.send(new ScanCommand({
      TableName: tableName,
      ProjectionExpression: 'PK, SK',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const item of res.Items || []) {
      if (item.PK != null && item.SK != null) {
        keys.push({ PK: item.PK, SK: item.SK });
      }
    }
    lastKey = res.LastEvaluatedKey || null;
    if (keys.length > 0 && keys.length % 500 === 0) {
      process.stdout.write(`\rEncontrados: ${keys.length}...`);
    }
  } while (lastKey);

  console.log(`\nTotal registros a borrar: ${keys.length}`);

  if (keys.length === 0) {
    console.log('La tabla está vacía. Nada que borrar.');
    process.exit(0);
  }

  let deleted = 0;
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    let req = {
      RequestItems: {
        [tableName]: chunk.map((k) => ({ DeleteRequest: { Key: k } })),
      },
    };
    let unprocessed;
    do {
      const res = await docClient.send(new BatchWriteCommand(req));
      unprocessed = res.UnprocessedItems?.[tableName];
      if (unprocessed?.length) {
        req = { RequestItems: { [tableName]: unprocessed } };
        await new Promise((r) => setTimeout(r, 200));
      } else {
        deleted += chunk.length;
      }
    } while (unprocessed?.length);

    if ((i + chunk.length) % 250 === 0 || i + chunk.length >= keys.length) {
      process.stdout.write(`\rBorrados: ${deleted}/${keys.length}`);
    }
  }

  console.log(`\nCompletado. ${deleted} registros borrados.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
