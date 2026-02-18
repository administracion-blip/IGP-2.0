#!/usr/bin/env node
/**
 * Sincroniza cierres de Ágora a Igp_SalesCloseouts cada 120 segundos.
 * En cada ciclo sincroniza los últimos N días (por defecto 7) para mantener datos actualizados.
 * Opcionalmente ejecuta una sincronización completa al iniciar.
 *
 * Uso: node scripts/sync-closeouts-interval.js
 * Variables de entorno:
 *   API_URL: URL del API (default: http://127.0.0.1:3002)
 *   INTERVAL_SECONDS: segundos entre sincronizaciones (default: 120)
 *   RECENT_DAYS: días recientes a sincronizar en cada ciclo (default: 7)
 *   RUN_FULL_INIT: si es "true", ejecuta full-sync 2025-01-01 hasta hoy al iniciar
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const API_URL = process.env.API_URL || 'http://127.0.0.1:3002';
const INTERVAL_SECONDS = parseInt(process.env.INTERVAL_SECONDS || '120', 10) || 120;
const RECENT_DAYS = parseInt(process.env.RECENT_DAYS || '7', 10) || 7;
const RUN_FULL_INIT = /^(true|1|yes)$/i.test(process.env.RUN_FULL_INIT || '');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function syncRange(dateFrom, dateTo) {
  const res = await fetch(`${API_URL}/api/agora/closeouts/full-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateFrom,
      dateTo,
      deleteOutOfRange: false,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  }
  return data;
}

async function runSync() {
  const dateTo = today();
  const dateFrom = addDays(dateTo, -RECENT_DAYS);
  const start = Date.now();
  try {
    const result = await syncRange(dateFrom, dateTo);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[${new Date().toISOString()}] Sync OK: ${dateFrom} → ${dateTo} | ` +
      `upserted: ${result.totalUpserted ?? 0} | ${elapsed}s`
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Sync ERROR:`, err.message);
  }
}

async function runFullInit() {
  console.log('Ejecutando sincronización completa inicial (2025-01-01 hasta hoy)...');
  const dateTo = today();
  const start = Date.now();
  try {
    const result = await syncRange('2025-01-01', dateTo);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `Full sync inicial completado: ${result.totalUpserted ?? 0} registros | ${elapsed}s`
    );
  } catch (err) {
    console.error('Error en full sync inicial:', err.message);
    process.exit(1);
  }
}

async function main() {
  console.log('=== Sincronización periódica de cierres Ágora → Igp_SalesCloseouts ===');
  console.log('API:', API_URL);
  console.log('Intervalo:', INTERVAL_SECONDS, 'segundos');
  console.log('Días recientes por ciclo:', RECENT_DAYS);
  console.log('');

  if (RUN_FULL_INIT) {
    await runFullInit();
    console.log('');
  }

  console.log(`Sincronizando cada ${INTERVAL_SECONDS}s (últimos ${RECENT_DAYS} días)...`);
  console.log('Ctrl+C para detener.');
  console.log('');

  await runSync();

  setInterval(runSync, INTERVAL_SECONDS * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
