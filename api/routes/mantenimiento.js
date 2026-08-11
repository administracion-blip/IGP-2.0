import crypto from 'node:crypto';
import express from 'express';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';
import {
  previsualizarFacturacionMantenimiento,
  generarFacturacionMantenimiento,
  CAMPOS_CIERRE_SIN_FACTURA,
} from '../lib/facturacion/facturarMantenimiento.js';

const router = express.Router();

const ZONAS = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'];
const CATEGORIAS = ['electricidad', 'fontanería', 'frío', 'mobiliario', 'limpieza técnica', 'IT', 'plagas', 'otros'];
const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'];
const TIPOS_LINEA_VALORACION = ['material', 'mano_obra', 'desplazamiento'];
const TIPOS_LINEA_UNICOS = ['mano_obra', 'desplazamiento'];

// Tarifas configurables en Ajustes (tabla genérica Igp_Ajustes).
const AJUSTES_MANTENIMIENTO_PK = 'mantenimiento';
const AJUSTES_DESPLAZAMIENTO_SK = 'desplazamiento';
const PRECIO_KM_DEFECTO = 7.25;
const IMPORTE_HORA_DEFECTO = 30;
// TransactWriteItems admite como mucho 100 operaciones y 4 MB de datos.
const MAX_OPERACIONES_TRANSACCION = 100;
const MAX_BYTES_TRANSACCION = 4 * 1024 * 1024;

/** Redondeo a 2 decimales estable para importes. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Sanitiza y recalcula las líneas de valoración de una reparación.
 * Descarta líneas incompletas. Devuelve { lineas, base, iva, total }.
 *
 * Cada línea lleva `tipo` (material | mano_obra | desplazamiento) para poder
 * tratar después la mano de obra con cronómetro y prorratear el desplazamiento
 * entre incidencias de una misma ruta; por eso mano de obra y desplazamiento
 * solo admiten una línea por valoración. Las valoraciones antiguas no tienen
 * `tipo` y se normalizan a `material`.
 */
function sanitizarValoracion(rawLineas) {
  const lineas = [];
  const tiposUsados = new Set();
  for (const l of Array.isArray(rawLineas) ? rawLineas : []) {
    const articulo = (l?.articulo ?? '').toString().trim();
    const cantidad = Number(l?.cantidad);
    const precio = Number(l?.precio);
    const tipoIvaRaw = l?.tipo_iva;
    const tipoIva =
      tipoIvaRaw === undefined || tipoIvaRaw === null || tipoIvaRaw === ''
        ? 21
        : Number(tipoIvaRaw);
    if (!articulo) continue;
    if (!Number.isFinite(cantidad) || cantidad <= 0) continue;
    if (!Number.isFinite(precio) || precio < 0) continue;
    const iva = Number.isFinite(tipoIva) && tipoIva >= 0 ? tipoIva : 21;
    const tipoRaw = (l?.tipo ?? '').toString().trim().toLowerCase();
    const tipo = TIPOS_LINEA_VALORACION.includes(tipoRaw) ? tipoRaw : 'material';
    if (TIPOS_LINEA_UNICOS.includes(tipo)) {
      if (tiposUsados.has(tipo)) {
        const etiqueta = tipo === 'mano_obra' ? 'mano de obra' : 'desplazamiento';
        const e = new Error(`La valoración solo admite una línea de ${etiqueta}`);
        e.status = 400;
        throw e;
      }
      tiposUsados.add(tipo);
    }
    const baseLinea = round2(cantidad * precio);
    const ivaLinea = round2((baseLinea * iva) / 100);
    const totalLinea = round2(baseLinea + ivaLinea);
    lineas.push({
      ...(l?.id_producto ? { id_producto: String(l.id_producto).trim() } : {}),
      articulo,
      cantidad,
      precio,
      tipo,
      tipo_iva: iva,
      base_linea: baseLinea,
      iva_linea: ivaLinea,
      total_linea: totalLinea,
    });
  }
  return { lineas, ...totalesValoracion(lineas) };
}

/** Suma de importes de un conjunto de líneas ya calculadas. */
function totalesValoracion(lineas) {
  const base = round2(lineas.reduce((s, l) => s + Number(l?.base_linea ?? 0), 0));
  const iva = round2(lineas.reduce((s, l) => s + Number(l?.iva_linea ?? 0), 0));
  return { base, iva, total: round2(base + iva) };
}

/** Recalcula los importes de una línea al cambiarle cantidad o precio. */
function recalcularLinea(linea, cantidad, precio) {
  const tipoIva = Number(linea?.tipo_iva);
  const iva = Number.isFinite(tipoIva) && tipoIva >= 0 ? tipoIva : 21;
  const baseLinea = round2(cantidad * precio);
  const ivaLinea = round2((baseLinea * iva) / 100);
  return {
    ...linea,
    cantidad,
    precio,
    tipo_iva: iva,
    base_linea: baseLinea,
    iva_linea: ivaLinea,
    total_linea: round2(baseLinea + ivaLinea),
  };
}

function esLineaDesplazamiento(l) {
  return (l?.tipo ?? '').toString().trim().toLowerCase() === 'desplazamiento';
}

/**
 * Día natural (yyyy-mm-dd) de una fecha programada. Se guarda así en el alta y
 * en la edición, pero algún parte antiguo puede traer hora detrás: comparar el
 * texto completo dejaría fuera hermanos del mismo día.
 */
function diaProgramado(valor) {
  const s = (valor ?? '').toString().trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * Tarifas de desplazamiento (Ajustes → Igp_Ajustes, PK 'mantenimiento' /
 * SK 'desplazamiento'). Si el ítem aún no existe o la lectura falla se usan los
 * valores por defecto: la valoración no puede romperse por falta de ajustes.
 */
async function leerAjustesDesplazamiento() {
  const defecto = { precio_km: PRECIO_KM_DEFECTO, importe_hora: IMPORTE_HORA_DEFECTO };
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.ajustes,
        Key: { PK: AJUSTES_MANTENIMIENTO_PK, SK: AJUSTES_DESPLAZAMIENTO_SK },
      })
    );
    const precioKm = Number(r.Item?.precio_km);
    const importeHora = Number(r.Item?.importe_hora);
    return {
      precio_km: Number.isFinite(precioKm) && precioKm > 0 ? precioKm : defecto.precio_km,
      importe_hora: Number.isFinite(importeHora) && importeHora > 0 ? importeHora : defecto.importe_hora,
    };
  } catch (err) {
    console.warn('[mantenimiento] No se pudieron leer los ajustes de desplazamiento:', err?.message || err);
    return defecto;
  }
}

/**
 * Identificador de la factura mensual del parte, o '' si todavía no se ha
 * facturado. Es el único campo que decide si el importe está congelado.
 */
function facturaDelParte(item) {
  return (item?.factura_mantenimiento_id ?? '').toString().trim();
}

/**
 * Punto único de decisión sobre si el reparto puede reescribir un parte.
 *
 * Un parte ya facturado no puede rehacerse: se queda con los kilómetros con los
 * que se cobró, aunque sigue contando en el reparto porque su parte del viaje ya
 * está pagada y hay que descontarla del trayecto.
 */
function repartoEditable(item) {
  return facturaDelParte(item) === '';
}

