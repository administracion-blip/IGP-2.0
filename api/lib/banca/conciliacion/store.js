/**
 * Acceso a datos de la conciliación bancaria.
 *
 * Aparte de `lib/banca/store.js` —que es el acceso a los movimientos tal y como
 * los deja la importación— porque aquí se escriben campos que solo existen a
 * partir de la conciliación (`conciliadoCentimos`, `conciliaciones`,
 * `sugerenciasDescartadas`) y se leen facturas, que son de otro dominio.
 *
 * OJO al escribir `estadoConciliacion`: es la clave HASH del GSI
 * `Estado-FechaOperacion-index`, así que cambiarla mueve el ítem de partición
 * dentro del índice. Es lo que se quiere (el listado de pendientes es una Query
 * a ese índice), pero por eso el estado se escribe siempre desde
 * `derivarEstado()` y nunca a mano.
 */

import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../../db.js';
import { formatId6 } from '../../usuarioLocales.js';
import {
  ESTADO_PARCIAL,
  ESTADO_PENDIENTE,
  ESTADOS_FACTURA_ELEGIBLES,
  facturaElegible,
} from './estado.js';
import { pkCuenta, queryMovimientosEmpresa, queryMovimientosEstado, skMovimiento } from '../store.js';

/** Tope de movimientos que entran en un barrido de sugerencias. */
const LIMITE_MOVIMIENTOS = 300;
const LIMITE_MOVIMIENTOS_MAXIMO = 1000;

/**
 * Alguien escribió el movimiento entre que se leyó y que se guardó. Quien llama
 * decide qué hacer: la conciliación reintenta fundiendo lo que haya.
 */
export const CODIGO_CONFLICTO_MOVIMIENTO = 'CONFLICTO_MOVIMIENTO';

function texto(val) {
  return val != null ? String(val).trim() : '';
}

function entero(valor) {
  return Math.max(0, Math.trunc(Number(valor) || 0));
}

/**
 * Condición de escritura del movimiento.
 *
 * `attribute_exists(PK)` evita que un Update sobre un movimiento borrado lo
 * resucite con solo la clave y el estado, sin importe ni concepto.
 *
 * Con `esperado` se añade el control de concurrencia: la escritura solo entra si
 * `conciliadoCentimos` sigue valiendo lo que valía cuando se leyó. Sin esto, dos
 * personas conciliando el mismo apunte a la vez pasan las dos validaciones (cada
 * una ve el importe entero libre), crean cada una su pago —son facturas
 * distintas, la clave de idempotencia no lo impide— y la última escritura pisa el
 * array de la otra: el movimiento acaba diciendo que tiene menos aplicado del que
 * de verdad le cuelga y la conciliación perdida ya no se puede deshacer.
 *
 * Los ítems importados antes de que existiera el atributo no lo tienen, así que
 * su ausencia cuenta como cero.
 */
function condicionMovimiento(esperado) {
  if (esperado == null) return { expresion: 'attribute_exists(PK)', valores: {} };
  return {
    expresion: 'attribute_exists(PK) AND '
      + '(attribute_not_exists(conciliadoCentimos) OR conciliadoCentimos = :esperado)',
    valores: { ':esperado': entero(esperado) },
  };
}

/** Traduce el fallo de la condición a un error propio, reconocible por `code`. */
function comoConflicto(err) {
  if (err?.name !== 'ConditionalCheckFailedException') return err;
  return Object.assign(
    new Error('El movimiento ha cambiado mientras se guardaba la conciliación'),
    { code: CODIGO_CONFLICTO_MOVIMIENTO, status: 409, conflicto: true },
  );
}

export function normalizarLimiteBarrido(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return LIMITE_MOVIMIENTOS;
  return Math.min(Math.trunc(n), LIMITE_MOVIMIENTOS_MAXIMO);
}

/** Clave primaria del movimiento a partir del propio ítem. */
export function claveMovimiento(movimiento) {
  return {
    PK: movimiento?.PK || pkCuenta(movimiento?.cuentaRef),
    SK: movimiento?.SK || skMovimiento(movimiento?.fechaOperacion, movimiento?.movementHash),
  };
}

