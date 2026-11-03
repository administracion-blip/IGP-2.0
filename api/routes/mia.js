/**
 * MIA — Motor Inteligente de Aprovisionamiento.
 *
 * Permisos:
 *  - mia.ver
 *  - mia.configurar (productos + calendario informativo)
 *  - mia.sincronizar
 *  - mia.calcular
 *  - mia.aprobar (ajustar / aprobar → PurchaseOrders Ágora en borrador)
 *  - mia.confirmar_agora (aprobar enviando el PurchaseOrder ya 'Confirmed')
 */
import { responderError } from '../lib/http/responderError.js';
import { Router } from 'express';
import { hasPermission, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { listConfigByWarehouse, upsertConfigProducto } from '../lib/mia/configProducto.js';
import { buildMapaLocalAlmacen } from '../lib/mia/localAlmacen.js';
import {
  getMiaSyncStatus,
  syncStocksAll,
  syncStocksForWarehouse,
} from '../lib/mia/stocksSync.js';
import { normalizeWarehouseId } from '../lib/mia/keys.js';
import { calcularPedidoMia } from '../lib/mia/motor.js';
import {
  deleteGrupoFamilias,
  listFamiliasMia,
  listGruposFamilias,
  upsertGrupoFamilias,
} from '../lib/mia/gruposFamilias.js';
import {
  deleteInforme,
  getInformeCompleto,
  getInformeMeta,
  listInformesByWarehouse,
  updateLineas,
} from '../lib/mia/informes.js';
import { aprobarInformeMia } from '../lib/mia/aprobar.js';
import { syncEntregasAlmacen } from '../lib/mia/syncEntregas.js';
import { listProveedoresParaAjustes, upsertProveedorConfig } from '../lib/mia/proveedoresConfig.js';
import {
  listByLocalId,
  listByWarehouseId,
  remove as removeCalendario,
  upsert as upsertCalendario,
} from '../lib/mia/calendarioPedidos.js';
import { formatId6 } from '../lib/usuarioLocales.js';
import { requireLocal, desde } from '../middleware/alcance.js';
import { MENSAJE_SIN_ACCESO_LOCAL } from '../lib/alcance.js';
import { filtrarLecturaPorLocal, permiteLecturaLocal } from '../lib/alcanceLecturas.js';
import { permiteAlmacen, permiteLecturaAlmacen } from '../lib/alcanceAlmacenes.js';
import { comprobarArchivo, multerPerfil } from '../lib/seguridad/subidas.js';
import { crearConteoStock, guardarLineasConteo, leerConteo, listarConteos } from '../lib/mia/conteoStock.js';
import { calcularConteo, simularConteo, sumarPrevisionRango } from '../lib/mia/calculoStock.js';
import { borrarTramosPropios, elegirTramo, guardarTramos, vistaTramos } from '../lib/mia/tramos.js';
import { guardarLineasStockMaximo, listarVistaStockMaximo, sanearConfigStock } from '../lib/mia/stockMaximo.js';
import {
  MAX_EXCEL_CONTEO_BYTES,
  MENSAJE_NO_XLSX,
  prepararLineasConteo,
} from '../lib/mia/importarExcel.js';

const router = Router();

const subirExcelConteo = multerPerfil('hoja', { maxBytes: MAX_EXCEL_CONTEO_BYTES }).single('fichero');

function recibirExcelConteo(req, res, next) {
  subirExcelConteo(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'El archivo supera el tamaño máximo (5 MB)' });
    }
    return res.status(400).json({ error: err.message || MENSAJE_NO_XLSX });
  });
}

function sinAcceso(res) {
  return res.status(403).json({ error: MENSAJE_SIN_ACCESO_LOCAL });
}

/** Acciones sobre un informe: el almacén del informe leído tiene que ser del usuario (basta un local suyo). */
async function permiteInforme(req, id) {
  const meta = await getInformeMeta(id);
  // Sin informe no se escribe nada: el 404 lo da la propia acción.
  if (!meta) return true;
  return permiteAlmacen(req, meta.WarehouseId ?? meta.warehouseId);
}

