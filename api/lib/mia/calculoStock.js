/**
 * Cálculo del pedido por stock máximo.
 *
 * La previsión del rango es la suma, día a día, del objetivo del día comparable
 * (FechaComparativa del festivo, o el mismo día del año anterior) de los locales
 * de sede «Grupo Paripe». Si no se elige ninguno, entran todos. No se prorratea
 * un mes. El tramo que se aplica es el global.
 *
 * El día de inicio, si el conteo no trae semanasDesde, es el día siguiente a
 * la fecha del conteo en calendario de Madrid: mañana respecto a esa fecha,
 * no respecto al momento de calcular y no el propio día del conteo.
 * Si trae semanasDesde y semanasHasta, mandan esas fechas.
 *
 * El tramo y el multiplicador se congelan al calcular. Simular hace la misma
 * cuenta y no escribe. Un máximo manual no se multiplica otra vez.
 * Sin máximo configurado no se pide.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';
import {
  buildFechaToComp,
  loadFestivosByFecha,
  queryTotalsByDay,
} from '../agora/objetivoMensual.js';
import { listConfigByWarehouse } from './configProducto.js';
import { guardarCalculoConteo, TIPO_CONTEO } from './conteoStock.js';
import { redondearCantidadCompra } from './demanda.js';
import { aplicarProveedorYUnidad } from './importarExcel.js';
import { getInformeMeta, listInformeLineas } from './informes.js';
import { elegirTramo, listarTramos } from './tramos.js';

export const AVISO_SIN_MAXIMO = 'Sin máximo configurado';
export const AVISO_SIN_CONTAR = 'Sin contar; no se pide';
export const MENSAJE_SIN_SEDE = 'No hay locales de sede Grupo Paripe';
export const MENSAJE_SIN_SELECCION = 'Elige al menos un local de sede Grupo Paripe';
export const AVISO_IMPORTE_PRUEBA = 'Importe de prueba; no sustituye a la previsión del rango';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TOPE_DIAS = 366;

function fallo(mensaje, status = 400) {
  return Object.assign(new Error(mensaje), { status, expose: true });
}

function euros(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Fecha civil de Madrid (YYYY-MM-DD) de un instante ISO. */
export function fechaCalendarioMadrid(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function sumarDiasIso(fecha, dias) {
  const d = new Date(`${String(fecha).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fechaOVacio(valor) {
  const s = String(valor || '').slice(0, 10);
  return RE_FECHA.test(s) ? s : '';
}

/**
 * Rango inclusive de la previsión.
 * Sin semanasDesde, el inicio es el día siguiente a la fecha del conteo.
 * @param {{ creadoEn?: string, semanasDesde?: string|null, semanasHasta?: string|null }} conteo
 */
export function resolverRangoPrevision(conteo) {
  const fechaConteo = fechaCalendarioMadrid(conteo?.creadoEn);
  if (!RE_FECHA.test(fechaConteo)) throw fallo('El conteo no tiene fecha');
  const manana = sumarDiasIso(fechaConteo, 1);
  const desde = fechaOVacio(conteo?.semanasDesde);
  const hasta = fechaOVacio(conteo?.semanasHasta);
  const inicio = desde || manana;
  const fin = hasta && hasta >= inicio ? hasta : sumarDiasIso(inicio, 6);
  return {
    fechaConteo,
    inicio,
    fin,
    inicioEsManana: !desde,
  };
}

function diasEntre(desde, hasta) {
  const dias = [];
  let cursor = desde;
  while (cursor <= hasta) {
    dias.push(cursor);
    if (dias.length > TOPE_DIAS) throw fallo('El rango de previsión no puede pasar de un año');
    cursor = sumarDiasIso(cursor, 1);
  }
  return dias;
}

async function tramosGlobales() {
  const globales = await listarTramos(null);
  if (!globales.length) throw fallo('No hay tramos de multiplicador');
  return globales;
}

/** Sede exacta. «Grupo Paripe Madrid» no entra. */
export function esSedeExactaGrupoParipe(loc) {
  return String(loc?.sede ?? loc?.Sede ?? '').trim().toLowerCase() === 'grupo paripe';
}

export async function listarLocalesGrupoParipe() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.locales,
      ProjectionExpression: 'id_Locales, nombre, agoraCode, sede, Sede',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items
    .map((l) => ({
      id: formatId6(l.id_Locales),
      nombre: String(l.nombre ?? '').trim(),
      agoraCode: l.agoraCode != null ? String(l.agoraCode).trim() : '',
      sede: String(l.sede ?? l.Sede ?? '').trim(),
    }))
    .filter((l) => l.id && l.id !== '000000' && esSedeExactaGrupoParipe(l))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function idsPedidos(raw) {
  if (raw == null) return null;
  const lista = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(lista.map((id) => formatId6(id)).filter((id) => id && id !== '000000'))];
}

/**
 * Suma el objetivo comparable de los locales de sede Grupo Paripe.
 * Sin `localIds`, entran todos. Una lista vacía no suma ninguno.
 * Un id de otra sede se ignora.
 */
export async function sumarPrevisionLocales(localIds, desde, hasta) {
  const dias = diasEntre(desde, hasta);
  const paripe = await listarLocalesGrupoParipe();
  const pedidos = idsPedidos(localIds);
  const locales = pedidos == null ? paripe : paripe.filter((l) => pedidos.includes(l.id));
  if (!locales.length) {
    return {
      importe: 0,
      aviso: pedidos == null ? MENSAJE_SIN_SEDE : MENSAJE_SIN_SELECCION,
      desglose: [],
      locales: [],
    };
  }

  const festivos = await loadFestivosByFecha(desde, hasta);
  const { fechaToComp, minComp, maxComp } = buildFechaToComp(desde, hasta, festivos);
  const avisos = [];
  const desglose = [];
  let total = 0;

  for (const local of locales) {
    const agora = String(local.agoraCode || '').trim();
    if (!agora) {
      avisos.push(`El local ${local.nombre || local.id} no tiene código Ágora; no suma previsión`);
    }
    const totales = agora && minComp ? await queryTotalsByDay(agora, minComp, maxComp) : {};
    for (const fecha of dias) {
      const fechaComparativa = fechaToComp[fecha];
      const importe = euros(totales[fechaComparativa] || 0);
      total += importe;
      desglose.push({
        fecha,
        localId: local.id,
        localNombre: local.nombre,
        fechaComparativa,
        importe,
      });
    }
  }

  return {
    importe: euros(total),
    aviso: avisos.length ? avisos.join('. ') : null,
    desglose,
    locales: locales.map((l) => ({ id: l.id, nombre: l.nombre })),
  };
}

function maximoConfigurado(config) {
  if (!config || config.maximo == null || config.maximo === '') return null;
  const n = Number(config.maximo);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function formatoDe(config) {
  const n = Number(config?.formatoCompra);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Máximo final y cantidad de una línea. Sin máximo no pide.
 * @param {object} linea
 * @param {object|undefined} config
 * @param {number} multiplicador
 */
export function calcularLineaStock(linea, config, multiplicador) {
  const manual = linea?.maximoManual === true
    && linea.maximoFinal != null
    && linea.maximoFinal !== ''
    && Number.isFinite(Number(linea.maximoFinal));
  const maximo = maximoConfigurado(config);
  const formatoCompra = formatoDe(config);
  const base = {
    ...linea,
    formatoCompra,
    sinMaximo: false,
    aviso: null,
  };
  if (!manual && maximo == null) {
    return {
      ...base,
      maximo: null,
      maximoFinal: null,
      cantidadPedida: 0,
      aviso: AVISO_SIN_MAXIMO,
      sinMaximo: true,
    };
  }
  const maximoFinal = manual ? euros(linea.maximoFinal) : euros(maximo * multiplicador);
  if (linea?.stockReal == null || linea?.stockReal === '') {
    return { ...base, maximo, maximoFinal, cantidadPedida: 0, aviso: AVISO_SIN_CONTAR };
  }
  if (linea?.cantidadManual === true && Number.isFinite(Number(linea.cantidadPedida))) {
    return { ...base, maximo, maximoFinal, cantidadPedida: Number(linea.cantidadPedida) };
  }
  const falta = Math.max(0, maximoFinal - Number(linea.stockReal));
  return {
    ...base,
    maximo,
    maximoFinal,
    cantidadPedida: redondearCantidadCompra(falta, formatoCompra),
  };
}

function vistaLinea(ln) {
  return {
    productId: ln.productId,
    proveedorId: ln.proveedorId,
    nombre: ln.nombre,
    stockReal: ln.stockReal,
    maximo: ln.maximo,
    maximoFinal: ln.maximoFinal,
    maximoManual: ln.maximoManual === true,
    cantidadPedida: ln.cantidadPedida,
    formatoCompra: ln.formatoCompra,
    purchaseUnitId: ln.purchaseUnitId == null ? '' : String(ln.purchaseUnitId),
    unit: String(ln.unit || ln.purchaseUnitName || '').trim(),
    aviso: ln.aviso,
  };
}

async function prepararCalculo(informeId, { previsionImporte, localIds, semanasDesde, semanasHasta } = {}) {
  const id = String(informeId || '').trim();
  const meta = await getInformeMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const warehouseId = meta.WarehouseId || meta.warehouseId;
  const desdePedido = fechaOVacio(semanasDesde);
  const hastaPedido = fechaOVacio(semanasHasta);
  const metaRango = desdePedido && hastaPedido
    ? { ...meta, semanasDesde: desdePedido, semanasHasta: hastaPedido }
    : meta;
  const rango = resolverRangoPrevision(metaRango);
  const prueba = previsionImporte != null && previsionImporte !== '';
  let prevision;
  if (prueba) {
    const n = Number(previsionImporte);
    if (!Number.isFinite(n) || n < 0) throw fallo('El importe de prueba no es válido');
    prevision = { importe: euros(n), aviso: AVISO_IMPORTE_PRUEBA, desglose: [] };
  } else {
    prevision = await sumarPrevisionLocales(localIds, rango.inicio, rango.fin);
  }
  const tramo = elegirTramo(prevision.importe, await tramosGlobales());
  if (!tramo) throw fallo('Ningún tramo cubre esta previsión');

  const configs = await listConfigByWarehouse(warehouseId);
  const porProducto = new Map(configs.map((c) => [String(c.ProductId), c]));
  const originales = await listInformeLineas(id);
  const calculadas = originales.map((ln) => calcularLineaStock(ln, porProducto.get(String(ln.productId)), tramo.multiplicador));
  const lineas = await aplicarProveedorYUnidad(calculadas, warehouseId);
  const lineasSinMaximo = lineas.filter((ln) => ln.sinMaximo).length;
  const aviso = [prevision.aviso, lineasSinMaximo ? `${lineasSinMaximo} producto(s) sin máximo configurado` : '']
    .filter(Boolean)
    .join('. ') || null;

  return {
    informeId: id,
    fechaConteo: rango.fechaConteo,
    rangoDesde: rango.inicio,
    rangoHasta: rango.fin,
    inicioEsManana: rango.inicioEsManana,
    previsionImporte: prevision.importe,
    tramoDesde: tramo.desde,
    tramoHasta: tramo.hasta,
    multiplicador: tramo.multiplicador,
    previsionAviso: aviso,
    desglose: prevision.desglose,
    lineasSinMaximo,
    lineas: lineas.map(vistaLinea),
    items: lineas,
  };
}

function respuesta(calc) {
  return {
    informeId: calc.informeId,
    fechaConteo: calc.fechaConteo,
    rangoDesde: calc.rangoDesde,
    rangoHasta: calc.rangoHasta,
    inicioEsManana: calc.inicioEsManana,
    previsionImporte: calc.previsionImporte,
    tramoDesde: calc.tramoDesde,
    tramoHasta: calc.tramoHasta,
    multiplicador: calc.multiplicador,
    previsionAviso: calc.previsionAviso,
    desglose: calc.desglose,
    lineasSinMaximo: calc.lineasSinMaximo,
    lineas: calc.lineas,
  };
}

/** Misma cuenta que calcular, sin escribir. `previsionImporte` prueba otro tramo. */
export async function simularConteo(informeId, opts = {}) {
  const calc = await prepararCalculo(informeId, opts);
  return respuesta(calc);
}

/** Calcula y congela tramo, multiplicador y cantidades. Recalcula si todo sigue en Generado. */
export async function calcularConteo(informeId, opts = {}) {
  const calc = await prepararCalculo(informeId, opts);
  await guardarCalculoConteo(informeId, {
    meta: {
      previsionImporte: calc.previsionImporte,
      tramoDesde: calc.tramoDesde,
      tramoHasta: calc.tramoHasta,
      multiplicador: calc.multiplicador,
      previsionAviso: calc.previsionAviso,
      previsionDesglose: calc.desglose,
      lineasSinMaximo: calc.lineasSinMaximo,
      rangoDesde: calc.rangoDesde,
      rangoHasta: calc.rangoHasta,
      semanasDesde: fechaOVacio(opts.semanasDesde) || undefined,
      semanasHasta: fechaOVacio(opts.semanasHasta) || undefined,
      fechaConteo: calc.fechaConteo,
      inicioEsManana: calc.inicioEsManana,
    },
    lineas: calc.items,
  });
  return respuesta(calc);
}
