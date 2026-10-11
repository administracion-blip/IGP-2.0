#!/usr/bin/env node
/**
 * Corrige en igp_usuarios el nombre de local mal escrito 'DISTRIBUIIDORA' en el
 * array `Local`, sustituyéndolo por el nombre exacto del local de igp_Locales cuyo
 * nombre normalizado es 'DISTRIBUIDORA'. Con el alcance por local, un nombre que
 * no está en el maestro no da acceso a ese local.
 *
 * Por defecto solo muestra lo que haría. Para escribir: --aplicar
 * Uso: node api/scripts/corregir-nombre-distribuidora.js [--aplicar]
 *
 * Cada escritura va condicionada a que `Local` siga igual que al leerlo.
 * Si la API está arrancada, el cambio se ve como mucho en un minuto (caché de acceso).
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const { docClient, tables } = await import('../lib/db.js');
const { maestroLocales } = await import('../lib/alcance.js');

const MAL_ESCRITO = 'distribuiidora';
const BUSCADO = 'distribuidora';

const aplicar = process.argv.includes('--aplicar');
const norm = (v) => String(v ?? '').trim().toLowerCase();

async function usuarios() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.usuarios,
      ProjectionExpression: 'id_usuario, Email, #local',
      ExpressionAttributeNames: { '#local': 'Local' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function run() {
  console.log(aplicar ? 'Modo APLICAR (escribe en DynamoDB)\n' : 'Modo simulación (no escribe). Usa --aplicar para escribir.\n');

  const { porNombre } = await maestroLocales();
  const destino = porNombre.get(BUSCADO);
  if (!destino) {
    console.error(`No hay ningún local en ${tables.locales} con nombre normalizado 'DISTRIBUIDORA'. No se toca nada.`);
    process.exit(1);
  }
  const nombreExacto = destino.nombre;
  console.log(`Local destino: "${nombreExacto}" (id ${destino.idLocal})\n`);

  let afectados = 0;
  for (const u of await usuarios()) {
    const actual = u.Local;
    if (!Array.isArray(actual)) {
      if (norm(actual) === MAL_ESCRITO) {
        console.log(`  ${u.id_usuario} <${u.Email ?? ''}>: Local no es una lista (${JSON.stringify(actual)}); revisar a mano`);
      }
      continue;
    }
    if (!actual.some((l) => norm(l) === MAL_ESCRITO)) continue;

    const nuevo = [];
    for (const l of actual) {
      const valor = norm(l) === MAL_ESCRITO ? nombreExacto : l;
      if (!nuevo.some((n) => norm(n) === norm(valor))) nuevo.push(valor);
    }
    afectados += 1;
    console.log(`  ${u.id_usuario} <${u.Email ?? ''}>: ${JSON.stringify(actual)} -> ${JSON.stringify(nuevo)}`);
    if (!aplicar) continue;
    try {
      await docClient.send(new UpdateCommand({
        TableName: tables.usuarios,
        Key: { id_usuario: u.id_usuario },
        UpdateExpression: 'SET #local = :nuevo',
        ConditionExpression: 'attribute_exists(id_usuario) AND #local = :anterior',
        ExpressionAttributeNames: { '#local': 'Local' },
        ExpressionAttributeValues: { ':nuevo': nuevo, ':anterior': actual },
      }));
      console.log('    actualizado');
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
      console.log('    Local cambió desde la lectura; no se toca. Vuelve a ejecutar el script.');
    }
  }
  console.log(`\n${afectados} usuario(s) ${aplicar ? 'procesados' : 'se corregirían'}.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