// ─── Importar Excel de conteo (stock máximo; sin previsión todavía) ─────────

router.post(
  '/mia/conteos/importar',
  requirePermission('mia.calcular'),
  recibirExcelConteo,
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    try {
      comprobarArchivo(req.file, 'hoja', { maxBytes: MAX_EXCEL_CONTEO_BYTES });
    } catch (err) {
      const tamano = /tamaño máximo/.test(String(err?.message || ''));
      return res.status(400).json({ error: tamano ? err.message : MENSAJE_NO_XLSX });
    }
    if (req.file.extDetectada !== 'xlsx') {
      return res.status(400).json({ error: MENSAJE_NO_XLSX });
    }

    const warehouseId = normalizeWarehouseId(req.body?.warehouseId);
    if (!warehouseId || warehouseId === '000000') {
      return res.status(400).json({ error: 'warehouseId es obligatorio' });
    }
    if (!(await permiteAlmacen(req, warehouseId))) return sinAcceso(res);

    try {
      const preparado = await prepararLineasConteo(req.file.buffer);
      const guardado = await crearConteoStock({
        warehouseId,
        semanasDesde: req.body?.semanasDesde,
        semanasHasta: req.body?.semanasHasta,
        ficheroNombre: req.file.originalname || null,
        lineas: preparado.lineas,
        lineasLeidas: preparado.lineasLeidas,
        idsDesconocidos: preparado.desconocidos,
        duplicados: preparado.duplicados,
      });
      return res.status(201).json({
        ok: true,
        informeId: guardado.meta.informeId,
        ficheroNombre: guardado.meta.ficheroNombre,
        lineasLeidas: guardado.meta.lineasLeidas,
        lineasGuardadas: guardado.lineas.length,
        lineasContadas: preparado.lineasContadas,
        desconocidos: preparado.desconocidos,
        duplicados: preparado.duplicados,
        avisoDuplicados: preparado.duplicados.length
          ? `Hay Ids repetidos; se usa la primera fila y no se suman: ${preparado.duplicados.join(', ')}`
          : null,
        multiplicador: guardado.meta.multiplicador,
        previsionImporte: guardado.meta.previsionImporte,
      });
    } catch (err) {
      return responderError(res, err, {
        mensaje: 'No se pudo importar el Excel',
        extra: {
          ...(err?.desconocidos ? { desconocidos: err.desconocidos } : {}),
          ...(err?.duplicados ? { duplicados: err.duplicados } : {}),
        },
      });
    }
  },
);

router.post('/mia/conteos/:id/simular', requirePermission('mia.calcular'), async (req, res) => {
  if (!(await permiteInforme(req, req.params.id))) return sinAcceso(res);
  try {
    const body = req.body || {};
    const resultado = await simularConteo(req.params.id, {
      ...(body.previsionImporte != null && body.previsionImporte !== ''
        ? { previsionImporte: body.previsionImporte }
        : {}),
    });
    return res.json(resultado);
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo simular el conteo' });
  }
});

router.get('/mia/conteos', requirePermission('mia.ver'), async (req, res) => {
  const wid = normalizeWarehouseId(req.query.warehouseId);
  if (!wid || wid === '000000') return res.status(400).json({ error: 'warehouseId es obligatorio' });
  if (!(await permiteAlmacen(req, wid))) return sinAcceso(res);
  try {
    return res.json(await listarConteos(wid));
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudieron cargar los conteos' });
  }
});

router.get('/mia/conteos/:id', requirePermission('mia.ver'), async (req, res) => {
  if (!(await permiteInforme(req, req.params.id))) return sinAcceso(res);
  try {
    return res.json(await leerConteo(req.params.id));
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo cargar el conteo' });
  }
});

