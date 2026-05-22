#!/usr/bin/env node
/**
 * Resetea la contraseña de un usuario directamente en DynamoDB (igp_usuarios).
 * Pensado para emergencias en las que el flujo de login no funciona pero las
 * credenciales AWS sí están disponibles.
 *
 * Uso (desde la raíz del proyecto o desde api/):
 *   node api/scripts/reset-password.js
 *   node api/scripts/reset-password.js --email admin@empresa.com
 *   node api/scripts/reset-password.js --email admin@empresa.com --password "NuevaPass123"
 *
 * Carga variables desde api/.env.local y api/.env si existen.
 * El SDK de AWS resolverá credenciales por la cadena estándar:
 *   process.env (AWS_*) → ~/.aws/credentials (perfil) → metadata
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline';
import bcrypt from 'bcrypt';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Cargar variables de entorno antes de importar dinámicamente módulos del API
// que crean clientes AWS al evaluarse (db.js lee process.env.AWS_REGION).
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

// Import dinámico para que `findUsuarioByEmail` reutilice el GSI Email-index
// del server. Si el GSI todavía no está activo (primer arranque), el helper
// hace fallback a Scan automáticamente.
const { findUsuarioByEmail, ensureUsuariosEmailGSI } = await import('../lib/dynamo/usuarios.js');

const TABLE = process.env.DDB_USUARIOS || process.env.DYNAMODB_TABLE || 'igp_usuarios';
const REGION = process.env.AWS_REGION || 'eu-west-3';
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function showHelp() {
  console.log(`
Resetea la contraseña de un usuario en DynamoDB (igp_usuarios).

Uso:
  node api/scripts/reset-password.js
  node api/scripts/reset-password.js --email user@example.com
  node api/scripts/reset-password.js --email user@example.com --password "NuevaPass"

Si no se pasan argumentos, se piden por consola.
La contraseña interactiva se oculta con '*'.
`);
}

function prompt(question) {
  const r = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => r.question(question, (ans) => { r.close(); resolve(ans); }));
}

/**
 * Lee una contraseña desde stdin sin mostrarla en claro (oculta con '*').
 * Si stdin no es TTY, cae a readline normal (sin ocultar).
 */
function promptPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const r = readline.createInterface({ input: stdin, output: process.stdout });
      r.question('', (ans) => { r.close(); resolve(ans); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pwd = '';
    const onData = (ch) => {
      switch (ch) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(pwd);
          break;
        case '\u0003':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.exit(130);
          break;
        case '\u007f':
        case '\b':
          if (pwd.length > 0) {
            pwd = pwd.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          pwd += ch;
          process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function findUserByEmail(email) {
  return await findUsuarioByEmail(email);
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) { showHelp(); return; }

  console.log(`Tabla: ${TABLE} | Región: ${REGION}\n`);

  // Marca `gsiReady=true` si el índice ya está activo (caso normal tras el
  // primer arranque del server). En frío hace fallback a Scan, sin error.
  await ensureUsuariosEmailGSI();

  const rawEmail = args.email != null ? args.email : await prompt('Email del usuario: ');
  const email = String(rawEmail).trim().toLowerCase();
  if (!email) { console.error('Email vacío. Abortando.'); process.exit(1); }

  console.log(`Buscando usuario con email '${email}'…`);
  const matches = await findUserByEmail(email);
  if (matches.length === 0) {
    console.error('No se encontró ningún usuario con ese email.');
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Encontrados ${matches.length} usuarios con ese email (debería ser único). Abortando por seguridad.`);
    matches.forEach((u, i) => console.error(`  ${i + 1}. id_usuario=${u.id_usuario} Rol=${u.Rol || '(sin rol)'}`));
    process.exit(1);
  }

  const user = matches[0];
  console.log(`\nUsuario encontrado:`);
  console.log(`  id_usuario: ${user.id_usuario}`);
  console.log(`  Nombre:     ${[user.Nombre, user.Apellidos].filter(Boolean).join(' ') || '(sin nombre)'}`);
  console.log(`  Email:      ${user.Email}`);
  console.log(`  Rol:        ${user.Rol || '(sin rol)'}`);

  let newPassword = args.password;
  if (!newPassword) {
    const p1 = await promptPassword('\nNueva contraseña: ');
    if (!p1) { console.error('Contraseña vacía. Abortando.'); process.exit(1); }
    if (p1.length < MIN_PASSWORD_LENGTH) {
      console.error(`Demasiado corta (mínimo ${MIN_PASSWORD_LENGTH} caracteres). Abortando.`);
      process.exit(1);
    }
    const p2 = await promptPassword('Repite la contraseña: ');
    if (p1 !== p2) { console.error('Las contraseñas no coinciden. Abortando.'); process.exit(1); }
    newPassword = p1;
  } else if (newPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(`Contraseña demasiado corta (mínimo ${MIN_PASSWORD_LENGTH} caracteres). Abortando.`);
    process.exit(1);
  }

  const confirm = (await prompt(`\n¿Confirmar reseteo de la contraseña de ${user.Email}? (escribe SI): `)).trim();
  if (confirm !== 'SI') {
    console.log('Cancelado.');
    return;
  }

  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { id_usuario: user.id_usuario },
    UpdateExpression: 'SET #Password = :p',
    ExpressionAttributeNames: { '#Password': 'Password' },
    ExpressionAttributeValues: { ':p': hash },
  }));

  console.log(`\n✓ Contraseña actualizada para ${user.Email} (id_usuario=${user.id_usuario}).`);
  console.log('Ya puedes hacer login con la nueva contraseña.');
}

run().catch((err) => {
  console.error('\nError:', err.message || err);
  if (err?.name === 'CredentialsProviderError' || /credentials/i.test(String(err?.message || ''))) {
    console.error('\nEl SDK de AWS no encontró credenciales. Asegúrate de tener una de estas opciones:');
    console.error('  - AWS_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY en api/.env.local');
    console.error('  - O un perfil configurado con `aws configure` (~/.aws/credentials)');
  }
  process.exit(1);
});
