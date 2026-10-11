#!/usr/bin/env node
/**
 * Marca en Igp_RolesPermisos los permisos que el servidor pasa a exigir en el
 * lote 5 de seguridad. Hay que ejecutarlo ANTES de desplegar el código que los exige.
 *
 * `mia.confirmar_agora`: aprobar un informe de MIA enviando el pedido a Ágora ya
 * 'Confirmed'. Se marca a todos los roles que hoy tienen `mia.aprobar`, para que
 * quien podía confirmar siga pudiendo. Los roles sin `mia.aprobar` no se tocan.
 *
 * Por defecto solo muestra lo que haría. Para escribir: --aplicar
 * Uso: node api/scripts/seed-permisos-seguridad-lote5.js [--aplicar] [--roles=RolA,RolB]
 *
 * Sin Scan: se revisan los roles de ROLES (y los que se añadan con --roles).
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

const ROLES = ['SuperUser', 'Administracion', 'Local', 'Socio', 'Mantenimiento', 'Marketing', 'Compras', 'Encargado'];
/** Permiso nuevo → permiso que ya tiene que tener el rol para recibirlo. */
const PERMISOS = [
  { permiso: 'mia.confirmar_agora', siTiene: 'mia.aprobar' },
];

const aplicar = process.argv.includes('--aplicar');
const rolesExtra = (process.argv.find((a) => a.startsWith('--roles=')) || '')
  .slice('--roles='.length)
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

async function tiene(rol, permiso) {
  const got = await docClient.send(new GetCommand({
    TableName: tables.rolesPermisos,
    Key: { PK: `ROL#${rol}`, SK: `PERMISO#${permiso}` },
  }));
  return Boolean(got.Item);
}

async function run() {
  console.log(aplicar ? 'Modo APLICAR (escribe en DynamoDB)\n' : 'Modo simulación (no escribe). Usa --aplicar para escribir.\n');
  const roles = [...new Set([...ROLES, ...rolesExtra])];
  let nuevos = 0;
  for (const rol of roles) {
    for (const { permiso, siTiene } of PERMISOS) {
      if (!(await tiene(rol, siTiene))) {
        console.log(`  ${rol} · ${permiso}: no tiene ${siTiene}, no se marca`);
        continue;
      }
      if (await tiene(rol, permiso)) {
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
          Item: { PK: `ROL#${rol}`, SK: `PERMISO#${permiso}` },
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
  console.log('Administrador no necesita fila: tiene todos los permisos.');
  if (aplicar && nuevos > 0) {
    console.log('Si la API está arrancada, los cambios se ven como mucho en un minuto (caché de permisos).');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