router.put('/mia/conteos/:id/lineas', requirePermission('mia.calcular'), async (req, res) => {
  if (!(await permiteInforme(req, req.params.id))) return sinAcceso(res);
  try {
    const vista = await guardarLineasConteo(req.params.id, req.body?.lineas);
    return res.json(vista);
  } catch (err) {
    return responderError(res, err, {
      mensaje: 'No se pudieron guardar las líneas',
      extra: {
        ...(Number.isInteger(err?.indice) ? { indice: err.indice } : {}),
        ...(err?.productId ? { productId: err.productId } : {}),
        ...(err?.proveedorId ? { proveedorId: err.proveedorId } : {}),
      },
    });
  }
});

router.post('/mia/conteos/:id/calcular', requirePermission('mia.calcular'), async (req, res) => {
  if (!(await permiteInforme(req, req.params.id))) return sinAcceso(res);
  try {
    const resultado = await calcularConteo(req.params.id);
    return res.json(resultado);
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo calcular el conteo' });
  }
});

// ─── Sync status ─────────────────────────────────────────────────────────────

router.get(
  '/mia/sync/status',
  requireAnyPermission('mia.ver', 'mia.sincronizar'),
  async (_req, res) => {
    const status = await getMiaSyncStatus();
    res.json(status);
  },
);

// ─── Familias Ágora + grupos MIA (filtro calcular) ────────────────────────────

router.get('/mia/familias', requirePermission('mia.ver'), async (req, res) => {
  try {
    const result = await listFamiliasMia();
    return res.json(result);
  } catch (err) {
    req.log?.error?.({ err }, '[mia/familias] Error');
    return responderError(res, err, {
      mensaje: 'Error listando familias', status: 502, extra: { familias: [], source: 'dynamo' },
    });
  }
});

router.get('/mia/grupos-familias', requirePermission('mia.ver'), async (req, res) => {
  try {
    const todos =
      req.query.todos === '1' ||
      req.query.todos === 'true' ||
      req.query.todos === 'all';
    const grupos = await listGruposFamilias({ todos });
    return res.json({ grupos, total: grupos.length, todos });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/grupos-familias] Error listando');
    return responderError(res, err, { mensaje: 'Error listando grupos' });
  }
});

router.put('/mia/grupos-familias', requirePermission('mia.configurar'), async (req, res) => {
  try {
    const item = await upsertGrupoFamilias(req.body || {});
    return res.json({ ok: true, item });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo guardar' });
  }
});

router.delete('/mia/grupos-familias/:id', requirePermission('mia.configurar'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id es obligatorio' });
  try {
    const result = await deleteGrupoFamilias(id);
    return res.json(result);
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo eliminar' });
  }
});


// ─── Stocks sync (JWT mia.sincronizar o X-Internal-Secret) ───────────────────

router.post('/mia/stocks/sync', requirePermission('mia.sincronizar'), async (req, res) => {
  const body = req.body || {};
  const force = body.force === true || body.force === 'true';
  const warehouseId = body.warehouseId != null && String(body.warehouseId).trim() !== ''
    ? body.warehouseId
    : (req.query.warehouseId || null);

  try {
    if (warehouseId != null && String(warehouseId).trim() !== '') {
      const result = await syncStocksForWarehouse(warehouseId, { force });
      return res.json(result);
    }

    const result = await syncStocksAll({ force });
    if (!result.ok) {
      return res.status(502).json(result);
    }
    return res.json(result);
  } catch (err) {
    req.log?.error?.({ err }, '[mia/stocks/sync] Error');
    return responderError(res, err, { mensaje: 'Error sincronizando stocks', status: 502, extra: { ok: false } });
  }
});

