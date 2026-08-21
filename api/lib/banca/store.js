/**
 * Acceso a DynamoDB del módulo Banca.
 *
 * `Igp_BankMovements`: PK = ACCOUNT#<cuenta>, SK = TXN#<fechaOperacion>#<movementHash>.
 *   GSI EmpresaId-FechaOperacion-index (empresaId → fechaOperacion).
 *   GSI Estado-FechaOperacion-index (estadoConciliacion → fechaOperacion).
 * `Igp_BankFiles`: PK = hashFichero. Sin GSI: el listado de cargas es un Scan
 *   filtrado (decenas de ficheros al mes), igual que en `Igp_Refacturaciones`.
 */

import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { limpiarIban } from '../remesas/iban.js';

export const GSI_EMPRESA_FECHA = 'EmpresaId-FechaOperacion-index';
export const GSI_ESTADO_FECHA = 'Estado-FechaOperacion-index';

/** Estado inicial de un movimiento importado. La conciliación es otra fase. */
export const ESTADO_PENDIENTE = 'pendiente';

/** Estados de una carga de extracto. */
export const ESTADO_FICHERO_CARGADO = 'cargado';
export const ESTADO_FICHERO_PENDIENTE_CUENTA = 'pendiente_cuenta';
/**
 * Reserva escrita antes de guardar los apuntes. Si la ingesta se corta a mitad,
 * la ficha queda en este estado y el reintento sabe que los movimientos que hay
 * en el rango son suyos, en vez de denunciarlos como solapamiento ajeno.
 */
export const ESTADO_FICHERO_EN_CURSO = 'en_curso';

const LIMITE_PAGINA_POR_DEFECTO = 200;
const LIMITE_PAGINA_MAXIMO = 1000;
/** Puts en paralelo por lote: sin límite, un extracto de cientos de apuntes dispara la latencia. */
const CONCURRENCIA_ESCRITURA = 10;

const tablaMovimientos = () => tables.bankMovements;
const tablaFicheros = () => tables.bankFiles;

/** Clave de partición de los movimientos de una cuenta. */
export function pkCuenta(cuentaRef) {
  return `ACCOUNT#${String(cuentaRef ?? '').trim()}`;
}

/** Clave de ordenación de un movimiento. */
export function skMovimiento(fechaOperacion, movementHash) {
  return `TXN#${String(fechaOperacion ?? '').trim()}#${String(movementHash ?? '').trim()}`;
}

export function normalizarLimite(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return LIMITE_PAGINA_POR_DEFECTO;
  return Math.min(Math.trunc(n), LIMITE_PAGINA_MAXIMO);
}

/** Cursor de paginación: la clave de continuación de DynamoDB en base64. */
export function codificarCursor(lastKey) {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey), 'utf8').toString('base64');
}

