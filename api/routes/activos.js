/**
 * Módulo Activos (Fase 1). Inventario, etiquetas, fotos e historial.
 * Permisos: activos.ver | crear | editar | borrar
 */

import { Router } from 'express';
import { requirePermission, requireAnyPermission } from '../middleware/auth.js';
import {
  bajaCategoria,
  bajaModelo,
  bajaPlantilla,
  borrarFoto,
  borrarFotoModelo,
  cambiarEstado,
  confirmarFoto,
  confirmarFotoModelo,
  crearActivo,
  crearActivosLote,
  crearCategoria,
  crearModelo,
  crearPlantilla,
  darDeBaja,
  devolverActivos,
  editarActivo,
  entregarActivos,
  editarCategoria,
  editarModelo,
  editarPlantilla,
  getFicha,
  marcarImpresas,
  marcarPerdido,
  presignFoto,
  presignFotoModelo,
  previewEtiquetas,
  previewPlantillaCuerpo,
  resolverActivo,
  servicioEventos,
  servicioGetModelo,
  servicioGetPlantilla,
  servicioCustodias,
  servicioListarActivos,
  servicioListarCategorias,
  servicioListarModelos,
  servicioListarPlantillas,
  servicioPendientes,
  servicioStockModelo,
  sustituirUnidad,
  trasladarActivo,
  urlFoto,
  verificarEtiqueta,
} from '../lib/activos/servicio.js';

const router = Router();

function userDe(req) {
  return req.user;
}

// ─── Catálogo ───

router.get(
  '/activos/categorias',
  requireAnyPermission('activos.ver', 'activos.crear', 'activos.editar'),
  async (req, res) => {
    res.json(await servicioListarCategorias(req.query));
  },
);

router.post('/activos/categorias', requirePermission('activos.crear'), async (req, res) => {
  res.status(201).json(await crearCategoria(userDe(req), req.body));
});

router.patch('/activos/categorias/:id', requirePermission('activos.editar'), async (req, res) => {
  res.json(await editarCategoria(userDe(req), req.params.id, req.body));
});

router.post('/activos/categorias/:id/baja', requirePermission('activos.borrar'), async (req, res) => {
  res.json(await bajaCategoria(userDe(req), req.params.id));
});

router.get(
  '/activos/modelos',
  requireAnyPermission('activos.ver', 'activos.crear', 'activos.editar'),
  async (req, res) => {
    res.json(await servicioListarModelos(req.query));
  },
);

router.get(
  '/activos/modelos/:id',
  requireAnyPermission('activos.ver', 'activos.crear', 'activos.editar'),
  async (req, res) => {
    res.json(await servicioGetModelo(req.params.id));
  },
);

router.get('/activos/modelos/:id/stock', requirePermission('activos.ver'), async (req, res) => {
  res.json(await servicioStockModelo(userDe(req), req.params.id));
});

router.post('/activos/modelos', requirePermission('activos.crear'), async (req, res) => {
  res.status(201).json(await crearModelo(userDe(req), req.body));
});

router.patch('/activos/modelos/:id', requirePermission('activos.editar'), async (req, res) => {
  res.json(await editarModelo(userDe(req), req.params.id, req.body));
});

router.post('/activos/modelos/:id/fotos/presign', requireAnyPermission('activos.crear', 'activos.editar'), async (req, res) => {
  res.json(await presignFotoModelo(userDe(req), req.params.id, req.body));
});

router.post('/activos/modelos/:id/fotos', requireAnyPermission('activos.crear', 'activos.editar'), async (req, res) => {
  res.status(201).json(await confirmarFotoModelo(userDe(req), req.params.id, req.body));
});

router.delete('/activos/modelos/:id/fotos', requirePermission('activos.editar'), async (req, res) => {
  res.json(await borrarFotoModelo(userDe(req), req.params.id));
});

router.post('/activos/modelos/:id/baja', requirePermission('activos.borrar'), async (req, res) => {
  res.json(await bajaModelo(userDe(req), req.params.id));
});

router.get(
  '/activos/plantillas',
  requireAnyPermission('activos.ver', 'activos.crear', 'activos.editar'),
  async (req, res) => {
    res.json(await servicioListarPlantillas(req.query));
  },
);

router.get(
  '/activos/plantillas/:id',
  requireAnyPermission('activos.ver', 'activos.crear', 'activos.editar'),
  async (req, res) => {
    res.json(await servicioGetPlantilla(req.params.id));
  },
);

router.post('/activos/plantillas/preview', requireAnyPermission('activos.ver', 'activos.editar', 'activos.crear'), async (req, res) => {
  res.json(previewPlantillaCuerpo(req.body));
});