/**
 * Reparte los kilómetros del trayecto entre `n` partes en centésimas enteras.
 * Las que sobran se dan a los primeros: así la suma de los tramos es exacta,
 * ningún parte se queda con kilómetros negativos y el resultado no depende de
 * qué parte dispare el recálculo.
 */
function repartirKm(kmTotales, n) {
  const centesimas = Math.max(0, Math.round(kmTotales * 100));
  const cuota = Math.floor(centesimas / n);
  const resto = centesimas - cuota * n;
  return Array.from({ length: n }, (_, i) => round2((cuota + (i < resto ? 1 : 0)) / 100));
}

/** ¿El parte está valorado y cobra desplazamiento? Entonces entra en el reparto del día. */
function esValoradoConDesplazamiento(item) {
  return (
    item?.EstadoValoracion === 'Valorado' &&
    (Array.isArray(item?.valoracion_lineas) ? item.valoracion_lineas : []).some(esLineaDesplazamiento)
  );
}

/**
 * Kilómetros del trayecto completo a partir de una línea de desplazamiento.
 *
 * Las líneas que ya han pasado por el reparto llevan `km_totales`. Las que
 * llegan del cliente no (sanitizarValoracion solo deja pasar campos conocidos)
 * y su `cantidad` son los kilómetros completos, que es justo lo que se pide al
 * valorar. Solo queda reconstruir para líneas antiguas repartidas antes de que
 * existiera `km_totales`: como el resto de centésimas se dio a los primeros
 * partes, `cantidad × partes` puede pasarse de largo (6,67 × 3 = 20,01 de un
 * viaje de 20), así que se descuenta ese margen para no inventar kilómetros que
 * nadie cobró.
 */
function kmTrayectoDeLinea(linea) {
  const km = Number(linea?.km_totales);
  if (Number.isFinite(km) && km > 0) return km;
  const cantidad = Number(linea?.cantidad);
  if (!Number.isFinite(cantidad) || cantidad <= 0) return 0;
  const partes = Number(linea?.reparto_partes);
  if (!Number.isFinite(partes) || partes <= 1) return cantidad;
  return round2(Math.max(0, Math.round(cantidad * 100) * partes - (partes - 1)) / 100);
}

/** Kilómetros que una línea de desplazamiento ya tiene imputados (su cantidad). */
function kmImputadosDeLinea(linea) {
  const km = Number(linea?.cantidad);
  return Number.isFinite(km) && km > 0 ? km : 0;
}

/**
 * Cierre optimista sobre la valoración de un parte.
 *
 * El testigo es `valoracion_rev`, un contador que sube en **toda** escritura de
 * las líneas de valoración. `fecha_valoracion` sola no sirve: el reparto de
 * kilómetros sobre un parte hermano le cambia el importe sin tocarla —y no puede
 * tocarla, porque tiene significado fiscal y es el criterio de corte del periodo
 * que se factura—, así que dos valoraciones simultáneas del mismo local y día
 * pasaban ambas la condición y el viaje se cobraba dos veces. Se comparan las
 * dos: la fecha detecta una revaloración y el contador, un reparto.
 *
 * Los partes anteriores al contador no tienen el atributo, así que ahí el
 * testigo es su ausencia; la primera escritura que los toque lo crea con ADD.
 * `valoracion_total` no serviría (dos valoraciones distintas pueden sumar lo
 * mismo) y `attribute_exists(PK)` evita además resucitar como fantasma un parte
 * borrado entretanto.
 */
function condicionValoracionIntacta(item) {
  const condiciones = ['attribute_exists(PK)'];
  const valores = {};
  const fecha = item?.fecha_valoracion;
  if (typeof fecha === 'string' && fecha !== '') {
    condiciones.push('fecha_valoracion = :fvPrevia');
    valores[':fvPrevia'] = fecha;
  } else {
    condiciones.push('attribute_not_exists(fecha_valoracion)');
  }
  const rev = Number(item?.valoracion_rev);
  if (Number.isFinite(rev)) {
    condiciones.push('valoracion_rev = :revPrevia');
    valores[':revPrevia'] = rev;
  } else {
    condiciones.push('attribute_not_exists(valoracion_rev)');
  }
  return { expresion: condiciones.join(' AND '), valores };
}

/**
 * Cláusulas que debe llevar toda escritura que modifique `valoracion_lineas`:
 * sube el contador que sirve de testigo de concurrencia y borra la marca de
 * cierre sin factura, porque un importe nuevo vuelve a ser facturable.
 */
const CLAUSULA_REMOVE_CIERRE = CAMPOS_CIERRE_SIN_FACTURA.join(', ');
const CLAUSULA_ADD_REV = 'ADD valoracion_rev :revIncremento';
const SUFIJO_ESCRITURA_VALORACION = ` REMOVE ${CLAUSULA_REMOVE_CIERRE} ${CLAUSULA_ADD_REV}`;
const VALORES_ESCRITURA_VALORACION = { ':revIncremento': 1 };

/**
 * Partes valorados del mismo local y día (distintos del actual) con
 * desplazamiento. El filtro por estado y día va en DynamoDB y la proyección se
 * limita a lo que usa el reparto: la partición de un local acumula todo su
 * histórico de incidencias con descripciones, fotos y tramos de trabajo.
 */
async function buscarHermanosDesplazamiento(pk, skActual, dia) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: tables.mantenimiento,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        // begins_with sobre la fecha: unos partes la guardan como yyyy-mm-dd y
        // otros pueden traer hora detrás.
        FilterExpression: 'EstadoValoracion = :val AND begins_with(fecha_programada, :dia)',
        // factura_mantenimiento_id decide si el hermano está congelado: sin él en
        // la proyección el reparto lo reescribiría como si no estuviera facturado.
        // valoracion_rev es el testigo del cierre optimista: sin él, la condición
        // se construiría como si el hermano no tuviera contador y fallaría siempre.
        ProjectionExpression:
          'PK, SK, valoracion_lineas, fecha_valoracion, valoracion_rev, factura_mantenimiento_id',
        ExpressionAttributeValues: { ':pk': pk, ':sk': 'INC#', ':val': 'Valorado', ':dia': dia },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      })
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items.filter(
    (i) =>
      i.SK !== skActual &&
      (Array.isArray(i.valoracion_lineas) ? i.valoracion_lineas : []).some(esLineaDesplazamiento)
  );
}

/**
 * Prepara el reparto del desplazamiento entre los partes del mismo local y día.
 *
 * El técnico sale una vez de la sede central hacia el local: ese viaje (solo la
 * ida) se cobra una única vez por local y día, así que si ese día hay varios
 * partes abiertos en el mismo local sus kilómetros se reparten entre todos. La
 * `cantidad` que manda el cliente son los kilómetros completos del trayecto,
 * porque al valorar no se sabe cuántos partes habrá; en la línea se persisten
 * `km_totales` y `reparto_partes` para poder volver a repartir cuando aparezca
 * un parte nuevo: a partir de una cantidad ya dividida no habría forma de
 * reconstruir el trayecto original. Si los kilómetros que llegan ahora difieren
 * de los guardados, manda el parte que se está valorando y se propagan a todos.
 *
 * `dia` es el día cuyo reparto se rehace y `sk` el parte que lo dispara, que
 * nunca cuenta como hermano. `lineasParte` son sus líneas si sigue en ese día
 * (las que llegan del cliente al valorar, o las ya guardadas si solo cambia de
 * fecha) o null si sale del reparto porque se borra, se va a otro día o deja de
 * cobrar desplazamiento. Las dos formas conviven sin ambigüedad porque solo las
 * ya guardadas traen `km_totales`: en las del cliente el trayecto es `cantidad`.
 *
 * Devuelve null si no hay nada que repartir. Si lo hay: las líneas y totales que
 * debe guardar el parte (null si no participa), el resumen del reparto para la
 * respuesta y las operaciones de actualización de los hermanos, que el llamante
 * escribe en la misma transacción para no dejar el día repartido a medias.
 */