export function decodificarCursor(cursor) {
  const raw = String(cursor || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function rangoSk(desde, hasta) {
  const lo = String(desde || '0000-00-00');
  const hi = String(hasta || '9999-12-31');
  return { lo: `TXN#${lo}#`, hi: `TXN#${hi}#\uffff` };
}

/**
 * Movimientos de una cuenta por clave principal.
 * @param {string} cuentaRef
 * @param {{ desde?: string, hasta?: string, estado?: string, limite?: number, cursor?: string }} opciones
 * @returns {Promise<{ movimientos: Array<Record<string, any>>, cursor: string|null }>}
 */
export async function queryMovimientosCuenta(cuentaRef, {
  desde,
  hasta,
  estado,
  limite,
  cursor,
} = {}) {
  const { lo, hi } = rangoSk(desde, hasta);
  const result = await docClient.send(
    new QueryCommand({
      TableName: tablaMovimientos(),
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
      ...(estado && {
        FilterExpression: 'estadoConciliacion = :estado',
      }),
      ExpressionAttributeValues: {
        ':pk': pkCuenta(cuentaRef),
        ':lo': lo,
        ':hi': hi,
        ...(estado && { ':estado': String(estado) }),
      },
      Limit: normalizarLimite(limite),
      ScanIndexForward: false,
      ...(cursor && { ExclusiveStartKey: decodificarCursor(cursor) || undefined }),
    }),
  );
  return {
    movimientos: result.Items || [],
    cursor: codificarCursor(result.LastEvaluatedKey),
  };
}

/** Todos los movimientos de una cuenta en un rango (paginando hasta el final). */
export async function movimientosEnRango(cuentaRef, desde, hasta) {
  const { lo, hi } = rangoSk(desde, hasta);
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tablaMovimientos(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: { ':pk': pkCuenta(cuentaRef), ':lo': lo, ':hi': hi },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function queryPorIndice(indexName, claveNombre, claveValor, {
  desde,
  hasta,
  estado,
  limite,
  cursor,
} = {}) {
  const condiciones = [`${claveNombre} = :clave`];
  const values = { ':clave': String(claveValor) };
  if (desde && hasta) {
    condiciones.push('fechaOperacion BETWEEN :desde AND :hasta');
    values[':desde'] = String(desde);
    values[':hasta'] = String(hasta);
  } else if (desde) {
    condiciones.push('fechaOperacion >= :desde');
    values[':desde'] = String(desde);
  } else if (hasta) {
    condiciones.push('fechaOperacion <= :hasta');
    values[':hasta'] = String(hasta);
  }
  if (estado) values[':estado'] = String(estado);

  const result = await docClient.send(
    new QueryCommand({
      TableName: tablaMovimientos(),
      IndexName: indexName,
      KeyConditionExpression: condiciones.join(' AND '),
      ...(estado && { FilterExpression: 'estadoConciliacion = :estado' }),
      ExpressionAttributeValues: values,
      Limit: normalizarLimite(limite),
      ScanIndexForward: false,
      ...(cursor && { ExclusiveStartKey: decodificarCursor(cursor) || undefined }),
    }),
  );
  return {
    movimientos: result.Items || [],
    cursor: codificarCursor(result.LastEvaluatedKey),
  };
}

/** Movimientos de una empresa (GSI EmpresaId-FechaOperacion-index). */
export function queryMovimientosEmpresa(empresaId, opciones = {}) {
  return queryPorIndice(GSI_EMPRESA_FECHA, 'empresaId', empresaId, opciones);
}

/** Movimientos por estado de conciliación (GSI Estado-FechaOperacion-index). */
export function queryMovimientosEstado(estado, opciones = {}) {
  const { estado: _ignorado, ...resto } = opciones;
  return queryPorIndice(GSI_ESTADO_FECHA, 'estadoConciliacion', estado, resto);
}

/**
 * Guarda un movimiento solo si no existía.
 *
 * Put individual con condición en vez de BatchWrite: BatchWriteItem no admite
 * ConditionExpression, así que reescribiría el movimiento ya guardado y perdería
 * el rastro de la carga original.
 * @param {Record<string, any>} item
 * @returns {Promise<'nuevo'|'duplicado'>}
 */
export async function putMovimientoSiNuevo(item) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: tablaMovimientos(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return 'nuevo';
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return 'duplicado';
    throw err;
  }
}

/**
 * Escribe una lista de movimientos con concurrencia limitada.
 * @param {Array<Record<string, any>>} items
 * @param {{ concurrencia?: number }} opciones
 * @returns {Promise<{ nuevos: number, duplicados: number }>}
 */
export async function escribirMovimientos(items, { concurrencia } = {}) {
  const lista = items || [];
  const ancho = Math.max(1, Number(concurrencia) || CONCURRENCIA_ESCRITURA);
  let indice = 0;
  let nuevos = 0;
  let duplicados = 0;

  async function trabajador() {
    while (indice < lista.length) {
      const propio = indice;
      indice += 1;
      const resultado = await putMovimientoSiNuevo(lista[propio]);
      if (resultado === 'nuevo') nuevos += 1;
      else duplicados += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(ancho, lista.length) }, trabajador));
  return { nuevos, duplicados };
}

/** Carga de extracto por su hash. */
export async function getFicheroCarga(hashFichero) {
  const hash = String(hashFichero || '').trim();
  if (!hash) return null;
  const result = await docClient.send(
    new GetCommand({ TableName: tablaFicheros(), Key: { hashFichero: hash } }),
  );
  return result.Item || null;
}

/**
 * Registra la carga solo si el fichero no estaba ya cargado.
 * @param {Record<string, any>} item
 * @returns {Promise<{ creado: boolean, existente: Record<string, any>|null }>}
 */
export async function putFicheroCargaSiNueva(item) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: tablaFicheros(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(hashFichero)',
      }),
    );
    return { creado: true, existente: null };
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    return { creado: false, existente: await getFicheroCarga(item.hashFichero) };
  }
}

