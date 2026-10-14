#!/usr/bin/env node
/**
 * Rellena `fecha_vencimiento` de las facturas de gasto (IN) pendientes que no
 * lo tienen, con emisión + plazo. El plazo sale de `condiciones_pago` de la
 * factura si se entiende y, si no, del `Vencimiento` del proveedor en el
 * maestro de empresas: el mismo orden que aplica la emisión/validación
 * (`api/lib/facturacion/plazoProveedor.js`).
 *
 * Lectura de facturas por `Estado-Fecha-index` (pendiente_revision,
 * pendiente_pago, parcialmente_pagada), sin Scan. Una factura sin `gsi_estado`
 * no sale: pasa antes `backfill-claves-gsi.mjs --tabla facturas`. El maestro se
 * lee por GetItem con caché por `empresa_id`.
 *
 * Por defecto no escribe (simulación). Para escribir: --aplicar. La escritura
 * es condicional: solo si el vencimiento sigue vacío y la factura sigue en el
 * estado y la versión leídos; un vencimiento puesto a mano o un pago entretanto
 * no se pisan (la factura se omite y se cuenta en el informe).
 *
 * Maestro de empresas:
 *   --revisar-maestro      lista las empresas cuyo `Vencimiento` no se entiende.
 *   --normalizar-maestro   convierte a Number los textos que sí se entienden y
 *                          quita los vacíos (con --aplicar; si no, simula).
 * Estos dos modos recorren igp_Empresas con Scan paginado: es un script
 * administrativo puntual, como `backfill-bank-accounts.js` o
 * `migrar-locales-id-empresa.js`, y el maestro no tiene índice que lo liste.
 *
 * Uso (desde la carpeta api):
 *   node scripts/backfill-vencimiento-facturas-gasto.mjs
 *   node scripts/backfill-vencimiento-facturas-gasto.mjs --aplicar
 *   node scripts/backfill-vencimiento-facturas-gasto.mjs --revisar-maestro
 *   node scripts/backfill-vencimiento-facturas-gasto.mjs --normalizar-maestro [--aplicar]
 *
 * Los helpers se importan después de dotenv, dentro de `cargarHelpers`, para
 * que `db.js` vea la región y los nombres de tabla.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ESTADOS_PENDIENTES = Object.freeze(['pendiente_revision', 'pendiente_pago', 'parcialmente_pagada']);

let helpers = null;

export async function cargarHelpers() {
  if (helpers) return helpers;
  const plazo = await import('../lib/facturacion/plazoVencimiento.js');
  const consulta = await import('../lib/facturacion/consultaIndice.js');
  const claves = await import('../lib/facturacion/clavesIndice.js');
  const version = await import('../lib/facturacion/versionFactura.js');
  const iban = await import('../lib/facturacion/ibanCongelado.js');
  const deuda = await import('../lib/facturacion/deudaProveedores.js');
  const db = await import('../lib/db.js');
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  helpers = {
    ...plazo,
    facturasPorEstado: consulta.facturasPorEstado,
    conClavesFactura: claves.conClavesFactura,
    updateFacturaVersionado: version.updateFacturaVersionado,
    buscarEmpresaPorIdEmpresa: iban.buscarEmpresaPorIdEmpresa,
    hoyMadridIso: deuda.hoyMadridIso,
    keyForFacturaItem: db.keyForFacturaItem,
    tables: db.tables,
    GetCommand,
  };
  return helpers;
}

function texto(v) {
  return v == null ? '' : String(v).trim();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function lineaError(err) {
  const nombre = err?.name ? `${err.name}: ` : '';
  return `${nombre}${String(err?.message || err)}`.replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * Parámetros del Update: SET vencimiento (y condiciones si faltan), solo si
 * sigue vacío y la factura sigue en el estado y la versión leídos. Los `gsi_*`
 * se recalculan desde la factura leída: si entretanto la pagan (o cambia el
 * proveedor o la fecha), escribirlos dejaría el índice con datos viejos.
 */
