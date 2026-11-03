/**
 * Cálculo del pedido por stock máximo.
 *
 * La previsión del rango es la suma, día a día y local a local, del objetivo
 * del día comparable (FechaComparativa del festivo, o el mismo día del año
 * anterior). No se prorratea un mes.
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

import {
  buildFechaToComp,
  loadFestivosByFecha,
  queryTotalsByDay,
} from '../agora/objetivoMensual.js';
import { listConfigByWarehouse } from './configProducto.js';
import { guardarCalculoConteo, TIPO_CONTEO } from './conteoStock.js';
import { redondearCantidadCompra } from './demanda.js';
import { getInformeMeta, listInformeLineas } from './informes.js';
import { buildMapaLocalAlmacen } from './localAlmacen.js';
import { elegirTramo, listarTramos } from './tramos.js';

export const AVISO_SIN_MAXIMO = 'Sin máximo configurado';
export const AVISO_SIN_CONTAR = 'Sin contar; no se pide';
export const MENSAJE_SIN_LOCAL = 'Este almacén no tiene local asociado; la previsión es 0';
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

async function tramosAplicables(warehouseId) {
  const propios = await listarTramos(warehouseId);
  if (propios.length) return propios;
  const globales = await listarTramos(null);
  if (globales.length) return globales;
  throw fallo('No hay tramos de multiplicador');
}

/**
 * Suma el objetivo comparable de cada día del rango en cada local del almacén.
 * @returns {Promise<{ importe: number, aviso: string|null, desglose: object[] }>}
 */
export async function sumarPrevisionRango(warehouseId, desde, hasta) {
  const dias = diasEntre(desde, hasta);
  const mapa = await buildMapaLocalAlmacen();
  const ids = mapa.porWarehouseId[warehouseId] || [];
  const locales = ids
    .map((id) => mapa.locales.find((l) => l.id === id))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!locales.length) {
    return { importe: 0, aviso: MENSAJE_SIN_LOCAL, desglose: [] };
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

  return { importe: euros(total), aviso: avisos.length ? avisos.join('. ') : null, desglose };
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
    nombre: ln.nombre,
    stockReal: ln.stockReal,
    maximo: ln.maximo,
    maximoFinal: ln.maximoFinal,
    maximoManual: ln.maximoManual === true,
    cantidadPedida: ln.cantidadPedida,
    formatoCompra: ln.formatoCompra,
    aviso: ln.aviso,
  };
}

async function prepararCalculo(informeId, { previsionImporte } = {}) {
  const id = String(informeId || '').trim();
  const meta = await getInformeMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const warehouseId = meta.WarehouseId || meta.warehouseId;
  const rango = resolverRangoPrevision(meta);
  const prueba = previsionImporte != null && previsionImporte !== '';
  let prevision;
  if (prueba) {
    const n = Number(previsionImporte);
    if (!Number.isFinite(n) || n < 0) throw fallo('El importe de prueba no es válido');
    prevision = { importe: euros(n), aviso: AVISO_IMPORTE_PRUEBA, desglose: [] };
  } else {
    prevision = await sumarPrevisionRango(warehouseId, rango.inicio, rango.fin);
  }
  const tramo = elegirTramo(prevision.importe, await tramosAplicables(warehouseId));
  if (!tramo) throw fallo('Ningún tramo cubre esta previsión');

  const configs = await listConfigByWarehouse(warehouseId);
  const porProducto = new Map(configs.map((c) => [String(c.ProductId), c]));
  const originales = await listInformeLineas(id);
  const lineas = originales.map((ln) => calcularLineaStock(ln, porProducto.get(String(ln.productId)), tramo.multiplicador));
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
export async function calcularConteo(informeId) {
  const calc = await prepararCalculo(informeId);
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
      fechaConteo: calc.fechaConteo,
      inicioEsManana: calc.inicioEsManana,
    },
    lineas: calc.items,
  });
  return respuesta(calc);
}
