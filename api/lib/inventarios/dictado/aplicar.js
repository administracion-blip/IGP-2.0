/**
 * Aplica al conteo las líneas de una sesión de dictado.
 *
 * Reglas:
 * - Solo se aplican líneas 'confirmada' o 'pendiente' con confirmar=false. Las demás vuelven en
 *   `rechazadas` con su motivo y no se escribe nada.
 * - Sin confirmar (estado 'pendiente') nunca se toca un producto que ya tiene stock contado
 *   ('ya_contado'), ni se guarda un total que no cabe exacto en las fracciones de botella
 *   ('redondeo'). Lo comprueba con la LINE# leída dentro del bucle, y la condición de versión de
 *   la transacción garantiza que nadie la contó entre medias.
 * - sumar: contado actual (stockContado de la LINE#: enteras + botella abierta) + total dictado;
 *   reemplazar: el total dictado; ambos se reparten con partirCantidad. Un total negativo se
 *   rechaza ('total_negativo'). borrar: la línea vuelve a «sin contar» (stockReal null, botellas 0),
 *   igual que un PUT /lineas con stockReal null; si el producto no está en el conteo, 'no_en_conteo'.
 * - Si el producto no está en el conteo se añade antes con anadirProducto (mismas reglas que
 *   POST /inventarios/:id/lineas: teórico de Ágora solo lectura). Si no se puede añadir ('producto_no_anadible',
 *   'agora_no_disponible') o falla otra cosa de esa línea, va a `rechazadas` y el lote sigue.
 *
 * Idempotencia: la escritura de LINE#<pid> (con las operaciones de guardarLinea, vía
 * escrituraLinea) y el paso de la línea de dictado a 'aplicada' van en UNA TransactWrite. La
 * línea de dictado exige seguir en pendiente/confirmada y con el mismo actualizadoEn que se leyó;
 * LINE# exige los mismos stockReal/botellasAbiertas/stockTeorico leídos, así que no se pierde la
 * escritura concurrente de otro usuario. Si la transacción falla se vuelve a leer (hasta 3 veces):
 * si la línea ya está aplicada, se devuelve su resultado guardado con yaAplicada=true.
 *
 * IGP no escribe en Ágora.
 */

import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../db.js';
import { logger } from '../../logger.js';
import { errorInventario, idSegmento, pkInventario, skDictadoLinea, usuarioSegmento } from '../claves.js';
import { anadirProducto } from '../conteo.js';
import { stockContado } from '../diferencia.js';
import { escrituraLinea, exigirConteo, leerLineaConteo, obtenerInventario } from '../inventarios.js';
import { tablaInventarios } from '../store.js';
import { partirCantidad } from './parser.js';
import { MAX_LINEAS_POR_ENVIO, leerLineaDictado } from './sesion.js';

const MAX_INTENTOS = 3;

function redondear4(n) {
  return Math.round(n * 10000) / 10000;
}

/** Lista de números de línea: enteros ≥ 1, sin repetir y en orden. */
export function numerosDeLineas(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw errorInventario('lineas debe ser una lista con al menos un número de línea.');
  }
  if (raw.length > MAX_LINEAS_POR_ENVIO) {
    throw errorInventario(`Como máximo ${MAX_LINEAS_POR_ENVIO} líneas por envío.`);
  }
  const ns = raw.map((v) => {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 1) throw errorInventario('Número de línea de dictado no válido.');
    return n;
  });
  return [...new Set(ns)].sort((a, b) => a - b);
}

/** Condición «LINE# sigue como se leyó». Lo que no existía tiene que seguir sin existir. */
function condicionVersion(previa) {
  const partes = [];
  const valores = {};
  const campo = (nombre, marcador) => {
    if (previa[nombre] == null) {
      partes.push(`attribute_not_exists(${nombre})`);
    } else {
      partes.push(`${nombre} = ${marcador}`);
      valores[marcador] = previa[nombre];
    }
  };
  campo('stockReal', ':vReal');
  campo('botellasAbiertas', ':vBotellas');
  campo('stockTeorico', ':vTeorico');
  return { expresion: partes.join(' AND '), valores };
}

function rechazo(n, motivo, extra = {}) {
  return { n, motivo, ...extra };
}

