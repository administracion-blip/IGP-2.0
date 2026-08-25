/**
 * Venta mayorista a clientes externos (empresas).
 * Lectura de acuerdos/compras; persistencia en Igp_Negociaciones.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import {
  QueryCommand,
  ScanCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
  BatchGetCommand,
  BatchWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { recalcularLinea, agregarTotales, costeNetoDesdeCompra, diasEntre, round4, round2 } from '../lib/mayorista/calculos.js';
import { resolveAcuerdoVigenteProducto } from '../lib/mayorista/acuerdoVigente.js';
import { GSI_COMPRAS_NAME } from '../lib/dynamo/comprasProveedor.js';

const router = Router();
const tNeg = tables.negociaciones;
const tCompras = tables.comprasProveedor;
const tAjustes = tables.ajustes;
const tEmpresas = tables.empresas;

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]?\d|2[0-3]):[0-5]\d$/;
const ESTADOS = new Set(['borrador', 'confirmada', 'facturada', 'pagada']);

function normalizarHora(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t.slice(0, 5);
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

function validarConfirmacion(meta, lineas) {
  const errores = [];
  if (!String(meta.cliente_id || '').trim()) errores.push('Cliente es obligatorio.');
  if (!String(meta.nombre || '').trim()) errores.push('Referencia es obligatoria.');
  if (!RE_FECHA.test(String(meta.fecha || ''))) errores.push('Fecha es obligatoria.');
  if (!String(meta.recogida_empresa_id || '').trim()) errores.push('Recogida en es obligatorio.');
  if (!RE_FECHA.test(String(meta.recogida_fecha || ''))) errores.push('Fecha recogida es obligatoria.');
  if (!Array.isArray(lineas) || lineas.length === 0) errores.push('Debe haber al menos una línea de producto.');

  for (const l of lineas) {
    const provNombre = String(l.proveedor_nombre || '').trim();
    const provId = String(l.proveedor_id || '').trim();
    const label = String(l.product_name || l.producto_id || '—');
    if (!provNombre && !provId) {
      errores.push(`Línea «${label}»: falta proveedor.`);
    }
  }
  return errores;
}

function pickRecogida(body, fallback = {}) {
  const fb = fallback || {};
  const recogida_fecha = body.recogida_fecha !== undefined
    ? String(body.recogida_fecha || '').slice(0, 10)
    : String(fb.recogida_fecha || '').slice(0, 10);
  const recogida_hora = body.recogida_hora !== undefined
    ? normalizarHora(body.recogida_hora)
    : normalizarHora(fb.recogida_hora);
  if (recogida_fecha && !RE_FECHA.test(recogida_fecha)) {
    throw new Error('fecha de recogida inválida');
  }
  if (recogida_hora && !RE_HORA.test(recogida_hora)) {
    throw new Error('hora de recogida inválida (HH:mm)');
  }
  return {
    recogida_empresa_id: body.recogida_empresa_id !== undefined
      ? String(body.recogida_empresa_id || '')
      : String(fb.recogida_empresa_id || ''),
    recogida_empresa_nombre: body.recogida_empresa_nombre !== undefined
      ? String(body.recogida_empresa_nombre || '').trim()
      : String(fb.recogida_empresa_nombre || '').trim(),
    recogida_fecha,
    recogida_hora,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function skLinea(id) {
  return `LINEA#${id}`;
}

async function getConfig() {
  const defaults = {
    tasa_capital_default: 0.08,
    umbral_verde: 20,
    umbral_ambar: 10,
    margen_minimo_ambar: 10,
    pct_ganancia_defecto: 0,
  };
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tAjustes, Key: { PK: 'mayorista', SK: 'config' } }),
    );
    const it = r.Item || {};
    return {
      tasa_capital_default: Number(it.tasa_capital_default ?? defaults.tasa_capital_default),
      umbral_verde: Number(it.umbral_verde ?? defaults.umbral_verde),
      umbral_ambar: Number(it.umbral_ambar ?? defaults.umbral_ambar),
      margen_minimo_ambar:
        it.margen_minimo_ambar === null || it.margen_minimo_ambar === undefined
          ? defaults.margen_minimo_ambar
          : Number(it.margen_minimo_ambar),
      pct_ganancia_defecto: Number(it.pct_ganancia_defecto ?? defaults.pct_ganancia_defecto),
    };
  } catch {
    return defaults;
  }
}

async function queryAll(params) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({ ...params, ...(lastKey && { ExclusiveStartKey: lastKey }) }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

function isoADmy(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!RE_FECHA.test(s)) return s || '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function buildNombreOperacion(numero, clienteNombre, fecha) {
  const n = String(Number(numero) || 0).padStart(4, '0');
  const cli = String(clienteNombre || '').trim() || 'Sin cliente';
  return `${n} · ${cli} · ${isoADmy(fecha)}`;
}

async function peekNumeroOperacion() {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tAjustes,
      Key: { PK: 'mayorista', SK: 'secuencia' },
    }));
    return (Number(r.Item?.numero_operacion) || 0) + 1;
  } catch {
    return 1;
  }
}

async function nextNumeroOperacion() {
  const r = await docClient.send(new UpdateCommand({
    TableName: tAjustes,
    Key: { PK: 'mayorista', SK: 'secuencia' },
    UpdateExpression: 'SET numero_operacion = if_not_exists(numero_operacion, :zero) + :one, updatedAt = :now',
    ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': nowIso() },
    ReturnValues: 'UPDATED_NEW',
  }));
  return Number(r.Attributes?.numero_operacion) || 1;
}

async function scanMetas() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tNeg,
      FilterExpression: 'SK = :meta',
      ExpressionAttributeValues: { ':meta': 'META' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

function mapMeta(item) {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return { id: item.id || PK, ...rest };
}

function mapLinea(item) {
  if (!item) return null;
  const { PK, SK, entityType, ...rest } = item;
  return rest;
}

async function cargarNegociacion(id) {
  const items = await queryAll({
    TableName: tNeg,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': id },
  });
  const meta = items.find((i) => i.SK === 'META');
  if (!meta) return null;
  const lineas = items
    .filter((i) => String(i.SK || '').startsWith('LINEA#'))
    .map(mapLinea)
    .sort((a, b) => String(a.orden ?? a.createdAt ?? '').localeCompare(String(b.orden ?? b.createdAt ?? '')));
  return { meta: mapMeta(meta), lineas };
}

async function enriquecerYRecalcularLinea(raw, cabecera, config) {
  const productoId = String(raw.producto_id ?? '').trim();
  const fecha = String(cabecera.fecha || '').slice(0, 10);
  const cantidad = Number(raw.cantidad) || 0;
  const tasaLinea = raw.tasa_capital != null && raw.tasa_capital !== ''
    ? Number(raw.tasa_capital)
    : (cabecera.tasa_capital != null ? Number(cabecera.tasa_capital) : config.tasa_capital_default);

  let acuerdo = {
    vigente: Boolean(raw.aportacion_vigente),
    aportacion_unitaria: Number(raw.aportacion_unitaria) || 0,
    acuerdo_id: raw.acuerdo_id || null,
    acuerdo_fecha_fin: raw.acuerdo_fecha_fin || null,
    acuerdo_marca: raw.marca || raw.acuerdo_marca || null,
  };

  if (productoId && RE_FECHA.test(fecha)) {
    const resuelto = await resolveAcuerdoVigenteProducto(productoId, fecha);
    acuerdo = resuelto;
  }

  const dias = acuerdo.acuerdo_fecha_fin && RE_FECHA.test(fecha)
    ? diasEntre(fecha, acuerdo.acuerdo_fecha_fin)
    : 0;

  const precioAlbaran = Number(raw.precio_albaran_original);
  const precioOp = raw.precio_compra_operacion != null && raw.precio_compra_operacion !== ''
    ? Number(raw.precio_compra_operacion)
    : precioAlbaran;
  const esNegociado = Boolean(raw.es_precio_negociado)
    || (Number.isFinite(precioAlbaran) && Number.isFinite(precioOp) && Math.abs(precioAlbaran - precioOp) > 0.0001);

  // Mk.% es virtual: el PVP del cliente/persistido no se reescribe desde el %.
  const calc = recalcularLinea({
    precioCompra: Number.isFinite(precioOp) ? precioOp : 0,
    descuentoImporte: Number(raw.descuento) || 0,
    cantidad,
    pctGanancia: Number(raw.pct_ganancia),
    pvpUnitario: Number(raw.pvp_unitario),
    aportacionUnitaria: acuerdo.aportacion_unitaria,
    tasaCapital: tasaLinea,
    diasCobro: dias,
    margenMinimoAmbar: config.margen_minimo_ambar,
    modoEdicion: 'pvp',
  });

  const id = String(raw.id_linea || raw.id || crypto.randomUUID());
  return {
    id_linea: id,
    negociacion_id: cabecera.id,
    producto_id: productoId,
    product_name: String(raw.product_name || raw.ProductName || '').trim(),
    marca: acuerdo.acuerdo_marca || String(raw.marca || '').trim() || null,
    proveedor_id: raw.proveedor_id != null ? String(raw.proveedor_id) : null,
    proveedor_nombre: String(raw.proveedor_nombre || '').trim() || null,
    albaran_ref: raw.albaran_ref != null ? String(raw.albaran_ref) : null,
    albaran_fecha: raw.albaran_fecha ? String(raw.albaran_fecha).slice(0, 10) : null,
    precio_albaran_original: Number.isFinite(precioAlbaran) ? round2(precioAlbaran) : null,
    precio_compra_operacion: Number.isFinite(precioOp) ? round2(precioOp) : null,
    es_precio_negociado: esNegociado,
    descuento: Number(raw.descuento) || 0,
    cantidad,
    pct_ganancia: calc.pct_ganancia,
    pvp_unitario: round2(calc.pvp_unitario),
    tasa_capital: tasaLinea,
    acuerdo_id: acuerdo.acuerdo_id,
    acuerdo_fecha_fin: acuerdo.acuerdo_fecha_fin,
    aportacion_vigente: acuerdo.vigente,
    aportacion_unitaria: calc.aportacion_unitaria,
    aportacion_asignada: calc.aportacion_asignada,
    dias_cobro: calc.dias_cobro,
    coste_neto: round2(calc.coste_neto),
    pmr: round2(calc.pmr),
    ultimo_iva_compra: raw.ultimo_iva_compra != null && Number.isFinite(Number(raw.ultimo_iva_compra))
      ? Number(raw.ultimo_iva_compra)
      : null,
    coste_financiero: calc.coste_financiero,
    beneficio_comercial: calc.beneficio_comercial,
    beneficio_neto: calc.beneficio_neto,
    alerta_nivel: calc.alerta_nivel,
    perdida_estimada: calc.perdida_estimada,
    alerta_aceptada: Boolean(raw.alerta_aceptada),
    orden: raw.orden != null ? Number(raw.orden) : Date.now(),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

async function persistirNegociacion(meta, lineas) {
  const id = meta.id;
  const existentes = await queryAll({
    TableName: tNeg,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': id },
  });
  const toDelete = existentes.filter((i) => String(i.SK || '').startsWith('LINEA#'));

  const metaItem = {
    PK: id,
    SK: 'META',
    id,
    ...meta,
    updatedAt: nowIso(),
  };
  await docClient.send(new PutCommand({ TableName: tNeg, Item: metaItem }));

  for (let i = 0; i < toDelete.length; i += 25) {
    const chunk = toDelete.slice(i, i + 25);
    await docClient.send(new BatchWriteCommand({
      RequestItems: {
        [tNeg]: chunk.map((it) => ({ DeleteRequest: { Key: { PK: it.PK, SK: it.SK } } })),
      },
    }));
  }

  for (const l of lineas) {
    await docClient.send(new PutCommand({
      TableName: tNeg,
      Item: {
        PK: id,
        SK: skLinea(l.id_linea),
        entityType: 'LINEA',
        ...l,
        negociacion_id: id,
      },
    }));
  }
  return mapMeta(metaItem);
}

// ── Config ──

router.get('/mayorista/config', requireAnyPermission('mayorista.ver', 'mayorista.crear', 'mayorista.editar'), async (_req, res) => {
  try {
    const config = await getConfig();
    return res.json({ ok: true, config });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al cargar config' });
  }
});

router.put('/mayorista/config', requirePermission('mayorista.editar'), async (req, res) => {
  try {
    const body = req.body || {};
    const prev = await getConfig();
    const item = {
      PK: 'mayorista',
      SK: 'config',
      Nombre: 'Configuración venta mayorista',
      tasa_capital_default: body.tasa_capital_default != null ? Number(body.tasa_capital_default) : prev.tasa_capital_default,
      umbral_verde: body.umbral_verde != null ? Number(body.umbral_verde) : prev.umbral_verde,
      umbral_ambar: body.umbral_ambar != null ? Number(body.umbral_ambar) : prev.umbral_ambar,
      margen_minimo_ambar: body.margen_minimo_ambar !== undefined
        ? (body.margen_minimo_ambar === null ? null : Number(body.margen_minimo_ambar))
        : prev.margen_minimo_ambar,
      pct_ganancia_defecto: body.pct_ganancia_defecto != null ? Number(body.pct_ganancia_defecto) : prev.pct_ganancia_defecto,
      updatedAt: nowIso(),
    };
    await docClient.send(new PutCommand({ TableName: tAjustes, Item: item }));
    return res.json({ ok: true, config: await getConfig() });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al guardar config' });
  }
});

// ── Acuerdo vigente (aportación) ──

router.get('/mayorista/productos/:productId/acuerdo-vigente', requireAnyPermission('mayorista.ver', 'mayorista.crear', 'mayorista.editar'), async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  const fecha = String(req.query.fecha || '').slice(0, 10);
  if (!productId) return res.status(400).json({ error: 'productId obligatorio' });
  if (!RE_FECHA.test(fecha)) return res.status(400).json({ error: 'fecha inválida (YYYY-MM-DD)' });
  try {
    const acuerdo = await resolveAcuerdoVigenteProducto(productId, fecha);
    const dias_cobro = acuerdo.acuerdo_fecha_fin && RE_FECHA.test(fecha)
      ? diasEntre(fecha, acuerdo.acuerdo_fecha_fin)
      : 0;
    return res.json({ ok: true, productId, fecha, acuerdo, dias_cobro });
  } catch (err) {
    console.error('[mayorista/acuerdo-vigente]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al resolver acuerdo' });
  }
});

// ── Comparador precios ──

router.get('/mayorista/productos/:productId/precios-proveedor', requireAnyPermission('mayorista.ver', 'mayorista.crear', 'mayorista.editar'), async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  if (!productId) return res.status(400).json({ error: 'productId obligatorio' });
  try {
    const keys = [];
    let lastKey = null;
    do {
      const r = await docClient.send(new QueryCommand({
        TableName: tCompras,
        IndexName: GSI_COMPRAS_NAME,
        KeyConditionExpression: 'ProductId = :pid',
        ExpressionAttributeValues: { ':pid': productId },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const item of (r.Items || [])) {
        if (item.PK && item.SK) keys.push({ PK: item.PK, SK: item.SK });
      }
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);

    const items = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const r = await docClient.send(new BatchGetCommand({
        RequestItems: { [tCompras]: { Keys: chunk } },
      }));
      items.push(...(r.Responses?.[tCompras] || []));
    }

    const porProveedor = new Map();
    for (const it of items) {
      const cn = costeNetoDesdeCompra(it.Price, it.DiscountRate);
      if (cn == null) continue;
      const sid = String(it.SupplierId ?? it.SupplierName ?? '');
      const fecha = String(it.AlbaranFecha || '');
      const prev = porProveedor.get(sid);
      if (!prev || fecha > prev.albaran_fecha || (fecha === prev.albaran_fecha && cn < prev.cn)) {
        porProveedor.set(sid, {
          proveedor_id: it.SupplierId != null ? String(it.SupplierId) : null,
          proveedor_nombre: String(it.SupplierName || ''),
          albaran_ref: `${it.AlbaranSerie || ''}#${it.AlbaranNumero || ''}`,
          albaran_fecha: fecha,
          price: Number(it.Price) || 0,
          discount_rate: Number(it.DiscountRate) || 0,
          cn,
          unidad: it.PurchaseUnitName || null,
          product_name: it.ProductName || null,
        });
      }
    }

    const precios = [...porProveedor.values()].sort((a, b) => a.cn - b.cn);
    if (precios[0]) precios[0].mejor_precio = true;
    for (let i = 1; i < precios.length; i++) precios[i].mejor_precio = false;

    return res.json({ ok: true, productId, precios });
  } catch (err) {
    console.error('[mayorista/precios-proveedor]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar precios' });
  }
});

// ── Última venta mayorista (mismo producto) ──

router.get('/mayorista/productos/:productId/ultima-venta', requireAnyPermission('mayorista.ver', 'mayorista.crear', 'mayorista.editar'), async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  const excluirId = String(req.query.excluirNegociacionId || '').trim();
  const proveedorId = String(req.query.proveedorId || '').trim();
  if (!productId) return res.status(400).json({ error: 'productId obligatorio' });
  try {
    const metas = (await scanMetas()).filter((m) => {
      const est = String(m.estado || '');
      if (est !== 'confirmada' && est !== 'facturada' && est !== 'pagada') return false;
      if (excluirId && String(m.id || m.PK) === excluirId) return false;
      return true;
    });
    metas.sort((a, b) => String(b.fecha || b.confirmado_at || b.updatedAt || '').localeCompare(String(a.fecha || a.confirmado_at || a.updatedAt || '')));

    for (const m of metas) {
      const id = String(m.id || m.PK);
      const items = await queryAll({
        TableName: tNeg,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': id, ':sk': 'LINEA#' },
      });
      const candidatas = items.filter((l) => {
        if (String(l.producto_id || '').trim() !== productId) return false;
        if (proveedorId && String(l.proveedor_id || '') !== proveedorId) return false;
        return true;
      });
      if (candidatas.length === 0) continue;
      candidatas.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const l = candidatas[0];
      return res.json({
        ok: true,
        encontrada: true,
        venta: {
          negociacion_id: id,
          negociacion_nombre: m.nombre || '',
          fecha: m.fecha || null,
          estado: m.estado,
          producto_id: l.producto_id,
          product_name: l.product_name,
          proveedor_id: l.proveedor_id,
          proveedor_nombre: l.proveedor_nombre,
          pvp_unitario: l.pvp_unitario,
          pct_ganancia: l.pct_ganancia,
          cantidad: l.cantidad,
        },
      });
    }
    return res.json({ ok: true, encontrada: false, venta: null });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al buscar última venta' });
  }
});

// ── CRUD negociaciones ──

router.get('/mayorista/negociaciones', requirePermission('mayorista.ver'), async (req, res) => {
  try {
    let metas = await scanMetas();
    const estado = String(req.query.estado || '').trim();
    const clienteId = String(req.query.cliente_id || '').trim();
    const desde = String(req.query.fechaDesde || '').trim();
    const hasta = String(req.query.fechaHasta || '').trim();
    if (estado) metas = metas.filter((m) => String(m.estado) === estado);
    if (clienteId) metas = metas.filter((m) => String(m.cliente_id) === clienteId);
    if (RE_FECHA.test(desde)) metas = metas.filter((m) => String(m.fecha || '') >= desde);
    if (RE_FECHA.test(hasta)) metas = metas.filter((m) => String(m.fecha || '') <= hasta);
    metas.sort((a, b) => String(b.fecha || b.updatedAt || '').localeCompare(String(a.fecha || a.updatedAt || '')));
    return res.json({ ok: true, negociaciones: metas.map(mapMeta) });
  } catch (err) {
    console.error('[mayorista/list]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar' });
  }
});

router.get('/mayorista/negociaciones/siguiente-numero', requirePermission('mayorista.crear'), async (req, res) => {
  try {
    const numero_operacion = await peekNumeroOperacion();
    return res.json({ ok: true, numero_operacion });
  } catch (err) {
    console.error('[mayorista/siguiente-numero]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener número de operación' });
  }
});

router.post('/mayorista/negociaciones', requirePermission('mayorista.crear'), async (req, res) => {
  try {
    const config = await getConfig();
    const body = req.body || {};
    const id = crypto.randomUUID();
    const fecha = String(body.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!RE_FECHA.test(fecha)) return res.status(400).json({ error: 'fecha inválida' });

    const numero_operacion = await nextNumeroOperacion();
    const cliente_nombre = String(body.cliente_nombre || '').trim();
    const recogida = pickRecogida(body);
    const nombreManual = body.nombre_manual === true;
    const nombreBody = String(body.nombre || '').trim();
    const nombre = nombreManual && nombreBody
      ? nombreBody
      : buildNombreOperacion(numero_operacion, cliente_nombre, fecha);
    const meta = {
      id,
      numero_operacion,
      cliente_id: body.cliente_id != null ? String(body.cliente_id) : '',
      cliente_nombre,
      fecha,
      nombre,
      ...recogida,
      estado: 'borrador',
      pct_ganancia_defecto: body.pct_ganancia_defecto != null ? Number(body.pct_ganancia_defecto) : config.pct_ganancia_defecto,
      tasa_capital: body.tasa_capital != null ? Number(body.tasa_capital) : config.tasa_capital_default,
      creado_por: req.user?.email || req.user?.sub || '',
      createdAt: nowIso(),
      ...agregarTotales([], config),
    };

    const lineasIn = Array.isArray(body.lineas) ? body.lineas : [];
    const lineas = [];
    for (const raw of lineasIn) {
      lineas.push(await enriquecerYRecalcularLinea(raw, meta, config));
    }
    const totales = agregarTotales(lineas, config);
    Object.assign(meta, totales);
    await persistirNegociacion(meta, lineas);
    return res.status(201).json({ ok: true, negociacion: meta, lineas });
  } catch (err) {
    console.error('[mayorista/create]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear' });
  }
});

// ── Resumen analítico (KPIs, serie mensual, top clientes) ──
// Debe declararse ANTES de '/:id' para que Express no capture "resumen" como id.
router.get('/mayorista/negociaciones/resumen', requirePermission('mayorista.ver'), async (req, res) => {
  try {
    const estado = String(req.query.estado || '').trim();
    const clienteId = String(req.query.cliente_id || '').trim();
    const desde = String(req.query.fechaDesde || '').trim();
    const hasta = String(req.query.fechaHasta || '').trim();
    const anio = Number(req.query.anio) || null;
    const mesesRaw = String(req.query.meses || '').trim();
    const meses = mesesRaw
      ? mesesRaw.split(',').map((m) => Number(m)).filter((m) => m >= 1 && m <= 12)
      : [];

    let metas = await scanMetas();
    metas = metas.filter((m) => {
      const f = String(m.fecha || '').slice(0, 10);
      if (!RE_FECHA.test(f)) return false;
      if (estado && String(m.estado) !== estado) return false;
      if (clienteId && String(m.cliente_id) !== clienteId) return false;
      if (RE_FECHA.test(desde) && f < desde) return false;
      if (RE_FECHA.test(hasta) && f > hasta) return false;
      if (anio && Number(f.slice(0, 4)) !== anio) return false;
      if (meses.length) {
        const mes = Number(f.slice(5, 7));
        if (!meses.includes(mes)) return false;
      }
      return true;
    });

    const serie = Array.from({ length: 12 }, () => ({ venta_total: 0, beneficio_neto: 0 }));
    let ventaTotal = 0;
    let beneficioNeto = 0;
    let costeTotal = 0;
    let aportacionTotal = 0;

    for (const m of metas) {
      const mesIdx = Number(String(m.fecha).slice(5, 7)) - 1;
      const venta = Number(m.venta_total) || 0;
      const benef = Number(m.beneficio_neto) || 0;
      ventaTotal += venta;
      beneficioNeto += benef;
      costeTotal += Number(m.coste_total) || 0;
      aportacionTotal += Number(m.aportacion_total) || 0;
      if (mesIdx >= 0 && mesIdx < 12) {
        serie[mesIdx].venta_total += venta;
        serie[mesIdx].beneficio_neto += benef;
      }
    }

    const clientMap = new Map();
    for (const m of metas) {
      const cid = String(m.cliente_id || '').trim() || '_sin_cliente';
      const nombre = String(m.cliente_nombre || '').trim() || 'Sin cliente';
      const venta = Number(m.venta_total) || 0;
      const benef = Number(m.beneficio_neto) || 0;
      const fecha = String(m.fecha || '').slice(0, 10);
      const proveedor = String(m.recogida_empresa_nombre || '').trim() || '—';

      if (!clientMap.has(cid)) {
        clientMap.set(cid, {
          cliente_id: cid === '_sin_cliente' ? '' : cid,
          cliente_nombre: nombre,
          importe: 0,
          beneficio_neto: 0,
          num_operaciones: 0,
          ultima_operacion: '',
          operaciones: [],
        });
      }
      const entry = clientMap.get(cid);
      entry.importe += venta;
      entry.beneficio_neto += benef;
      entry.num_operaciones += 1;
      if (fecha && (!entry.ultima_operacion || fecha > entry.ultima_operacion)) {
        entry.ultima_operacion = fecha;
      }
      entry.operaciones.push({
        id: String(m.id || m.PK || ''),
        proveedor_nombre: proveedor,
        fecha,
        importe: round2(venta),
        beneficio: round2(benef),
        nombre: String(m.nombre || '').trim(),
      });
    }

    const topClientes = [...clientMap.values()]
      .map((c) => ({
        cliente_id: c.cliente_id,
        cliente_nombre: c.cliente_nombre,
        importe: round2(c.importe),
        beneficio_neto: round2(c.beneficio_neto),
        num_operaciones: c.num_operaciones,
        ultima_operacion: c.ultima_operacion,
        operaciones: c.operaciones.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))),
      }))
      .sort((a, b) => b.importe - a.importe)
      .slice(0, 5);

    // Coherente con detalle/agregarTotales: margen = beneficio neto / venta (no venta−coste bruto).
    const margenPct = ventaTotal > 0 ? round2((beneficioNeto / ventaTotal) * 100) : 0;

    return res.json({
      ok: true,
      kpis: {
        venta_total: round2(ventaTotal),
        beneficio_neto: round2(beneficioNeto),
        coste_total: round2(costeTotal),
        aportacion_total: round2(aportacionTotal),
        margen_pct: margenPct,
        num_operaciones: metas.length,
      },
      serie_mensual: serie.map((s, i) => ({
        mes: i + 1,
        venta_total: round2(s.venta_total),
        beneficio_neto: round2(s.beneficio_neto),
      })),
      top_clientes: topClientes,
    });
  } catch (err) {
    console.error('[mayorista/resumen]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al calcular resumen' });
  }
});

router.get('/mayorista/negociaciones/:id', requirePermission('mayorista.ver'), async (req, res) => {
  try {
    const data = await cargarNegociacion(String(req.params.id));
    if (!data) return res.status(404).json({ error: 'Negociación no encontrada' });
    return res.json({ ok: true, negociacion: data.meta, lineas: data.lineas });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al cargar' });
  }
});

router.put('/mayorista/negociaciones/:id', requirePermission('mayorista.editar'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const actual = await cargarNegociacion(id);
    if (!actual) return res.status(404).json({ error: 'Negociación no encontrada' });
    if (actual.meta.estado !== 'borrador') {
      return res.status(400).json({ error: 'Solo se pueden editar negociaciones en borrador' });
    }

    const config = await getConfig();
    const body = req.body || {};
    const recogida = pickRecogida(body, actual.meta);
    const meta = {
      ...actual.meta,
      id,
      cliente_id: body.cliente_id !== undefined ? String(body.cliente_id) : actual.meta.cliente_id,
      cliente_nombre: body.cliente_nombre !== undefined ? String(body.cliente_nombre).trim() : actual.meta.cliente_nombre,
      fecha: body.fecha !== undefined ? String(body.fecha).slice(0, 10) : actual.meta.fecha,
      nombre: body.nombre !== undefined ? String(body.nombre).trim() : actual.meta.nombre,
      ...recogida,
      pct_ganancia_defecto: body.pct_ganancia_defecto !== undefined ? Number(body.pct_ganancia_defecto) : actual.meta.pct_ganancia_defecto,
      tasa_capital: body.tasa_capital !== undefined ? Number(body.tasa_capital) : actual.meta.tasa_capital,
      estado: 'borrador',
      createdAt: actual.meta.createdAt,
      creado_por: actual.meta.creado_por,
    };
    if (!RE_FECHA.test(meta.fecha)) return res.status(400).json({ error: 'fecha inválida' });

    const lineasIn = Array.isArray(body.lineas) ? body.lineas : actual.lineas;
    const lineas = [];
    for (const raw of lineasIn) {
      lineas.push(await enriquecerYRecalcularLinea(raw, meta, config));
    }
    Object.assign(meta, agregarTotales(lineas, config));
    await persistirNegociacion(meta, lineas);
    return res.json({ ok: true, negociacion: meta, lineas });
  } catch (err) {
    console.error('[mayorista/put]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al guardar' });
  }
});

router.post('/mayorista/negociaciones/:id/confirmar', requirePermission('mayorista.confirmar'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const actual = await cargarNegociacion(id);
    if (!actual) return res.status(404).json({ error: 'Negociación no encontrada' });
    if (actual.meta.estado !== 'borrador') {
      return res.status(400).json({ error: 'Solo se confirman borradores' });
    }

    const erroresVal = validarConfirmacion(actual.meta, actual.lineas);
    if (erroresVal.length) {
      return res.status(400).json({ error: erroresVal.join('\n'), errores: erroresVal });
    }

    const config = await getConfig();
    const body = req.body || {};
    const aceptadas = new Set(
      Array.isArray(body.lineas_alerta_aceptada)
        ? body.lineas_alerta_aceptada.map(String)
        : actual.lineas.filter((l) => l.alerta_aceptada).map((l) => String(l.id_linea)),
    );

    const lineas = [];
    for (const raw of actual.lineas) {
      const l = await enriquecerYRecalcularLinea(
        { ...raw, alerta_aceptada: aceptadas.has(String(raw.id_linea)) || Boolean(raw.alerta_aceptada) },
        actual.meta,
        config,
      );
      if (l.alerta_nivel === 'rojo' && !l.alerta_aceptada) {
        return res.status(400).json({
          error: 'Hay líneas en venta bajo coste sin aceptar. Confirma explícitamente las alertas.',
          lineas_rojo: lineas.concat([l]).filter((x) => x.alerta_nivel === 'rojo'),
        });
      }
      lineas.push(l);
    }

    const meta = {
      ...actual.meta,
      ...agregarTotales(lineas, config),
      estado: 'confirmada',
      confirmado_por: req.user?.email || req.user?.sub || '',
      confirmado_at: nowIso(),
    };
    await persistirNegociacion(meta, lineas);
    return res.json({ ok: true, negociacion: meta, lineas });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al confirmar' });
  }
});

router.post('/mayorista/negociaciones/:id/facturar', requirePermission('mayorista.editar'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const actual = await cargarNegociacion(id);
    if (!actual) return res.status(404).json({ error: 'Negociación no encontrada' });
    if (actual.meta.estado !== 'confirmada') {
      return res.status(400).json({ error: 'Solo se puede marcar facturada una operación confirmada' });
    }
    const meta = {
      ...actual.meta,
      estado: 'facturada',
      facturado_at: nowIso(),
      facturado_por: req.user?.email || req.user?.sub || '',
    };
    await persistirNegociacion(meta, actual.lineas);
    return res.json({ ok: true, negociacion: meta, lineas: actual.lineas });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al facturar' });
  }
});

router.post('/mayorista/negociaciones/:id/pagar', requirePermission('mayorista.editar'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const actual = await cargarNegociacion(id);
    if (!actual) return res.status(404).json({ error: 'Negociación no encontrada' });
    if (actual.meta.estado !== 'facturada') {
      return res.status(400).json({ error: 'Solo se puede marcar como pagada una operación facturada' });
    }
    const meta = {
      ...actual.meta,
      estado: 'pagada',
      pagado_at: nowIso(),
      pagado_por: req.user?.email || req.user?.sub || '',
    };
    await persistirNegociacion(meta, actual.lineas);
    return res.json({ ok: true, negociacion: meta, lineas: actual.lineas });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al marcar como pagada' });
  }
});

router.post('/mayorista/negociaciones/:id/duplicar', requirePermission('mayorista.crear'), async (req, res) => {
  try {
    const actual = await cargarNegociacion(String(req.params.id));
    if (!actual) return res.status(404).json({ error: 'Negociación no encontrada' });
    const config = await getConfig();
    const id = crypto.randomUUID();
    const fecha = String(req.body?.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const numero_operacion = await nextNumeroOperacion();
    const meta = {
      id,
      numero_operacion,
      cliente_id: actual.meta.cliente_id,
      cliente_nombre: actual.meta.cliente_nombre,
      fecha,
      nombre: buildNombreOperacion(numero_operacion, actual.meta.cliente_nombre, fecha),
      recogida_empresa_id: actual.meta.recogida_empresa_id || '',
      recogida_empresa_nombre: actual.meta.recogida_empresa_nombre || '',
      recogida_fecha: actual.meta.recogida_fecha || '',
      recogida_hora: actual.meta.recogida_hora || '',
      estado: 'borrador',
      pct_ganancia_defecto: actual.meta.pct_ganancia_defecto,
      tasa_capital: actual.meta.tasa_capital,
      creado_por: req.user?.email || req.user?.sub || '',
      createdAt: nowIso(),
      duplicada_de: actual.meta.id,
    };
    const lineas = [];
    for (const raw of actual.lineas) {
      lineas.push(await enriquecerYRecalcularLinea({
        ...raw,
        id_linea: crypto.randomUUID(),
        alerta_aceptada: false,
        createdAt: nowIso(),
      }, meta, config));
    }
    Object.assign(meta, agregarTotales(lineas, config));
    await persistirNegociacion(meta, lineas);
    return res.status(201).json({ ok: true, negociacion: meta, lineas });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al duplicar' });
  }
});

router.delete('/mayorista/negociaciones/:id', requirePermission('mayorista.borrar'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const actual = await cargarNegociacion(id);
    if (!actual) return res.status(404).json({ error: 'Negociación no encontrada' });
    if (actual.meta.estado !== 'borrador' && actual.meta.estado !== 'confirmada') {
      return res.status(400).json({
        error: 'Solo se pueden borrar operaciones en borrador o confirmada (no facturadas ni pagadas)',
      });
    }
    const items = await queryAll({
      TableName: tNeg,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': id },
    });
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [tNeg]: chunk.map((it) => ({ DeleteRequest: { Key: { PK: it.PK, SK: it.SK } } })),
        },
      }));
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al borrar' });
  }
});

router.get('/mayorista/negociaciones/:id/export', requirePermission('mayorista.exportar'), async (req, res) => {
  const version = String(req.query.version || 'cliente');
  if (version !== 'cliente' && version !== 'interna') {
    return res.status(400).json({ error: 'version debe ser cliente|interna' });
  }
  const data = await cargarNegociacion(String(req.params.id));
  if (!data) return res.status(404).json({ error: 'Negociación no encontrada' });
  // Stub: PDF pendiente de confirmación de campos con Javier.
  return res.status(501).json({
    error: 'Exportación PDF pendiente de definir campos (versión cliente/interna).',
    version,
    negociacion_id: data.meta.id,
  });
});

// Empresas como clientes (reutilización)
router.get('/mayorista/clientes', requirePermission('mayorista.ver'), async (_req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tEmpresas,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
    const clientes = items
      .map((e) => {
        const id = String(e.id_empresa ?? e.id_Empresa ?? '').trim();
        const nombre = String(e.Nombre || e.nombre || e.Alias || '').trim();
        const alias = String(e.Alias || '').trim();
        return {
          id,
          nombre: nombre || alias || id,
          cif: String(e.Cif || e.CIF || e.cif || '').trim(),
          alias: alias && alias !== nombre ? alias : '',
        };
      })
      .filter((c) => c.id)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return res.json({ ok: true, clientes });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error al listar empresas' });
  }
});

export default router;