async function prepararRepartoDesplazamiento({ pk, sk, dia, lineasParte = null }) {
  const lineas = Array.isArray(lineasParte) ? lineasParte : null;
  const lineaActual = lineas ? lineas.find(esLineaDesplazamiento) || null : null;
  const hermanos = dia ? await buscarHermanosDesplazamiento(pk, sk, dia) : [];

  const ajustes = await leerAjustesDesplazamiento();
  const precioActual = Number(lineaActual?.precio);
  // Un precio de 0 €/km es una decisión del usuario, no un hueco: solo se
  // recurre a la tarifa de Ajustes si no llega un número válido.
  const precioPropagado = Number.isFinite(precioActual) && precioActual >= 0 ? precioActual : ajustes.precio_km;

  const participantes = [
    ...(lineaActual ? [{ actual: true, sk, item: null, linea: lineaActual, precio: precioPropagado }] : []),
    ...hermanos.map((h) => {
      const linea = h.valoracion_lineas.find(esLineaDesplazamiento);
      const precioHermano = Number(linea?.precio);
      // Sin parte actual que mande, cada hermano conserva su propio precio.
      const precioPropio = Number.isFinite(precioHermano) && precioHermano >= 0 ? precioHermano : ajustes.precio_km;
      return { actual: false, sk: h.SK, item: h, linea, precio: lineaActual ? precioPropagado : precioPropio };
    }),
  ].sort((a, b) => String(a.sk).localeCompare(String(b.sk)));

  if (participantes.length === 0) return null;

  const kmTotales = lineaActual
    ? kmTrayectoDeLinea(lineaActual)
    : round2(participantes.reduce((max, p) => Math.max(max, kmTrayectoDeLinea(p.linea)), 0));
  const n = participantes.length;
  // Los partes ya facturados conservan los kilómetros con los que se cobraron,
  // así que solo se reparte el resto del trayecto entre los que aún se pueden
  // reescribir: repartir el total otra vez cobraría dos veces el mismo viaje.
  // Si lo facturado ya cubre el trayecto, al parte tardío le tocan cero
  // kilómetros; nunca un resto negativo.
  const editables = participantes.filter((p) => repartoEditable(p.item));
  const kmFacturados = participantes.reduce(
    (suma, p) => (repartoEditable(p.item) ? suma : suma + kmImputadosDeLinea(p.linea)),
    0
  );
  const kmARepartir = round2(Math.max(0, kmTotales - kmFacturados));
  const kmPorParte = editables.length > 0 ? repartirKm(kmARepartir, editables.length) : [];

  let lineasActuales = null;
  let resumenActual = null;
  const operaciones = [];

  // El parte que dispara el reparto nunca está facturado (valorar, cambiar de
  // fecha y borrar se rechazan en ese caso), así que siempre está en editables.
  editables.forEach((p, idx) => {
    const km = kmPorParte[idx];
    const nuevaLinea = {
      ...recalcularLinea(p.linea, km, p.precio),
      km_totales: kmTotales,
      reparto_partes: n,
    };
    if (p.actual) {
      resumenActual = { km_imputados: km, importe_imputado: nuevaLinea.base_linea, total_imputado: nuevaLinea.total_linea };
      lineasActuales = lineas.map((l) => (l === p.linea ? nuevaLinea : l));
      return;
    }
    const sinCambios =
      Number(p.linea.cantidad) === nuevaLinea.cantidad &&
      Number(p.linea.precio) === nuevaLinea.precio &&
      Number(p.linea.km_totales) === kmTotales &&
      Number(p.linea.reparto_partes) === n;
    if (sinCambios) return;
    const lineasHermano = p.item.valoracion_lineas.map((l) => (l === p.linea ? nuevaLinea : l));
    const totales = totalesValoracion(lineasHermano);
    const condicion = condicionValoracionIntacta(p.item);
    operaciones.push({
      Update: {
        TableName: tables.mantenimiento,
        Key: { PK: p.item.PK, SK: p.item.SK },
        UpdateExpression:
          'SET valoracion_lineas = :ln, valoracion_base = :vb, valoracion_iva = :vi, valoracion_total = :vt' +
          SUFIJO_ESCRITURA_VALORACION,
        ConditionExpression: condicion.expresion,
        ExpressionAttributeValues: {
          ':ln': lineasHermano,
          ':vb': totales.base,
          ':vi': totales.iva,
          ':vt': totales.total,
          ...VALORES_ESCRITURA_VALORACION,
          ...condicion.valores,
        },
      },
    });
  });

  return {
    lineas: lineasActuales,
    ...(lineasActuales ? totalesValoracion(lineasActuales) : { base: null, iva: null, total: null }),
    operaciones,
    reparto: {
      km_totales: kmTotales,
      partes: n,
      precio_km: lineaActual ? precioPropagado : null,
      km_imputados: null,
      importe_imputado: null,
      total_imputado: null,
      ...(resumenActual ?? {}),
    },
  };
}

/**
 * Rehace el reparto de los días implicados cuando un parte valorado con
 * desplazamiento se borra o cambia de fecha programada. Es el caso simétrico de
 * añadir un parte al día: si no se recalcula, los kilómetros que ese parte
 * soltaba se quedan sin cobrar a nadie.
 *
 * `diaNuevo` vacío significa que el parte sale del reparto (borrado). Devuelve
 * las operaciones sobre los hermanos de ambos días y, cuando el parte llega a un
 * día nuevo, sus propias líneas y totales recalculados.
 */
async function repartoPorCambioDeDia({ pk, sk, item, diaNuevo }) {
  const diaAnterior = diaProgramado(item?.fecha_programada);
  const destino = diaProgramado(diaNuevo);
  if (diaAnterior === destino) return null;

  const operaciones = [];
  let lineas = null;
  let totales = null;
  if (diaAnterior) {
    const salida = await prepararRepartoDesplazamiento({ pk, sk, dia: diaAnterior, lineasParte: null });
    if (salida) operaciones.push(...salida.operaciones);
  }
  if (destino) {
    const llegada = await prepararRepartoDesplazamiento({
      pk,
      sk,
      dia: destino,
      lineasParte: item?.valoracion_lineas,
    });
    if (llegada) {
      operaciones.push(...llegada.operaciones);
      lineas = llegada.lineas;
      totales = { base: llegada.base, iva: llegada.iva, total: llegada.total };
    }
  }
  if (operaciones.length === 0 && !lineas) return null;
  return { operaciones, lineas, ...(totales ?? { base: null, iva: null, total: null }) };
}

/**
 * Escribe en una sola transacción el parte y los hermanos de su reparto: o se
 * guarda todo o no se guarda nada. Devuelve { ok } o el error ya traducido.
 */
