/**
 * Aprueba un pedido de proveedor de un conteo de stock máximo.
 * Un solo envío a Ágora: el hijo pasa a «enviando» con condición y, si Ágora
 * falla, vuelve a Generado. Borrador por defecto; Confirmed lo pide la ruta.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { buildPurchaseOrderPayload } from '../agora/purchaseOrdersImport.js';
import { parseSupplierIdAgora } from './aprobar.js';
import { MENSAJE_SIN_NUMERO, SERIE_PEDIDO_MIA, reservarNumeroPedido } from './contadorPedido.js';
import { TIPO_CONTEO, skPedidoProveedor } from './conteoStock.js';
import { listInformeLineas } from './informes.js';
import { normalizeWarehouseId, pkInforme } from './keys.js';

export const MENSAJE_EN_CURSO = 'Este proveedor ya se está enviando o ya no está en Generado';
export const MENSAJE_LINEAS = 'No se envía el pedido: hay líneas que no se pueden pedir';
export const MENSAJE_SIN_LINEAS = 'No hay líneas con cantidad para este proveedor';
export const MENSAJE_AGORA = 'Ágora ha rechazado el pedido. El proveedor sigue en Generado';

function fallo(mensaje, status = 400, extra = {}) {
  return Object.assign(new Error(mensaje), { status, expose: true, ...extra });
}

async function leerMeta(informeId) {
  const r = await docClient.send(new GetCommand({
    TableName: tables.miaInformes,
    Key: { PK: pkInforme(informeId), SK: 'META' },
  }));
  return r.Item || null;
}

async function leerHijo(informeId, proveedorId) {
  const r = await docClient.send(new GetCommand({
    TableName: tables.miaInformes,
    Key: { PK: pkInforme(informeId), SK: skPedidoProveedor(proveedorId) },
  }));
  return r.Item || null;
}

function esCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

async function pasarEstado(informeId, proveedorId, valores, extra = '', names = null) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: tables.miaInformes,
      Key: { PK: pkInforme(informeId), SK: skPedidoProveedor(proveedorId) },
      UpdateExpression: `SET estado = :destino, actualizadoEn = :ahora${extra}`,
      ConditionExpression: 'estado = :esperado',
      ExpressionAttributeValues: valores,
      ...(names ? { ExpressionAttributeNames: names } : {}),
    }));
    return true;
  } catch (err) {
    if (esCondicion(err)) return false;
    throw err;
  }
}

function euros(n) {
  return Math.round(Number(n) * 100) / 100;
}

function validarLineas(lineas, proveedorId) {
  const supplierId = parseSupplierIdAgora(proveedorId);
  const candidatas = lineas.filter((ln) => ln.omitida !== true);
  const fallos = [];
  for (const ln of candidatas) {
    const motivos = [];
    if (!supplierId) motivos.push('el proveedor no es un proveedor de Ágora');
    const unidadId = Number(ln.purchaseUnitId);
    const unidadNombre = String(ln.unit || ln.purchaseUnitName || '').trim();
    if (!Number.isInteger(unidadId) || unidadId <= 0 || !unidadNombre) motivos.push('no tiene unidad de compra');
    const qty = Number(ln.cantidadPedida);
    if (!Number.isFinite(qty) || qty <= 0) motivos.push('la cantidad tiene que ser mayor que 0');
    if (motivos.length) {
      fallos.push({
        productId: ln.productId,
        nombre: ln.nombre || ln.productId,
        error: motivos.join('; '),
      });
    }
  }
  return { supplierId, candidatas, fallos };
}

async function impuestoDeProducto(productId, vats) {
  const idNum = Number(String(productId ?? '').trim());
  const r = await docClient.send(new GetCommand({
    TableName: tables.agoraProducts,
    Key: { PK: 'GLOBAL', SK: String(idNum) },
  }));
  const vatId = Number(r.Item?.VatId);
  const vat = vats?.get?.(vatId);
  const vatRate = Number(vat?.VatRate);
  const surchargeRate = Number(vat?.SurchargeRate);
  if (
    !Number.isInteger(vatId) || vatId <= 0
    || !Number.isFinite(vatRate) || vatRate < 0
    || !Number.isFinite(surchargeRate) || surchargeRate < 0
  ) {
    return null;
  }
  return { vatId, vatRate, surchargeRate };
}

async function maestrosReales(warehouseIdNum, supplierIds) {
  const { exportWarehouses, exportSuppliers, exportVats } = await import('../agora/client.js');
  const out = { warehouse: null, suppliers: new Map(), vats: new Map() };
  const [warehouses, suppliers, vats] = await Promise.all([
    exportWarehouses(),
    exportSuppliers(),
    exportVats(),
  ]);
  out.warehouse = (warehouses || []).find((w) => Number(w?.Id) === warehouseIdNum) || null;
  const wanted = new Set(supplierIds);
  for (const s of suppliers || []) {
    const sid = Number(s?.Id);
    if (wanted.has(sid)) out.suppliers.set(sid, s);
  }
  for (const v of vats || []) {
    const id = Number(v?.Id);
    if (Number.isInteger(id)) out.vats.set(id, v);
  }
  return out;
}

async function importarReal(payload) {
  const { importPurchaseOrders } = await import('../agora/purchaseOrdersImport.js');
  return importPurchaseOrders({ purchaseOrders: [payload] });
}

async function nombreAlmacen(warehouseId) {
  const r = await docClient.send(new GetCommand({
    TableName: tables.almacenes,
    Key: { Id: normalizeWarehouseId(warehouseId) },
  }));
  return String(r.Item?.Nombre ?? r.Item?.nombre ?? '').trim();
}

/**
 * @param {string} informeId
 * @param {string} proveedorId
 * @param {{ statusAgora?: 'Draft'|'Confirmed', importar?: Function, cargarMaestros?: Function }} [opts]
 */