function resultadoAplicado(item) {
  return {
    stockReal: item.aplicado?.stockReal ?? null,
    botellasAbiertas: item.aplicado?.botellasAbiertas ?? 0,
  };
}

/** Por qué no se puede aplicar la línea tal como está, o null si se puede. */
function motivoNoAplicable(item) {
  if (item.estado === 'descartada') return 'descartada';
  if (item.estado === 'pendiente' && item.confirmar) return 'requiere_confirmacion';
  if (item.estado !== 'pendiente' && item.estado !== 'confirmada') return 'estado_no_valido';
  if (!item.productId) return 'sin_producto';
  if (!item.modo) return 'sin_modo';
  if (item.modo !== 'borrar' && (item.cantidad == null || typeof item.cantidad.total !== 'number')) {
    return 'sin_cantidad';
  }
  return null;
}

/**
 * stockReal/botellasAbiertas que quedarán, o { negativo: true }. `redondeada`: el total no cabe
 * exacto en las fracciones de botella y se guardará otro valor.
 */
export function calcularResultado(modo, cantidad, previa) {
  if (modo === 'borrar') return { stockReal: null, botellasAbiertas: 0, redondeada: false };
  const dictado = cantidad.total;
  const total = modo === 'sumar' ? redondear4((stockContado(previa) ?? 0) + dictado) : dictado;
  if (total < 0) return { negativo: true };
  const p = partirCantidad(total);
  return { stockReal: p.stockReal, botellasAbiertas: p.botellasAbiertas, redondeada: p.redondeada };
}

/** Motivo de rechazo de un error de una sola línea; el lote sigue con las demás. */
function motivoDeError(err) {
  if (err?.status === 502) return 'agora_no_disponible';
  if (err?.status === 403) return 'estado_inventario';
  if (err?.status === 409) return 'conflicto';
  if (err?.status >= 400 && err?.status < 500) return 'no_valida';
  return null;
}

function esCancelada(err) {
  return err?.name === 'TransactionCanceledException' || err?.name === 'ConditionalCheckFailedException';
}

/**
 * @param {{
 *   inventarioId: string, usuarioId: string, quien: string, quienSesion: string,
 *   lineas: unknown, soloContar: boolean, exportStocks: Function, inventario?: object,
 * }} args `usuarioId` es el id de la sesión (req.user.sub); `quien` va al META del inventario
 *   como en guardarLinea; `quienSesion`, a actualizadoPor de la línea de dictado. `inventario`
 *   (obtenerInventario ya leído por la ruta) evita releerlo; tras un conflicto se relee.
 * @returns {Promise<{ aplicadas: object[], rechazadas: object[] }>}
 *   Un error de una línea (estado del inventario, Ágora…) la deja en `rechazadas` y sigue.
 * @throws errorInventario 400 si `lineas` no es una lista válida.
 */
export async function aplicarLineasDictado({
  inventarioId, usuarioId, quien, quienSesion, lineas, soloContar, exportStocks, inventario = null,
}) {
  const id = idSegmento(inventarioId, 'inventarioId');
  const u = usuarioSegmento(usuarioId);
  const ns = numerosDeLineas(lineas);
  const ctx = { id, u, usuarioId, quien, quienSesion, soloContar, exportStocks, inventario };
  const aplicadas = [];
  const rechazadas = [];
  for (const n of ns) {
    let r;
    try {
      r = await aplicarUna(ctx, n);
    } catch (err) {
      const motivo = motivoDeError(err);
      if (!motivo) {
        logger.error({ err, inventarioId: id, n }, '[dictado] error aplicando una línea');
        r = { rechazada: rechazo(n, 'error_interno') };
      } else {
        r = { rechazada: rechazo(n, motivo, { mensaje: err.message }) };
      }
      ctx.inventario = null;
    }
    if (r.rechazada) rechazadas.push(r.rechazada);
    else aplicadas.push(r.aplicada);
  }
  return { aplicadas, rechazadas };
}

function yaAplicada(n, item) {
  return {
    aplicada: { n, productId: item.productId, modo: item.modo, ...resultadoAplicado(item), yaAplicada: true },
  };
}

