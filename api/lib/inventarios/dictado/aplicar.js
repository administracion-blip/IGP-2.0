/**
 * Aplica al conteo las líneas de una sesión de dictado.
 *
 * Reglas:
 * - Solo se aplican líneas 'confirmada' o 'pendiente' con confirmar=false. Las demás vuelven en
 *   `rechazadas` con su motivo y no se escribe nada.
 * - Sin confirmar (estado 'pendiente') nunca se toca un producto que ya tiene stock contado
 *   ('ya_contado'), salvo la regla «sumado» (sumableSola: lo último que lo tocó fue este mismo
 *   dictado), ni se guarda un total que no cabe exacto en las fracciones de botella
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
 * Al aplicar se guarda también `anterior` (la LINE# leída antes de escribir) para poder deshacer
 * (deshacerLineaDictado). Una línea 'deshecha' no se vuelve a aplicar (rechazada 'deshecha').
 *
 * IGP no escribe en Ágora.
 */

import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../db.js';
import { logger } from '../../logger.js';
import { errorInventario, idSegmento, pkInventario, skDictadoLinea, usuarioSegmento } from '../claves.js';
import { anadirProducto } from '../conteo.js';
import { stockContado } from '../diferencia.js';
import { escrituraLinea, exigirConteo, leerLineaConteo, obtenerInventario, versionLinea } from '../inventarios.js';
import { tablaInventarios } from '../store.js';
import { partirCantidad } from './parser.js';
import {
  MAX_LINEAS_POR_ENVIO, cicloDe, descartarLinea, leerLineaDictado, presentarLinea, ultimaAplicadaDelProducto,
} from './sesion.js';

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
  if (item.estado === 'deshecha') return 'deshecha';
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

/**
 * Regla «sumado»: una línea 'sumar' marcada 'sumado' en interpretar se aplica sin confirmar sobre
 * un producto contado solo si lo último que escribió su LINE# fue este mismo dictado: la versión
 * leída en `previa` es la `aplicado.version` de la última aplicada del producto en el ciclo actual,
 * y la línea es de ese ciclo. Como escrituraLinea exige esa misma versión leída en la
 * TransactWrite, nadie puede escribir LINE# entre esta comprobación y la escritura.
 */