export function paramsActualizarVencimiento(h, key, factura, { vencimiento, condiciones }) {
  const sets = ['#fv = :fv'];
  const tieneVersion = factura.version !== undefined && factura.version !== null;
  const valores = {
    ':fv': vencimiento,
    ':vacio': '',
    ':estadoLeido': factura.estado,
    ...(tieneVersion && { ':verLeida': factura.version }),
  };
  if (condiciones) {
    sets.push('#cp = :cp');
    valores[':cp'] = condiciones;
  }
  const nueva = {
    ...factura,
    fecha_vencimiento: vencimiento,
    ...(condiciones && { condiciones_pago: condiciones }),
  };
  const condVersion = tieneVersion ? '#ver = :verLeida' : 'attribute_not_exists(#ver)';
  return h.updateFacturaVersionado(h.conClavesFactura({
    Key: key,
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: `attribute_exists(#pk) AND (attribute_not_exists(#fv) OR #fv = :vacio) AND #estado = :estadoLeido AND ${condVersion}`,
    ExpressionAttributeNames: {
      '#pk': Object.keys(key)[0],
      '#fv': 'fecha_vencimiento',
      '#estado': 'estado',
      '#ver': 'version',
      ...(condiciones && { '#cp': 'condiciones_pago' }),
    },
    ExpressionAttributeValues: valores,
  }, nueva));
}

/**
 * Por qué no se escribió una factura cuya condición falló: se relee para
 * contarlo en el informe.
 * @returns {Promise<'vencimiento'|'estado'|'version'>}
 */
async function motivoOmision(h, docClient, key, factura) {
  const r = await docClient.send(new h.GetCommand({ TableName: h.tables.facturas, Key: key, ConsistentRead: true }));
  const actual = r.Item;
  if (!actual) return 'version';
  if (texto(actual.fecha_vencimiento)) return 'vencimiento';
  if (actual.estado !== factura.estado) return 'estado';
  return 'version';
}

/**
 * Recorre las facturas IN pendientes sin vencimiento y calcula (y con
 * `aplicar` escribe) el vencimiento.
 * @param {{ docClient: object, UpdateCommand: Function, aplicar: boolean, hoy?: string, h?: object }} ctx
 */
export async function procesarFacturas(ctx) {
  const h = ctx.h || (await cargarHelpers());
  const { docClient, UpdateCommand, aplicar } = ctx;
  const hoy = ctx.hoy || h.hoyMadridIso();
  const stats = {
    leidas: 0,
    sinVencimiento: 0,
    porCondiciones: 0,
    conPlazoProveedor: 0,
    sinPlazo: 0,
    actualizadas: 0,
    yaVencidas: 0,
    saldoYaVencido: 0,
    errores: 0,
    omitidasPorVencimiento: 0,
    omitidasPorEstado: 0,
    omitidasPorVersion: 0,
  };
  const proveedoresSinPlazo = new Map();
  const cacheEmpresas = new Map();
  const ejemplos = [];

  async function diasProveedor(idEmpresa) {
    const id = texto(idEmpresa);
    if (!id) return null;
    if (!cacheEmpresas.has(id)) {
      const empresa = await h.buscarEmpresaPorIdEmpresa(id);
      cacheEmpresas.set(id, h.parseDiasPlazo(empresa?.Vencimiento));
    }
    return cacheEmpresas.get(id);
  }

  const vistas = new Set();
  for (const estado of ESTADOS_PENDIENTES) {
    const facturas = await h.facturasPorEstado(estado);
    for (const f of facturas) {
      const id = texto(f.id_factura || f.id_entrada);
      if (vistas.has(id)) continue;
      vistas.add(id);
      stats.leidas += 1;
      if (texto(f.tipo).toUpperCase() !== 'IN') continue;
      if (texto(f.fecha_vencimiento)) continue;
      stats.sinVencimiento += 1;
      try {
        let dias = h.parseDiasPlazo(f.condiciones_pago);
        if (dias != null) {
          stats.porCondiciones += 1;
        } else {
          dias = await diasProveedor(f.empresa_id);
          if (dias != null) stats.conPlazoProveedor += 1;
        }
        const vencimiento = dias != null ? h.calcularFechaVencimiento(f.fecha_emision, dias) : '';
        if (!vencimiento) {
          stats.sinPlazo += 1;
          const clave = `${texto(f.empresa_id) || '(sin id)'} · ${texto(f.empresa_nombre) || texto(f.empresa_cif) || '?'}`;
          proveedoresSinPlazo.set(clave, (proveedoresSinPlazo.get(clave) || 0) + 1);
          continue;
        }
        const condiciones = texto(f.condiciones_pago) ? '' : h.condicionesDesdeDias(dias);
        if (vencimiento < hoy) {
          stats.yaVencidas += 1;
          stats.saldoYaVencido = round2(stats.saldoYaVencido + (Number(f.saldo_pendiente) || 0));
        }
        if (ejemplos.length < 5) {
          ejemplos.push({
            id_factura: id,
            estado: f.estado,
            fecha_emision: f.fecha_emision,
            dias,
            fecha_vencimiento: vencimiento,
            ...(condiciones && { condiciones_pago: condiciones }),
          });
        }
        if (!aplicar) {
          stats.actualizadas += 1;
          continue;
        }
        const key = await h.keyForFacturaItem(f);
        try {
          await docClient.send(new UpdateCommand(paramsActualizarVencimiento(h, key, f, { vencimiento, condiciones })));
          stats.actualizadas += 1;
        } catch (err) {
          if (err?.name === 'ConditionalCheckFailedException') {
            const motivo = await motivoOmision(h, docClient, key, f);
            if (motivo === 'vencimiento') stats.omitidasPorVencimiento += 1;
            else if (motivo === 'estado') stats.omitidasPorEstado += 1;
            else stats.omitidasPorVersion += 1;
          } else {
            throw err;
          }
        }
      } catch (err) {
        stats.errores += 1;
        console.error(`  error ${id}: ${lineaError(err)}`);
      }
    }
  }

  return { stats, proveedoresSinPlazo, ejemplos };
}