async function aplicarUna(ctx, n) {
  const { id, u, usuarioId, quien, quienSesion, soloContar, exportStocks } = ctx;
  const tabla = tablaInventarios();
  const pk = pkInventario(id);
  for (let intento = 0; intento < MAX_INTENTOS; intento += 1) {
    const item = await leerLineaDictado(id, usuarioId, n);
    if (!item) return { rechazada: rechazo(n, 'no_encontrada') };
    if (item.estado === 'aplicada') return yaAplicada(n, item);
    const motivo = motivoNoAplicable(item);
    if (motivo) {
      return { rechazada: rechazo(n, motivo, { motivos: Array.isArray(item.motivos) ? item.motivos : [] }) };
    }

    if (!ctx.inventario) ctx.inventario = await obtenerInventario(id);
    const { inventario } = ctx;
    exigirConteo(inventario, soloContar);
    const pid = item.productId;
    let previa = await leerLineaConteo(id, pid);
    if (!previa && item.modo === 'borrar') return { rechazada: rechazo(n, 'no_en_conteo') };
    if (!previa) {
      try {
        await anadirProducto(id, pid, quien, { soloContar, exportStocks });
      } catch (err) {
        if (err?.status === 404) return { rechazada: rechazo(n, 'producto_no_encontrado') };
        if (err?.status === 403) return { rechazada: rechazo(n, 'producto_no_anadible', { mensaje: err.message }) };
        if (err?.status === 502) return { rechazada: rechazo(n, 'agora_no_disponible', { mensaje: err.message }) };
        if (err?.status !== 409) throw err;
      }
      previa = await leerLineaConteo(id, pid);
      if (!previa) continue;
    }

    // Rechazos que dependen de lo leído en LINE#: si otra petición acaba de aplicar esta misma
    // línea (y por eso LINE# ya está contada), se responde yaAplicada en vez de rechazar.
    const rechazarTrasLeer = async (motivoRechazo) => {
      const ahoraItem = await leerLineaDictado(id, usuarioId, n);
      if (ahoraItem?.estado === 'aplicada') return yaAplicada(n, ahoraItem);
      if (ahoraItem && ahoraItem.actualizadoEn !== item.actualizadoEn) return null;
      return { rechazada: rechazo(n, motivoRechazo) };
    };
    const sinConfirmar = item.estado !== 'confirmada';
    if (sinConfirmar && stockContado(previa) != null) {
      const r = await rechazarTrasLeer('ya_contado');
      if (r) return r;
      continue;
    }
    const resultado = calcularResultado(item.modo, item.cantidad, previa);
    if (resultado.negativo || (sinConfirmar && resultado.redondeada)) {
      const r = await rechazarTrasLeer(resultado.negativo ? 'total_negativo' : 'redondeo');
      if (r) return r;
      continue;
    }

    const ahora = new Date().toISOString();
    const { operaciones } = escrituraLinea(
      inventario,
      previa,
      { productId: pid, stockReal: resultado.stockReal, botellasAbiertas: resultado.botellasAbiertas },
      quien,
      { soloContar, condicionExtra: condicionVersion(previa) },
    );
    operaciones.push({
      Update: {
        TableName: tabla,
        Key: { PK: pk, SK: skDictadoLinea(u, n) },
        UpdateExpression: 'SET estado = :aplicada, aplicado = :res, actualizadoEn = :ahora, actualizadoPor = :quien',
        ConditionExpression: 'estado IN (:pendiente, :confirmada) AND actualizadoEn = :leido',
        ExpressionAttributeValues: {
          ':aplicada': 'aplicada',
          ':res': { stockReal: resultado.stockReal, botellasAbiertas: resultado.botellasAbiertas, en: ahora },
          ':ahora': ahora,
          ':quien': quienSesion || '',
          ':pendiente': 'pendiente',
          ':confirmada': 'confirmada',
          ':leido': item.actualizadoEn,
        },
      },
    });
    try {
      await docClient.send(new TransactWriteCommand({ TransactItems: operaciones }));
    } catch (err) {
      if (!esCancelada(err)) throw err;
      // Otro cambió la línea de dictado, LINE# o el estado del inventario: se relee todo.
      ctx.inventario = null;
      continue;
    }
    return {
      aplicada: {
        n, productId: pid, modo: item.modo,
        stockReal: resultado.stockReal, botellasAbiertas: resultado.botellasAbiertas, yaAplicada: false,
      },
    };
  }
  return { rechazada: rechazo(n, 'conflicto') };
}
