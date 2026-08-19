/**
 * Escandallos IGP — recetas de plato de venta (no escribe en Ágora).
 *
 * Permisos: escandallos.ver / escandallos.editar
 */
import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requirePermission } from '../middleware/auth.js';
import { docClient, tables } from '../lib/db.js';
import { normalizeProductId } from '../lib/escandallos/keys.js';
import {
  deleteReceta,
  getReceta,
  listRecetas,
  listRecetasConIngredientes,
  putReceta,
  setImagenKey,
} from '../lib/escandallos/store.js';
import { queryUltimaCompraPorProductos } from '../lib/dynamo/comprasProveedor.js';
import {
  listCentrosVenta,
  listLocalesTarifa,
  pickPriceListId,
} from '../lib/dynamo/saleCenters.js';
import { buildMapaLocalAlmacen } from '../lib/mia/localAlmacen.js';
import { normalizeWarehouseId } from '../lib/mia/keys.js';
import { normalizeLocalesUsuario, tieneAlcanceGlobalLocales } from '../lib/usuarioLocales.js';
import { findUsuarioByEmail } from '../lib/dynamo/usuarios.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const PRESIGN_EXPIRES = 3600;
const COMPRAS_CONTEXTO_MAX = 80;

function uuid() {
  return crypto.randomUUID();
}

/**
 * Nombres de locales (normalizados) visibles para el usuario. Mismo patrón que
 * `empresasPermitidasDelUsuario`: el alcance se resuelve una sola vez y luego se
 * filtra en memoria (el JWT no lleva Locales, se recargan por email).
 * @returns {Promise<null|Set<string>>} null = sin restricción; Set = solo esos nombres
 */
async function localesPermitidosDelUsuario(user) {
  if (!user) return new Set();
  if (user.rol === 'Administrador') return null;
  try {
    const usuarios = await findUsuarioByEmail(String(user.email || '').trim().toLowerCase());
    const locales = normalizeLocalesUsuario(usuarios[0]);
    if (tieneAlcanceGlobalLocales(user.rol, locales)) return null;
    return new Set(locales.map((l) => String(l).trim().toLowerCase()));
  } catch (err) {
    console.error('[escandallos localesPermitidosDelUsuario]', err.message || err);
    return new Set();
  }
}

router.get('/escandallos', requirePermission('escandallos.ver'), async (req, res) => {
  const conIngredientes = String(req.query.conIngredientes || '') === '1';
  const recetas = conIngredientes ? await listRecetasConIngredientes() : await listRecetas();
  return res.json({ recetas, total: recetas.length });
});

/** Rutas estáticas ANTES de /:productoId */
router.get('/escandallos/compras-contexto', requirePermission('escandallos.ver'), async (req, res) => {
  const raw = String(req.query.productIds ?? '').trim();
  if (!raw) {
    return res.status(400).json({ error: 'productIds es obligatorio' });
  }
  const productIds = [...new Set(raw.split(',').map((s) => normalizeProductId(s)).filter(Boolean))];
  if (!productIds.length) {
    return res.status(400).json({ error: 'productIds inválidos' });
  }
  if (productIds.length > COMPRAS_CONTEXTO_MAX) {
    return res.status(400).json({ error: `Máximo ${COMPRAS_CONTEXTO_MAX} productIds` });
  }
  const warehouseId = req.query.warehouseId != null ? String(req.query.warehouseId).trim() : '';
  const map = await queryUltimaCompraPorProductos(productIds, {
    warehouseId: warehouseId || undefined,
  });
  /** @type {Record<string, object>} */
  const items = {};
  for (const pid of productIds) {
    const row = map.get(pid);
    if (!row) continue;
    items[pid] = {
      proveedorId: row.SupplierId || '',
      proveedorNombre: row.SupplierName || '',
      formatoNombre: row.PurchaseUnitName || '',
      purchaseUnitId: row.PurchaseUnitId || '',
      precio: row.Price,
      fecha: row.AlbaranFecha || null,
    };
  }
  return res.json({ items });
});

