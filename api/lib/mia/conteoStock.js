/**
 * Documento de conteo del MIA por stock máximo.
 *
 * Cabecera y pedidos de proveedor en Igp_MiaInformes (PK INFORME#id).
 * Líneas en Igp_MiaInformeLineas, igual que el informe de consumo.
 * tipo = stock_maximo para no mezclarlo con el cálculo por consumo.
 * El estado (generado → pedido → confirmado) es de cada proveedor, no del documento.
 */

import { randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { redondearCantidadCompra } from './demanda.js';
import { listInformeLineas, listInformesByWarehouse } from './informes.js';
import { normalizeProductId, normalizeWarehouseId, pkInforme, skInformeLinea } from './keys.js';
import { listProveedoresParaAjustes } from './proveedoresConfig.js';
import { unidadesAgora } from './stockMaximo.js';

export const TIPO_CONTEO = 'stock_maximo';
export const ESTADOS_PEDIDO = ['generado', 'enviando', 'pedido', 'confirmado'];
export const MENSAJE_RECALCULO_BLOQUEADO = 'No se puede recalcular: hay un pedido de proveedor en Pedido o Confirmado';
export const MENSAJE_CANTIDAD_NEGATIVA = 'La cantidad no puede ser negativa';
export const MENSAJE_CANTIDAD = 'La cantidad tiene que ser un número ≥ 0';
export const MENSAJE_CANTIDAD_FORMATO = 'La cantidad tiene que ser un múltiplo del formato de compra';
export const MENSAJE_MAXIMO_FINAL_NEGATIVO = 'El máximo final no puede ser negativo';
export const MENSAJE_MAXIMO_FINAL = 'El máximo final tiene que ser un número ≥ 0';

const SIGUIENTE = {
  generado: new Set(['enviando', 'pedido', 'confirmado']),
  enviando: new Set(['generado', 'pedido', 'confirmado']),
  pedido: new Set(['confirmado']),
  confirmado: new Set(),
};

function fallo(mensaje, status = 400) {
  return Object.assign(new Error(mensaje), { status, expose: true });
}

export function skPedidoProveedor(proveedorId) {
  const id = String(proveedorId ?? '').trim() || 'SIN_PROVEEDOR';
  return `PROV#${id}`;
}

function estadoDe(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!ESTADOS_PEDIDO.includes(e)) throw fallo('Estado de pedido no válido');
  return e;
}

async function leerMeta(informeId) {
  const r = await docClient.send(new GetCommand({
    TableName: tables.miaInformes,
    Key: { PK: pkInforme(informeId), SK: 'META' },
  }));
  return r.Item || null;
}

/**
 * Crea la cabecera, las líneas y un pedido por proveedor en estado generado.
 * La previsión, si viene, se guarda tal cual: este módulo no la recalcula.
 */
