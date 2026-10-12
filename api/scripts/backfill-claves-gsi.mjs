#!/usr/bin/env node
/**
 * Rellena los atributos `gsi_*` de los registros antiguos.
 *
 * Los índices ya están activos y las escrituras nuevas los rellenan con
 * `api/lib/facturacion/clavesIndice.js` y `api/lib/clavesIndice.js`. Este
 * script llama a esas mismas funciones: el valor calculado es el de un alta
 * nueva. Un `gsi_*` nunca se escribe como `''`.
 *
 * Por defecto no escribe (simulación). Para escribir: --aplicar
 *
 * Uso (desde la carpeta api):
 *   node scripts/backfill-claves-gsi.mjs --tabla pedidos --tabla remesas
 *   node scripts/backfill-claves-gsi.mjs --todas
 *   node scripts/backfill-claves-gsi.mjs --tabla facturas --aplicar
 *
 * `--tabla` se puede repetir. `--todas` recorre las soportadas. Compras a
 * proveedor no entra aquí.
 *
 * Los helpers se importan después de dotenv, dentro de `cargarHelpers`, para
 * que `db.js` vea la región y los nombres de tabla.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ALIAS_TABLAS = Object.freeze([
  'facturas',
  'facturasPagos',
  'remesas',
  'empresas',
  'pedidos',
  'actuaciones',
  'mysteryGuest',
  'mantenimiento',
  'negociaciones',
  'acuerdosDetalles',
  'refacturaciones',
  'bankFiles',
  'bankMovements',
]);

const CONCURRENCIA = 5;
const REINTENTOS = 6;
const ESPERA_INICIAL_MS = 200;

let helpers = null;

/** Carga los calculadores de claves. No toca la red hasta que se llama. */
export async function cargarHelpers() {
  if (helpers) return helpers;
  const fact = await import('../lib/facturacion/clavesIndice.js');
  const resto = await import('../lib/clavesIndice.js');
  const cif = await import('../lib/empresaCif.js');
  helpers = {
    clavesIndiceFactura: fact.clavesIndiceFactura,
    clavesIndicePago: fact.clavesIndicePago,
    clavesIndiceRemesa: fact.clavesIndiceRemesa,
    clavesEmpresa: resto.clavesEmpresa,
    clavesPedido: resto.clavesPedido,
    clavesActuacion: resto.clavesActuacion,
    clavesMysteryGuest: resto.clavesMysteryGuest,
    clavesMantenimiento: resto.clavesMantenimiento,
    clavesNegociacionMeta: resto.clavesNegociacionMeta,
    clavesAcuerdoDetalle: resto.clavesAcuerdoDetalle,
    clavesRefacturacion: resto.clavesRefacturacion,
    clavesFicheroBanca: resto.clavesFicheroBanca,
    clavesMovimientoBanca: resto.clavesMovimientoBanca,
    getCifFromEmpresaItem: cif.getCifFromEmpresaItem,
  };
  return helpers;
}

/**
 * Claves que escribiría un alta nueva, en la forma del helper de esa tabla.
 * `null` si el ítem no entra en el backfill (líneas de negociación).
 */
export async function clavesDeAlias(alias, item) {
  const h = await cargarHelpers();
  switch (alias) {
    case 'facturas':
      return h.clavesIndiceFactura(item);
    case 'facturasPagos':
      return h.clavesIndicePago(item);
    case 'remesas':
      return h.clavesIndiceRemesa(item);
    case 'empresas':
      return h.clavesEmpresa(h.getCifFromEmpresaItem(item));
    case 'pedidos':
      return h.clavesPedido(item);
    case 'actuaciones':
      return h.clavesActuacion(item);
    case 'mysteryGuest':
      return h.clavesMysteryGuest(item);
    case 'mantenimiento':
      return h.clavesMantenimiento(item);
    case 'negociaciones':
      if (item?.SK !== 'META') return null;
      return h.clavesNegociacionMeta(item);
    case 'acuerdosDetalles':
      return h.clavesAcuerdoDetalle(item?.ProductId);
    case 'refacturaciones':
      return h.clavesRefacturacion(item);
    case 'bankFiles':
      return h.clavesFicheroBanca(item);
    case 'bankMovements':
      return h.clavesMovimientoBanca(item?.hashFichero);
    default:
      throw new Error(`Tabla no soportada: ${alias}`);
  }
}