/**
 * Guarda la ficha de carga pisando la que hubiera. Se usa para cerrar una carga
 * que ya estaba reservada con `putFicheroCargaSiNueva`.
 * @param {Record<string, any>} item
 */
export async function putFicheroCarga(item) {
  await docClient.send(new PutCommand({ TableName: tablaFicheros(), Item: item }));
}

/**
 * Listado de cargas (Scan filtrado), lo más reciente primero.
 * @param {{ desde?: string, hasta?: string, estado?: string, iban?: string, limite?: number }} filtros
 */
export async function listarFicherosCarga({ desde, hasta, estado, iban, limite } = {}) {
  const partes = [];
  const values = {};
  if (desde) {
    partes.push('importadoEn >= :desde');
    values[':desde'] = String(desde);
  }
  if (hasta) {
    partes.push('importadoEn <= :hasta');
    values[':hasta'] = `${String(hasta)}\uffff`;
  }
  if (estado) {
    partes.push('estado = :estado');
    values[':estado'] = String(estado);
  }

  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tablaFicheros(),
        ...(partes.length && {
          FilterExpression: partes.join(' AND '),
          ExpressionAttributeValues: values,
        }),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  const ibanFiltro = String(iban || '').trim();
  const filtrados = ibanFiltro
    ? items.filter((f) => (f.cuentas || []).some((c) => c.iban === ibanFiltro || c.cuentaRef === ibanFiltro))
    : items;

  filtrados.sort((a, b) => String(b.importadoEn || '').localeCompare(String(a.importadoEn || '')));
  const max = normalizarLimite(limite);
  return filtrados.slice(0, max);
}

/**
 * Movimientos guardados con un `hashFichero` concreto.
 * Recorre las cuentas del resumen de la carga; si no hay cuentas, hace un Scan
 * filtrado (caso raro de cargas antiguas o corruptas).
 * @param {string} hashFichero
 * @param {Array<{ cuentaRef?: string, iban?: string }>} [cuentas]
 */
export async function listarMovimientosDeCarga(hashFichero, cuentas = []) {
  const hash = String(hashFichero || '').trim();
  if (!hash) return [];

  const refs = new Set();
  for (const c of cuentas || []) {
    const ref = String(c?.cuentaRef || c?.iban || '').trim();
    if (ref) refs.add(ref);
  }

  const items = [];
  if (refs.size > 0) {
    for (const ref of refs) {
      let lastKey = null;
      do {
        const result = await docClient.send(
          new QueryCommand({
            TableName: tablaMovimientos(),
            KeyConditionExpression: 'PK = :pk',
            FilterExpression: 'hashFichero = :h',
            ExpressionAttributeValues: { ':pk': pkCuenta(ref), ':h': hash },
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          }),
        );
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    }
    return items;
  }

  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tablaMovimientos(),
        FilterExpression: 'hashFichero = :h',
        ExpressionAttributeValues: { ':h': hash },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/** Borra movimientos por PK/SK en lotes de 25. @returns {Promise<number>} */
export async function borrarMovimientos(items) {
  const lista = (items || []).filter((m) => m?.PK && m?.SK);
  let borrados = 0;
  for (let i = 0; i < lista.length; i += 25) {
    const lote = lista.slice(i, i + 25);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tablaMovimientos()]: lote.map((m) => ({
            DeleteRequest: { Key: { PK: m.PK, SK: m.SK } },
          })),
        },
      }),
    );
    borrados += lote.length;
  }
  return borrados;
}

/** Elimina el ítem de `Igp_BankFiles`. */
export async function borrarFicheroCarga(hashFichero) {
  const hash = String(hashFichero || '').trim();
  if (!hash) return;
  await docClient.send(
    new DeleteCommand({ TableName: tablaFicheros(), Key: { hashFichero: hash } }),
  );
}

/**
 * Compara IBAN / cuentaRef del resumen de carga con la clave pedida.
 * Ambos lados pasan por `limpiarIban` (tolera guiones/espacios).
 */
function cuentaFicheroCoincide(cuenta, cuentaRefOIban) {
  const clave = limpiarIban(cuentaRefOIban) || String(cuentaRefOIban || '').trim();
  if (!clave) return false;
  const iban = limpiarIban(cuenta?.iban) || String(cuenta?.iban || '').trim();
  const ref = limpiarIban(cuenta?.cuentaRef) || String(cuenta?.cuentaRef || '').trim();
  return iban === clave || ref === clave;
}