export async function crearConteoStock(input) {
  const informeId = String(input?.informeId || '').trim() || randomUUID();
  const warehouseId = normalizeWarehouseId(input?.warehouseId);
  if (!warehouseId || warehouseId === '000000') throw fallo('warehouseId es obligatorio');
  if (await leerMeta(informeId)) throw fallo('Ya existe un conteo con ese id', 409);

  const ahora = new Date().toISOString();
  const lineasIn = Array.isArray(input?.lineas) ? input.lineas : [];
  const PK = pkInforme(informeId);
  const lineas = lineasIn.map((ln) => {
    const productId = normalizeProductId(ln?.productId);
    if (!productId) throw fallo('Cada línea necesita productId');
    const proveedorId = String(ln?.proveedorId || 'SIN_PROVEEDOR').trim() || 'SIN_PROVEEDOR';
    const stockVacio = ln?.stockReal == null || ln?.stockReal === '';
    const stockReal = stockVacio ? null : Number(ln.stockReal);
    if (stockReal != null && !Number.isFinite(stockReal)) throw fallo('Stock real no válido');
    return {
      PK,
      SK: skInformeLinea(proveedorId, productId),
      informeId,
      productId,
      nombre: String(ln?.nombre || '').trim(),
      proveedorId,
      proveedorNombre: String(ln?.proveedorNombre || '').trim(),
      stockReal,
      maximo: ln?.maximo == null || ln?.maximo === '' ? null : Number(ln.maximo),
      maximoFinal: ln?.maximoFinal == null || ln?.maximoFinal === '' ? null : Number(ln.maximoFinal),
      maximoManual: ln?.maximoManual === true,
      cantidadManual: ln?.cantidadManual === true,
      cantidadPedida: ln?.cantidadPedida == null || ln?.cantidadPedida === '' ? null : Number(ln.cantidadPedida),
      formatoCompra: ln?.formatoCompra == null || ln?.formatoCompra === '' ? null : Number(ln.formatoCompra),
      purchaseUnitId: ln?.purchaseUnitId == null ? '' : String(ln.purchaseUnitId),
      unit: String(ln?.unit || '').trim(),
      proveedorManual: ln?.proveedorManual === true,
      unidadManual: ln?.unidadManual === true,
      costeUnitario: ln?.costeUnitario == null || ln?.costeUnitario === '' ? null : Number(ln.costeUnitario),
      costeLinea: ln?.costeLinea == null || ln?.costeLinea === '' ? null : Number(ln.costeLinea),
    };
  });

  const proveedores = new Map();
  for (const ln of lineas) {
    if (!proveedores.has(ln.proveedorId)) {
      proveedores.set(ln.proveedorId, {
        proveedorId: ln.proveedorId,
        proveedorNombre: ln.proveedorNombre,
      });
    }
  }

  const meta = {
    PK,
    SK: 'META',
    informeId,
    tipo: TIPO_CONTEO,
    estado: 'generado',
    WarehouseId: warehouseId,
    warehouseId,
    CreadoEn: ahora,
    creadoEn: ahora,
    semanasDesde: String(input?.semanasDesde || '').trim() || null,
    semanasHasta: String(input?.semanasHasta || '').trim() || null,
    ficheroNombre: String(input?.ficheroNombre || '').trim() || null,
    lineasLeidas: Number.isFinite(Number(input?.lineasLeidas)) ? Number(input.lineasLeidas) : lineas.length,
    idsDesconocidos: Array.isArray(input?.idsDesconocidos) ? input.idsDesconocidos.map((id) => String(id)) : [],
    duplicados: Array.isArray(input?.duplicados) ? input.duplicados.map((id) => String(id)) : [],
    previsionImporte: input?.previsionImporte == null ? null : Number(input.previsionImporte),
    tramoDesde: input?.tramoDesde == null ? null : Number(input.tramoDesde),
    tramoHasta: input?.tramoHasta == null ? null : Number(input.tramoHasta),
    multiplicador: input?.multiplicador == null ? null : Number(input.multiplicador),
    previsionAviso: String(input?.previsionAviso || '').trim() || null,
  };
  await docClient.send(new PutCommand({ TableName: tables.miaInformes, Item: meta }));

  for (const ln of lineas) {
    await docClient.send(new PutCommand({ TableName: tables.miaInformeLineas, Item: ln }));
  }

  const pedidos = [];
  for (const p of proveedores.values()) {
    const item = {
      PK,
      SK: skPedidoProveedor(p.proveedorId),
      informeId,
      tipo: TIPO_CONTEO,
      proveedorId: p.proveedorId,
      proveedorNombre: p.proveedorNombre,
      estado: 'generado',
      serie: null,
      number: null,
      importe: null,
      creadoEn: ahora,
    };
    await docClient.send(new PutCommand({ TableName: tables.miaInformes, Item: item }));
    pedidos.push(item);
  }

  return { meta, lineas, pedidos };
}

