import { ScanCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { internalSyncFetchHeaders } from '../internalSync.js';
import { logger } from '../logger.js';
import { INFORME_AJUSTE_PK, INFORME_AJUSTE_SK } from '../informes/informeDiario.js';

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
      headers: internalSyncFetchHeaders(),
      body: JSON.stringify({ dateFrom, dateTo: today, deleteOutOfRange: false }),
    });
    const data = await res.json();
    if (res.ok) {
      logger.info(
        { dateFrom, dateTo: today, upserted: data.totalUpserted ?? 0 },
        `[closeouts/sync] OK: ${dateFrom} → ${today} | upserted: ${data.totalUpserted ?? 0}`,
      );
    } else {
      logger.error(
        { status: res.status, error: data.error || res.statusText },
        '[closeouts/sync] Error',
      );
    }
  } catch (err) {
    logger.error({ err }, '[closeouts/sync]');
  }
}

export const SYNC_SCHEDULER_INTERVAL_MS = 60 * 1000;

const SYNC_ENDPOINTS = {
  agora_productos: { path: '/api/agora/products/sync', body: { force: true } },
  agora_usuarios: { path: '/api/agora/users/sync', body: { force: true } },
  compras_proveedor: { path: '/api/agora/purchases/sync', body: {} },
  closeouts: { path: '/api/agora/closeouts/sync', body: {} },
  ventas_producto: { path: '/api/agora/sales-lines/sync', body: {} },
  almacenes: { path: '/api/agora/warehouses/sync', body: {} },
  formas_pago: { path: '/api/agora/payment-methods/sync', body: {} },
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
      logger.info({ sk, hhmm }, `[auto-sync] Ejecutando ${sk} (${hhmm})`);

      try {
        const r = await fetch(`http://127.0.0.1:${port}${ep.path}`, {
          method: 'POST',
          headers: internalSyncFetchHeaders(),
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
        logger.info({ sk, resultado }, `[auto-sync] ${sk} → ${resultado}`);
      } catch (err) {
        logger.error({ err, sk }, `[auto-sync] ${sk} error`);
      }
    }
  } catch (err) {
    logger.error({ err }, '[auto-sync] scheduler error');
  }
}

const informeLastRun = {};

/**
 * Job del informe diario: revisa la config en Igp_Ajustes (PK='informes',
 * SK='informe_diario'); si está habilitada y coincide día/hora, dispara el envío
 * llamando al endpoint interno (mismo que usa el botón "Forzar envío").
 */
export async function checkInformeDiario(port) {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tableAjustesName,
      Key: { PK: INFORME_AJUSTE_PK, SK: INFORME_AJUSTE_SK },
    }));
    const item = r?.Item;
    if (!item || item.Enabled !== true) return;
    if (!Array.isArray(item.Days) || !Array.isArray(item.Times)) return;

    const now = new Date();
    const dayKey = DAY_MAP[now.getDay()];
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (!item.Days.includes(dayKey) || !item.Times.includes(hhmm)) return;

    const today = now.toISOString().slice(0, 10);
    const runKey = `informe_${hhmm}`;
    if (informeLastRun[runKey] === today) return;
    informeLastRun[runKey] = today;

    logger.info({ hhmm }, `[informe-diario] Ejecutando envío (${hhmm})`);
    const res = await fetch(`http://127.0.0.1:${port}/api/informes/diario/enviar`, {
      method: 'POST',
      headers: internalSyncFetchHeaders(),
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      logger.info({ enviados: data.enviados ?? 0, total: data.total ?? 0 }, `[informe-diario] OK: ${data.enviados ?? 0}/${data.total ?? 0}`);
    } else {
      logger.error({ status: res.status, error: data.error }, '[informe-diario] Error en envío');
    }
  } catch (err) {
    logger.error({ err }, '[informe-diario] scheduler error');
  }
}

export const VENCIMIENTOS_INTERVAL_MS = 60 * 60 * 1000;

/** Sync nocturno de ventas por producto (día anterior). */
export const SYNC_SALES_LINES_ENABLED = process.env.SYNC_SALES_LINES_ENABLED !== 'false';

