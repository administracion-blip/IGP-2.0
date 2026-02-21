#!/usr/bin/env node
/**
 * Obtiene la respuesta cruda de Ágora export-master Warehouses para ver los campos.
 * Uso: node scripts/dump-agora-warehouses.js
 * Genera: api/agora-warehouses-raw.json
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const baseUrl = (process.env.AGORA_BASE_URL || process.env.AGORA_API_BASE_URL || '').replace(/\/$/, '');
const token = process.env.AGORA_API_TOKEN || '';

async function run() {
  if (!baseUrl || !token) {
    console.error('Faltan AGORA_API_BASE_URL o AGORA_API_TOKEN en .env.local');
    process.exit(1);
  }

  const url = `${baseUrl}/api/export-master/?filter=Warehouses`;
  console.log('Consultando:', url);

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Api-Token': token, Accept: 'application/json' },
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.error('La respuesta no es JSON. Primeros 500 chars:', rawText.slice(0, 500));
    process.exit(1);
  }

  const warehouses = data.Warehouses ?? data.warehouses ?? data.Warehouse ?? data.warehouse ?? [];
  const list = Array.isArray(warehouses) ? warehouses : (warehouses?.Items ?? warehouses?.items ?? []);

  console.log('Top-level keys:', Object.keys(data));
  console.log('Registros Warehouses:', list.length);

  if (list.length > 0) {
    const first = list[0];
    console.log('\n--- Campos del primer registro ---');
    console.log(Object.keys(first));
    console.log('\n--- Primer registro completo ---');
    console.log(JSON.stringify(first, null, 2));
  }

  const outPath = join(__dirname, '..', 'agora-warehouses-raw.json');
  writeFileSync(outPath, JSON.stringify({ raw: data, list }, null, 2), 'utf8');
  console.log('\nGuardado en:', outPath);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