router.post('/mia/entregas/sync', requirePermission('mia.sincronizar'), async (req, res) => {
  const body = req.body || {};
  const wid = normalizeWarehouseId(body.warehouseId ?? req.query.warehouseId);
  if (!wid || wid === '000000') {
    return res.status(400).json({ error: 'warehouseId es obligatorio' });
  }
  if (!(await permiteAlmacen(req, wid))) return sinAcceso(res);
  try {
    const result = await syncEntregasAlmacen(wid, {
      maxDias: body.maxDias,
      maxInformes: body.maxInformes,
    });
    return res.json(result);
  } catch (err) {
    req.log?.error?.({ err }, '[mia/entregas/sync] Error');
    return responderError(res, err, { mensaje: 'Error sincronizando entregas', status: 502, extra: { ok: false } });
  }
});

// ─── Config producto ─────────────────────────────────────────────────────────

router.get('/mia/config', requirePermission('mia.ver'), async (req, res) => {
  const warehouseId = req.query.warehouseId;
  if (warehouseId == null || String(warehouseId).trim() === '') {
    return res.status(400).json({ error: 'warehouseId es obligatorio' });
  }
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') {
    return res.status(400).json({ error: 'warehouseId inválido' });
  }
  if (!(await permiteLecturaAlmacen(req, wid))) return sinAcceso(res);
  const items = await listConfigByWarehouse(wid);
  res.json({ warehouseId: wid, items, total: items.length });
});

router.put('/mia/config', requirePermission('mia.configurar'), async (req, res) => {
  const body = req.body || {};
  const wid = normalizeWarehouseId(body.warehouseId);
  if (!wid || wid === '000000') {
    return res.status(400).json({ error: 'warehouseId es obligatorio' });
  }
  if (!(await permiteAlmacen(req, wid))) return sinAcceso(res);
  try {
    const saneado = await sanearConfigStock(body);
    const item = await upsertConfigProducto(saneado);
    res.json({ ok: true, item });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo guardar' });
  }
});

router.get('/mia/stock-maximo', requirePermission('mia.ver'), async (req, res) => {
  const wid = normalizeWarehouseId(req.query.warehouseId);
  if (!wid || wid === '000000') return res.status(400).json({ error: 'warehouseId es obligatorio' });
  if (!(await permiteAlmacen(req, wid))) return sinAcceso(res);
  try {
    const vista = await listarVistaStockMaximo(wid, {
      familia: req.query.familia,
      sinMaximo: req.query.sinMaximo === '1' || req.query.sinMaximo === 'true',
      q: req.query.q,
      offset: req.query.offset,
      limit: req.query.limit,
    });
    return res.json(vista);
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo cargar el stock máximo' });
  }
});

function idAlmacenTramo(raw) {
  if (raw == null || String(raw).trim() === '' || String(raw).trim() === 'GLOBAL') return null;
  const wid = normalizeWarehouseId(raw);
  if (!wid || wid === '000000') {
    throw Object.assign(new Error('Almacén del tramo no válido'), { status: 400, expose: true });
  }
  return wid;
}

const RE_FECHA_TRAMO = /^\d{4}-\d{2}-\d{2}$/;

router.get('/mia/tramos', requirePermission('mia.ver'), async (req, res) => {
  try {
    const wid = idAlmacenTramo(req.query.warehouseId);
    if (wid && !(await permiteAlmacen(req, wid))) return sinAcceso(res);
    return res.json(await vistaTramos(wid));
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudieron cargar los tramos' });
  }
});

router.put('/mia/tramos', requirePermission('mia.configurar'), async (req, res) => {
  try {
    const body = req.body || {};
    const wid = idAlmacenTramo(body.warehouseId);
    if (wid && !(await permiteAlmacen(req, wid))) return sinAcceso(res);
    const guardados = await guardarTramos(wid, body.tramos);
    return res.json({ ok: true, ambito: wid || 'GLOBAL', heredados: false, tramos: guardados });
  } catch (err) {
    return responderError(res, err, {
      mensaje: 'No se pudieron guardar los tramos',
      extra: Number.isInteger(err?.indice) ? { indice: err.indice } : {},
    });
  }
});