export async function listarPedidosProveedor(informeId) {
  const PK = pkInforme(informeId);
  if (!PK) return [];
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.miaInformes,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :pref)',
      ExpressionAttributeValues: { ':pk': PK, ':pref': 'PROV#' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Congela el cálculo en la cabecera y en las líneas.
 * Si algún proveedor ya salió de Generado, no escribe nada.
 * @param {string} informeId
 * @param {{ meta: object, lineas: object[] }} calculo
 */
export async function guardarCalculoConteo(informeId, calculo) {
  const id = String(informeId || '').trim();
  const meta = await leerMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const pedidos = await listarPedidosProveedor(id);
  if (pedidos.some((p) => p.estado !== 'generado')) {
    throw fallo(MENSAJE_RECALCULO_BLOQUEADO, 409);
  }
  const ahora = new Date().toISOString();
  const campos = calculo?.meta || {};
  const siguiente = {
    ...meta,
    previsionImporte: campos.previsionImporte,
    tramoDesde: campos.tramoDesde,
    tramoHasta: campos.tramoHasta,
    multiplicador: campos.multiplicador,
    previsionAviso: campos.previsionAviso,
    previsionDesglose: Array.isArray(campos.previsionDesglose) ? campos.previsionDesglose : [],
    lineasSinMaximo: Number(campos.lineasSinMaximo) || 0,
    rangoDesde: campos.rangoDesde,
    rangoHasta: campos.rangoHasta,
    fechaConteo: campos.fechaConteo,
    inicioEsManana: campos.inicioEsManana === true,
    calculadoEn: ahora,
  };
  await docClient.send(new PutCommand({ TableName: tables.miaInformes, Item: siguiente }));
  const lineas = [];
  for (const ln of calculo?.lineas || []) {
    await docClient.send(new PutCommand({ TableName: tables.miaInformeLineas, Item: ln }));
    lineas.push(ln);
  }
  const previas = await listInformeLineas(id);
  const vigentes = new Set(lineas.map((ln) => ln.SK));
  for (const vieja of previas) {
    if (vigentes.has(vieja.SK)) continue;
    await docClient.send(new DeleteCommand({
      TableName: tables.miaInformeLineas,
      Key: { PK: vieja.PK, SK: vieja.SK },
    }));
  }
  await reconciliarPedidos(id, lineas);
  return { meta: siguiente, lineas };
}

/** Crea, renombra o quita el hijo de proveedor mientras sigue en Generado. */
async function reconciliarPedidos(informeId, lineas) {
  const PK = pkInforme(informeId);
  const nombres = new Map();
  for (const ln of lineas) {
    const proveedorId = String(ln.proveedorId || 'SIN_PROVEEDOR');
    if (!nombres.has(proveedorId)) nombres.set(proveedorId, String(ln.proveedorNombre || '').trim());
  }
  const pedidos = await listarPedidosProveedor(informeId);
  const ahora = new Date().toISOString();
  for (const p of pedidos) {
    if (!nombres.has(p.proveedorId)) {
      if (p.estado === 'generado') {
        await docClient.send(new DeleteCommand({
          TableName: tables.miaInformes,
          Key: { PK, SK: p.SK },
        }));
      }
      continue;
    }
    const nombre = nombres.get(p.proveedorId);
    if (p.estado === 'generado' && nombre && nombre !== p.proveedorNombre) {
      await docClient.send(new PutCommand({
        TableName: tables.miaInformes,
        Item: { ...p, proveedorNombre: nombre },
      }));
    }
    nombres.delete(p.proveedorId);
  }
  for (const [proveedorId, proveedorNombre] of nombres) {
    await docClient.send(new PutCommand({
      TableName: tables.miaInformes,
      Item: {
        PK,
        SK: skPedidoProveedor(proveedorId),
        informeId,
        tipo: TIPO_CONTEO,
        proveedorId,
        proveedorNombre,
        estado: 'generado',
        serie: null,
        number: null,
        importe: null,
        creadoEn: ahora,
      },
    }));
  }
}

/**
 * Pasa un pedido de proveedor al estado siguiente y guarda serie y número si ya está en Ágora.
 */
export async function marcarPedidoProveedor(informeId, proveedorId, patch) {
  const id = String(informeId || '').trim();
  const meta = await leerMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const SK = skPedidoProveedor(proveedorId);
  const r = await docClient.send(new GetCommand({
    TableName: tables.miaInformes,
    Key: { PK: pkInforme(id), SK },
  }));
  const actual = r.Item;
  if (!actual) throw fallo('Pedido de proveedor no encontrado', 404);

  const destino = estadoDe(patch?.estado);
  if (destino !== actual.estado && !SIGUIENTE[actual.estado]?.has(destino)) {
    throw fallo(`No se puede pasar de ${actual.estado} a ${destino}`);
  }
  const serie = patch?.serie != null ? String(patch.serie).trim() : actual.serie;
  const number = patch?.number != null ? Number(patch.number) : actual.number;
  if ((destino === 'pedido' || destino === 'confirmado') && (!serie || !Number.isInteger(number) || number <= 0)) {
    throw fallo('Un pedido enviado a Ágora necesita serie y número');
  }
  const item = {
    ...actual,
    estado: destino,
    serie: serie || null,
    number: Number.isInteger(number) ? number : null,
    importe: patch?.importe == null ? actual.importe : Number(patch.importe),
    actualizadoEn: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: tables.miaInformes, Item: item }));
  return item;
}

