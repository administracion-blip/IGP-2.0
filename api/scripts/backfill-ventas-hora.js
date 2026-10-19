#!/usr/bin/env node
/**
 * Rellena Igp_VentasHora con la venta por hora de Ágora para días cerrados.
 *
 * Uso:
 *   node api/scripts/backfill-ventas-hora.js --desde=2025-01-01 --hasta=2025-12-31 \
 *     [--workplaces=101,202] [--force] [--aplicar]
 *
 * - Por defecto es simulación: cuenta lo que ya está guardado y lo que pediría a Ágora.
 * - `--aplicar` pide a Ágora (concurrencia 2) y guarda. Salta los días ya guardados
 *   salvo `--force`.
 * - Sin `--workplaces`, todos los locales con agoraCode del maestro.
 * - Solo días anteriores a la jornada de negocio de hoy.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const { client, tables } = await import('../lib/db.js');
const { obtenerVentasHora } = await import('../lib/agora/ventasHoraStore.js');
const { workplacesConAgora, diasCerradosDelRango } = await import('../lib/agora/ventasHoraSync.js');
const { esFechaIso } = await import('../lib/prevision/franjas.js');
const { jornadaNegocioHoyIso } = await import('../lib/usuarioLocales.js');

const CONCURRENCIA = 2;
const DIAS_POR_TANDA = 7;

function argumento(nombre) {
  const pref = `--${nombre}=`;
  const a = process.argv.find((x) => x.startsWith(pref));
  return a ? a.slice(pref.length).trim() : '';
}

const desde = argumento('desde');
const hasta = argumento('hasta');
const workplacesArg = argumento('workplaces');
const force = process.argv.includes('--force');
const aplicar = process.argv.includes('--aplicar');

async function tablaExiste() {
  try {
    await client.send(new DescribeTableCommand({ TableName: tables.ventasHora }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function run() {
  if (!esFechaIso(desde) || !esFechaIso(hasta) || desde > hasta) {
    console.error('Uso: --desde=YYYY-MM-DD --hasta=YYYY-MM-DD [--workplaces=a,b] [--force] [--aplicar]');
    process.exit(1);
  }
  if (!(await tablaExiste())) {
    console.error(`La tabla ${tables.ventasHora} no existe. Créala con node api/scripts/create-ventas-hora-table.js`);
    process.exit(1);
  }

  const hoyJornada = jornadaNegocioHoyIso();
  const filtro = workplacesArg ? workplacesArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const { workplaces, desconocidos } = await workplacesConAgora(filtro);
  if (desconocidos.length) console.warn('Locales sin agoraCode en el maestro (se ignoran):', desconocidos.join(', '));
  const dias = diasCerradosDelRango(desde, hasta, hoyJornada);

  console.log(aplicar ? 'Modo APLICAR (pide a Ágora y escribe en DynamoDB)' : 'Modo simulación (no escribe). Usa --aplicar para escribir.');
  console.log(`Tabla: ${tables.ventasHora} · Días cerrados: ${dias.length} · Locales: ${workplaces.length}${force ? ' · force' : ''}\n`);

  const totales = { existentes: 0, traidos: 0, porTraer: 0, errores: 0 };
  for (let i = 0; i < dias.length; i += DIAS_POR_TANDA) {
    const tanda = dias.slice(i, i + DIAS_POR_TANDA);
    const pares = [];
    for (const workplaceId of workplaces) {
      for (const businessDay of tanda) pares.push({ workplaceId, businessDay });
    }
    const datos = await obtenerVentasHora(pares, {
      maxFetch: aplicar ? Infinity : 0,
      concurrencia: CONCURRENCIA,
      force,
      hoyJornada,
    });
    const t = { existentes: 0, traidos: 0, porTraer: 0, errores: 0 };
    for (const v of datos.values()) {
      if (v.error) t.errores += 1;
      else if (v.pendiente) t.porTraer += 1;
      else if (v.origen === 'agora') t.traidos += 1;
      else if (v.origen === 'tabla') t.existentes += 1;
    }
    for (const k of Object.keys(totales)) totales[k] += t[k];
    console.log(
      `  ${tanda[0]} → ${tanda[tanda.length - 1]}: guardados ${t.existentes}, `
        + (aplicar ? `traídos ${t.traidos}, errores ${t.errores}` : `por traer ${t.porTraer}`),
    );
  }

  console.log(
    `\nTotal: guardados ${totales.existentes}, `
      + (aplicar ? `traídos ${totales.traidos}, errores ${totales.errores}` : `por traer ${totales.porTraer}`),
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
