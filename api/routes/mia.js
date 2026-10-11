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
  getInformeCompleto,
  getInformeMeta,
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
import { requireLocal, desde } from '../middleware/alcance.js';
import { MENSAJE_SIN_ACCESO_LOCAL } from '../lib/alcance.js';
import { filtrarLecturaPorLocal, permiteLecturaLocal } from '../lib/alcanceLecturas.js';
import { permiteAlmacen, permiteLecturaAlmacen } from '../lib/alcanceAlmacenes.js';

const router = Router();

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
    const item = await upsertConfigProducto(body);
    res.json({ ok: true, item });
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
