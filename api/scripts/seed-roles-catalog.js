#!/usr/bin/env node
/**
 * Registra en catálogo (SK=META) los roles iniciales del sistema.
 * Uso: node api/scripts/seed-roles-catalog.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { seedRolesCatalogoInicial } from '../lib/roles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

async function run() {
  console.log('Sembrando catálogo de roles (META)…\n');
  const resultados = await seedRolesCatalogoInicial();
  for (const r of resultados) {
    console.log(`  ${r.nombre}: ${r.accion}`);
  }
  console.log('\nListo.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