/**
 * Locales del almacén (o todos si no se pasa warehouseId) + tarifa de venta de cada local.
 * La tarifa viene del mapa manual local → centro de venta (PK='LOCAL_TARIFA',
 * se edita con PUT /agora/locales-tarifa); el nombre del centro se lee de
 * PK='SALECENTER'. `sinAsignar: true` = local sin centro de venta asignado.
 * Requiere sync de centros de venta (POST /agora/sale-centers/sync) y de
 * productos Ágora (Prices por PriceListId).
 */
router.get('/escandallos/almacen-contexto', requirePermission('escandallos.ver'), async (req, res) => {
  // warehouseId es opcional: sin él se devuelven todos los locales.
  const warehouseIdRaw = req.query.warehouseId != null ? String(req.query.warehouseId).trim() : '';
  let warehouseId = null;
  if (warehouseIdRaw !== '') {
    warehouseId = normalizeWarehouseId(warehouseIdRaw);
    if (!warehouseId || warehouseId === '000000') {
      return res.status(400).json({ error: 'warehouseId inválido' });
    }
  }
  const [mapa, localesOk] = await Promise.all([
    buildMapaLocalAlmacen(),
    localesPermitidosDelUsuario(req.user),
  ]);
  let localesBase = mapa.locales;
  if (warehouseId) {
    const localIds = mapa.porWarehouseId[warehouseId] || [];
    const localesById = new Map(mapa.locales.map((l) => [l.id, l]));
    localesBase = localIds
      .map((id) => localesById.get(id))
      .filter(Boolean);
  }
  // Con y sin warehouseId: el usuario solo ve sus locales (comparación por nombre).
  if (localesOk != null) {
    localesBase = localesBase.filter((l) => localesOk.has(String(l?.nombre ?? '').trim().toLowerCase()));
  }

  const [asignaciones, centros] = await Promise.all([
    listLocalesTarifa(docClient, tables.saleCenters),
    listCentrosVenta(docClient, tables.saleCenters),
  ]);
  const centroPorId = new Map(
    centros.map((c) => [String(c.SK ?? c.Id ?? '').trim(), c]),
  );
  const asignPorLocal = new Map(
    asignaciones.map((a) => [String(a.localId ?? a.SK ?? '').trim(), a]),
  );

  const locales = localesBase.map((l) => {
    const asign = asignPorLocal.get(l.id);
    const saleCenterId =
      asign?.saleCenterId != null ? String(asign.saleCenterId).trim() : '';
    const centro = saleCenterId ? centroPorId.get(saleCenterId) : null;
    // Tarifa actual del centro; el valor guardado en la asignación es el fallback.
    const priceListId =
      pickPriceListId(centro) ??
      (asign?.priceListId != null && String(asign.priceListId).trim() !== ''
        ? String(asign.priceListId)
        : null);
    return {
      id: l.id,
      nombre: l.nombre,
      agoraCode: l.agoraCode || '',
      warehouseIds: Array.isArray(l.warehouseIds) ? l.warehouseIds : [],
      priceListId,
      saleCenterNombre: centro?.Nombre != null ? String(centro.Nombre).trim() : '',
      sinAsignar: !saleCenterId,
    };
  });

  const almacenes = (mapa.almacenes || []).map((a) => ({
    id: a.id,
    nombre: a.nombre,
  }));
  return res.json({ warehouseId, almacenes, locales });
});

router.get('/escandallos/:productoId', requirePermission('escandallos.ver'), async (req, res) => {
  const productoId = normalizeProductId(req.params.productoId);
  if (!productoId) {
    return res.status(400).json({ error: 'productoId es obligatorio' });
  }
  const receta = await getReceta(productoId);
  if (!receta) {
    return res.status(404).json({ error: 'Receta no encontrada', productoId });
  }
  return res.json({
    productoId: receta.meta.productoId,
    nombre: receta.meta.nombre,
    udReceta: receta.meta.udReceta,
    activo: receta.meta.activo,
    imagen_key: receta.meta.imagen_key || '',
    updatedAt: receta.meta.updatedAt,
    ingredientes: receta.ingredientes,
  });
});

