import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

const tableAjustesName = tables.ajustes;

export const SYNC_CLOSEOUTS_INTERVAL_MS = parseInt(process.env.SYNC_CLOSEOUTS_INTERVAL_MS || '120000', 10) || 120000;
export const SYNC_CLOSEOUTS_RECENT_DAYS = parseInt(process.env.SYNC_CLOSEOUTS_RECENT_DAYS || '7', 10) || 7;
export const SYNC_CLOSEOUTS_ENABLED = process.env.SYNC_CLOSEOUTS_ENABLED === 'true';

export async function runCloseoutsSync(port) {
  if (!SYNC_CLOSEOUTS_ENABLED) return;
  const today = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - SYNC_CLOSEOUTS_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${baseUrl}/api/agora/closeouts/full-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateFrom, dateTo: today, deleteOutOfRange: false }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`[closeouts/sync] OK: ${dateFrom} → ${today} | upserted: ${data.totalUpserted ?? 0}`);
    } else {
      console.error('[closeouts/sync] Error:', data.error || res.statusText);
    }
  } catch (err) {
    console.error('[closeouts/sync]', err.message || err);
  }
}

export const SYNC_SCHEDULER_INTERVAL_MS = 60 * 1000;

const SYNC_ENDPOINTS = {
  agora_productos: { path: '/api/agora/products/sync', body: { force: true } },
  compras_proveedor: { path: '/api/agora/purchases/sync', body: {} },
  closeouts: { path: '/api/agora/closeouts/sync', body: {} },
  almacenes: { path: '/api/agora/warehouses/sync', body: {} },
};

const DAY_MAP = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
const syncLastRun = {};

export async function checkAutoSyncs(port) {
  try {
    const { Items = [] } = await docClient.send(new ScanCommand({
      TableName: tableAjustesName,
      FilterExpression: 'PK = :pk AND Enabled = :e',
      ExpressionAttributeValues: { ':pk': 'sincronizaciones', ':e': true },
    }));

    const now = new Date();
    const dayKey = DAY_MAP[now.getDay()];
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const item of Items) {
      const sk = item.SK;
      const ep = SYNC_ENDPOINTS[sk];
      if (!ep) continue;
      if (!Array.isArray(item.Days) || !item.Days.includes(dayKey)) continue;
      if (!Array.isArray(item.Times) || !item.Times.includes(hhmm)) continue;

      const runKey = `${sk}_${hhmm}`;
      const today = now.toISOString().slice(0, 10);
      if (syncLastRun[runKey] === today) continue;

      syncLastRun[runKey] = today;
      console.log(`[auto-sync] Ejecutando ${sk} (${hhmm})`);

      try {
        const r = await fetch(`http://127.0.0.1:${port}${ep.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
        });
        const d = await r.json();

        const resultado = d.ok ? 'OK' : (d.error || 'Error');
        await docClient.send(new UpdateCommand({
          TableName: tableAjustesName,
          Key: { PK: 'sincronizaciones', SK: sk },
          UpdateExpression: 'SET UltimaSync = :u, Estado = :e, Resultado = :r, updatedAt = :t',
          ExpressionAttributeValues: {
            ':u': now.toISOString(),
            ':e': d.ok ? 'ok' : 'error',
            ':r': resultado,
            ':t': new Date().toISOString(),
          },
        }));
        console.log(`[auto-sync] ${sk} → ${resultado}`);
      } catch (err) {
        console.error(`[auto-sync] ${sk} error:`, err.message || err);
      }
    }
  } catch (err) {
    console.error('[auto-sync] scheduler error:', err.message || err);
  }
}

export const VENCIMIENTOS_INTERVAL_MS = 60 * 60 * 1000;

export async function checkVencimientosFacturas(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/facturacion/check-vencimientos`, { method: 'POST' });
    const data = await res.json();
    if (data.actualizadas > 0) {
      console.log(`[vencimientos] ${data.actualizadas} factura(s) marcada(s) como vencida(s)`);
    }
  } catch (err) {
    console.error('[vencimientos]', err.message || err);
  }

  if (process.env.SMTP_USER) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/facturacion/enviar-recordatorios`, { method: 'POST' });
      const data = await res.json();
      if (data.enviados > 0) {
        console.log(`[recordatorios] ${data.enviados} recordatorio(s) de cobro enviado(s)`);
      }
    } catch (err) {
      console.error('[recordatorios]', err.message || err);
    }
  }
}