function euros(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** true si qty es múltiplo exacto del formato (0 también vale). */
export function esMultiploDeFormato(qty, formato) {
  const pack = Number(formato);
  const q = Number(qty);
  if (!Number.isFinite(pack) || pack <= 0 || !Number.isFinite(q)) return false;
  const texto = String(pack);
  const coma = texto.indexOf('.');
  const decimales = coma < 0 ? 0 : Math.min(6, texto.length - coma - 1);
  const escala = 10 ** decimales;
  const unidades = Math.round(q * escala);
  const paso = Math.round(pack * escala);
  return paso > 0 && unidades % paso === 0;
}

/**
 * Cantidad y máximo final como los dejaría calcular, sin las marcas manuales.
 * Sin máximo o sin multiplicador, la cantidad calculada es 0.
 */
export function valorCalculado(linea, multiplicador) {
  const maximo = linea?.maximo == null || linea.maximo === '' ? null : Number(linea.maximo);
  const formato = Number(linea?.formatoCompra);
  const pack = Number.isFinite(formato) && formato > 0 ? formato : null;
  const mult = Number(multiplicador);
  if (maximo == null || !Number.isFinite(maximo) || maximo < 0 || !Number.isFinite(mult)) {
    return { maximoFinal: null, cantidadPedida: 0 };
  }
  const maximoFinal = euros(maximo * mult);
  if (linea?.stockReal == null || linea?.stockReal === '') {
    return { maximoFinal, cantidadPedida: 0 };
  }
  const falta = Math.max(0, maximoFinal - Number(linea.stockReal));
  return { maximoFinal, cantidadPedida: redondearCantidadCompra(falta, pack) };
}

function textoNumero(raw) {
  return String(raw ?? '').trim().replace(',', '.');
}

/**
 * @returns {number}
 */
export function interpretarCantidad(raw, formato, indice) {
  const t = textoNumero(raw);
  if (t.startsWith('-')) mal(MENSAJE_CANTIDAD_NEGATIVA, indice);
  if (!/^\d+(\.\d+)?$/.test(t)) mal(MENSAJE_CANTIDAD, indice);
  const n = Number(t);
  const pack = Number(formato);
  if (Number.isFinite(pack) && pack > 0 && !esMultiploDeFormato(n, pack)) {
    mal(MENSAJE_CANTIDAD_FORMATO, indice);
  }
  return n;
}

function interpretarMaximoFinal(raw, indice) {
  if (raw == null || textoNumero(raw) === '') return null;
  const t = textoNumero(raw);
  if (t.startsWith('-')) mal(MENSAJE_MAXIMO_FINAL_NEGATIVO, indice);
  if (!/^\d+(\.\d+)?$/.test(t)) mal(MENSAJE_MAXIMO_FINAL, indice);
  return Number(t);
}

function mal(mensaje, indice, extra = {}) {
  throw Object.assign(fallo(mensaje), { indice, ...extra });
}

export function estadoDeConteo(pedidos) {
  const estados = (pedidos || []).map((p) => String(p.estado || 'generado'));
  if (!estados.length || estados.every((e) => e === 'generado')) return 'generado';
  if (estados.every((e) => e === 'confirmado')) return 'confirmado';
  if (estados.every((e) => e === 'pedido' || e === 'confirmado')) return 'pedido';
  if (estados.every((e) => e === 'enviando')) return 'enviando';
  return 'mixto';
}

function vistaLinea(ln, multiplicador) {
  const calculado = valorCalculado(ln, multiplicador);
  return {
    productId: ln.productId,
    nombre: ln.nombre || '',
    proveedorId: ln.proveedorId,
    proveedorNombre: ln.proveedorNombre || '',
    stockReal: ln.stockReal == null || ln.stockReal === '' ? null : Number(ln.stockReal),
    maximo: ln.maximo == null || ln.maximo === '' ? null : Number(ln.maximo),
    maximoFinal: ln.maximoFinal == null || ln.maximoFinal === '' ? null : Number(ln.maximoFinal),
    maximoManual: ln.maximoManual === true,
    cantidadPedida: ln.cantidadPedida == null || ln.cantidadPedida === '' ? null : Number(ln.cantidadPedida),
    cantidadManual: ln.cantidadManual === true,
    formatoCompra: ln.formatoCompra == null || ln.formatoCompra === '' ? null : Number(ln.formatoCompra),
    purchaseUnitId: ln.purchaseUnitId == null ? '' : String(ln.purchaseUnitId),
    unit: String(ln.unit || ln.purchaseUnitName || '').trim(),
    proveedorManual: ln.proveedorManual === true,
    unidadManual: ln.unidadManual === true,
    costeUnitario: ln.costeUnitario == null || ln.costeUnitario === '' ? null : Number(ln.costeUnitario),
    omitida: ln.omitida === true,
    aviso: ln.aviso || (ln.stockReal == null || ln.stockReal === '' ? 'Sin contar; no se pide' : null),
    cantidadCalculada: calculado.cantidadPedida,
    maximoCalculado: calculado.maximoFinal,
  };
}

function resumenPedido(p) {
  return {
    proveedorId: p.proveedorId,
    proveedorNombre: p.proveedorNombre || '',
    estado: p.estado || 'generado',
    serie: p.serie || null,
    number: p.number ?? null,
    enviandoDesde: p.enviandoDesde || null,
  };
}

/** Conteos de stock máximo del almacén, del más reciente al más antiguo. */
export async function listarConteos(warehouseId) {
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') throw fallo('warehouseId es obligatorio');
  const items = await listInformesByWarehouse(wid, { limit: 100 });
  const metas = items.filter((it) => it.SK === 'META' && it.tipo === TIPO_CONTEO);
  const conteos = [];
  for (const meta of metas) {
    const pedidos = await listarPedidosProveedor(meta.informeId);
    conteos.push({
      informeId: meta.informeId,
      creadoEn: meta.creadoEn || meta.CreadoEn || null,
      ficheroNombre: meta.ficheroNombre || null,
      estado: estadoDeConteo(pedidos),
      multiplicador: meta.multiplicador == null ? null : Number(meta.multiplicador),
      calculadoEn: meta.calculadoEn || null,
    });
  }
  conteos.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
  return { warehouseId: wid, conteos };
}

/** Cabecera, líneas y pedidos. No escribe. */
export async function leerConteo(informeId) {
  const id = String(informeId || '').trim();
  const meta = await leerMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const [lineas, pedidos] = await Promise.all([
    listInformeLineas(id),
    listarPedidosProveedor(id),
  ]);
  const vista = [];
  for (const ln of lineas) {
    const v = vistaLinea(ln, meta.multiplicador);
    v.unidades = unidadesAgora(await fichaUnidades(ln.productId));
    vista.push(v);
  }
  const sinContar = vista
    .filter((ln) => ln.stockReal == null)
    .map((ln) => ({ productId: ln.productId, nombre: ln.nombre }));
  return {
    informeId: id,
    warehouseId: meta.WarehouseId || meta.warehouseId,
    creadoEn: meta.creadoEn || meta.CreadoEn || null,
    ficheroNombre: meta.ficheroNombre || null,
    semanasDesde: meta.semanasDesde || null,
    semanasHasta: meta.semanasHasta || null,
    multiplicador: meta.multiplicador == null ? null : Number(meta.multiplicador),
    previsionImporte: meta.previsionImporte == null ? null : Number(meta.previsionImporte),
    previsionAviso: meta.previsionAviso || null,
    rangoDesde: meta.rangoDesde || null,
    rangoHasta: meta.rangoHasta || null,
    calculadoEn: meta.calculadoEn || null,
    desconocidos: Array.isArray(meta.idsDesconocidos) ? meta.idsDesconocidos : [],
    duplicados: Array.isArray(meta.duplicados) ? meta.duplicados : [],
    lineasLeidas: meta.lineasLeidas ?? vista.length,
    lineasContadas: vista.filter((ln) => ln.stockReal != null).length,
    sinContar,
    estado: estadoDeConteo(pedidos),
    editable: pedidos.every((p) => p.estado === 'generado'),
    proveedores: await proveedoresParaElegir(meta.WarehouseId || meta.warehouseId, lineas),
    pedidos: pedidos.map(resumenPedido),
    lineas: vista,
  };
}

/**
 * Guarda cantidad, máximo final y línea quitada.
 * Valida el lote entero antes de escribir. Si algún proveedor ya no está
 * en Generado, no toca nada.
 */
export async function guardarLineasConteo(informeId, ajustes) {
  const id = String(informeId || '').trim();
  const meta = await leerMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const pedidos = await listarPedidosProveedor(id);
  if (pedidos.some((p) => p.estado !== 'generado')) {
    throw fallo(MENSAJE_RECALCULO_BLOQUEADO, 409);
  }
  if (!Array.isArray(ajustes) || ajustes.length === 0) {
    throw fallo('No hay líneas para guardar');
  }
  const lineas = await listInformeLineas(id);
  const porClave = new Map(lineas.map((ln) => [`${ln.proveedorId}#${ln.productId}`, ln]));
  const tocadas = [];
  const vistas = new Set();
  for (let indice = 0; indice < ajustes.length; indice += 1) {
    const adj = ajustes[indice] || {};
    const productId = normalizeProductId(adj.productId);
    const proveedorId = String(adj.proveedorId || '').trim();
    if (!productId || !proveedorId) mal('Cada línea necesita producto y proveedor', indice);
    const clave = `${proveedorId}#${productId}`;
    if (vistas.has(clave)) mal('La línea está repetida', indice, { productId, proveedorId });
    vistas.add(clave);
    const linea = porClave.get(clave);
    if (!linea) mal('Línea no encontrada', indice, { productId, proveedorId });
    const calculado = valorCalculado(linea, meta.multiplicador);
    const omitida = adj.omitida === true;
    const cantidadManual = !omitida && adj.cantidadManual === true;
    const maximoManual = adj.maximoManual === true;
    const cantidad = omitida || !cantidadManual
      ? (omitida ? 0 : calculado.cantidadPedida)
      : interpretarCantidad(adj.cantidadPedida, linea.formatoCompra, indice);
    if (!omitida && cantidadManual) interpretarCantidad(cantidad, linea.formatoCompra, indice);
    const maximoFinal = maximoManual
      ? interpretarMaximoFinal(adj.maximoFinal, indice)
      : calculado.maximoFinal;
    if (maximoManual && maximoFinal == null) mal(MENSAJE_MAXIMO_FINAL, indice, { productId, proveedorId });
    let proveedorDestino = linea.proveedorId;
    let proveedorNombre = linea.proveedorNombre;
    let proveedorManual = linea.proveedorManual === true;
    if (adj.proveedorManual === true) {
      const destino = String(adj.proveedorDestino || '').trim();
      if (!/^\d+$/.test(destino) || Number(destino) <= 0) {
        mal('Elige un proveedor de Ágora', indice, { productId, proveedorId });
      }
      proveedorDestino = destino;
      proveedorNombre = String(adj.proveedorNombre || '').trim() || destino;
      proveedorManual = true;
    }
    let purchaseUnitId = linea.purchaseUnitId == null ? '' : String(linea.purchaseUnitId);
    let unit = String(linea.unit || '').trim();
    let unidadManual = linea.unidadManual === true;
    if (adj.unidadManual === true) {
      const idUnidad = String(adj.purchaseUnitId || '').trim();
      const nombreUnidad = String(adj.unit || '').trim() || idUnidad;
      if (!/^\d+$/.test(idUnidad) || Number(idUnidad) <= 0) {
        mal('Elige una unidad de compra', indice, { productId, proveedorId });
      }
      purchaseUnitId = idUnidad;
      unit = nombreUnidad;
      unidadManual = true;
    }
    const skNueva = skInformeLinea(proveedorDestino, productId);
    const choca = lineas.find((ln) => ln.SK === skNueva && ln.SK !== linea.SK);
    if (choca) mal('Ya hay una línea de ese producto con ese proveedor', indice, { productId, proveedorId });
    tocadas.push({
      ...linea,
      SK: skNueva,
      skAnterior: linea.SK,
      proveedorId: proveedorDestino,
      proveedorNombre,
      proveedorManual,
      purchaseUnitId,
      unit,
      unidadManual,
      omitida,
      cantidadManual: omitida || cantidadManual,
      cantidadPedida: cantidad,
      maximoManual,
      maximoFinal,
    });
  }
  for (const ln of tocadas) {
    const { skAnterior, ...item } = ln;
    await docClient.send(new PutCommand({ TableName: tables.miaInformeLineas, Item: item }));
    if (skAnterior && skAnterior !== item.SK) {
      await docClient.send(new DeleteCommand({
        TableName: tables.miaInformeLineas,
        Key: { PK: item.PK, SK: skAnterior },
      }));
    }
  }
  await reconciliarPedidos(id, await listInformeLineas(id));
  return leerConteo(id);
}

async function fichaUnidades(productId) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.agoraProducts,
      Key: { PK: 'GLOBAL', SK: id },
    }));
    return r.Item && r.Item.SK !== 'META' ? r.Item : null;
  } catch {
    return null;
  }
}

async function proveedoresParaElegir(warehouseId, lineas) {
  const porId = new Map();
  for (const ln of lineas || []) {
    const id = String(ln.proveedorId || '').trim();
    if (!id || id === 'SIN_PROVEEDOR') continue;
    porId.set(id, String(ln.proveedorNombre || '').trim() || id);
  }
  try {
    const lista = await listProveedoresParaAjustes(warehouseId);
    for (const p of lista) {
      if (!p?.proveedorId || p.proveedorId === 'SIN_PROVEEDOR') continue;
      porId.set(p.proveedorId, p.proveedorNombre || porId.get(p.proveedorId) || p.proveedorId);
    }
  } catch {
    /* sin la tabla de compras, el desplegable usa los proveedores que ya hay en el conteo */
  }
  return [...porId.entries()]
    .map(([proveedorId, proveedorNombre]) => ({ proveedorId, proveedorNombre }))
    .sort((a, b) => a.proveedorNombre.localeCompare(b.proveedorNombre, 'es'));
}