export async function aprobarPedidoProveedor(informeId, proveedorId, opts = {}) {
  const id = String(informeId || '').trim();
  const pid = String(proveedorId || '').trim();
  const meta = await leerMeta(id);
  if (!meta || meta.tipo !== TIPO_CONTEO) throw fallo('Conteo no encontrado', 404);
  const hijo = await leerHijo(id, pid);
  if (!hijo) throw fallo('Pedido de proveedor no encontrado', 404);

  const lineas = (await listInformeLineas(id)).filter((ln) => String(ln.proveedorId) === pid);
  const { supplierId, candidatas, fallos } = validarLineas(lineas, pid);
  if (fallos.length) throw fallo(MENSAJE_LINEAS, 400, { lineas: fallos });
  if (!candidatas.length) throw fallo(MENSAJE_SIN_LINEAS);

  const ahora = new Date().toISOString();
  const reclamado = await pasarEstado(id, pid, {
    ':destino': 'enviando',
    ':esperado': 'generado',
    ':ahora': ahora,
  });
  if (!reclamado) throw fallo(MENSAJE_EN_CURSO, 409);

  const soltar = () => pasarEstado(id, pid, {
    ':destino': 'generado',
    ':esperado': 'enviando',
    ':ahora': new Date().toISOString(),
  });

  try {
    const statusAgora = String(opts.statusAgora || 'Draft').trim() === 'Confirmed' ? 'Confirmed' : 'Draft';
    const warehouseId = normalizeWarehouseId(meta.WarehouseId || meta.warehouseId);
    const warehouseIdNum = Number(String(warehouseId).replace(/^0+/, '') || NaN);
    const cargarMaestros = opts.cargarMaestros || maestrosReales;
    const importar = opts.importar || importarReal;
    const maestros = await cargarMaestros(warehouseIdNum, [supplierId]);
    const poLines = [];
    const fallosImpuesto = [];
    for (const ln of candidatas) {
      const imp = await impuestoDeProducto(ln.productId, maestros.vats);
      if (!imp) {
        fallosImpuesto.push({
          productId: ln.productId,
          nombre: ln.nombre || ln.productId,
          error: 'no tiene impuesto en el maestro',
        });
        continue;
      }
      poLines.push({
        productId: ln.productId,
        productName: ln.nombre,
        orderedQuantity: Number(ln.cantidadPedida),
        purchaseUnitId: ln.purchaseUnitId,
        purchaseUnitName: String(ln.unit || ln.purchaseUnitName || '').trim(),
        price: ln.costeUnitario == null || ln.costeUnitario === '' ? null : Number(ln.costeUnitario),
        vatId: imp.vatId,
        vatRate: imp.vatRate,
        surchargeRate: imp.surchargeRate,
      });
    }
    if (fallosImpuesto.length) {
      await soltar();
      throw fallo(MENSAJE_LINEAS, 400, { lineas: fallosImpuesto });
    }

    let numero;
    try {
      numero = await reservarNumeroPedido();
    } catch (err) {
      await soltar();
      throw fallo(err?.message || MENSAJE_SIN_NUMERO);
    }

    const fecha = new Date().toISOString().slice(0, 10);
    const warehouseName = await nombreAlmacen(warehouseId);
    const supplierName = candidatas.map((ln) => String(ln.proveedorNombre || '').trim()).find(Boolean) || '';
    const payload = buildPurchaseOrderPayload({
      serie: SERIE_PEDIDO_MIA,
      number: numero,
      warehouseId: warehouseIdNum,
      warehouseName,
      warehouse: maestros.warehouse || null,
      supplierId,
      supplierName,
      supplier: maestros.suppliers?.get(supplierId) || null,
      status: statusAgora,
      date: fecha,
      lines: poLines,
    });

    try {
      await importar(payload);
    } catch {
      await soltar();
      throw fallo(MENSAJE_AGORA, 502);
    }

    const importe = euros(poLines.reduce((acc, ln) => {
      const precio = Number(ln.price);
      return acc + (Number.isFinite(precio) ? ln.orderedQuantity * precio : 0);
    }, 0));
    const destino = statusAgora === 'Confirmed' ? 'confirmado' : 'pedido';
    const cerrado = await pasarEstado(id, pid, {
      ':destino': destino,
      ':esperado': 'enviando',
      ':ahora': new Date().toISOString(),
      ':serie': SERIE_PEDIDO_MIA,
      ':num': numero,
      ':fecha': fecha,
      ':importe': importe,
    }, ', serie = :serie, #num = :num, fecha = :fecha, importe = :importe', { '#num': 'number' });
    if (!cerrado) {
      throw fallo('El pedido se envió a Ágora pero no se pudo guardar el estado', 500);
    }

    return {
      ok: true,
      proveedorId: pid,
      proveedorNombre: supplierName,
      estado: destino,
      serie: SERIE_PEDIDO_MIA,
      number: numero,
      fecha,
      statusAgora,
      lineas: poLines.length,
      importe,
    };
  } catch (err) {
    if (err?.expose) throw err;
    await soltar();
    throw err;
  }
}