async function escribirTransaccionReparto(items) {
  if (items.length > MAX_OPERACIONES_TRANSACCION) {
    return {
      ok: false,
      status: 409,
      error: 'Hay demasiados partes valorados con desplazamiento en este local y día para repartirlo de una vez',
    };
  }
  // Cada operación reescribe el array completo de líneas, así que el tope de
  // 4 MB por transacción es alcanzable; sin este control saldría como
  // ValidationException y acabaría en un 500 genérico.
  if (Buffer.byteLength(JSON.stringify(items)) > MAX_BYTES_TRANSACCION) {
    return {
      ok: false,
      status: 409,
      error: 'El reparto del desplazamiento de este local y día es demasiado grande para guardarse de una vez',
    };
  }
  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: items }));
    return { ok: true };
  } catch (err) {
    if (err?.name !== 'TransactionCanceledException') throw err;
    const razones = Array.isArray(err.CancellationReasons) ? err.CancellationReasons : [];
    // Un choque de concurrencia y un throttling se ven igual desde fuera: sin
    // los motivos no hay forma de saber cuál de los dos fue.
    console.warn(
      '[mantenimiento] Reparto de desplazamiento cancelado:',
      razones.map((r) => r?.Code ?? 'None').join(', ')
    );
    if (razones.some((r) => r?.Code === 'ConditionalCheckFailed')) {
      return {
        ok: false,
        status: 409,
        error: 'Otro usuario ha modificado un parte de este día mientras se repartía el desplazamiento. No se ha guardado nada; recarga e inténtalo de nuevo',
      };
    }
    return {
      ok: false,
      status: 503,
      error: 'No se ha podido guardar el reparto del desplazamiento. No se ha guardado nada; inténtalo de nuevo en unos segundos',
    };
  }
}

/**
 * Lee el cronómetro de trabajo de una incidencia tolerando su ausencia.
 *
 * El tiempo se guarda como array de tramos y no como un único par inicio/fin
 * porque el técnico puede parar a mitad (ir a por material, atender otra cosa)
 * y reanudar después: el total es la suma de los tramos ya cerrados. Se
 * acumulan segundos, no minutos, para no perder precisión en cada parada; la
 * conversión a horas la hace el frontend al valorar.
 */
function leerTrabajo(item) {
  const tramos = Array.isArray(item?.trabajo_tramos) ? item.trabajo_tramos : [];
  const segundosRaw = Number(item?.trabajo_segundos);
  const segundos = Number.isFinite(segundosRaw) ? Math.max(0, Math.trunc(segundosRaw)) : 0;
  const indiceAbierto = tramos.findIndex((t) => t && (t.fin === null || t.fin === undefined || t.fin === ''));
  return { tramos, segundos, indiceAbierto };
}

/** Duración en segundos entre dos ISO. Nunca negativa: datos raros suman 0. */
function duracionSegundos(inicio, fin) {
  const ini = Date.parse(inicio);
  const f = Date.parse(fin);
  if (!Number.isFinite(ini) || !Number.isFinite(f)) return 0;
  return Math.max(0, Math.round((f - ini) / 1000));
}

/**
 * Cierra el tramo abierto a la hora indicada y devuelve el nuevo estado del
 * cronómetro, o null si no había ninguno abierto.
 *
 * Lo usan también valorar y marcar_reparado: el parte se puede cerrar desde
 * pantallas que no conocen el cronómetro, y sin esto el tramo se quedaría
 * corriendo para siempre, invisible y sin forma de pararlo.
 */
function cerrarTramoAbierto(item, ahora) {
  const { tramos, segundos, indiceAbierto } = leerTrabajo(item);
  if (indiceAbierto < 0) return null;
  const abierto = tramos[indiceAbierto];
  return {
    tramos: tramos.map((t, idx) => (idx === indiceAbierto ? { ...abierto, fin: ahora } : t)),
    segundos: segundos + duracionSegundos(abierto.inicio, ahora),
  };
}

/**
 * Si el error indica que la tabla mantenimiento no existe, lanza Error con
 * status 404 y mensaje custom para el operador. Resto se re-lanza.
 */
function throwSiTablaMantenimientoFalta(err) {
  const msg = err?.message || String(err);
  if (
    err?.name === 'ResourceNotFoundException' ||
    msg.includes('Requested resource not found') ||
    msg.includes('ResourceNotFoundException')
  ) {
    const e = new Error(
      `La tabla ${tables.mantenimiento} no existe en DynamoDB. Créala en AWS con PK (String) y SK (String). Ver api/MANTENIMIENTO.md`,
    );
    e.status = 404;
    e.code = 'TABLE_NOT_FOUND';
    throw e;
  }
  throw err;
}

router.post('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? body.id_Locales ?? '').toString().trim();
  const zona = (body.zona ?? '').toString().trim().toLowerCase();
  const categoria = (body.categoria ?? '').toString().trim().toLowerCase();
  const titulo = (body.titulo ?? '').toString().trim();
  const descripcion = (body.descripcion ?? '').toString().trim();
  const prioridadReportada = (body.prioridad_reportada ?? 'media').toString().trim().toLowerCase();
  const fotos = Array.isArray(body.fotos) ? body.fotos.filter((f) => typeof f === 'string' && f.length > 0).slice(0, 3) : [];
  const creadoPor = (body.creado_por_id_usuario ?? req.headers['x-user-id'] ?? '').toString().trim();

  if (!localId) return res.status(400).json({ error: 'local_id es obligatorio' });
  if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });
  if (!ZONAS.includes(zona)) return res.status(400).json({ error: 'zona no válida' });
  if (!CATEGORIAS.includes(categoria)) return res.status(400).json({ error: 'categoria no válida' });
  if (!PRIORIDADES.includes(prioridadReportada)) return res.status(400).json({ error: 'prioridad_reportada no válida' });

  const getLocal = await docClient.send(
    new GetCommand({
      TableName: tables.locales,
      Key: { id_Locales: localId },
    })
  );
  if (!getLocal.Item) {
    return res.status(400).json({ error: 'Local no encontrado' });
  }

  const uuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const sk = `INC#${now}#${uuid}`;
  const pk = `LOCAL#${localId}`;
  const item = {
    PK: pk,
    SK: sk,
    tipo: 'INC',
    id_incidencia: uuid,
    fecha_creacion: now,
    creado_por_id_usuario: creadoPor || undefined,
    local_id: localId,
    zona,
    categoria,
    titulo,
    descripcion,
    prioridad_reportada: prioridadReportada,
    estado: 'Nuevo',
    ...(fotos.length > 0 && { fotos }),
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: tables.mantenimiento,
        Item: item,
      })
    );
  } catch (err) {
    throwSiTablaMantenimientoFalta(err);
  }
  return res.json({ ok: true, incidencia: item });
});

