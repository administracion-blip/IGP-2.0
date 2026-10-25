/**
 * Aprobación de informe MIA → PurchaseOrders en Ágora.
 *
 * Estados de aprobación:
 *  - calculado | revisado → (claim) aprobando → aprobado | aprobado_parcial | (revert) previo
 *  - force: reclama desde aprobado | aprobado_parcial | aprobando; solo reenvía proveedores sin PO OK
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  buildPurchaseOrderPayload,
  importPurchaseOrders,
} from '../agora/purchaseOrdersImport.js';
import { exportSuppliers, exportVats, exportWarehouses } from '../agora/client.js';
import { formatId6 } from '../usuarioLocales.js';
import { mensajeSeguro } from '../http/responderError.js';
import {
  getInformeMeta,
  listInformeLineas,
  updateMeta,
} from './informes.js';
import { normalizeWarehouseId, pkInforme, skInformeMeta } from './keys.js';

const SIN_PROVEEDOR = 'SIN_PROVEEDOR';
const ESTADOS_APROBABLES = new Set(['calculado', 'revisado']);
const ESTADOS_FORCE = new Set(['aprobado', 'aprobado_parcial', 'aprobando']);

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function qtyOf(ln) {
  return toNum(ln?.cantidadPedida != null ? ln.cantidadPedida : ln?.qty, 0);
}

function tableInformes() {
  return tables.miaInformes;
}

/**
 * SupplierId numérico válido de Ágora (no SIN_PROVEEDOR, no vacío).
 * @param {string} proveedorId
 * @returns {number|null}
 */
export function parseSupplierIdAgora(proveedorId) {
  const raw = String(proveedorId ?? '').trim();
  if (!raw || raw === SIN_PROVEEDOR) return null;
  const n = Number(raw.replace(/^0+/, '') || NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Serie PO: env → maestro almacén.PurchaseOrderSerie → 'MIA'.
 * @param {string} warehouseId
 */
export async function resolvePurchaseOrderSerie(warehouseId) {
  const fromEnv = String(process.env.AGORA_PURCHASE_ORDER_SERIE || '').trim();
  if (fromEnv) return fromEnv;

  const wid = normalizeWarehouseId(warehouseId);
  if (wid && wid !== '000000') {
    try {
      const r = await docClient.send(
        new GetCommand({
          TableName: tables.almacenes,
          Key: { Id: wid },
        }),
      );
      const serie = String(r.Item?.PurchaseOrderSerie ?? r.Item?.purchaseOrderSerie ?? '').trim();
      if (serie) return serie;
    } catch {
      // maestro opcional
    }
  }
  return 'MIA';
}

/** Nombre del almacén en el maestro (Ágora exige Warehouse.Name en el import). */
async function resolverNombreAlmacen(warehouseId) {
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.almacenes, Key: { Id: normalizeWarehouseId(warehouseId) } }),
    );
    return String(r.Item?.Nombre ?? r.Item?.nombre ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Fichas de almacén, proveedores e impuestos de Ágora (solo lectura).
 * Almacén y proveedor, si faltan, se completan con el nombre. El impuesto no:
 * sin VatId del producto y tipos del maestro no se envía la línea.
 */
async function cargarMaestrosAgora(warehouseIdNum, supplierIds) {
  const out = { warehouse: null, suppliers: new Map(), vats: new Map() };
  try {
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
  } catch (err) {
    console.warn('[mia/aprobar] No se pudieron leer los maestros de Ágora', err?.message || err);
  }
  return out;
}

/**
 * VatId del producto en Igp_AgoraProducts y tipos del maestro de impuestos de Ágora.
 * No inventa cifras: si falta el producto o el tipo, 400 y no se llama a Ágora.
 */
async function impuestoDeProducto(productId, vats) {
  const idNum = Number(String(productId ?? '').trim());
  if (!Number.isInteger(idNum) || idNum <= 0) {
    const err = new Error(`El producto ${productId} no tiene impuesto; no se envía el pedido`);
    err.status = 400;
    throw err;
  }
  let vatId = NaN;
  try {
    const r = await docClient.send(
      new GetCommand({
        TableName: tables.agoraProducts,
        Key: { PK: 'GLOBAL', SK: String(idNum) },
      }),
    );
    vatId = Number(r.Item?.VatId);
  } catch (err) {
    console.warn('[mia/aprobar] No se pudo leer el impuesto del producto', idNum, err?.message || err);
  }
  const vat = vats?.get(vatId);
  const vatRate = Number(vat?.VatRate);
  const surchargeRate = Number(vat?.SurchargeRate);
  if (
    !Number.isInteger(vatId) || vatId <= 0
    || !Number.isFinite(vatRate) || vatRate < 0
    || !Number.isFinite(surchargeRate) || surchargeRate < 0
  ) {
    const err = new Error(
      `El producto ${idNum} no tiene impuesto en el maestro; no se envía el pedido`,
    );
    err.status = 400;
    throw err;
  }
  return { vatId, vatRate, surchargeRate };
}

/**
 * Mapa proveedorId → identidad PO ya creada en Ágora.
 * @param {object} meta
 * @returns {Record<string, object>}
 */
function mapaPoIds(meta) {
  const out = {};
  const raw = meta?.agoraPurchaseOrderIds;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object') out[String(k)] = v;
    }
  }
  const resultados = Array.isArray(meta?.agoraResultados) ? meta.agoraResultados : [];
  for (const r of resultados) {
    if (!r?.ok || !r.proveedorId) continue;
    const pid = String(r.proveedorId);
    if (out[pid]) continue;
    out[pid] = {
      proveedorId: pid,
      supplierId: r.supplierId ?? null,
      serie: r.serie ?? null,
      number: r.number ?? null,
    };
  }
  return out;
}