/** Unifica `{ poner, quitar }` y `{ set, remove }`. */
export function normalizarClaves(claves) {
  if (!claves || typeof claves !== 'object') return { set: {}, remove: [] };
  if ('poner' in claves || 'quitar' in claves) {
    return { set: { ...(claves.poner || {}) }, remove: [...(claves.quitar || [])] };
  }
  return { set: { ...(claves.set || {}) }, remove: [...(claves.remove || [])] };
}

function atributoPresente(item, clave) {
  return !!item && Object.prototype.hasOwnProperty.call(item, clave) && item[clave] !== undefined;
}

/**
 * Qué hay que SET y qué hay que REMOVE para que el ítem quede como el cálculo.
 * No propone escribir `''`. Si el atributo a quitar no está, no hay cambio.
 */
export function diffClavesGsi(item, claves) {
  const { set: calculado, remove } = normalizarClaves(claves);
  const set = {};
  const quitar = [];
  const yaQuita = new Set();
  const enSet = new Set();

  const anadirQuitar = (clave) => {
    if (enSet.has(clave) || yaQuita.has(clave)) return;
    if (!atributoPresente(item, clave)) return;
    yaQuita.add(clave);
    quitar.push(clave);
  };

  for (const [clave, valor] of Object.entries(calculado)) {
    if (!clave.startsWith('gsi_')) continue;
    if (typeof valor !== 'string' || valor === '') {
      anadirQuitar(clave);
      continue;
    }
    enSet.add(clave);
    if (!atributoPresente(item, clave) || item[clave] !== valor) set[clave] = valor;
  }
  for (const clave of remove) {
    if (typeof clave !== 'string' || !clave.startsWith('gsi_')) continue;
    anadirQuitar(clave);
  }
  return {
    set,
    remove: quitar,
    cambia: Object.keys(set).length > 0 || quitar.length > 0,
  };
}

/**
 * Decisión de un ítem: omitir (no META), o el diff contra las claves del helper.
 */
export async function planBackfill(alias, item) {
  const claves = await clavesDeAlias(alias, item);
  if (claves == null) return { omitir: true, cambia: false, set: {}, remove: [] };
  return { omitir: false, ...diffClavesGsi(item, claves) };
}

/**
 * Parámetros de UpdateItem: SET de los que cambian, REMOVE de los que sobran,
 * y `attribute_exists` de cada atributo de la clave primaria.
 */
export function paramsUpdateClaves(key, diff) {
  if (!key || typeof key !== 'object' || Object.keys(key).length === 0) {
    throw new Error('Falta la clave primaria');
  }
  const names = {};
  const values = {};
  const sets = [];
  const removes = [];
  let i = 0;
  for (const [attr, val] of Object.entries(diff?.set || {})) {
    if (!attr.startsWith('gsi_') || typeof val !== 'string' || val === '') {
      throw new Error(`Clave gsi no escribible: ${attr}`);
    }
    const nombre = `#g${i}`;
    const valor = `:g${i}`;
    names[nombre] = attr;
    values[valor] = val;
    sets.push(`${nombre} = ${valor}`);
    i += 1;
  }
  for (const attr of diff?.remove || []) {
    if (typeof attr !== 'string' || !attr.startsWith('gsi_')) {
      throw new Error(`Atributo a quitar no es gsi: ${attr}`);
    }
    const nombre = `#g${i}`;
    names[nombre] = attr;
    removes.push(nombre);
    i += 1;
  }
  if (sets.length === 0 && removes.length === 0) {
    throw new Error('No hay cambios que escribir');
  }
  const condiciones = [];
  for (const attr of Object.keys(key)) {
    const alias = `#k${condiciones.length}`;
    names[alias] = attr;
    condiciones.push(`attribute_exists(${alias})`);
  }
  const partes = [];
  if (sets.length) partes.push(`SET ${sets.join(', ')}`);
  if (removes.length) partes.push(`REMOVE ${removes.join(', ')}`);
  const params = {
    Key: key,
    UpdateExpression: partes.join(' '),
    ConditionExpression: condiciones.join(' AND '),
    ExpressionAttributeNames: names,
  };
  if (Object.keys(values).length > 0) params.ExpressionAttributeValues = values;
  return params;
}

