#!/usr/bin/env node
/**
 * Script para ejecutar la sincronización completa de cierres desde Ágora a Igp_SalesCloseouts.
 * Rango por defecto: 2025-01-01 hasta hoy (todas las columnas).
 * Uso: node scripts/full-sync-closeouts.js [dateFrom] [dateTo]
 * Ejemplo: node scripts/full-sync-closeouts.js 2025-01-01
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const API_URL = process.env.API_URL || 'http://127.0.0.1:3002';
const today = new Date().toISOString().slice(0, 10);
const dateFrom = process.argv[2] || '2025-01-01';
const dateTo = process.argv[3] || today;

async function run() {
  console.log('Iniciando sincronización completa de cierres...');
  console.log('Rango:', dateFrom, 'a', dateTo);
  console.log('API:', API_URL);

  const res = await fetch(`${API_URL}/api/agora/closeouts/full-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom, dateTo, deleteOutOfRange: true }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('Error:', data.error || res.statusText);
    process.exit(1);
  }

  console.log('Resultado:', JSON.stringify(data, null, 2));
  console.log('Completado.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