router.delete('/mia/tramos', requirePermission('mia.configurar'), async (req, res) => {
  try {
    const wid = idAlmacenTramo(req.query.warehouseId ?? req.body?.warehouseId);
    if (!wid) {
      return res.status(400).json({ error: 'Hace falta el almacén cuyos tramos propios se quitan' });
    }
    if (!(await permiteAlmacen(req, wid))) return sinAcceso(res);
    return res.json(await borrarTramosPropios(wid));
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudieron quitar los tramos' });
  }
});

router.post('/mia/tramos/simular', requirePermission('mia.calcular'), async (req, res) => {
  try {
    const body = req.body || {};
    const wid = idAlmacenTramo(body.warehouseId);
    if (!wid) return res.status(400).json({ error: 'Elige un almacén para ver la previsión' });
    if (!(await permiteAlmacen(req, wid))) return sinAcceso(res);
    const desde = String(body.semanasDesde || '').slice(0, 10);
    const hasta = String(body.semanasHasta || '').slice(0, 10);
    if (!RE_FECHA_TRAMO.test(desde) || !RE_FECHA_TRAMO.test(hasta) || hasta < desde) {
      return res.status(400).json({ error: 'Elige un rango de semanas válido' });
    }
    const prevision = await sumarPrevisionRango(wid, desde, hasta);
    const vista = await vistaTramos(wid);
    const tramo = elegirTramo(prevision.importe, vista.tramos);
    return res.json({
      warehouseId: wid,
      rangoDesde: desde,
      rangoHasta: hasta,
      previsionImporte: prevision.importe,
      aviso: prevision.aviso,
      desglose: prevision.desglose,
      heredados: vista.heredados,
      tramoDesde: tramo?.desde ?? null,
      tramoHasta: tramo?.hasta ?? null,
      multiplicador: tramo?.multiplicador ?? null,
    });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo simular la previsión' });
  }
});

router.put('/mia/stock-maximo', requirePermission('mia.configurar'), async (req, res) => {
  const body = req.body || {};
  const wid = normalizeWarehouseId(body.warehouseId);
  if (!wid || wid === '000000') return res.status(400).json({ error: 'warehouseId es obligatorio' });
  if (!(await permiteAlmacen(req, wid))) return sinAcceso(res);
  try {
    const guardadas = await guardarLineasStockMaximo(wid, body.lineas);
    return res.json({ ok: true, guardados: guardadas.length });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo guardar el stock máximo' });
  }
});

// ─── Plazo y frecuencia por proveedor (Igp_Ajustes PK=mia_proveedores) ───────

router.get('/mia/proveedores-config', requirePermission('mia.configurar'), async (req, res) => {
  const raw = req.query.warehouseId;
  let wid = null;
  if (raw != null && String(raw).trim() !== '') {
    wid = normalizeWarehouseId(raw);
    if (!wid || wid === '000000') {
      return res.status(400).json({ error: 'warehouseId inválido' });
    }
    if (!(await permiteLecturaAlmacen(req, wid))) return sinAcceso(res);
  }
  try {
    const items = await listProveedoresParaAjustes(wid);
    return res.json({ warehouseId: wid, items, total: items.length });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/proveedores-config] Error listando');
    return responderError(res, err, { mensaje: 'Error listando proveedores' });
  }
});

router.put('/mia/proveedores-config', requirePermission('mia.configurar'), async (req, res) => {
  try {
    const item = await upsertProveedorConfig(req.body || {}, req.user);
    return res.json({ ok: true, item });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo guardar' });
  }
});

// ─── Diagnóstico mapa local ↔ almacén ────────────────────────────────────────

router.get('/mia/locales-almacenes', requirePermission('mia.ver'), async (_req, res) => {
  const mapa = await buildMapaLocalAlmacen();
  res.json({
    locales: mapa.locales,
    almacenes: mapa.almacenes,
    mismatches: mapa.mismatches,
    resumen: {
      locales: mapa.locales.length,
      almacenes: mapa.almacenes.length,
      nombresSinAlmacen: mapa.mismatches.nombresSinAlmacen.length,
      almacenesSinLocal: mapa.mismatches.almacenesSinLocal.length,
    },
  });
});