async function sumableSola(ctx, item, previa) {
  if (item.modo !== 'sumar' || !Array.isArray(item.motivos) || !item.motivos.includes('sumado')) return false;
  const ultima = await ultimaAplicadaDelProducto(ctx.id, ctx.usuarioId, item.productId);
  return Boolean(ultima) && ultima.ciclo === cicloDe(item) && versionLinea(previa) === ultima.version;
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
    // Solo informativo (deshacer restaura siempre los valores de `anterior`): false si la LINE#
    // la creó este intento; si otro la añadió a la vez (409), ya existía.
    let existia = Boolean(previa);
    if (!previa && item.modo === 'borrar') return { rechazada: rechazo(n, 'no_en_conteo') };
    if (!previa) {
      try {
        await anadirProducto(id, pid, quien, { soloContar, exportStocks });
        existia = false;
      } catch (err) {
        existia = true;
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
    if (sinConfirmar && stockContado(previa) != null && !(await sumableSola(ctx, item, previa))) {
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
    const { operaciones, version } = escrituraLinea(
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
        UpdateExpression: 'SET estado = :aplicada, aplicado = :res, anterior = :ant, actualizadoEn = :ahora, actualizadoPor = :quien',
        ConditionExpression: 'estado IN (:pendiente, :confirmada) AND actualizadoEn = :leido',
        ExpressionAttributeValues: {
          ':aplicada': 'aplicada',
          ':res': { stockReal: resultado.stockReal, botellasAbiertas: resultado.botellasAbiertas, version, en: ahora },
          ':ant': {
            existia,
            stockReal: previa.stockReal ?? null,
            botellasAbiertas: previa.botellasAbiertas ?? 0,
          },
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

// ─── Deshacer ───

const MENSAJE_CAMBIADO = 'Ese producto se ha cambiado después; corrígelo a mano.';

/**
 * LINE# sigue exactamente como la dejó el dictado: misma versión (nadie la ha escrito después,
 * aunque dejase el mismo valor). Las aplicadas antes de guardar `aplicado.version` se comparan
 * por valores.
 */
function sigueComoAplicada(previa, aplicado) {
  if (!previa) return false;
  if (aplicado.version != null) return versionLinea(previa) === Number(aplicado.version);
  return (previa.stockReal ?? null) === (aplicado.stockReal ?? null)
    && (previa.botellasAbiertas ?? 0) === (aplicado.botellasAbiertas ?? 0);
}

/**
 * Deshace una línea de la sesión del usuario.
 * - pendiente/confirmada → descartada (como PATCH estado descartada).
 * - aplicada → en UNA TransactWrite: LINE# vuelve SIEMPRE a los valores de `anterior` (vía
 *   escrituraLinea, mismas reglas que guardarLinea) y la línea pasa a 'deshecha'. Si el alta la
 *   hizo este dictado, `anterior` ya es «sin contar» (stockReal null, botellas 0); la LINE# NO se
 *   borra: así no se pierde el teórico que se leyó de Ágora ni cambia qué filas salen en el Excel.
 *   Condiciones: LINE# sigue en la versión que dejó el aplicar (`aplicado.version`; sin ella, con
 *   los mismos valores) y la línea sigue 'aplicada' con su actualizadoEn.
 * - deshecha/descartada → yaDeshecha (idempotente).
 * @returns {Promise<{ deshecha: true, yaDeshecha?: true, linea: object }>}
 * @throws errorInventario 404 sin línea; 409 si LINE# cambió después, si la línea se aplicó sin
 *   guardar `anterior` o tras 3 conflictos; 403/409 de exigirConteo.
 */
export async function deshacerLineaDictado({
  inventarioId, usuarioId, quien, quienSesion, n, soloContar, inventario = null,
}) {
  const id = idSegmento(inventarioId, 'inventarioId');
  const u = usuarioSegmento(usuarioId);
  const tabla = tablaInventarios();
  const pk = pkInventario(id);
  let inv = inventario;
  for (let intento = 0; intento < MAX_INTENTOS; intento += 1) {
    const item = await leerLineaDictado(id, usuarioId, n);
    if (!item) throw errorInventario('Línea de dictado no encontrada.', 404);
    if (item.estado === 'deshecha' || item.estado === 'descartada') {
      return { deshecha: true, yaDeshecha: true, linea: presentarLinea(item) };
    }
    if (item.estado === 'pendiente' || item.estado === 'confirmada') {
      try {
        return { deshecha: true, linea: await descartarLinea(id, usuarioId, n, quienSesion) };
      } catch (err) {
        if (err?.status !== 409) throw err;
        continue;
      }
    }
    if (item.estado !== 'aplicada') throw errorInventario('Esta línea no se puede deshacer.', 409);
    if (!item.anterior || !item.aplicado) {
      throw errorInventario('Esta línea se aplicó sin guardar el valor anterior; corrígelo a mano.', 409);
    }

    if (!inv) inv = await obtenerInventario(id);
    exigirConteo(inv, soloContar);
    const pid = item.productId;
    const previa = await leerLineaConteo(id, pid);
    if (!sigueComoAplicada(previa, item.aplicado)) throw errorInventario(MENSAJE_CAMBIADO, 409);
    const restaurar = {
      stockReal: item.anterior.stockReal ?? null,
      botellasAbiertas: item.anterior.botellasAbiertas ?? 0,
    };

    const ahora = new Date().toISOString();
    const { operaciones } = escrituraLinea(
      inv,
      previa,
      { productId: pid, ...restaurar },
      quien,
      { soloContar, condicionExtra: condicionVersion(previa) },
    );
    operaciones.push({
      Update: {
        TableName: tabla,
        Key: { PK: pk, SK: skDictadoLinea(u, n) },
        UpdateExpression: 'SET estado = :deshecha, actualizadoEn = :ahora, actualizadoPor = :quien',
        ConditionExpression: 'estado = :aplicada AND actualizadoEn = :leido',
        ExpressionAttributeValues: {
          ':deshecha': 'deshecha',
          ':aplicada': 'aplicada',
          ':ahora': ahora,
          ':quien': quienSesion || '',
          ':leido': item.actualizadoEn,
        },
      },
    });
    try {
      await docClient.send(new TransactWriteCommand({ TransactItems: operaciones }));
    } catch (err) {
      if (!esCancelada(err)) throw err;
      // META, LINE# o la línea cambiaron: se relee; si LINE# ya no es lo aplicado, 409 arriba.
      inv = null;
      continue;
    }
    return {
      deshecha: true,
      linea: presentarLinea({ ...item, estado: 'deshecha', actualizadoEn: ahora, actualizadoPor: quienSesion }),
    };
  }
  throw errorInventario('El dictado ha cambiado; vuelve a intentarlo.', 409);
}