/**
 * Movimiento por cuenta y huella.
 *
 * La clave de ordenación lleva la fecha (`TXN#<fecha>#<hash>`), así que sin la
 * fecha no hay GetItem posible: se consulta la partición de la cuenta filtrando
 * por huella. Si el llamante conoce la fecha se usa el camino rápido.
 *
 * @param {string} cuentaRef
 * @param {string} movementHash
 * @param {{ fechaOperacion?: string }} [opciones]
 * @returns {Promise<Record<string, any>|null>}
 */
export async function getMovimiento(cuentaRef, movementHash, { fechaOperacion } = {}) {
  const cuenta = texto(cuentaRef);
  const hash = texto(movementHash);
  if (!cuenta || !hash) return null;

  if (texto(fechaOperacion)) {
    const result = await docClient.send(
      new GetCommand({
        TableName: tables.bankMovements,
        Key: { PK: pkCuenta(cuenta), SK: skMovimiento(fechaOperacion, hash) },
      }),
    );
    if (result.Item) return result.Item;
  }

  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tables.bankMovements,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefijo)',
        FilterExpression: 'movementHash = :hash',
        ExpressionAttributeValues: { ':pk': pkCuenta(cuenta), ':prefijo': 'TXN#', ':hash': hash },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    const encontrado = (result.Items || [])[0];
    if (encontrado) return encontrado;
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return null;
}

/**
 * Guarda el resultado de una conciliación en el movimiento.
 *
 * @param {object} datos
 * @param {Record<string, any>} datos.movimiento Ítem original (de él salen PK/SK).
 * @param {object[]} datos.conciliaciones
 * @param {number} datos.conciliadoCentimos
 * @param {string} datos.estadoConciliacion
 * @param {number} [datos.esperadoCentimos] `conciliadoCentimos` que se leyó; si no
 *   coincide con lo guardado, la escritura falla con `CODIGO_CONFLICTO_MOVIMIENTO`.
 * @param {string} [datos.usuario]
 * @returns {Promise<Record<string, any>>} Movimiento actualizado.
 */
export async function guardarConciliacion({
  movimiento,
  conciliaciones,
  conciliadoCentimos,
  estadoConciliacion,
  esperadoCentimos,
  usuario,
}) {
  const condicion = condicionMovimiento(esperadoCentimos);
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: tables.bankMovements,
        Key: claveMovimiento(movimiento),
        UpdateExpression: 'SET conciliaciones = :conciliaciones, conciliadoCentimos = :centimos, '
          + 'estadoConciliacion = :estado, actualizadoEn = :ahora, actualizadoPor = :autor',
        ConditionExpression: condicion.expresion,
        ExpressionAttributeValues: {
          ':conciliaciones': conciliaciones || [],
          ':centimos': entero(conciliadoCentimos),
          ':estado': String(estadoConciliacion),
          ':ahora': new Date().toISOString(),
          ':autor': texto(usuario),
          ...condicion.valores,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return result.Attributes;
  } catch (err) {
    throw comoConflicto(err);
  }
}

/**
 * Marca una factura como "no es de este movimiento" para que no vuelva a
 * proponerse. Idempotente: si ya estaba descartada no se escribe nada.
 *
 * @param {{ movimiento: Record<string, any>, idFactura: string, usuario?: string }} datos
 * @returns {Promise<{ yaEstaba: boolean, descartadas: string[] }>}
 */