router.get('/mantenimiento/incidencias', async (req, res) => {
  const localId = (req.query.local_id ?? '').toString().trim();
  const creadoPor = (req.query.creado_por ?? '').toString().trim();
  const estado = (req.query.estado ?? '').toString().trim().toUpperCase();

  let items = [];
  try {
    if (localId) {
      let lastKey = null;
      do {
        const cmd = new QueryCommand({
          TableName: tables.mantenimiento,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `LOCAL#${localId}`, ':sk': 'INC#' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    } else {
      let lastKey = null;
      do {
        const cmd = new ScanCommand({
          TableName: tables.mantenimiento,
          FilterExpression: 'tipo = :tipo',
          ExpressionAttributeValues: { ':tipo': 'INC' },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        });
        const result = await docClient.send(cmd);
        items.push(...(result.Items || []));
        lastKey = result.LastEvaluatedKey || null;
      } while (lastKey);
    }
  } catch (err) {
    throwSiTablaMantenimientoFalta(err);
  }
  if (creadoPor) items = items.filter((i) => (i.creado_por_id_usuario ?? '') === creadoPor);
  if (estado) items = items.filter((i) => (i.estado ?? '') === estado);
  items.sort((a, b) => (b.fecha_creacion || '').localeCompare(a.fecha_creacion || ''));
  const incidencias = items.map((i) => {
    const { tramos, segundos, indiceAbierto } = leerTrabajo(i);
    return {
      id_incidencia: i.id_incidencia,
      fecha_creacion: i.fecha_creacion,
      fecha_programada: i.fecha_programada,
      creado_por_id_usuario: i.creado_por_id_usuario,
      local_id: i.local_id,
      zona: i.zona,
      categoria: i.categoria,
      titulo: i.titulo,
      descripcion: i.descripcion,
      prioridad_reportada: i.prioridad_reportada,
      estado: i.estado,
      fotos: i.fotos ?? [],
      fecha_completada: i.FechaCompletada ?? null,
      estado_valoracion: i.EstadoValoracion ?? null,
      fecha_valoracion: i.fecha_valoracion ?? null,
      valoracion_lineas: i.valoracion_lineas ?? [],
      valoracion_base: i.valoracion_base ?? null,
      valoracion_iva: i.valoracion_iva ?? null,
      valoracion_total: i.valoracion_total ?? null,
      factura_mantenimiento_id: i.factura_mantenimiento_id ?? null,
      factura_mantenimiento_periodo: i.factura_mantenimiento_periodo ?? null,
      fecha_facturacion: i.fecha_facturacion ?? null,
      factura_mantenimiento_id_empresa: i.factura_mantenimiento_id_empresa ?? null,
      // Cierre sin factura: el parte no se facturará nunca (líneas a 0, o local de
      // la propia sociedad emisora). No es una factura, y por eso no lleva id.
      factura_mantenimiento_cierre: i.factura_mantenimiento_cierre ?? null,
      factura_mantenimiento_cierre_texto: i.factura_mantenimiento_cierre_texto ?? null,
      factura_mantenimiento_cierre_periodo: i.factura_mantenimiento_cierre_periodo ?? null,
      factura_mantenimiento_cierre_en: i.factura_mantenimiento_cierre_en ?? null,
      trabajo_segundos: segundos,
      trabajo_en_curso_desde: indiceAbierto >= 0 ? (tramos[indiceAbierto].inicio ?? null) : null,
      trabajo_tramos: tramos,
    };
  });
  return res.json({ incidencias });
});

router.post('/mantenimiento/incidencias/lote', async (req, res) => {
  const body = req.body || {};
  const localIds = Array.isArray(body.local_ids) ? body.local_ids.map((v) => String(v).trim()).filter(Boolean) : [];
  const fechas = Array.isArray(body.fechas_programadas) ? body.fechas_programadas.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f))) : [];
  const zona = (body.zona ?? '').toString().trim().toLowerCase();
  const categoria = (body.categoria ?? 'otros').toString().trim().toLowerCase();
  const titulo = (body.titulo ?? '').toString().trim();
  const descripcion = (body.descripcion ?? '').toString().trim();
  const prioridadReportada = (body.prioridad_reportada ?? 'media').toString().trim().toLowerCase();
  const creadoPor = (body.creado_por_id_usuario ?? req.headers['x-user-id'] ?? '').toString().trim();
  const idSerie = body.id_serie || crypto.randomUUID();

  if (localIds.length === 0) return res.status(400).json({ error: 'Se necesita al menos un local_id' });
  if (fechas.length === 0) return res.status(400).json({ error: 'Se necesita al menos una fecha' });
  if (localIds.length * fechas.length > 500) return res.status(400).json({ error: 'Máximo 500 registros por lote' });
  if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });
  if (!ZONAS.includes(zona)) return res.status(400).json({ error: 'zona no válida' });
  if (!CATEGORIAS.includes(categoria)) return res.status(400).json({ error: 'categoria no válida' });
  if (!PRIORIDADES.includes(prioridadReportada)) return res.status(400).json({ error: 'prioridad_reportada no válida' });

  let creados = 0;
  const errores = [];
  const now = new Date().toISOString();

  for (const localId of localIds) {
    for (const fecha of fechas) {
      try {
        const uuid = crypto.randomUUID();
        const sk = `INC#${now}#${uuid}`;
        const pk = `LOCAL#${localId}`;
        await docClient.send(
          new PutCommand({
            TableName: tables.mantenimiento,
            Item: {
              PK: pk,
              SK: sk,
              tipo: 'INC',
              id_incidencia: uuid,
              fecha_creacion: now,
              creado_por_id_usuario: creadoPor || undefined,
              local_id: localId,
              zona,
              categoria,
              titulo,
              descripcion,
              prioridad_reportada: prioridadReportada,
              estado: 'Programado',
              fecha_programada: fecha,
              id_serie: idSerie,
              origen: 'recurrente',
            },
          })
        );
        creados++;
      } catch (err) {
        // Acumulamos fallos por par localId/fecha y seguimos: respuesta tolerante.
        errores.push(`${localId}/${fecha}: ${err.message}`);
      }
    }
  }

  return res.json({ ok: true, creados, total: localIds.length * fechas.length, errores });
});

