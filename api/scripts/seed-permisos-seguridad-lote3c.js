#!/usr/bin/env node
/**
 * Marca en Igp_RolesPermisos los permisos que el servidor va a exigir en el
 * lote 3c de seguridad, para los roles que ya hacían esas acciones sin control.
 * Hay que ejecutarlo ANTES de desplegar el código que los exige.
 *
 * `franjas.editar`: crear, editar y borrar plantillas de franjas horarias
 * (POST/PUT/DELETE /agora/franjas-plantillas), que SuperUser y Administracion
 * gestionan desde Cajas → Plantillas de franjas. Antes bastaba `objetivos.ver`,
 * que también tiene el rol Local.
 *
 * Por defecto solo muestra lo que haría. Para escribir: --aplicar
 * Uso: node api/scripts/seed-permisos-seguridad-lote3c.js [--aplicar]
 *
 * Solo añade filas (attribute_not_exists): no quita ni modifica nada.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const { docClient, tables } = await import('../lib/db.js');

const ROLES = ['SuperUser', 'Administracion'];
const PERMISOS = [
  'franjas.editar',
];

const aplicar = process.argv.includes('--aplicar');

async function run() {
  console.log(aplicar ? 'Modo APLICAR (escribe en DynamoDB)\n' : 'Modo simulación (no escribe). Usa --aplicar para escribir.\n');
  let nuevos = 0;
  for (const rol of ROLES) {
    for (const permiso of PERMISOS) {
      const Key = { PK: `ROL#${rol}`, SK: `PERMISO#${permiso}` };
      const got = await docClient.send(new GetCommand({ TableName: tables.rolesPermisos, Key }));
      if (got.Item) {
        console.log(`  ${rol} · ${permiso}: ya lo tenía`);
        continue;
      }
      nuevos += 1;
      if (!aplicar) {
        console.log(`  ${rol} · ${permiso}: se marcaría`);
        continue;
      }
      try {
        await docClient.send(new PutCommand({
          TableName: tables.rolesPermisos,
          Item: Key,
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
        console.log(`  ${rol} · ${permiso}: marcado`);
      } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
        console.log(`  ${rol} · ${permiso}: ya lo tenía`);
      }
    }
  }
  console.log(`\n${nuevos} permiso(s) ${aplicar ? 'marcados' : 'pendientes de marcar'}.`);
  if (aplicar && nuevos > 0) {
    console.log('Si la API está arrancada, los cambios se ven como mucho en un minuto (caché de permisos).');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