/** Resultados guardados de intentos anteriores, sin el cuerpo crudo de Ágora que llevaban los antiguos. */
function resultadosPrevios(meta) {
  const lista = Array.isArray(meta?.agoraResultados) ? meta.agoraResultados : [];
  return lista.map((r) => {
    if (!r || typeof r !== 'object' || !('agoraBody' in r)) return r;
    const { agoraBody: _cuerpo, ...resto } = r;
    return resto;
  });
}

function proveedorTienePoOk(poIds, proveedorId) {
  const prev = poIds[String(proveedorId)];
  if (!prev) return false;
  // Identidad Serie+Number, o flag explícito de éxito previo
  if (prev.serie != null && prev.number != null) return true;
  if (prev.ok === true) return true;
  return false;
}

/**
 * Claim atómico: calculado|revisado → aprobando (o force desde estados terminales/parciales).
 * @returns {Promise<object>} Attributes actualizados
 */
async function claimAprobando(informeId, { force, estadoPrevio }) {
  const PK = pkInforme(informeId);
  const ahora = new Date().toISOString();
  /** @type {Record<string, string>} */
  const values = {
    ':nuevo': 'aprobando',
    ':ts': ahora,
    ':previo': String(estadoPrevio || ''),
  };

  let condition;
  if (force) {
    condition = '#estado IN (:eAprob, :eParc, :eAprobando)';
    values[':eAprob'] = 'aprobado';
    values[':eParc'] = 'aprobado_parcial';
    values[':eAprobando'] = 'aprobando';
  } else {
    condition = '#estado IN (:eCalc, :eRev)';
    values[':eCalc'] = 'calculado';
    values[':eRev'] = 'revisado';
  }

  try {
    const r = await docClient.send(
      new UpdateCommand({
        TableName: tableInformes(),
        Key: { PK, SK: skInformeMeta() },
        UpdateExpression:
          'SET #estado = :nuevo, actualizadoEn = :ts, updatedAt = :ts, estadoPrevioAprobacion = :previo',
        ConditionExpression: condition,
        ExpressionAttributeNames: { '#estado': 'estado' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return r.Attributes || {};
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      const e = new Error('Informe ya en proceso de aprobación o aprobado');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

/**
 * @param {string} informeId
 * @param {{
 *   statusAgora?: 'Draft'|'Confirmed',
 *   force?: boolean,
 *   usuario?: object,
 * }} [opts]
 */
export async function aprobarInformeMia(informeId, opts = {}) {
  const id = String(informeId || '').trim();
  if (!id) {
    const err = new Error('informeId obligatorio');
    err.status = 400;
    throw err;
  }

  const meta = await getInformeMeta(id);
  if (!meta) {
    const err = new Error('Informe no encontrado');
    err.status = 404;
    throw err;
  }

  const estado = String(meta.estado || '').trim();
  const force = opts.force === true;

  if (!force) {
    if (estado === 'aprobado') {
      const err = new Error('Informe ya aprobado (use force: true para reenviar a Ágora)');
      err.status = 409;
      throw err;
    }
    if (estado === 'aprobando') {
      const err = new Error('Informe ya en proceso de aprobación o aprobado');
      err.status = 409;
      throw err;
    }
    if (estado === 'aprobado_parcial') {
      const err = new Error(
        'Informe con aprobación parcial (use force: true para reenviar proveedores pendientes)',
      );
      err.status = 409;
      throw err;
    }
    if (!ESTADOS_APROBABLES.has(estado)) {
      const err = new Error(`Estado '${estado || 'desconocido'}' no permite aprobar`);
      err.status = 409;
      throw err;
    }
  } else if (!ESTADOS_FORCE.has(estado)) {
    const err = new Error(
      `force solo aplica a aprobado / aprobado_parcial / aprobando (estado actual: '${estado || 'desconocido'}')`,
    );
    err.status = 409;
    throw err;
  }

  const statusAgora =
    String(opts.statusAgora || 'Draft').trim() === 'Confirmed' ? 'Confirmed' : 'Draft';

  const warehouseId = normalizeWarehouseId(meta.warehouseId || meta.WarehouseId);
  if (!warehouseId || warehouseId === '000000') {
    const err = new Error('Informe sin warehouseId válido');
    err.status = 400;
    throw err;
  }
  const warehouseIdNum = Number(String(warehouseId).replace(/^0+/, '') || NaN);
  if (!Number.isFinite(warehouseIdNum) || warehouseIdNum <= 0) {
    const err = new Error('warehouseId no es numérico para Ágora');
    err.status = 400;
    throw err;
  }

  const lineas = await listInformeLineas(id);
  /** @type {Record<string, object[]>} */
  const porProveedor = {};
  /** @type {Array<object>} */
  const omitidasAgora = [];
  /** @type {string[]} */
  const avisos = [];

  for (const ln of lineas) {
    if (ln?.omitida === true) continue;
    const qty = qtyOf(ln);
    if (qty <= 0) continue;

    const proveedorId = String(ln.proveedorId || SIN_PROVEEDOR).trim() || SIN_PROVEEDOR;
    const supplierId = parseSupplierIdAgora(proveedorId);
    if (supplierId == null) {
      omitidasAgora.push({
        productId: ln.productId,
        nombre: ln.nombre || null,
        proveedorId,
        qty,
        motivo: proveedorId === SIN_PROVEEDOR ? 'sin_proveedor' : 'supplierId_invalido',
      });
      continue;
    }
    if (!porProveedor[proveedorId]) porProveedor[proveedorId] = [];
    porProveedor[proveedorId].push(ln);
  }

  if (omitidasAgora.length) {
    avisos.push(
      `${omitidasAgora.length} línea(s) no enviadas a Ágora (SIN_PROVEEDOR o supplierId inválido)`,
    );
  }

  const poIdsPrevios = mapaPoIds(meta);
  const todosProveedorIds = Object.keys(porProveedor).sort();

  // Sin ningún proveedor enviable (p.ej. solo SIN_PROVEEDOR): no fingir éxito ni claim
  if (!todosProveedorIds.length) {
    const err = new Error(
      'Ningún pedido enviable a Ágora: todas las líneas están omitidas, sin proveedor o con supplierId inválido',
    );
    err.status = 400;
    err.omitidasAgora = omitidasAgora;
    err.enviadoAgora = false;
    err.pedidosCreados = 0;
    throw err;
  }

  /** Proveedores a enviar ahora (force: solo los que aún no tienen PO OK) */
  let proveedorIds = todosProveedorIds;
  /** @type {Array<object>} */
  const omitidosPorForce = [];
  if (force) {
    proveedorIds = [];
    for (const pid of todosProveedorIds) {
      if (proveedorTienePoOk(poIdsPrevios, pid)) {
        omitidosPorForce.push({
          proveedorId: pid,
          motivo: 'ya_tiene_po',
          po: poIdsPrevios[pid],
        });
      } else {
        proveedorIds.push(pid);
      }
    }
    if (omitidosPorForce.length) {
      avisos.push(
        `${omitidosPorForce.length} proveedor(es) omitidos en reenvío (ya tienen PurchaseOrder)`,
      );
    }
  }

  // Claim atómico antes de tocar Ágora
  await claimAprobando(id, { force, estadoPrevio: estado });

  const serie = await resolvePurchaseOrderSerie(warehouseId);
  const warehouseName = await resolverNombreAlmacen(warehouseId);
  const maestros = proveedorIds.length
    ? await cargarMaestrosAgora(warehouseIdNum, proveedorIds.map(parseSupplierIdAgora))
    : { warehouse: null, suppliers: new Map(), vats: new Map() };
  /** @type {Array<object>} */
  const agoraResultadosNuevos = [];

  // force y todos ya OK: no llamar Ágora; cerrar como aprobado
  if (force && !proveedorIds.length) {
    avisos.push('Nada que reenviar a Ágora: todos los proveedores ya tienen PurchaseOrder');
    const ahora = new Date().toISOString();
    const usuario = opts.usuario || {};
    const metaAvisos = Array.isArray(meta.avisos) ? [...meta.avisos] : [];
    for (const a of avisos) {
      if (!metaAvisos.includes(a)) metaAvisos.push(a);
    }
    const prevResults = resultadosPrevios(meta);
    const metaActualizado = await updateMeta(id, {
      estado: 'aprobado',
      aprobadoEn: meta.aprobadoEn || ahora,
      aprobadoPor: meta.aprobadoPor || {
        email: usuario.email || null,
        id_usuario: usuario.id_usuario || usuario.sub || null,
        nombre: usuario.Nombre || usuario.nombre || null,
      },
      statusAgora,
      agoraSerie: serie,
      agoraPurchaseOrderIds: poIdsPrevios,
      agoraResultados: prevResults,
      omitidasAgora,
      avisos: metaAvisos,
      warehouseIdPadded: warehouseId,
      warehouseIdAgora: warehouseIdNum,
      actualizadoEn: ahora,
      updatedAt: ahora,
    });
    return {
      ok: true,
      enviadoAgora: false,
      pedidosCreados: 0,
      informe: metaActualizado,
      agoraResultados: prevResults,
      omitidasAgora,
      omitidosPorForce,
      avisos,
      resumen: {
        proveedoresEnviados: 0,
        proveedoresFallidos: 0,
        proveedoresYaOk: omitidosPorForce.length,
        lineasOmitidasAgora: omitidasAgora.length,
        serie,
        statusAgora,
        force,
        estado: 'aprobado',
        warehouseId: formatId6(warehouseIdNum),
      },
    };
  }

  for (const proveedorId of proveedorIds) {
    const group = porProveedor[proveedorId];
    const supplierId = parseSupplierIdAgora(proveedorId);
    let poLines;
    let payload;
    try {
      poLines = [];
      for (const ln of group) {
        const imp = await impuestoDeProducto(ln.productId, maestros.vats);
        poLines.push({
          productId: ln.productId,
          productName: ln.nombre,
          orderedQuantity: qtyOf(ln),
          // Unidad de compra guardada en la línea (la del producto), no la unidad base.
          purchaseUnitId: ln.purchaseUnitId,
          purchaseUnitName: ln.unit,
          price: ln.costeUnitario != null ? toNum(ln.costeUnitario, null) : null,
          vatId: imp.vatId,
          vatRate: imp.vatRate,
          surchargeRate: imp.surchargeRate,
        });
      }
      payload = buildPurchaseOrderPayload({
        serie,
        warehouseId: warehouseIdNum,
        warehouseName,
        warehouse: maestros.warehouse,
        supplierId,
        supplierName: group.map((ln) => String(ln.proveedorNombre || '').trim()).find(Boolean) || null,
        supplier: maestros.suppliers.get(supplierId) || null,
        status: statusAgora,
        date: new Date().toISOString().slice(0, 10),
        lines: poLines,
      });
    } catch (err) {
      agoraResultadosNuevos.push({
        proveedorId,
        supplierId,
        ok: false,
        error: mensajeSeguro(err, 'Error construyendo PurchaseOrder'),
        lineas: group.length,
      });
      continue;
    }

    try {
      const result = await importPurchaseOrders({ purchaseOrders: [payload] });
      agoraResultadosNuevos.push({
        proveedorId,
        supplierId,
        ok: true,
        serie: payload.Serie,
        number: payload.Number ?? null,
        status: payload.Status,
        lineas: poLines.length,
        agoraStatus: result.status,
        agoraData: result.data ?? null,
      });
    } catch (err) {
      console.warn(
        '[mia/aprobar] Ágora rechazó el pedido del proveedor',
        proveedorId,
        err?.agoraStatus ?? '',
        err?.message || err,
        err?.agoraBody != null ? JSON.stringify(err.agoraBody).slice(0, 2000) : '',
      );
      agoraResultadosNuevos.push({
        proveedorId,
        supplierId,
        ok: false,
        serie: payload.Serie,
        number: payload.Number ?? null,
        status: payload.Status,
        lineas: poLines.length,
        error: mensajeSeguro(err, 'Error importando en Ágora'),
        agoraStatus: err?.agoraStatus ?? null,
      });
    }
  }

  const okNuevos = agoraResultadosNuevos.filter((r) => r.ok);
  const failNuevos = agoraResultadosNuevos.filter((r) => !r.ok);
  const okCount = okNuevos.length;
  const failCount = failNuevos.length;

  // Merge PO ids: previos + nuevos OK
  /** @type {Record<string, object>} */
  const agoraPurchaseOrderIds = { ...poIdsPrevios };
  for (const r of okNuevos) {
    agoraPurchaseOrderIds[String(r.proveedorId)] = {
      proveedorId: String(r.proveedorId),
      supplierId: r.supplierId ?? null,
      serie: r.serie ?? null,
      number: r.number ?? null,
      ok: true,
    };
  }

  // Merge resultados: sustituir entrada del proveedor si se reintentó
  const prevResults = resultadosPrevios(meta);
  const byProv = new Map(prevResults.map((r) => [String(r.proveedorId), r]));
  for (const r of agoraResultadosNuevos) {
    byProv.set(String(r.proveedorId), r);
  }
  const agoraResultados = [...byProv.values()];

  const ahora = new Date().toISOString();
  const usuario = opts.usuario || {};
  const metaAvisos = Array.isArray(meta.avisos) ? [...meta.avisos] : [];

  // Fallo total de este intento (ningún PO nuevo OK)
  if (failCount && !okCount && proveedorIds.length) {
    if (failCount) {
      avisos.push(`${failCount} proveedor(es) fallaron al importar en Ágora`);
    }
    for (const a of avisos) {
      if (!metaAvisos.includes(a)) metaAvisos.push(a);
    }
    // Revertir a estado recuperable (previo al claim), conservando ids ya creados
    const estadoRevert = ESTADOS_APROBABLES.has(estado)
      ? estado
      : Object.keys(agoraPurchaseOrderIds).length
        ? 'aprobado_parcial'
        : 'revisado';
    try {
      await updateMeta(id, {
        estado: estadoRevert,
        statusAgora,
        agoraSerie: serie,
        agoraPurchaseOrderIds,
        agoraResultados,
        omitidasAgora,
        avisos: metaAvisos,
        warehouseIdPadded: warehouseId,
        warehouseIdAgora: warehouseIdNum,
        actualizadoEn: ahora,
        updatedAt: ahora,
      });
    } catch (revertErr) {
      // No enmascarar el 502 de Ágora
      console.error('[mia/aprobar] Error revirtiendo estado tras fallo total', revertErr);
    }
    const err = new Error(
      `Falló el envío a Ágora para todos los proveedores (${failCount})`,
    );
    err.status = 502;
    err.expose = true;
    err.agoraResultados = agoraResultados;
    err.omitidasAgora = omitidasAgora;
    err.enviadoAgora = true;
    err.pedidosCreados = 0;
    err.agoraPurchaseOrderIds = agoraPurchaseOrderIds;
    throw err;
  }

  if (failCount) {
    avisos.push(`${failCount} proveedor(es) fallaron al importar en Ágora`);
  }
  for (const a of avisos) {
    if (!metaAvisos.includes(a)) metaAvisos.push(a);
  }

  // ¿Quedan proveedores del informe sin PO OK?
  const pendientes = todosProveedorIds.filter((pid) => !proveedorTienePoOk(agoraPurchaseOrderIds, pid));
  const estadoFinal = pendientes.length || failCount ? 'aprobado_parcial' : 'aprobado';

  const metaActualizado = await updateMeta(id, {
    estado: estadoFinal,
    ...(estadoFinal === 'aprobado'
      ? {
          aprobadoEn: ahora,
          aprobadoPor: {
            email: usuario.email || null,
            id_usuario: usuario.id_usuario || usuario.sub || null,
            nombre: usuario.Nombre || usuario.nombre || null,
          },
        }
      : {
          // Parcial: no terminal; conservar aprobadoEn previo si existía
          aprobadoParcialEn: ahora,
          aprobadoParcialPor: {
            email: usuario.email || null,
            id_usuario: usuario.id_usuario || usuario.sub || null,
            nombre: usuario.Nombre || usuario.nombre || null,
          },
        }),
    statusAgora,
    agoraSerie: serie,
    agoraPurchaseOrderIds,
    agoraResultados,
    omitidasAgora,
    avisos: metaAvisos,
    warehouseIdPadded: warehouseId,
    warehouseIdAgora: warehouseIdNum,
    actualizadoEn: ahora,
    updatedAt: ahora,
  });

  return {
    ok: estadoFinal === 'aprobado',
    parcial: estadoFinal === 'aprobado_parcial',
    enviadoAgora: true,
    pedidosCreados: okCount,
    informe: metaActualizado,
    agoraResultados,
    agoraPurchaseOrderIds,
    omitidasAgora,
    omitidosPorForce: force ? omitidosPorForce : undefined,
    avisos,
    resumen: {
      proveedoresEnviados: okCount,
      proveedoresFallidos: failCount,
      proveedoresPendientes: pendientes.length,
      proveedoresYaOk: force ? omitidosPorForce.length : 0,
      lineasOmitidasAgora: omitidasAgora.length,
      serie,
      statusAgora,
      force,
      estado: estadoFinal,
      warehouseId: formatId6(warehouseIdNum),
    },
  };
}