router.put('/escandallos/:productoId', requirePermission('escandallos.editar'), async (req, res) => {
  const productoId = normalizeProductId(req.params.productoId);
  if (!productoId) {
    return res.status(400).json({ error: 'productoId es obligatorio' });
  }
  const body = req.body || {};
  if (body.ingredientes != null && !Array.isArray(body.ingredientes)) {
    return res.status(400).json({ error: 'ingredientes debe ser un array' });
  }
  try {
    const saved = await putReceta(productoId, body);
    return res.json({
      ok: true,
      productoId: saved.meta.productoId,
      nombre: saved.meta.nombre,
      udReceta: saved.meta.udReceta,
      activo: saved.meta.activo,
      imagen_key: saved.meta.imagen_key || '',
      updatedAt: saved.meta.updatedAt,
      ingredientes: saved.ingredientes,
    });
  } catch (err) {
    const status = err?.status || 400;
    return res.status(status).json({
      error: err?.message || 'Datos inválidos',
      ...(err?.code ? { code: err.code } : {}),
    });
  }
});

router.post(
  '/escandallos/:productoId/imagen',
  requirePermission('escandallos.editar'),
  upload.single('file'),
  async (req, res) => {
    const productoId = normalizeProductId(req.params.productoId);
    if (!productoId) {
      return res.status(400).json({ error: 'productoId es obligatorio' });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Falta archivo (field: file)' });
    }
    try {
      const ext = (req.file.originalname || 'img').match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] || 'jpg';
      const key = `escandallos/${productoId}/${Date.now()}_${uuid().slice(0, 8)}.${ext}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype || 'image/jpeg',
        }),
      );
      await setImagenKey(productoId, key);
      return res.json({ ok: true, imagen_key: key });
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({
        error: err?.message || 'Error al subir imagen',
        ...(err?.code ? { code: err.code } : {}),
      });
    }
  },
);

router.get('/escandallos/:productoId/imagen-url', requirePermission('escandallos.ver'), async (req, res) => {
  const productoId = normalizeProductId(req.params.productoId);
  if (!productoId) {
    return res.status(400).json({ error: 'productoId es obligatorio' });
  }
  const receta = await getReceta(productoId);
  if (!receta) {
    return res.status(404).json({ error: 'Receta no encontrada', productoId });
  }
  const key = receta.meta.imagen_key;
  if (!key) {
    return res.json({ url: null, expiresIn: PRESIGN_EXPIRES });
  }
  const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: String(key) });
  const url = await getSignedUrl(s3, cmd, { expiresIn: PRESIGN_EXPIRES });
  return res.json({ url, expiresIn: PRESIGN_EXPIRES });
});

router.delete('/escandallos/:productoId/imagen', requirePermission('escandallos.editar'), async (req, res) => {
  const productoId = normalizeProductId(req.params.productoId);
  if (!productoId) {
    return res.status(400).json({ error: 'productoId es obligatorio' });
  }
  try {
    const result = await setImagenKey(productoId, null);
    return res.json({ ok: true, productoId: result.productoId, imagen_key: null });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || 'Error al borrar imagen',
      ...(err?.code ? { code: err.code } : {}),
    });
  }
});

router.delete('/escandallos/:productoId', requirePermission('escandallos.editar'), async (req, res) => {
  const productoId = normalizeProductId(req.params.productoId);
  if (!productoId) {
    return res.status(400).json({ error: 'productoId es obligatorio' });
  }
  const result = await deleteReceta(productoId);
  return res.json(result);
});

export default router;