router.patch('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();
  const fechaProgramada = (body.fecha_programada ?? '').toString().trim();
  const marcarReparado = body.marcar_reparado === true;
  const valorar = body.valorar === true;
  const editarCampos = body.editar_campos === true;
  const iniciarTrabajo = body.iniciar_trabajo === true;
  const finalizarTrabajo = body.finalizar_trabajo === true;

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  const pk = `LOCAL#${localId}`;
  const sk = `INC#${fechaCreacion}#${idIncidencia}`;

  // Cronómetro: el inicio y el fin los marca el servidor, nunca el cliente,
  // porque de ese tiempo sale el importe de mano de obra que se factura.
  if (iniciarTrabajo || finalizarTrabajo) {
    const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
    const item = current.Item || {};
    const tieneProgramacion =
      (item.fecha_programada && String(item.fecha_programada).trim() !== '') ||
      item.estado === 'Programado';
    if (!tieneProgramacion) {
      return res.status(400).json({ error: 'La incidencia debe estar programada antes de registrar tiempo de trabajo' });
    }

    // Un parte valorado ya está facturado: ni abrir ni cerrar tramos puede
    // dejar trabajo_segundos por encima de las horas cobradas.
    if (item.EstadoValoracion === 'Valorado') {
      return res.status(400).json({ error: 'La incidencia ya está valorada: no se puede imputar más tiempo' });
    }

    const { tramos, segundos, indiceAbierto } = leerTrabajo(item);
    const ahora = new Date().toISOString();
    let nuevosTramos;
    let nuevosSegundos;
    let enCursoDesde;

    if (iniciarTrabajo) {
      if (indiceAbierto >= 0) {
        return res.status(400).json({ error: 'Ya hay un tramo de trabajo abierto' });
      }
      const idUsuario = (req.user?.sub ?? req.user?.id_usuario ?? '').toString().trim();
      nuevosTramos = [...tramos, { inicio: ahora, fin: null, id_usuario: idUsuario }];
      nuevosSegundos = segundos;
      enCursoDesde = ahora;
    } else {
      const cierre = cerrarTramoAbierto(item, ahora);
      if (!cierre) {
        return res.status(400).json({ error: 'No hay ningún tramo de trabajo abierto' });
      }
      nuevosTramos = cierre.tramos;
      nuevosSegundos = cierre.segundos;
      enCursoDesde = null;
    }

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tables.mantenimiento,
          Key: { PK: pk, SK: sk },
          UpdateExpression: 'SET trabajo_tramos = :tr, trabajo_segundos = :seg',
          // Decidimos sobre el item leído sin bloqueo: si otra pulsación tocó el
          // cronómetro entretanto, esta debe fallar en vez de duplicar tramo o tiempo.
          // attribute_exists(PK) evita resucitar como item fantasma una incidencia
          // borrada entre la lectura y la escritura.
          ConditionExpression:
            'attribute_exists(PK) AND (attribute_not_exists(trabajo_tramos) OR size(trabajo_tramos) = :nTramos) AND (attribute_not_exists(trabajo_segundos) OR trabajo_segundos = :segPrevio)',
          ExpressionAttributeValues: {
            ':tr': nuevosTramos,
            ':seg': nuevosSegundos,
            ':nTramos': tramos.length,
            ':segPrevio': segundos,
          },
        })
      );
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        return res.status(409).json({ error: 'El cronómetro se ha modificado en otra sesión. Recarga e inténtalo de nuevo' });
      }
      throw err;
    }

    return res.json({ ok: true, trabajo: { en_curso_desde: enCursoDesde, segundos: nuevosSegundos } });
  }

  // Valorar = reparar con líneas de cobro (obligatorio al menos una línea).
  if (valorar) {
    const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
    const item = current.Item || {};
    const tieneProgramacion =
      (item.fecha_programada && String(item.fecha_programada).trim() !== '') ||
      item.estado === 'Programado';
    if (!tieneProgramacion) {
      return res.status(400).json({ error: 'La incidencia debe estar programada antes de valorarla' });
    }

    // Una vez facturado el parte, su importe está congelado en la factura: una
    // revaloración lo dejaría distinto de lo ya cobrado.
    if (facturaDelParte(item)) {
      return res.status(400).json({ error: 'La incidencia ya está facturada: no se puede volver a valorar' });
    }

    const { lineas, base, iva, total } = sanitizarValoracion(body.lineas);
    if (lineas.length === 0) {
      return res.status(400).json({ error: 'La valoración debe incluir al menos una línea válida (artículo, cantidad y precio)' });
    }

    const lineaDesplazamiento = lineas.find(esLineaDesplazamiento) || null;
    const dia = diaProgramado(item.fecha_programada);
    // Sin día no hay viaje que compartir: el parte cobraría el trayecto entero y
    // nunca aparecería como hermano, así que el mismo local podría cobrar la ida
    // dos veces el mismo día.
    if (lineaDesplazamiento && !dia) {
      return res.status(400).json({
        error: 'La incidencia no tiene fecha programada (yyyy-mm-dd): sin ella no se puede repartir el desplazamiento del día',
      });
    }

    const teniaDesplazamiento = (Array.isArray(item.valoracion_lineas) ? item.valoracion_lineas : []).some(
      esLineaDesplazamiento
    );
    // Si no hay desplazamiento ahora ni lo hubo antes no hay reparto que rehacer,
    // y así una valoración de solo materiales no paga la consulta de hermanos.
    const reparto =
      lineaDesplazamiento || teniaDesplazamiento
        ? await prepararRepartoDesplazamiento({ pk, sk, dia, lineasParte: lineaDesplazamiento ? lineas : null })
        : null;
    const lineasFinales = reparto?.lineas ?? lineas;
    const baseFinal = reparto?.base ?? base;
    const ivaFinal = reparto?.iva ?? iva;
    const totalFinal = reparto?.total ?? total;
    const operacionesHermanos = reparto?.operaciones ?? [];
    const condicionParte = condicionValoracionIntacta(item);

    const fechaCompletada = new Date().toISOString();
    // El tiempo que se cierra aquí ya no cambia el importe (las líneas llegan
    // calculadas), pero deja el cronómetro consistente para la facturación.
    const cierre = cerrarTramoAbierto(item, fechaCompletada);
    const actualizacionParte = {
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression:
          'SET FechaCompletada = :fc, fecha_valoracion = :fv, EstadoValoracion = :ev, #est = :est, valoracion_lineas = :ln, valoracion_base = :vb, valoracion_iva = :vi, valoracion_total = :vt' +
        (cierre ? ', trabajo_tramos = :tr, trabajo_segundos = :seg' : '') +
        SUFIJO_ESCRITURA_VALORACION,
        ExpressionAttributeNames: { '#est': 'estado' },
      // Sin este cierre, dos valoraciones que se solapan escriben cada una su
      // reparto sobre la lectura vieja de la otra y el viaje se cobra dos veces.
      ConditionExpression: condicionParte.expresion,
        ExpressionAttributeValues: {
          ':fc': fechaCompletada,
          ':fv': fechaCompletada,
          ':ev': 'Valorado',
          ':est': 'Reparacion',
        ':ln': lineasFinales,
        ':vb': baseFinal,
        ':vi': ivaFinal,
        ':vt': totalFinal,
          ...(cierre && { ':tr': cierre.tramos, ':seg': cierre.segundos }),
        ...VALORES_ESCRITURA_VALORACION,
        ...condicionParte.valores,
      },
    };

    if (operacionesHermanos.length > 0) {
      // Parte y hermanos en una sola transacción: o se guarda el reparto entero
      // o no se guarda nada, en vez de dejar el día repartido a medias.
      const escritura = await escribirTransaccionReparto([{ Update: actualizacionParte }, ...operacionesHermanos]);
      if (!escritura.ok) return res.status(escritura.status).json({ error: escritura.error });
    } else {
      try {
        await docClient.send(new UpdateCommand(actualizacionParte));
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') {
          return res.status(409).json({ error: 'La incidencia se ha modificado en otra sesión. Recarga e inténtalo de nuevo' });
        }
        throw err;
      }
    }

    return res.json({
      ok: true,
      valoracion: { lineas: lineasFinales, base: baseFinal, iva: ivaFinal, total: totalFinal },
      ...(reparto?.reparto?.km_imputados != null && { desplazamiento: reparto.reparto }),
    });
  }

  if (marcarReparado) {
    const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
    const item = current.Item || {};
    const tieneProgramacion =
      (item.fecha_programada && String(item.fecha_programada).trim() !== '') ||
      item.estado === 'Programado';
    if (!tieneProgramacion) {
      return res.status(400).json({ error: 'La incidencia debe estar programada antes de marcarla como reparada' });
    }

    // Marcar reparado deja EstadoValoracion en 'Reparado' y saca el parte del
    // reparto: sus kilómetros ya facturados dejarían de descontarse del trayecto
    // y el viaje se volvería a cobrar entero a otro parte.
    if (facturaDelParte(item)) {
      return res.status(400).json({ error: 'La incidencia ya está facturada: no se puede marcar como reparada' });
    }

    // Pasar a 'Reparado' saca el parte del conjunto de hermanos y del universo de
    // candidatos, que exigen estado valorado: sin rehacer el reparto, su tramo del
    // viaje no lo pagaría nadie. Es el caso simétrico de borrarlo.
    const cambio = esValoradoConDesplazamiento(item)
      ? await repartoPorCambioDeDia({ pk, sk, item, diaNuevo: '' })
      : null;

    const fechaCompletada = new Date().toISOString();
    // Esta pantalla no conoce el cronómetro: si el técnico lo dejó corriendo,
    // se cierra aquí en la misma escritura.
    const cierre = cerrarTramoAbierto(item, fechaCompletada);
    const actualizacionReparado = {
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression:
          'SET FechaCompletada = :fc, EstadoValoracion = :ev, #est = :est' +
          (cierre ? ', trabajo_tramos = :tr, trabajo_segundos = :seg' : ''),
        ExpressionAttributeNames: { '#est': 'estado' },
        ExpressionAttributeValues: {
          ':fc': fechaCompletada,
          ':ev': 'Reparado',
          ':est': 'Reparacion',
          ...(cierre && { ':tr': cierre.tramos, ':seg': cierre.segundos }),
        },
    };

    if (cambio && cambio.operaciones.length > 0) {
      // Las líneas de este parte no cambian, pero sí las de sus hermanos: o se
      // guarda el reparto entero o no se guarda nada.
      const condicion = condicionValoracionIntacta(item);
      const escritura = await escribirTransaccionReparto([
        {
          Update: {
            ...actualizacionReparado,
            ConditionExpression: condicion.expresion,
            ExpressionAttributeValues: {
              ...actualizacionReparado.ExpressionAttributeValues,
              ...condicion.valores,
            },
          },
        },
        ...cambio.operaciones,
      ]);
      if (!escritura.ok) return res.status(escritura.status).json({ error: escritura.error });
      return res.json({ ok: true });
    }

    await docClient.send(new UpdateCommand(actualizacionReparado));
    return res.json({ ok: true });
  }

  if (editarCampos) {
    const sets = [];
    const removes = [];
    const names = {};
    const values = {};
    let operacionesReparto = [];
    let condicionParte = null;
    let subirRev = false;
    const titulo = (body.titulo ?? '').toString().trim();
    const descripcion = (body.descripcion ?? '').toString().trim();
    const zona = (body.zona ?? '').toString().trim().toLowerCase();
    const categoria = (body.categoria ?? '').toString().trim().toLowerCase();
    const prioridadReportada = (body.prioridad_reportada ?? '').toString().trim().toLowerCase();
    const editarFechaProgramada = Object.prototype.hasOwnProperty.call(body, 'fecha_programada');

    if (titulo) { sets.push('#tit = :tit'); names['#tit'] = 'titulo'; values[':tit'] = titulo; }
    if (descripcion !== undefined && body.descripcion !== undefined) { sets.push('#desc = :desc'); names['#desc'] = 'descripcion'; values[':desc'] = descripcion; }
    if (zona && ZONAS.includes(zona)) { sets.push('zona = :zona'); values[':zona'] = zona; }
    if (categoria && CATEGORIAS.includes(categoria)) { sets.push('categoria = :cat'); values[':cat'] = categoria; }
    if (prioridadReportada && PRIORIDADES.includes(prioridadReportada)) { sets.push('prioridad_reportada = :pr'); values[':pr'] = prioridadReportada; }

    if (editarFechaProgramada) {
      const fpRaw = body.fecha_programada;
      const fp = fpRaw === null || fpRaw === undefined ? '' : String(fpRaw).trim();
      const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
      const item = current.Item || {};
      const esReparacion = item.estado === 'Reparacion';
      const conDesplazamiento = esValoradoConDesplazamiento(item);
      // Cambiar de día rehace el reparto de los dos días implicados, y los
      // kilómetros de un parte ya facturado no se pueden recalcular.
      if (facturaDelParte(item)) {
        return res.status(400).json({
          error: 'La incidencia ya está facturada: no se puede cambiar su fecha programada',
        });
      }
      if (!fp) {
        // Dejar sin día un desplazamiento ya cobrado rompe el reparto: ese parte
        // no vuelve a ser hermano de nadie y sus kilómetros no los paga nadie.
        if (conDesplazamiento) {
          return res.status(400).json({
            error: 'La incidencia tiene un desplazamiento valorado: cámbiale la fecha programada en lugar de quitarla',
          });
        }
        removes.push('fecha_programada');
        if (!esReparacion) {
          sets.push('#est = :estNuevo');
          names['#est'] = 'estado';
          values[':estNuevo'] = 'Nuevo';
        }
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(fp)) {
        return res.status(400).json({ error: 'fecha_programada debe ser yyyy-mm-dd' });
      } else {
        const programada = new Date(fp + 'T12:00:00');
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        programada.setHours(0, 0, 0, 0);
        if (programada.getTime() < hoy.getTime()) {
          return res.status(400).json({ error: 'No se puede asignar una fecha anterior al día actual' });
        }
        sets.push('fecha_programada = :fp');
        if (!esReparacion) {
          sets.push('#est = :estProg');
          names['#est'] = 'estado';
          values[':estProg'] = 'Programado';
        }
        values[':fp'] = fp;

        // Mover un parte valorado cambia dos repartos: el del día que deja y el
        // del día al que llega.
        const cambio = conDesplazamiento ? await repartoPorCambioDeDia({ pk, sk, item, diaNuevo: fp }) : null;
        if (cambio) {
          operacionesReparto = cambio.operaciones;
          condicionParte = condicionValoracionIntacta(item);
          Object.assign(values, condicionParte.valores);
          if (cambio.lineas) {
            sets.push('valoracion_lineas = :vln', 'valoracion_base = :vlb', 'valoracion_iva = :vli', 'valoracion_total = :vlt');
            values[':vln'] = cambio.lineas;
            values[':vlb'] = cambio.base;
            values[':vli'] = cambio.iva;
            values[':vlt'] = cambio.total;
            // Sus líneas cambian: sube el testigo y se reabre el cierre sin factura.
            removes.push(...CAMPOS_CIERRE_SIN_FACTURA);
            subirRev = true;
            Object.assign(values, VALORES_ESCRITURA_VALORACION);
          }
        }
      }
    } else {
      const current = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
      const item = current.Item || {};
      const tieneFechaProgramada = item.fecha_programada && String(item.fecha_programada).trim() !== '';
      if (!tieneFechaProgramada && item.estado === 'Programado') {
        sets.push('#est = :est');
        names['#est'] = 'estado';
        values[':est'] = 'Nuevo';
      }
    }

    if (sets.length === 0 && removes.length === 0) {
      return res.status(400).json({ error: 'No hay campos válidos para editar' });
    }

    const parts = [];
    if (sets.length > 0) parts.push(`SET ${sets.join(', ')}`);
    if (removes.length > 0) parts.push(`REMOVE ${removes.join(', ')}`);
    if (subirRev) parts.push(CLAUSULA_ADD_REV);

    const actualizacion = {
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression: parts.join(' '),
        ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
        ...(Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
      ...(condicionParte && { ConditionExpression: condicionParte.expresion }),
    };
    if (condicionParte) {
      const escritura = await escribirTransaccionReparto([{ Update: actualizacion }, ...operacionesReparto]);
      if (!escritura.ok) return res.status(escritura.status).json({ error: escritura.error });
    } else {
      await docClient.send(new UpdateCommand(actualizacion));
    }
    return res.json({ ok: true });
  }

  // Programar / desprogramar desde planning: también mueve el parte de día, así
  // que el reparto del desplazamiento se rehace igual que al editar campos.
  const actualGet = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
  const itemActual = actualGet.Item || {};
  const conDesplazamiento = esValoradoConDesplazamiento(itemActual);

  if (facturaDelParte(itemActual)) {
    return res.status(400).json({
      error: 'La incidencia ya está facturada: no se puede cambiar su fecha programada',
    });
  }

  if (!fechaProgramada || !/^\d{4}-\d{2}-\d{2}$/.test(fechaProgramada)) {
    if (conDesplazamiento) {
      return res.status(400).json({
        error: 'La incidencia tiene un desplazamiento valorado: cámbiale la fecha programada en lugar de quitarla',
      });
    }
    await docClient.send(
      new UpdateCommand({
        TableName: tables.mantenimiento,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'REMOVE fecha_programada SET #est = :est',
        ExpressionAttributeNames: { '#est': 'estado' },
        ExpressionAttributeValues: { ':est': 'Nuevo' },
      })
    );
    return res.json({ ok: true });
  }

  const programada = new Date(fechaProgramada + 'T12:00:00');
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  programada.setHours(0, 0, 0, 0);
  if (programada.getTime() < hoy.getTime()) {
    return res.status(400).json({ error: 'No se puede asignar una fecha anterior al día actual' });
  }

  const cambioDia = conDesplazamiento
    ? await repartoPorCambioDeDia({ pk, sk, item: itemActual, diaNuevo: fechaProgramada })
    : null;
  const setsProgramar = ['fecha_programada = :fp', '#est = :est'];
  const valuesProgramar = { ':fp': fechaProgramada, ':est': 'Programado' };
  if (cambioDia?.lineas) {
    setsProgramar.push('valoracion_lineas = :vln', 'valoracion_base = :vlb', 'valoracion_iva = :vli', 'valoracion_total = :vlt');
    valuesProgramar[':vln'] = cambioDia.lineas;
    valuesProgramar[':vlb'] = cambioDia.base;
    valuesProgramar[':vli'] = cambioDia.iva;
    valuesProgramar[':vlt'] = cambioDia.total;
    Object.assign(valuesProgramar, VALORES_ESCRITURA_VALORACION);
  }
  const condicionProgramar = cambioDia ? condicionValoracionIntacta(itemActual) : null;
  const actualizacionProgramar = {
      TableName: tables.mantenimiento,
      Key: { PK: pk, SK: sk },
    UpdateExpression:
      `SET ${setsProgramar.join(', ')}` + (cambioDia?.lineas ? SUFIJO_ESCRITURA_VALORACION : ''),
      ExpressionAttributeNames: { '#est': 'estado' },
    ExpressionAttributeValues: { ...valuesProgramar, ...(condicionProgramar?.valores ?? {}) },
    ...(condicionProgramar && { ConditionExpression: condicionProgramar.expresion }),
  };

  if (condicionProgramar) {
    const escritura = await escribirTransaccionReparto([
      { Update: actualizacionProgramar },
      ...(cambioDia?.operaciones ?? []),
    ]);
    if (!escritura.ok) return res.status(escritura.status).json({ error: escritura.error });
  } else {
    await docClient.send(new UpdateCommand(actualizacionProgramar));
  }
  return res.json({ ok: true });
});