router.post('/activos/plantillas', requirePermission('activos.crear'), async (req, res) => {
  res.status(201).json(await crearPlantilla(userDe(req), req.body));
});

router.patch('/activos/plantillas/:id', requirePermission('activos.editar'), async (req, res) => {
  res.json(await editarPlantilla(userDe(req), req.params.id, req.body));
});

router.post('/activos/plantillas/:id/baja', requirePermission('activos.borrar'), async (req, res) => {
  res.json(await bajaPlantilla(userDe(req), req.params.id));
});

// ─── Consultas estáticas (antes de :assetId) ───

router.get('/activos/pendientes-verificacion', requirePermission('activos.ver'), async (req, res) => {
  res.json(await servicioPendientes(userDe(req), req.query));
});

router.get('/activos/resolver/:assetId', requirePermission('activos.ver'), async (req, res) => {
  res.json(await resolverActivo(userDe(req), req.params.assetId));
});

router.get('/activos/custodia', requirePermission('activos.ver'), async (req, res) => {
  res.json(await servicioCustodias(userDe(req), req.query));
});

router.post('/activos/entregas', requirePermission('activos.editar'), async (req, res) => {
  res.status(201).json(await entregarActivos(userDe(req), req.body));
});

router.post('/activos/devoluciones', requirePermission('activos.editar'), async (req, res) => {
  res.json(await devolverActivos(userDe(req), req.body));
});

router.get('/activos', requirePermission('activos.ver'), async (req, res) => {
  res.json(await servicioListarActivos(userDe(req), req.query));
});

router.post('/activos/lote', requirePermission('activos.crear'), async (req, res) => {
  res.status(201).json(await crearActivosLote(userDe(req), req.body));
});

router.post('/activos', requirePermission('activos.crear'), async (req, res) => {
  res.status(201).json(await crearActivo(userDe(req), req.body));
});

router.post('/activos/etiquetas/preview', requirePermission('activos.editar'), async (req, res) => {
  res.json(await previewEtiquetas(userDe(req), req.body?.asset_ids));
});

router.post('/activos/etiquetas/impresa', requirePermission('activos.editar'), async (req, res) => {
  res.json(await marcarImpresas(userDe(req), req.body?.asset_ids));
});

router.get('/activos/:assetId', requirePermission('activos.ver'), async (req, res) => {
  res.json(await getFicha(userDe(req), req.params.assetId));
});

router.patch('/activos/:assetId', requirePermission('activos.editar'), async (req, res) => {
  res.json(await editarActivo(userDe(req), req.params.assetId, req.body));
});

router.post('/activos/:assetId/traslado', requirePermission('activos.editar'), async (req, res) => {
  res.json(await trasladarActivo(userDe(req), req.params.assetId, req.body));
});

router.post('/activos/:assetId/estado', requirePermission('activos.editar'), async (req, res) => {
  res.json(await cambiarEstado(userDe(req), req.params.assetId, req.body));
});

router.post('/activos/:assetId/baja', requirePermission('activos.borrar'), async (req, res) => {
  res.json(await darDeBaja(userDe(req), req.params.assetId, req.body));
});

router.post('/activos/:assetId/perdido', requirePermission('activos.editar'), async (req, res) => {
  res.json(await marcarPerdido(userDe(req), req.params.assetId, req.body));
});

router.post('/activos/:assetId/sustitucion', requirePermission('activos.editar'), async (req, res) => {
  res.json(await sustituirUnidad(userDe(req), req.params.assetId, req.body));
});

router.get('/activos/:assetId/eventos', requirePermission('activos.ver'), async (req, res) => {
  res.json(await servicioEventos(userDe(req), req.params.assetId, req.query));
});

router.post('/activos/:assetId/fotos/presign', requireAnyPermission('activos.crear', 'activos.editar'), async (req, res) => {
  res.json(await presignFoto(userDe(req), req.params.assetId, req.body));
});

router.post('/activos/:assetId/fotos', requireAnyPermission('activos.crear', 'activos.editar'), async (req, res) => {
  res.status(201).json(await confirmarFoto(userDe(req), req.params.assetId, req.body));
});

router.delete('/activos/:assetId/fotos/:fotoId', requirePermission('activos.editar'), async (req, res) => {
  res.json(await borrarFoto(userDe(req), req.params.assetId, req.params.fotoId));
});

router.get('/activos/:assetId/fotos/:fotoId/url', requirePermission('activos.ver'), async (req, res) => {
  res.json(await urlFoto(userDe(req), req.params.assetId, req.params.fotoId));
});

router.post('/activos/:assetId/etiqueta/verificar', requirePermission('activos.editar'), async (req, res) => {
  res.json(await verificarEtiqueta(userDe(req), req.params.assetId));
});

export default router;