/**
 * Qué hacer con el `Vencimiento` de una empresa del maestro.
 * @returns {{ accion: 'nada'|'normalizar'|'quitar'|'no_valido', dias?: number }}
 */
export function clasificarVencimientoMaestro(h, valor) {
  if (valor === undefined) return { accion: 'nada' };
  if (typeof valor === 'number') {
    return h.parseDiasPlazo(valor) == null ? { accion: 'no_valido' } : { accion: 'nada' };
  }
  if (valor == null || (typeof valor === 'string' && valor.trim() === '')) return { accion: 'quitar' };
  const dias = h.parseDiasPlazo(valor);
  return dias == null ? { accion: 'no_valido' } : { accion: 'normalizar', dias };
}

async function procesarMaestro({ docClient, ScanCommand, UpdateCommand, tables, aplicar, normalizar }) {
  const h = await cargarHelpers();
  const stats = { leidas: 0, conNumero: 0, normalizables: 0, vacias: 0, noValidas: 0, escritas: 0, errores: 0 };
  const noValidas = [];
  const pendientes = [];
  let lastKey;
  do {
    const pagina = await docClient.send(new ScanCommand({
      TableName: tables.empresas,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const item of pagina.Items || []) {
      stats.leidas += 1;
      const c = clasificarVencimientoMaestro(h, item.Vencimiento);
      if (c.accion === 'nada') {
        if (typeof item.Vencimiento === 'number') stats.conNumero += 1;
      } else if (c.accion === 'no_valido') {
        stats.noValidas += 1;
        noValidas.push({ id_empresa: item.id_empresa, nombre: item.Nombre || item.nombre || '', Vencimiento: item.Vencimiento });
      } else {
        if (c.accion === 'normalizar') stats.normalizables += 1;
        else stats.vacias += 1;
        pendientes.push({ item, c });
      }
    }
    lastKey = pagina.LastEvaluatedKey;
  } while (lastKey);

  console.log(`\n== Maestro de empresas (${tables.empresas}) ==`);
  console.log(`  leídas: ${stats.leidas}, ya en Number: ${stats.conNumero}, texto convertible: ${stats.normalizables}, vacías (''): ${stats.vacias}, no válidas: ${stats.noValidas}`);
  if (noValidas.length) {
    console.log('  Empresas con Vencimiento no válido (corregir a mano en el maestro):');
    for (const e of noValidas) {
      console.log(`    ${e.id_empresa} · ${e.nombre}: ${JSON.stringify(e.Vencimiento)}`);
    }
  }
  if (!normalizar) return stats;

  const muestra = pendientes.slice(0, 10).map(({ item, c }) => (
    `    ${item.id_empresa}: ${JSON.stringify(item.Vencimiento)} → ${c.accion === 'quitar' ? '(sin atributo)' : c.dias}`
  ));
  if (muestra.length) console.log(`  Cambios${aplicar ? '' : ' que se harían'} (muestra):\n${muestra.join('\n')}`);
  if (!aplicar) {
    console.log(`  Simulación: se normalizarían ${pendientes.length}. Usa --aplicar para escribir.`);
    return stats;
  }
  for (const { item, c } of pendientes) {
    try {
      const base = {
        TableName: tables.empresas,
        Key: { id_empresa: item.id_empresa },
        ConditionExpression: '#v = :previo',
        ExpressionAttributeNames: { '#v': 'Vencimiento' },
      };
      await docClient.send(new UpdateCommand(c.accion === 'quitar'
        ? { ...base, UpdateExpression: 'REMOVE #v', ExpressionAttributeValues: { ':previo': item.Vencimiento } }
        : { ...base, UpdateExpression: 'SET #v = :dias', ExpressionAttributeValues: { ':previo': item.Vencimiento, ':dias': c.dias } }));
      stats.escritas += 1;
    } catch (err) {
      stats.errores += 1;
      console.error(`  error ${item.id_empresa}: ${lineaError(err)}`);
    }
  }
  console.log(`  escritas: ${stats.escritas}, errores: ${stats.errores}`);
  return stats;
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

function leerArgs(argv) {
  const args = { aplicar: false, revisarMaestro: false, normalizarMaestro: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--aplicar') args.aplicar = true;
    else if (arg === '--revisar-maestro') args.revisarMaestro = true;
    else if (arg === '--normalizar-maestro') args.normalizarMaestro = true;
    else throw new Error(`Argumento no reconocido: ${arg}`);
  }
  return args;
}

function imprimirFacturas({ stats, proveedoresSinPlazo, ejemplos }, aplicar, hoy) {
  console.log('\n== Facturas de gasto pendientes ==');
  console.log(`  leídas (${ESTADOS_PENDIENTES.join(', ')}): ${stats.leidas}`);
  console.log(`  IN sin vencimiento: ${stats.sinVencimiento}`);
  console.log(`    con plazo en sus condiciones de pago: ${stats.porCondiciones}`);
  console.log(`    con plazo en el proveedor: ${stats.conPlazoProveedor}`);
  console.log(`    sin plazo (se quedan sin vencimiento): ${stats.sinPlazo}`);
  console.log(`  ${aplicar ? 'actualizadas' : 'se actualizarían'}: ${stats.actualizadas}`);
  if (aplicar) {
    console.log('  omitidas porque la factura cambió entre la lectura y la escritura (vuelve a lanzar para recogerlas):');
    console.log(`    alguien puso vencimiento: ${stats.omitidasPorVencimiento}`);
    console.log(`    cambió de estado (p. ej. se pagó): ${stats.omitidasPorEstado}`);
    console.log(`    otra edición (versión distinta): ${stats.omitidasPorVersion}`);
  }
  console.log(`  quedarían ya vencidas (vencimiento < ${hoy}): ${stats.yaVencidas}, saldo pendiente ${stats.saldoYaVencido.toFixed(2)} €`);
  console.log(`  errores: ${stats.errores}`);
  if (proveedoresSinPlazo.size) {
    console.log('  Proveedores sin plazo (nº de facturas):');
    for (const [prov, n] of [...proveedoresSinPlazo].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${prov}: ${n}`);
    }
  }
  ejemplos.forEach((ej, i) => console.log(`  ejemplo ${i + 1}: ${JSON.stringify(ej)}`));
}

async function main() {
  let args;
  try {
    args = leerArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    console.error('Uso: node scripts/backfill-vencimiento-facturas-gasto.mjs [--aplicar] [--revisar-maestro | --normalizar-maestro]');
    process.exit(1);
  }

  const dotenv = (await import('dotenv')).default;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.join(dir, '..', '.env.local') });
  dotenv.config({ path: path.join(dir, '..', '.env') });

  const { ScanCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = await import('../lib/db.js');
  const h = await cargarHelpers();

  let region = process.env.AWS_REGION || '(desconocida)';
  try {
    region = await db.client.config.region();
  } catch {
    // nos quedamos con la variable de entorno
  }
  console.log(args.aplicar ? 'Modo APLICAR: se escribe.' : 'Modo simulación (no escribe). Usa --aplicar para escribir.');
  console.log('Región AWS:', region);

  if (args.revisarMaestro || args.normalizarMaestro) {
    const stats = await procesarMaestro({
      docClient: db.docClient,
      ScanCommand,
      UpdateCommand,
      tables: db.tables,
      aplicar: args.aplicar,
      normalizar: args.normalizarMaestro,
    });
    if (stats.errores > 0) process.exitCode = 1;
    return;
  }

  const hoy = h.hoyMadridIso();
  const resultado = await procesarFacturas({ docClient: db.docClient, UpdateCommand, aplicar: args.aplicar, hoy, h });
  imprimirFacturas(resultado, args.aplicar, hoy);
  if (resultado.stats.errores > 0) process.exitCode = 1;
}

if (invocadoComoScript()) {
  try {
    await main();
  } catch (err) {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  }
}