// ─── Calendario informativo de pedidos (v1.1) ────────────────────────────────

router.get('/mia/calendario', requirePermission('mia.ver'), async (req, res) => {
  const hasLocal = req.query.localId != null && String(req.query.localId).trim() !== '';
  const hasWh = req.query.warehouseId != null && String(req.query.warehouseId).trim() !== '';
  if (hasLocal === hasWh) {
    return res.status(400).json({
      error: 'Indica exactamente uno: localId o warehouseId',
    });
  }
  try {
    if (hasLocal) {
      const localId = formatId6(req.query.localId);
      if (!localId || localId === '000000') {
        return res.status(400).json({ error: 'localId inválido' });
      }
      if (!(await permiteLecturaLocal(req, { idLocal: localId }))) return sinAcceso(res);
      const items = await listByLocalId(localId);
      return res.json({ localId, items, total: items.length });
    }
    const wid = normalizeWarehouseId(req.query.warehouseId);
    if (!wid || wid === '000000') {
      return res.status(400).json({ error: 'warehouseId inválido' });
    }
    const items = await filtrarLecturaPorLocal(req, await listByWarehouseId(wid), (it) => ({ idLocal: it.LocalId }));
    return res.json({ warehouseId: wid, items, total: items.length });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/calendario] Error listando');
    return responderError(res, err, { mensaje: 'Error listando calendario' });
  }
});

router.put('/mia/calendario', requirePermission('mia.configurar'), requireLocal(desde.body('localId'), { tipo: 'idLocal' }), async (req, res) => {
  const body = req.body || {};
  try {
    const item = await upsertCalendario(body, { usuario: req.user });
    return res.json({ ok: true, item });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo guardar' });
  }
});

router.delete('/mia/calendario', requirePermission('mia.configurar'), requireLocal(desde.query('localId'), { tipo: 'idLocal' }), async (req, res) => {
  const localId = req.query.localId;
  const proveedorId = req.query.proveedorId;
  if (localId == null || String(localId).trim() === '') {
    return res.status(400).json({ error: 'localId es obligatorio' });
  }
  if (proveedorId == null || String(proveedorId).trim() === '') {
    return res.status(400).json({ error: 'proveedorId es obligatorio' });
  }
  try {
    const result = await removeCalendario(localId, proveedorId);
    return res.json(result);
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo eliminar' });
  }
});

// ─── Cálculo + informes (Fase 3) ──────────────────────────────────────────────