router.delete('/mantenimiento/incidencias', async (req, res) => {
  const body = req.body || {};
  const localId = (body.local_id ?? '').toString().trim();
  const idIncidencia = (body.id_incidencia ?? '').toString().trim();
  const fechaCreacion = (body.fecha_creacion ?? '').toString().trim();

  if (!localId || !idIncidencia || !fechaCreacion) {
    return res.status(400).json({ error: 'local_id, id_incidencia y fecha_creacion son obligatorios' });
  }

  const pk = `LOCAL#${localId}`;
  const sk = `INC#${fechaCreacion}#${idIncidencia}`;

  // Borrar un parte que compartía viaje deja su parte de los kilómetros sin
  // cobrar a nadie: hay que rehacer el reparto del día con los que quedan.
  const actual = await docClient.send(new GetCommand({ TableName: tables.mantenimiento, Key: { PK: pk, SK: sk } }));
  const item = actual.Item || {};
  if (facturaDelParte(item)) {
    return res.status(400).json({ error: 'La incidencia ya está facturada: no se puede borrar' });
  }
  const cambio = esValoradoConDesplazamiento(item)
    ? await repartoPorCambioDeDia({ pk, sk, item, diaNuevo: '' })
    : null;

  if (cambio && cambio.operaciones.length > 0) {
    const condicion = condicionValoracionIntacta(item);
    const escritura = await escribirTransaccionReparto([
      {
        Delete: {
          TableName: tables.mantenimiento,
          Key: { PK: pk, SK: sk },
          ConditionExpression: condicion.expresion,
          ...(Object.keys(condicion.valores).length > 0 && { ExpressionAttributeValues: condicion.valores }),
        },
      },
      ...cambio.operaciones,
    ]);
    if (!escritura.ok) return res.status(escritura.status).json({ error: escritura.error });
    return res.json({ ok: true });
  }

  await docClient.send(
    new DeleteCommand({
      TableName: tables.mantenimiento,
      Key: { PK: pk, SK: sk },
    })
  );
  return res.json({ ok: true });
});