export async function descartarSugerencia({ movimiento, idFactura, usuario }) {
  const id = texto(idFactura);
  const previas = Array.isArray(movimiento?.sugerenciasDescartadas)
    ? movimiento.sugerenciasDescartadas.map((x) => String(x))
    : [];
  if (previas.includes(id)) return { yaEstaba: true, descartadas: previas };

  const result = await docClient.send(
    new UpdateCommand({
      TableName: tables.bankMovements,
      Key: claveMovimiento(movimiento),
      UpdateExpression: 'SET sugerenciasDescartadas = :lista, actualizadoEn = :ahora, actualizadoPor = :autor',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: {
        ':lista': [...previas, id],
        ':ahora': new Date().toISOString(),
        ':autor': texto(usuario),
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return { yaEstaba: false, descartadas: result.Attributes?.sugerenciasDescartadas || [] };
}

/**
 * Cambia solo el estado del movimiento (ignorar / dejar de ignorar).
 *
 * Va condicionado igual que `guardarConciliacion`: ignorar un movimiento se
 * decide habiendo comprobado que no tiene pagos aplicados, y si a alguien le
 * entra uno en medio, marcarlo como "no es una factura" dejaría pagos colgando
 * de un apunte que dice no tener ninguno.
 *
 * @param {{ movimiento: Record<string, any>, estadoConciliacion: string,
 *   esperadoCentimos?: number, usuario?: string }} datos
 */
export async function guardarEstadoMovimiento({ movimiento, estadoConciliacion, esperadoCentimos, usuario }) {
  const condicion = condicionMovimiento(esperadoCentimos);
  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: tables.bankMovements,
        Key: claveMovimiento(movimiento),
        UpdateExpression: 'SET estadoConciliacion = :estado, actualizadoEn = :ahora, actualizadoPor = :autor',
        ConditionExpression: condicion.expresion,
        ExpressionAttributeValues: {
          ':estado': String(estadoConciliacion),
          ':ahora': new Date().toISOString(),
          ':autor': texto(usuario),
          ...condicion.valores,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return result.Attributes;
  } catch (err) {
    throw comoConflicto(err);
  }
}

/** Factura por id (la tabla resuelve su clave con DescribeTable). */
export async function getFactura(idFactura) {
  const id = texto(idFactura);
  if (!id) return null;
  const result = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
  );
  return result.Item || null;
}

/**
 * Facturas conciliables de un tipo.
 *
 * Scan filtrado, como el resto de las consultas de `Igp_Facturas` (la tabla no
 * tiene GSI por tipo ni por estado). El filtro de estado se manda al servicio
 * para no traerse las pagadas y las anuladas, que son la mayoría con el tiempo.
 *
 * @param {string} tipo 'IN' | 'OUT'
 * @param {{ empresaId?: string }} [filtros] `empresaId` = sociedad del grupo (emisor_id).
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function listarFacturasElegibles(tipo, { empresaId } = {}) {
  const estados = [...ESTADOS_FACTURA_ELEGIBLES];
  const valores = { ':tipo': String(tipo) };
  estados.forEach((estado, i) => {
    valores[`:e${i}`] = estado;
  });
  const filtroEstados = estados.map((_, i) => `#estado = :e${i}`).join(' OR ');

  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.facturas,
        FilterExpression: `#tipo = :tipo AND (${filtroEstados})`,
        ExpressionAttributeNames: { '#tipo': 'tipo', '#estado': 'estado' },
        ExpressionAttributeValues: valores,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  // El maestro no guarda los id normalizados: la misma sociedad está unas veces
  // como "7" y otras como "000007". Comparar en crudo dejaría el barrido sin una
  // sola factura y la pantalla diría "no hay sugerencias" en vez de fallar, que
  // es la peor manera de equivocarse. El motor ya compara así.
  const sociedad = texto(empresaId);
  const normalizada = sociedad ? formatId6(sociedad) : '';
  return items.filter((f) => facturaElegible(f)
    && (!normalizada || formatId6(texto(f.emisor_id)) === normalizada));
}

/**
 * Movimientos que aún pueden conciliarse (pendientes y parciales).
 *
 * Con `empresaId` va por el GSI de empresa; sin él, por el de estado. Los
 * movimientos cuyo IBAN no está dado de alta no tienen `empresaId` y por tanto
 * no están en el índice de empresa: solo aparecen en el barrido sin filtro de
 * sociedad. Es la contrapartida conocida de no indexar `empresaId: ''`.
 *
 * @param {{ empresaId?: string, desde?: string, hasta?: string, limite?: number }} filtros
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function listarMovimientosAbiertos({ empresaId, desde, hasta, limite } = {}) {
  const tope = normalizarLimiteBarrido(limite);
  const sociedad = texto(empresaId);

  if (sociedad) {
    const { movimientos } = await queryMovimientosEmpresa(sociedad, { desde, hasta, limite: tope });
    return movimientos.filter((m) => m.estadoConciliacion === ESTADO_PENDIENTE
      || m.estadoConciliacion === ESTADO_PARCIAL);
  }

  const pendientes = await queryMovimientosEstado(ESTADO_PENDIENTE, { desde, hasta, limite: tope });
  const parciales = await queryMovimientosEstado(ESTADO_PARCIAL, { desde, hasta, limite: tope });
  return [...pendientes.movimientos, ...parciales.movimientos]
    .sort((a, b) => String(b.fechaOperacion || '').localeCompare(String(a.fechaOperacion || '')))
    .slice(0, tope);
}
