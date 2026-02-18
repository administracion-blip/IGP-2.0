#!/usr/bin/env node
/**
 * Debug: muestra la estructura cruda de un cierre de Ágora.
 * Uso: node scripts/debug-agora-closeout.js [YYYY-MM-DD]
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exportPosCloseOuts, exportSystemCloseOuts } from '../lib/agora/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const businessDay = process.argv[2] || new Date().toISOString().slice(0, 10);

function extractArray(data, keys) {
  if (!data) return [];
  const unwrap = (d) => d?.Data ?? d?.data ?? d?.Result ?? d?.result ?? d?.Export ?? d?.export ?? d;
  let cur = unwrap(data);
  const k = Array.isArray(keys) ? keys : [keys];
  for (const key of k) {
    const v = cur?.[key];
    if (Array.isArray(v)) return v;
    if (v?.Items) return v.Items;
    if (v?.items) return v.items;
  }
  if (Array.isArray(cur)) return cur;
  return [];
}

async function run() {
  console.log('Consultando Ágora business-day:', businessDay);
  let rawList = [];
  let usePos = false;
  const [posData, sysData] = await Promise.all([
    exportPosCloseOuts(businessDay).catch((e) => ({ _err: e })),
    exportSystemCloseOuts(businessDay).catch((e) => ({ _err: e })),
  ]);

  const posList = !posData?._err ? extractArray(posData, ['PosCloseOuts', 'PosCloseouts', 'posCloseOuts']) : [];
  const sysList = !sysData?._err ? extractArray(sysData, ['SystemCloseOuts', 'SystemCloseouts', 'systemCloseOuts']) : [];
  if (posList.length > 0) {
    rawList = posList;
    usePos = true;
    const sysHasPayments = sysList.some((r) => Array.isArray(r?.InvoicePayments ?? r?.invoicePayments) && (r.InvoicePayments ?? r.invoicePayments).length > 0);
    console.log('Usando PosCloseOuts (TPV, PosId)' + (sysHasPayments ? ' + SystemCloseOuts (desglose pagos)' : ''));
  } else if (sysList.length > 0) {
    rawList = sysList;
    usePos = false;
    console.log('Usando SystemCloseOuts (sin PosId)');
  }

  if (rawList.length > 0 && process.argv.includes('--raw')) {
    console.log('\n--- Respuesta cruda completa del API (primeros 3000 chars) ---\n');
    const src = usePos ? posData : sysData;
    console.log(JSON.stringify(src, null, 2).slice(0, 3000) + '...');
  }

  if (rawList.length === 0) {
    console.log('Sin cierres. Probando día anterior...');
    const prevDay = new Date(businessDay + 'T12:00:00');
    prevDay.setDate(prevDay.getDate() - 1);
    const prev = prevDay.toISOString().slice(0, 10);
    const [p2, s2] = await Promise.all([
      exportPosCloseOuts(prev).catch(() => ({ _err: true })),
      exportSystemCloseOuts(prev).catch(() => ({ _err: true })),
    ]);
    rawList = extractArray(p2?._err ? s2 : p2, ['PosCloseOuts', 'PosCloseouts', 'posCloseOuts', 'SystemCloseOuts', 'SystemCloseouts', 'systemCloseOuts']);
  }

  if (rawList.length > 0) {
    console.log('\n--- Primer registro crudo (estructura completa) ---\n');
    console.log(JSON.stringify(rawList[0], null, 2));
    const withMultipleBalances = rawList.find((r) => (r.Balances ?? r.balances ?? []).length > 1);
    if (withMultipleBalances) {
      console.log('\n--- Registro con múltiples Balances ---\n');
      console.log(JSON.stringify(withMultipleBalances, null, 2));
    }
    const withNonZero = rawList.find((r) =>
      (r.Balances ?? r.balances ?? []).some((b) => (b?.ActualEndAmount ?? b?.actualEndAmount ?? 0) > 0)
    );
    if (withNonZero) {
      console.log('\n--- Registro con importes > 0 en Balances ---\n');
      console.log(JSON.stringify(withNonZero, null, 2));
    }
    console.log('\n--- Resumen: total registros =', rawList.length);
    console.log('Balances por registro:', rawList.map((r) => (r.Balances ?? r.balances ?? []).length));
  } else {
    console.log('No hay datos de cierres. Revisa AGORA_BASE_URL y AGORA_API_TOKEN.');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