function invocadoComoScript() {
  const entrada = process.argv[1];
  if (!entrada) return false;
  try {
    const propio = path.resolve(fileURLToPath(import.meta.url));
    return path.resolve(entrada).toLowerCase() === propio.toLowerCase();
  } catch {
    return false;
  }
}

function uso() {
  return [
    'Uso: node scripts/backfill-claves-gsi.mjs [--tabla alias ...] [--todas] [--aplicar]',
    'Por defecto no escribe. --aplicar escribe solo los registros cuyo gsi_* difiere.',
    `Alias: ${ALIAS_TABLAS.join(', ')}`,
  ].join('\n');
}

function leerArgs(argv) {
  const tablas = [];
  let todas = false;
  let aplicar = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--aplicar') aplicar = true;
    else if (arg === '--todas') todas = true;
    else if (arg === '--tabla') {
      const nombre = argv[i + 1];
      if (!nombre || nombre.startsWith('--')) throw new Error('--tabla necesita un alias');
      tablas.push(nombre);
      i += 1;
    } else {
      throw new Error(`Argumento no reconocido: ${arg}`);
    }
  }
  return { tablas, todas, aplicar };
}

function esThrottling(err) {
  const nombre = String(err?.name || '');
  if (
    nombre === 'ProvisionedThroughputExceededException'
    || nombre === 'ThrottlingException'
    || nombre === 'RequestLimitExceeded'
    || nombre === 'LimitExceededException'
  ) {
    return true;
  }
  if (err?.$retryable?.throttling) return true;
  return /Throughput exceeds|Rate exceeded|Throttling/i.test(String(err?.message || ''));
}

async function esperar(ms) {
  await new Promise((resolver) => setTimeout(resolver, ms));
}

async function enviarConReintento(enviar) {
  let espera = ESPERA_INICIAL_MS;
  for (let intento = 0; intento < REINTENTOS; intento += 1) {
    try {
      return await enviar();
    } catch (err) {
      if (!esThrottling(err) || intento === REINTENTOS - 1) throw err;
      await esperar(espera);
      espera = Math.min(espera * 2, 8000);
    }
  }
  return undefined;
}

async function enParaleloLimitado(items, limite, fn) {
  if (items.length === 0) return;
  let cursor = 0;
  const trabajadores = Math.min(limite, items.length);
  async function trabajador() {
    while (cursor < items.length) {
      const indice = cursor;
      cursor += 1;
      await fn(items[indice]);
    }
  }
  await Promise.all(Array.from({ length: trabajadores }, () => trabajador()));
}

function valorVisible(valor) {
  const texto = String(valor ?? '');
  if (/^ACCOUNT#/i.test(texto) || /^[A-Z]{2}\d{2}[A-Z0-9]{12,}$/.test(texto)) {
    return `${texto.slice(0, 12)}…`;
  }
  return texto.length > 120 ? `${texto.slice(0, 120)}…` : texto;
}

function claveVisible(key) {
  const out = {};
  for (const [k, v] of Object.entries(key || {})) out[k] = valorVisible(v);
  return out;
}

function lineaError(err) {
  const nombre = err?.name ? `${err.name}: ` : '';
  return `${nombre}${String(err?.message || err)}`.replace(/\s+/g, ' ').slice(0, 240);
}