router.post('/mia/calcular', requirePermission('mia.calcular'), async (req, res) => {
  const body = req.body || {};
  if (!(await permiteAlmacen(req, body.warehouseId))) return sinAcceso(res);
  try {
    const result = await calcularPedidoMia({
      warehouseId: body.warehouseId,
      fechaDesde: body.fechaDesde,
      fechaHasta: body.fechaHasta,
      grupoFamiliaId: body.grupoFamiliaId,
      grupoFamiliaNombre: body.grupoFamiliaNombre,
      semanasHistorico: body.semanasHistorico,
      colchonDias: body.colchonDias,
      syncStock: body.syncStock,
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    return responderError(res, err, { mensaje: 'Error calculando pedido MIA', extra: { ok: false } });
  }
});

router.get('/mia/informes', requirePermission('mia.ver'), async (req, res) => {
  const warehouseId = req.query.warehouseId;
  if (warehouseId == null || String(warehouseId).trim() === '') {
    return res.status(400).json({ error: 'warehouseId es obligatorio' });
  }
  const wid = normalizeWarehouseId(warehouseId);
  if (!wid || wid === '000000') {
    return res.status(400).json({ error: 'warehouseId inválido' });
  }
  if (!(await permiteLecturaAlmacen(req, wid))) return sinAcceso(res);
  try {
    const limit = req.query.limit;
    const items = await listInformesByWarehouse(wid, { limit });
    return res.json({ warehouseId: wid, items, total: items.length });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/informes] Error');
    return responderError(res, err, { mensaje: 'Error listando informes' });
  }
});

router.delete('/mia/informes/:id', requirePermission('mia.calcular'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id de informe obligatorio' });
  if (!(await permiteInforme(req, id))) return sinAcceso(res);
  try {
    const result = await deleteInforme(id);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return responderError(res, err, { mensaje: 'Error borrando informe', extra: { ok: false } });
  }
});

router.get('/mia/informes/:id', requirePermission('mia.ver'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id de informe obligatorio' });
  try {
    const full = await getInformeCompleto(id);
    if (!full) return res.status(404).json({ error: 'Informe no encontrado' });
    if (!(await permiteLecturaAlmacen(req, full.informe?.WarehouseId ?? full.informe?.warehouseId))) {
      return sinAcceso(res);
    }
    return res.json({ ok: true, ...full, avisos: full.informe?.avisos || [] });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/informes/:id] Error');
    return responderError(res, err, { mensaje: 'Error leyendo informe' });
  }
});

// ─── Ajuste líneas + aprobación Ágora (Fase 5a) ──────────────────────────────
// PDF: GET /mia/informes/:id ya devuelve meta+líneas+porProveedor (sin ruta pdf-data).

router.patch(
  '/mia/informes/:id/lineas',
  requireAnyPermission('mia.calcular', 'mia.aprobar'),
  async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id de informe obligatorio' });
    const lineas = req.body?.lineas;
    if (!Array.isArray(lineas) || lineas.length === 0) {
      return res.status(400).json({ error: 'Body { lineas: [...] } obligatorio' });
    }
    if (!(await permiteInforme(req, id))) return sinAcceso(res);
    try {
      const result = await updateLineas(id, lineas, { usuario: req.user });
      return res.json({
        ok: true,
        ...result,
        avisos: result.informe?.avisos || [],
      });
    } catch (err) {
      return responderError(res, err, {
        mensaje: 'Error ajustando líneas',
        extra: { ok: false, ...(err?.missing ? { missing: err.missing } : {}) },
      });
    }
  },
);

router.post('/mia/informes/:id/aprobar', requirePermission('mia.aprobar'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id de informe obligatorio' });
  const body = req.body || {};
  if (!(await permiteInforme(req, id))) return sinAcceso(res);
  // Sin permiso no se degrada a borrador: quien pidió confirmar tiene que saber que no se hizo.
  const pideConfirmado = String(body.statusAgora ?? '').trim() === 'Confirmed';
  if (pideConfirmado && !req.isInternal && !(await hasPermission(req.user, 'mia.confirmar_agora'))) {
    return res.status(403).json({
      ok: false,
      error: 'No tienes permiso para enviar el pedido a Ágora como confirmado; apruébalo como borrador',
    });
  }
  try {
    const result = await aprobarInformeMia(id, {
      statusAgora: pideConfirmado ? 'Confirmed' : 'Draft',
      force: body.force === true || body.force === 'true',
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    return responderError(res, err, {
      mensaje: 'Error aprobando informe',
      extra: {
        ok: false,
        ...(err?.agoraResultados ? { agoraResultados: err.agoraResultados } : {}),
        ...(err?.omitidasAgora ? { omitidasAgora: err.omitidasAgora } : {}),
        ...(err?.agoraPurchaseOrderIds ? { agoraPurchaseOrderIds: err.agoraPurchaseOrderIds } : {}),
        ...(err?.enviadoAgora != null ? { enviadoAgora: err.enviadoAgora } : {}),
        ...(err?.pedidosCreados != null ? { pedidosCreados: err.pedidosCreados } : {}),
      },
    });
  }
});

export default router;
