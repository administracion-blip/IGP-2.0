/**
 * MIA — Motor Inteligente de Aprovisionamiento.
 *
 * Permisos:
 *  - mia.ver
 *  - mia.configurar (productos + calendario informativo)
 *  - mia.sincronizar
 *  - mia.calcular
 *  - mia.aprobar (ajustar / aprobar → PurchaseOrders Ágora)
 */
import { Router } from 'express';
import { requireAnyPermission, requirePermission } from '../middleware/auth.js';
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
  getInformeCompleto,
  listInformesByWarehouse,
  updateLineas,
} from '../lib/mia/informes.js';
import { aprobarInformeMia } from '../lib/mia/aprobar.js';
import {
  listByLocalId,
  listByWarehouseId,
  remove as removeCalendario,
  upsert as upsertCalendario,
} from '../lib/mia/calendarioPedidos.js';
import { formatId6 } from '../lib/usuarioLocales.js';

const router = Router();

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
    return res.status(502).json({
      error: err?.message || 'Error listando familias',
      familias: [],
      source: 'dynamo',
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
    return res.status(500).json({ error: err?.message || 'Error listando grupos' });
  }
});

router.put('/mia/grupos-familias', requirePermission('mia.configurar'), async (req, res) => {
  try {
    const item = await upsertGrupoFamilias(req.body || {});
    return res.json({ ok: true, item });
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'Datos inválidos' });
  }
});

router.delete('/mia/grupos-familias/:id', requirePermission('mia.configurar'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id es obligatorio' });
  try {
    const result = await deleteGrupoFamilias(id);
    return res.json(result);
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'No se pudo eliminar' });
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
    return res.status(502).json({
      ok: false,
      error: err?.message || 'Error sincronizando stocks',
    });
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
  const items = await listConfigByWarehouse(wid);
  res.json({ warehouseId: wid, items, total: items.length });
});

router.put('/mia/config', requirePermission('mia.configurar'), async (req, res) => {
  const body = req.body || {};
  try {
    const item = await upsertConfigProducto(body);
    res.json({ ok: true, item });
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Datos inválidos' });
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
      const items = await listByLocalId(localId);
      return res.json({ localId, items, total: items.length });
    }
    const wid = normalizeWarehouseId(req.query.warehouseId);
    if (!wid || wid === '000000') {
      return res.status(400).json({ error: 'warehouseId inválido' });
    }
    const items = await listByWarehouseId(wid);
    return res.json({ warehouseId: wid, items, total: items.length });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/calendario] Error listando');
    return res.status(500).json({ error: err?.message || 'Error listando calendario' });
  }
});

router.put('/mia/calendario', requirePermission('mia.configurar'), async (req, res) => {
  const body = req.body || {};
  try {
    const item = await upsertCalendario(body, { usuario: req.user });
    return res.json({ ok: true, item });
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'Datos inválidos' });
  }
});

router.delete('/mia/calendario', requirePermission('mia.configurar'), async (req, res) => {
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
    const status = err?.status || 400;
    return res.status(status).json({ error: err?.message || 'No se pudo eliminar' });
  }
});

// ─── Cálculo + informes (Fase 3) ──────────────────────────────────────────────

router.post('/mia/calcular', requirePermission('mia.calcular'), async (req, res) => {
  const body = req.body || {};
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
    const status = err?.status || 500;
    if (status >= 500) {
      req.log?.error?.({ err }, '[mia/calcular] Error');
    }
    return res.status(status).json({
      ok: false,
      error: err?.message || 'Error calculando pedido MIA',
      ...(err?.code ? { code: err.code } : {}),
    });
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
  try {
    const limit = req.query.limit;
    const items = await listInformesByWarehouse(wid, { limit });
    return res.json({ warehouseId: wid, items, total: items.length });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/informes] Error');
    return res.status(500).json({ error: err?.message || 'Error listando informes' });
  }
});

router.get('/mia/informes/:id', requirePermission('mia.ver'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id de informe obligatorio' });
  try {
    const full = await getInformeCompleto(id);
    if (!full) return res.status(404).json({ error: 'Informe no encontrado' });
    return res.json({ ok: true, ...full, avisos: full.informe?.avisos || [] });
  } catch (err) {
    req.log?.error?.({ err }, '[mia/informes/:id] Error');
    return res.status(500).json({ error: err?.message || 'Error leyendo informe' });
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
    try {
      const result = await updateLineas(id, lineas, { usuario: req.user });
      return res.json({
        ok: true,
        ...result,
        avisos: result.informe?.avisos || [],
      });
    } catch (err) {
      const status = err?.status || 500;
      if (status >= 500) req.log?.error?.({ err }, '[mia/informes/:id/lineas] Error');
      return res.status(status).json({
        ok: false,
        error: err?.message || 'Error ajustando líneas',
        ...(err?.missing ? { missing: err.missing } : {}),
      });
    }
  },
);

router.post('/mia/informes/:id/aprobar', requirePermission('mia.aprobar'), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id de informe obligatorio' });
  const body = req.body || {};
  try {
    const result = await aprobarInformeMia(id, {
      statusAgora: body.statusAgora,
      force: body.force === true || body.force === 'true',
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) req.log?.error?.({ err }, '[mia/informes/:id/aprobar] Error');
    return res.status(status).json({
      ok: false,
      error: err?.message || 'Error aprobando informe',
      ...(err?.agoraResultados ? { agoraResultados: err.agoraResultados } : {}),
      ...(err?.omitidasAgora ? { omitidasAgora: err.omitidasAgora } : {}),
      ...(err?.agoraPurchaseOrderIds ? { agoraPurchaseOrderIds: err.agoraPurchaseOrderIds } : {}),
      ...(err?.enviadoAgora != null ? { enviadoAgora: err.enviadoAgora } : {}),
      ...(err?.pedidosCreados != null ? { pedidosCreados: err.pedidosCreados } : {}),
    });
  }
});

export default router;