// ─── Facturación mensual de reparaciones ───

/**
 * Qué se facturaría del periodo, sin escribir nada. Por defecto, el mes
 * anterior. La lógica vive en `api/lib/facturacion/facturarMantenimiento.js`
 * porque la comparten el trabajo programado y el script de ensayo.
 */
router.get(
  '/mantenimiento/facturacion/previsualizar',
  requirePermission('mantenimiento.facturar'),
  async (req, res) => {
    const periodo = (req.query.periodo ?? '').toString().trim();
    try {
      const r = await previsualizarFacturacionMantenimiento({ periodo });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json(r);
    } catch (err) {
      throwSiTablaMantenimientoFalta(err);
    }
  }
);

/**
 * Genera las facturas del periodo en borrador. Si el periodo ya tenía factura
 * para una sociedad, se crea otra aparte: nunca se añaden líneas a un borrador
 * existente, porque el usuario puede estar editándolo y su guardado reescribe
 * todas las líneas.
 */
router.post(
  '/mantenimiento/facturacion/generar',
  requirePermission('mantenimiento.facturar'),
  async (req, res) => {
    const body = req.body || {};
    const periodo = (body.periodo ?? '').toString().trim();
    try {
      const r = await generarFacturacionMantenimiento({
        periodo,
        usuario_id: (req.user?.sub ?? '').toString(),
        usuario_nombre: (req.user?.Nombre ?? req.user?.email ?? '').toString(),
        origen: req.isInternal ? 'automatico' : 'manual',
      });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      return res.json(r);
    } catch (err) {
      throwSiTablaMantenimientoFalta(err);
    }
  }
);

export default router;
