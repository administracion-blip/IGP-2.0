#!/usr/bin/env node
/**
 * Borra filas en pedidosLineas cuyo PedidoId no existe en la tabla pedidos
 * (líneas huérfanas tras borrar pedidos sin cascada).
 *
 * Uso (desde la carpeta api):
 *   node scripts/cleanup-pedidos-lineas-huerfanas.js --dry-run
 *   node scripts/cleanup-pedidos-lineas-huerfanas.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');

function lineaKey(linea) {
  const pid = String(linea.PedidoId ?? '').trim();
  const li = linea.LineaIndex != null ? String(linea.LineaIndex).trim() : '';
  if (!pid || !li) return null;
  return { PedidoId: pid, LineaIndex: li };
}

async function scanPedidoIds() {
  const set = new Set();
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.pedidos,
        ProjectionExpression: 'Id',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    for (const p of r.Items || []) {
      const id = String(p.Id ?? '').trim();
      if (id) set.add(id);
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return set;
}

async function main() {
  console.log('Tablas:', tables.pedidos, '→', tables.pedidosLineas);
  if (dryRun) {
    console.log('Modo --dry-run: no se borrará nada.\n');
  }

  const pedidoIds = await scanPedidoIds();
  console.log('Pedidos existentes:', pedidoIds.size);

  const toDelete = [];
  let scanned = 0;
  let lastKey = null;
  do {
    const r = await docClient.send(
      new ScanCommand({
        TableName: tables.pedidosLineas,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    for (const linea of r.Items || []) {
      scanned++;
      const pid = String(linea.PedidoId ?? '').trim();
      if (!pid || pedidoIds.has(pid)) continue;
      const key = lineaKey(linea);
      if (key) toDelete.push(key);
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  console.log('Líneas escaneadas:', scanned);
  console.log('Huérfanas a borrar:', toDelete.length);

  if (toDelete.length === 0) {
    console.log('Nada que hacer.');
    return;
  }

  if (dryRun) {
    const max = 100;
    for (let i = 0; i < Math.min(toDelete.length, max); i++) {
      console.log('  [dry-run]', toDelete[i]);
    }
    if (toDelete.length > max) {
      console.log(`  ... y ${toDelete.length - max} más`);
    }
    return;
  }

  let ok = 0;
  for (const key of toDelete) {
    await docClient.send(
      new DeleteCommand({
        TableName: tables.pedidosLineas,
        Key: key,
      })
    );
    ok++;
    if (ok % 50 === 0) {
      process.stdout.write(`\rBorradas ${ok}/${toDelete.length}`);
    }
  }
  console.log(`\nBorradas ${ok} línea(s) huérfana(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