/**
 * Actualiza en memoria la entrada de `cuentas[]` de una carga tras asignar el
 * IBAN al maestro. No toca ficheros `en_curso`.
 *
 * @param {Record<string, any>|null|undefined} fichero
 * @param {string} cuentaRefOIban
 * @param {{ empresaId?: string, empresaNombre?: string }} [datos]
 * @returns {Record<string, any>|null} fichero actualizado, o null si no aplica
 */
export function aplicarAsignacionCuentaEnFichero(fichero, cuentaRefOIban, { empresaId, empresaNombre } = {}) {
  if (!fichero || typeof fichero !== 'object') return null;
  if (fichero.estado === ESTADO_FICHERO_EN_CURSO) return null;

  const cuentas = Array.isArray(fichero.cuentas) ? [...fichero.cuentas] : [];
  const idx = cuentas.findIndex((c) => cuentaFicheroCoincide(c, cuentaRefOIban));
  if (idx < 0) return null;

  const previa = cuentas[idx] && typeof cuentas[idx] === 'object' ? cuentas[idx] : {};
  // Solo las que quedaron huérfanas en la ingesta; si ya estaba asignada, no pisar.
  if (previa.pendienteAsignar !== true) return null;

  cuentas[idx] = {
    ...previa,
    pendienteAsignar: false,
    empresaId: String(empresaId || '').trim(),
    empresaNombre: String(empresaNombre || '').trim(),
  };

  const siguePendiente = cuentas.some((c) => c?.pendienteAsignar === true);
  return {
    ...fichero,
    cuentas,
    estado: siguePendiente ? ESTADO_FICHERO_PENDIENTE_CUENTA : ESTADO_FICHERO_CARGADO,
  };
}

/**
 * Marca en `Igp_BankFiles` que una cuenta del extracto ya está en el maestro.
 * @param {string} hashFichero
 * @param {string} cuentaRefOIban
 * @param {{ empresaId?: string, empresaNombre?: string }} [datos]
 * @returns {Promise<Record<string, any>|null>}
 */
export async function marcarCuentaAsignadaEnFichero(hashFichero, cuentaRefOIban, datos = {}) {
  const fichero = await getFicheroCarga(hashFichero);
  const actualizado = aplicarAsignacionCuentaEnFichero(fichero, cuentaRefOIban, datos);
  if (!actualizado) return null;
  await putFicheroCarga(actualizado);
  return actualizado;
}

/**
 * Rellena el `empresaId` de los movimientos de una cuenta que se importaron sin
 * él (el IBAN no estaba en el maestro). Sin ese atributo el movimiento no entra
 * en el GSI de empresa, así que hasta que se ejecuta esto no aparece en las
 * consultas por empresa.
 *
 * La llama el alta de cuenta bancaria (`POST /empresas/:id/cuentas` y
 * `POST /banca/ficheros/:hash/asignar-cuenta`).
 * @param {string} cuentaRef IBAN (o CCC) con el que se guardaron los movimientos.
 * @param {string} empresaId
 * @param {{ empresaNombre?: string }} [datos]
 * @returns {Promise<{ actualizados: number }>}
 */
export async function asignarEmpresaAMovimientos(cuentaRef, empresaId, { empresaNombre } = {}) {
  const empresa = String(empresaId || '').trim();
  if (!cuentaRef || !empresa) return { actualizados: 0 };

  const pendientes = (await movimientosEnRango(cuentaRef)).filter((m) => !m.empresaId);
  const ahora = new Date().toISOString();
  let actualizados = 0;
  for (const mov of pendientes) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tablaMovimientos(),
          Key: { PK: mov.PK, SK: mov.SK },
          UpdateExpression: 'SET empresaId = :empresa, empresaNombre = :nombre, actualizadoEn = :ahora',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(empresaId)',
          ExpressionAttributeValues: {
            ':empresa': empresa,
            ':nombre': String(empresaNombre || mov.empresaNombre || ''),
            ':ahora': ahora,
          },
        }),
      );
      actualizados += 1;
    } catch (err) {
      // Otro proceso pudo asignarle empresa entre la lectura y el Update.
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  return { actualizados };
}
