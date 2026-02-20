#!/usr/bin/env node
/**
 * Guarda la respuesta cruda de Ágora PosCloseOuts y SystemCloseOuts en JSON.
 * Uso: node scripts/dump-agora-raw.js [YYYY-MM-DD]
 * Ejemplo: node scripts/dump-agora-raw.js 2026-02-13
 * 
 * Genera: api/agora-raw-YYYY-MM-DD.json
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';
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
  const [posData, sysData] = await Promise.all([
    exportPosCloseOuts(businessDay).catch((e) => ({ _err: String(e?.message || e) })),
    exportSystemCloseOuts(businessDay).catch((e) => ({ _err: String(e?.message || e) })),
  ]);

  const posList = !posData?._err ? extractArray(posData, ['PosCloseOuts', 'PosCloseouts', 'posCloseOuts']) : [];
  const sysList = !sysData?._err ? extractArray(sysData, ['SystemCloseOuts', 'SystemCloseouts', 'systemCloseOuts']) : [];

  const speakeasyPos = posList.filter((r) =>
    /SPEAKEASY/i.test(String(r?.PosName ?? r?.posName ?? r?.PointOfSale?.Name ?? ''))
  );
  const speakeasySys = sysList.filter((r) =>
    /SPEAKEASY/i.test(String(r?.WorkplaceName ?? r?.workplaceName ?? ''))
  );

  const output = {
    businessDay,
    posCloseOuts: { raw: posData, list: posList, speakeasy: speakeasyPos },
    systemCloseOuts: { raw: sysData, list: sysList, speakeasy: speakeasySys },
  };

  const outPath = join(__dirname, '..', `agora-raw-${businessDay}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log('Guardado en:', outPath);
  console.log('PosCloseOuts SPEAKEASY:', speakeasyPos.length, 'registros');
  if (speakeasyPos.length > 0) {
    console.log('\n--- Estructura primer SPEAKEASY PosCloseOut ---');
    console.log(JSON.stringify(speakeasyPos[0], null, 2).slice(0, 3000));
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