export async function runSalesLinesSync(port) {
  if (!SYNC_SALES_LINES_ENABLED) return;
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${baseUrl}/api/agora/sales-lines/sync`, {
      method: 'POST',
      headers: internalSyncFetchHeaders(),
      body: JSON.stringify({ businessDay: yesterday, force: true }),
    });
    const data = await res.json();
    if (res.ok) {
      logger.info(
        { businessDay: yesterday, items: data.items ?? 0, locales: data.locales ?? 0 },
        `[sales-lines/sync] OK: ${yesterday} | items: ${data.items ?? 0}`,
      );
    } else {
      logger.error(
        { status: res.status, error: data.error || res.statusText },
        '[sales-lines/sync] Error',
      );
    }
  } catch (err) {
    logger.error({ err }, '[sales-lines/sync]');
  }
}

/**
 * Resync semanal de ventas por producto.
 * Se ejecuta en la madrugada del lunes y recopia la semana anterior completa
 * (lunes anterior → domingo) desde Ágora vía full-sync (idempotente: borra y
 * reescribe cada día, sin duplicar). Sirve de red de seguridad frente a fallos
 * puntuales del sync nocturno y anulaciones tardías.
 */
export const SYNC_SALES_LINES_WEEKLY_ENABLED =
  process.env.SYNC_SALES_LINES_WEEKLY_ENABLED !== 'false';
export const SYNC_SALES_LINES_WEEKLY_HOUR =
  parseInt(process.env.SYNC_SALES_LINES_WEEKLY_HOUR || '5', 10) || 5;

let weeklyResyncLastRun = null;

export async function checkWeeklySalesLinesResync(port) {
  if (!SYNC_SALES_LINES_WEEKLY_ENABLED) return;

  const now = new Date();
  // 1 = lunes (madrugada de domingo a lunes)
  if (now.getDay() !== 1) return;
  if (now.getHours() !== SYNC_SALES_LINES_WEEKLY_HOUR) return;

  const today = now.toISOString().slice(0, 10);
  if (weeklyResyncLastRun === today) return;
  weeklyResyncLastRun = today;

  // Semana anterior completa: lunes anterior (hoy - 7 días) → ayer (domingo).
  const fechaInicio = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const fechaFin = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const baseUrl = `http://127.0.0.1:${port}`;
  logger.info(
    { fechaInicio, fechaFin },
    `[sales-lines/weekly-resync] Iniciando resync semanal ${fechaInicio} → ${fechaFin}`,
  );
  try {
    const res = await fetch(`${baseUrl}/api/agora/sales-lines/full-sync`, {
      method: 'POST',
      headers: internalSyncFetchHeaders(),
      body: JSON.stringify({ fechaInicio, fechaFin }),
    });
    const data = await res.json();
    if (res.ok) {
      logger.info(
        {
          fechaInicio,
          fechaFin,
          daysProcessed: data.daysProcessed ?? 0,
          totalItems: data.totalItems ?? 0,
          errors: data.errors?.length ?? 0,
        },
        `[sales-lines/weekly-resync] OK: ${fechaInicio} → ${fechaFin} | items: ${data.totalItems ?? 0}`,
      );
    } else {
      logger.error(
        { status: res.status, error: data.error || res.statusText },
        '[sales-lines/weekly-resync] Error',
      );
    }
  } catch (err) {
    logger.error({ err }, '[sales-lines/weekly-resync]');
  }
}

export async function checkVencimientosFacturas(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/facturacion/check-vencimientos`, {
      method: 'POST',
      headers: internalSyncFetchHeaders(),
    });
    const data = await res.json();
    if (data.actualizadas > 0) {
      logger.info(
        { actualizadas: data.actualizadas },
        `[vencimientos] ${data.actualizadas} factura(s) marcada(s) como vencida(s)`,
      );
    }
  } catch (err) {
    logger.error({ err }, '[vencimientos]');
  }

  if (process.env.SMTP_USER) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/facturacion/enviar-recordatorios`, {
        method: 'POST',
        headers: internalSyncFetchHeaders(),
      });
      const data = await res.json();
      if (data.enviados > 0) {
        logger.info(
          { enviados: data.enviados },
          `[recordatorios] ${data.enviados} recordatorio(s) de cobro enviado(s)`,
        );
      }
    } catch (err) {
      logger.error({ err }, '[recordatorios]');
    }
  }
}
