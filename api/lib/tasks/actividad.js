/**
 * Registro de actividad del módulo de dirección.
 *
 * Append-only y **transversal a las cuatro entidades** (proyecto, tarea, línea de
 * compra, reunión), con el patrón de `Igp_FacturasAuditoria` pero genérico desde el
 * principio: cuatro tablas de auditoría con el mismo esquema serían cuatro sitios
 * donde arreglar el mismo error.
 *
 * - **PK** `<TIPO>#<id_entidad>` — `PROY#…`, `TAREA#…`, `COMPRA#…`, `REU#…`
 * - **SK** `ACT#<iso>#<uuid>`
 * - Sin índices: siempre se consulta por entidad.
 *
 * El `uuid` del SK no es decorativo: dos procesos escribiendo en el mismo
 * milisegundo colisionarían con solo el instante, y en una tabla append-only una
 * colisión es una entrada perdida en silencio. Dentro de un mismo proceso, el orden
 * lo garantiza además `instanteMonotono()`.
 *
 * Ver `docs/tasks/02-modelo-datos.md`.
 */

import crypto from 'crypto';
import { PutCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { SK } from './tipos.js';
import { codificarCursor, decodificarCursor, limiteValido } from './paginacion.js';

/**
 * Prefijo de partición por tipo de entidad. La línea de compra tiene el suyo
 * aunque viva dentro de la partición del proyecto: su historial se consulta por
 * línea, no por proyecto, y mezclarlos obligaría a filtrar en memoria.
 */
export const PREFIJO_ENTIDAD = Object.freeze({
  proyecto: 'PROY',
  tarea: 'TAREA',
  compra: 'COMPRA',
  reunion: 'REU',
});

export const TIPOS_ENTIDAD_ACTIVIDAD = Object.freeze(Object.keys(PREFIJO_ENTIDAD));

/**
 * Acciones registradas. La lista está abierta a propósito —cada fase añade las
 * suyas— pero las que ya se usan viven aquí para que no aparezcan como literales
 * sueltos repartidos por los handlers.
 */
export const ACCIONES = Object.freeze({
  creada: 'creada',
  editada: 'editada',
  borrada: 'borrada',
  estadoCambiado: 'estado_cambiado',
  reasignada: 'reasignada',
  miembroAnadido: 'miembro_anadido',
  miembroQuitado: 'miembro_quitado',
  vinculoAnadido: 'vinculo_anadido',
  vinculoQuitado: 'vinculo_quitado',
  comentario: 'comentario',
  checklistCambiada: 'checklist_cambiada',
  enlaceAnadido: 'enlace_anadido',
  enlaceCapturado: 'enlace_capturado',
  enlaceBorrado: 'enlace_borrado',
  adjuntoAnadido: 'adjunto_anadido',
  adjuntoBorrado: 'adjunto_borrado',
  compraPropuesta: 'compra_propuesta',
  compraAprobada: 'compra_aprobada',
  compraRechazada: 'compra_rechazada',
  compraEstadoCambiado: 'compra_estado_cambiado',
  audioBorrado: 'audio_borrado',
  actaValidada: 'acta_validada',
});

/** Acciones en las que el importe es obligatorio: sin él, la traza no sirve de nada. */
const ACCIONES_CON_IMPORTE = Object.freeze([
  ACCIONES.compraAprobada,
  ACCIONES.compraRechazada,
]);

/** Autor de las acciones que no dispara una persona (jobs, cron, pipeline). */
export const AUTOR_SISTEMA = 'sistema';

/**
 * Tope del campo `detalle`. Un ítem de DynamoDB no pasa de 400 KB y el antes/después
 * de una entidad grande podría acercarse: se recorta con marca visible en lugar de
 * hacer fallar la escritura, porque perder el detalle es malo pero perder la entrada
 * entera es peor.
 */
const MAX_DETALLE = 8000;

/**
 * Último instante entregado, para que el historial de un proceso sea estrictamente
 * creciente.
 *
 * `Date.now()` solo tiene resolución de milisegundo, y un handler que registra dos
 * acciones seguidas —o un lote de cincuenta tareas— las produce todas en el mismo.
 * Con el instante repetido, el orden dentro de ese milisegundo lo decidiría el UUID
 * del SK, que es aleatorio: el historial podría mostrar «reasignada» antes de
 * «estado_cambiado» aunque se escribieran al contrario.
 *
 * El precio es que, en una ráfaga, `creado_en` puede adelantarse tantos
 * milisegundos como entradas haya en la ráfaga. Cincuenta tareas son cincuenta
 * milisegundos, y se reabsorbe en cuanto el reloj real adelanta.
 */
let ultimoInstante = 0;

function instanteMonotono() {
  const ahora = Date.now();
  ultimoInstante = ahora > ultimoInstante ? ahora : ultimoInstante + 1;
  return new Date(ultimoInstante).toISOString();
}

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

/** @param {'proyecto'|'tarea'|'compra'|'reunion'} tipo */
export function pkActividad(tipo, entidadId) {
  const prefijo = PREFIJO_ENTIDAD[tipo];
  if (!prefijo) throw new Error(`Tipo de entidad de actividad no válido: ${tipo}`);
  const id = texto(entidadId);
  if (!id) throw new Error('La actividad necesita el id de la entidad');
  return `${prefijo}#${id}`;
}

function serializarDetalle(detalle) {
  if (detalle == null) return '';
  const bruto = typeof detalle === 'string' ? detalle : JSON.stringify(detalle);
  const cadena = texto(bruto);
  if (cadena.length <= MAX_DETALLE) return cadena;
  return `${cadena.slice(0, MAX_DETALLE)}…[recortado]`;
}

/**
 * Construye la entrada sin escribirla. Se expone porque la creación en lote de
 * tareas necesita preparar todas las entradas antes de mandarlas juntas.
 *
 * @param {object} opciones
 * @param {'proyecto'|'tarea'|'compra'|'reunion'} opciones.tipo
 * @param {string} opciones.entidadId
 * @param {string} opciones.accion
 * @param {{ id_usuario?: string, sub?: string, Nombre?: string, nombre?: string }} [opciones.usuario]
 * @param {object|string} [opciones.detalle] Antes y después del cambio.
 * @param {number} [opciones.importe] Obligatorio al aprobar o rechazar una compra.
 */
export function construirEntradaActividad({ tipo, entidadId, accion, usuario, detalle, importe }) {
  const codigo = texto(accion);
  if (!codigo) throw new Error('La actividad necesita una acción');

  const creadoEn = instanteMonotono();
  const item = {
    PK: pkActividad(tipo, entidadId),
    SK: SK.actividad(creadoEn, crypto.randomUUID()),
    accion: codigo,
    // Nunca vacío: una entrada sin autor no se puede auditar. Lo que no dispara
    // una persona queda a nombre del sistema, de forma explícita.
    usuario_id: texto(usuario?.id_usuario ?? usuario?.sub) || AUTOR_SISTEMA,
    usuario_nombre: texto(usuario?.Nombre ?? usuario?.nombre),
    creado_en: creadoEn,
  };

  const detalleSerializado = serializarDetalle(detalle);
  if (detalleSerializado) item.detalle = detalleSerializado;

  const n = Number(importe);
  if (Number.isFinite(n)) item.importe = n;
  else if (ACCIONES_CON_IMPORTE.includes(codigo)) {
    throw new Error(`La acción ${codigo} exige un importe`);
  }

  return item;
}

/**
 * Escribe una entrada. No lanza hacia arriba si DynamoDB falla: perder una línea
 * de historial no debe tumbar la operación que el usuario acaba de hacer con éxito.
 * Un error de validación —tipo o acción inválidos— sí lanza, porque es un fallo de
 * programación y conviene verlo en desarrollo.
 */
export async function registrarActividad(opciones) {
  const item = construirEntradaActividad(opciones);
  try {
    await docClient.send(new PutCommand({ TableName: tables.actividad, Item: item }));
    return item;
  } catch (err) {
    console.error('[tasks/actividad] no se pudo registrar la actividad', item.PK, item.accion, err);
    return null;
  }
}

/** Límite de `BatchWriteItem`. */
const MAX_LOTE = 25;
const MAX_INTENTOS_LOTE = 3;

/**
 * Escribe varias entradas. Igual que la individual, un fallo se registra y no se
 * propaga. Los elementos que DynamoDB devuelve sin procesar se reintentan, porque
 * `BatchWrite` no garantiza escribirlos todos en la primera pasada.
 *
 * @param {Array<Parameters<typeof construirEntradaActividad>[0]>} entradas
 */
export async function registrarActividadLote(entradas) {
  const items = (Array.isArray(entradas) ? entradas : []).map(construirEntradaActividad);
  if (items.length === 0) return [];

  for (let i = 0; i < items.length; i += MAX_LOTE) {
    let pendientes = items.slice(i, i + MAX_LOTE).map((Item) => ({ PutRequest: { Item } }));
    for (let intento = 0; intento < MAX_INTENTOS_LOTE && pendientes.length > 0; intento += 1) {
      try {
        const res = await docClient.send(
          new BatchWriteCommand({ RequestItems: { [tables.actividad]: pendientes } }),
        );
        pendientes = res?.UnprocessedItems?.[tables.actividad] || [];
      } catch (err) {
        console.error('[tasks/actividad] falló un lote de actividad', err);
        pendientes = [];
      }
    }
  }
  return items;
}

/**
 * Historial de una entidad, **más reciente primero** y paginado.
 *
 * @param {object} opciones
 * @param {'proyecto'|'tarea'|'compra'|'reunion'} opciones.tipo
 * @param {string} opciones.entidadId
 * @param {number} [opciones.limite]
 * @param {string} [opciones.cursor]
 * @returns {Promise<{ actividad: object[], cursor: string|null }>}
 */
export async function listarActividad({ tipo, entidadId, limite, cursor } = {}) {
  const pk = pkActividad(tipo, entidadId);
  const desde = decodificarCursor(cursor);
  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.actividad,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      // El SK empieza por el instante, así que el orden inverso de la clave ya es
      // el cronológico inverso: no hace falta ordenar en memoria.
      ScanIndexForward: false,
      Limit: limiteValido(limite),
      ...(desde && { ExclusiveStartKey: desde }),
    }),
  );

  return {
    actividad: (res.Items || []).map(({ PK: _pk, SK: _sk, ...resto }) => resto),
    cursor: codificarCursor(res.LastEvaluatedKey),
  };
}