async function procesarTabla(alias, ctx) {
  const { ScanCommand, UpdateCommand, docClient, tables, getTableKeySchema, buildDynamoKeyFromItem, aplicar } = ctx;
  const tableName = tables[alias];
  if (!tableName) throw new Error(`No hay nombre de tabla para ${alias}`);
  const schema = await getTableKeySchema(tableName);
  const stats = { leidos: 0, actualizados: 0, sinCambios: 0, errores: 0, omitidos: 0 };
  const ejemplos = [];
  let lastKey;

  console.log(`\n== ${alias} (${tableName}) ==`);

  do {
    const pagina = await enviarConReintento(() => docClient.send(new ScanCommand({
      TableName: tableName,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    })));
    const cambios = [];
    for (const item of pagina.Items || []) {
      stats.leidos += 1;
      try {
        const plan = await planBackfill(alias, item);
        if (plan.omitir) {
          stats.omitidos += 1;
          continue;
        }
        if (!plan.cambia) {
          stats.sinCambios += 1;
          continue;
        }
        const key = buildDynamoKeyFromItem(item, schema);
        if (!key) {
          stats.errores += 1;
          console.error('  error: el ítem no trae la clave primaria');
          continue;
        }
        if (ejemplos.length < 3) {
          ejemplos.push({ clave: claveVisible(key), set: plan.set, remove: plan.remove });
        }
        if (!aplicar) {
          stats.actualizados += 1;
          continue;
        }
        cambios.push({ key, plan });
      } catch (err) {
        stats.errores += 1;
        console.error(`  error: ${lineaError(err)}`);
      }
    }
    if (aplicar && cambios.length) {
      await enParaleloLimitado(cambios, CONCURRENCIA, async ({ key, plan }) => {
        try {
          await enviarConReintento(() => docClient.send(new UpdateCommand({
            TableName: tableName,
            ...paramsUpdateClaves(key, plan),
          })));
          stats.actualizados += 1;
        } catch (err) {
          stats.errores += 1;
          console.error(`  error ${JSON.stringify(claveVisible(key))}: ${lineaError(err)}`);
        }
      });
    }
    lastKey = pagina.LastEvaluatedKey;
  } while (lastKey);

  if (ejemplos.length === 0) {
    console.log('  ejemplos: ninguno (no hay registros que cambiar)');
  } else {
    ejemplos.forEach((ej, i) => {
      console.log(`  ejemplo ${i + 1}: ${JSON.stringify(ej)}`);
    });
  }
  if (stats.omitidos > 0) console.log(`  omitidos (no META): ${stats.omitidos}`);
  console.log(
    `  leídos: ${stats.leidos}, actualizados: ${stats.actualizados}, sin cambios: ${stats.sinCambios}, errores: ${stats.errores}`,
  );
  return stats;
}

async function main() {
  let args;
  try {
    args = leerArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    console.error(uso());
    process.exit(1);
  }
  if (!args.todas && args.tablas.length === 0) {
    console.error(uso());
    process.exit(1);
  }
  const elegidas = args.todas ? [...ALIAS_TABLAS] : [...new Set(args.tablas)];
  const desconocidas = elegidas.filter((alias) => !ALIAS_TABLAS.includes(alias));
  if (desconocidas.length) {
    console.error(`Alias desconocido: ${desconocidas.join(', ')}`);
    console.error(uso());
    process.exit(1);
  }

  const dotenv = (await import('dotenv')).default;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.join(dir, '..', '.env.local') });
  dotenv.config({ path: path.join(dir, '..', '.env') });

  const { ScanCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = await import('../lib/db.js');
  await cargarHelpers();

  let region = process.env.AWS_REGION || '(desconocida)';
  try {
    region = await db.client.config.region();
  } catch {
    // nos quedamos con la variable de entorno
  }

  console.log(args.aplicar
    ? 'Modo APLICAR: se escriben los gsi_* que difieren.'
    : 'Modo simulación (no escribe). actualizados = registros que se actualizarían. Usa --aplicar para escribir.');
  console.log('Región AWS:', region);
  console.log('Tablas:', elegidas.join(', '));

  const totales = { leidos: 0, actualizados: 0, sinCambios: 0, errores: 0 };
  let tablasFallidas = 0;
  for (const alias of elegidas) {
    try {
      const stats = await procesarTabla(alias, {
        ScanCommand,
        UpdateCommand,
        docClient: db.docClient,
        tables: db.tables,
        getTableKeySchema: db.getTableKeySchema,
        buildDynamoKeyFromItem: db.buildDynamoKeyFromItem,
        aplicar: args.aplicar,
      });
      totales.leidos += stats.leidos;
      totales.actualizados += stats.actualizados;
      totales.sinCambios += stats.sinCambios;
      totales.errores += stats.errores;
    } catch (err) {
      tablasFallidas += 1;
      totales.errores += 1;
      console.error(`\n== ${alias} ==`);
      console.error(`  error de tabla: ${lineaError(err)}`);
    }
  }

  console.log(
    `\nTOTAL leídos: ${totales.leidos}, actualizados: ${totales.actualizados}, sin cambios: ${totales.sinCambios}, errores: ${totales.errores}`,
  );
  if (tablasFallidas > 0) process.exitCode = 1;
}

if (invocadoComoScript()) {
  try {
    await main();
  } catch (err) {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  }
}
