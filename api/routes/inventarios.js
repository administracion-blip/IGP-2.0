/**
 * Inventarios. IGP no escribe el inventario en Ágora: el Excel lo importa una persona.
 *
 * inventario.gestionar — plantillas, cabecera, estados y borrado.
 * inventario.contar — crear el conteo, anotar líneas y pasarlo a «contado».
 */
import { Router } from 'express';
import { hasPermission, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { exportStocks } from '../lib/agora/client.js';
import { permiteAlmacen } from '../lib/alcanceAlmacenes.js';
import { listFamiliasMia } from '../lib/mia/gruposFamilias.js';
import { responderError } from '../lib/http/responderError.js';
import {
  actualizarPlantilla,
  borrarPlantilla,
  crearPlantilla,
  listarPlantillas,
  obtenerPlantilla,
} from '../lib/inventarios/plantillas.js';
import {
  actualizarCabecera,
  borrarInventario,
  borrarLinea,
  anotarExportacion,
  cambiarEstado,
  crearInventario,
  guardarLinea,
  listarInventarios,
  obtenerInventario,
  ultimoImportado,
} from '../lib/inventarios/inventarios.js';
import { abrirConteo, anadirProducto } from '../lib/inventarios/conteo.js';
import { bufferInventario } from '../lib/inventarios/excel.js';
import { guardarUmbral, leerUmbral } from '../lib/inventarios/umbral.js';
import { listarProductosInventario } from '../lib/inventarios/productos.js';
import {
  borrarFoto,
  confirmarFoto,
  listarFotos,
  prepararFoto,
} from '../lib/inventarios/fotos.js';

const router = Router();

const ver = requireAnyPermission('inventario.gestionar', 'inventario.contar');
const gestionar = requirePermission('inventario.gestionar');

function quien(req) {
  const email = req.user?.email || req.user?.sub || '';
  const nombre = String(req.user?.Nombre || '').trim();
  if (nombre && email && nombre !== email) return `${nombre} (${email})`;
  return email;
}

async function puedeGestionar(req) {
  if (req.isInternal || req.user?.rol === 'Administrador') return true;
  return hasPermission(req.user, 'inventario.gestionar');
}

async function conAlmacen(req, res, warehouseId) {
  if (!(await permiteAlmacen(req, warehouseId))) {
    res.status(403).json({ error: 'Sin acceso a este almacén' });
    return false;
  }
  return true;
}

function atrapar(res, err, mensaje) {
  return responderError(res, err, { mensaje, statusPorDefecto: 400 });
}

/** Quien solo cuenta no recibe el stock teórico. */
function sinTeorico(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload.lineas)) {
    return {
      ...payload,
      lineas: payload.lineas.map((ln) => {
        if (!ln || typeof ln !== 'object') return ln;
        const { stockTeorico, ...resto } = ln;
        return resto;
      }),
    };
  }
  if ('stockTeorico' in payload) {
    const { stockTeorico, ...resto } = payload;
    return resto;
  }
  return payload;
}

async function responderConteo(req, res, payload, status = 200) {
  const gestiona = await puedeGestionar(req);
  return res.status(status).json(gestiona ? payload : sinTeorico(payload));
}

router.get('/inventarios/umbral', gestionar, async (req, res) => {
  try {
    return res.json(await leerUmbral());
  } catch (err) {
    return atrapar(res, err, 'Error leyendo el umbral');
  }
});

router.put('/inventarios/umbral', gestionar, async (req, res) => {
  try {
    return res.json(await guardarUmbral(req.body?.porcentaje, quien(req)));
  } catch (err) {
    return atrapar(res, err, 'Error guardando el umbral');
  }
});

router.get('/inventarios/familias', gestionar, async (req, res) => {
  try {
    const result = await listFamiliasMia();
    return res.json(result);
  } catch (err) {
    return atrapar(res, err, 'Error listando familias');
  }
});

router.get('/inventarios/productos', ver, async (req, res) => {
  try {
    const productos = await listarProductosInventario({ todos: true });
    return res.json({
      productos: productos.map((p) => ({
        productId: p.productId,
        nombre: p.nombre,
        familiaNombre: p.familiaNombre,
      })),
    });
  } catch (err) {
    return atrapar(res, err, 'Error listando productos');
  }
});

router.get('/inventarios/plantillas', ver, async (req, res) => {
  try {
    const plantillas = await listarPlantillas();
    return res.json({ plantillas });
  } catch (err) {
    return atrapar(res, err, 'Error listando plantillas');
  }
});

router.get('/inventarios/plantillas/:id', ver, async (req, res) => {
  try {
    return res.json(await obtenerPlantilla(req.params.id));
  } catch (err) {
    return atrapar(res, err, 'Error leyendo la plantilla');
  }
});

router.post('/inventarios/plantillas', gestionar, async (req, res) => {
  try {
    const plantilla = await crearPlantilla(req.body || {}, quien(req));
    return res.status(201).json(plantilla);
  } catch (err) {
    return atrapar(res, err, 'Error creando la plantilla');
  }
});

router.put('/inventarios/plantillas/:id', gestionar, async (req, res) => {
  try {
    const plantilla = await actualizarPlantilla(req.params.id, req.body || {}, quien(req));
    return res.json(plantilla);
  } catch (err) {
    return atrapar(res, err, 'Error actualizando la plantilla');
  }
});

router.delete('/inventarios/plantillas/:id', gestionar, async (req, res) => {
  try {
    return res.json(await borrarPlantilla(req.params.id));
  } catch (err) {
    return atrapar(res, err, 'Error borrando la plantilla');
  }
});

router.get('/inventarios/ultimo', ver, async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId;
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId es obligatorio' });
    if (!(await conAlmacen(req, res, warehouseId))) return;
    return res.json(await ultimoImportado(warehouseId));
  } catch (err) {
    return atrapar(res, err, 'Error leyendo el último inventario importado');
  }
});

router.get('/inventarios', ver, async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId;
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId es obligatorio' });
    if (!(await conAlmacen(req, res, warehouseId))) return;
    const inventarios = await listarInventarios(warehouseId);
    return res.json({ inventarios });
  } catch (err) {
    return atrapar(res, err, 'Error listando inventarios');
  }
});

router.post('/inventarios/conteo', ver, async (req, res) => {
  try {
    if (!(await conAlmacen(req, res, req.body?.warehouseId))) return;
    const inventario = await abrirConteo(req.body || {}, quien(req), { exportStocks });
    return responderConteo(req, res, inventario, 201);
  } catch (err) {
    return atrapar(res, err, 'Error abriendo el conteo');
  }
});

router.post('/inventarios', ver, async (req, res) => {
  try {
    if (!(await conAlmacen(req, res, req.body?.warehouseId))) return;
    const inventario = await crearInventario(req.body || {}, quien(req));
    return responderConteo(req, res, inventario, 201);
  } catch (err) {
    return atrapar(res, err, 'Error creando el inventario');
  }
});

router.get('/inventarios/:id/excel', gestionar, async (req, res) => {
  try {
    const inventario = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, inventario.warehouseId))) return;
    if (inventario.estado !== 'revisado' && inventario.estado !== 'exportado') {
      return res.status(409).json({ error: 'Solo se exporta un inventario revisado' });
    }
    if (inventario.estado === 'exportado' && req.query.repetir !== '1') {
      return res.status(409).json({
        error: 'Este inventario ya se exportó. Confirma para descargarlo otra vez.',
      });
    }
    const buffer = await bufferInventario(inventario);
    const veces = inventario.estado === 'revisado' ? 1 : (Number(inventario.exportaciones) || 1) + 1;
    if (inventario.estado === 'revisado') {
      await cambiarEstado(inventario.inventarioId, 'exportado', quien(req));
    }
    await anotarExportacion(inventario.inventarioId, quien(req), veces);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Inventario-${inventario.fecha}.xlsx"`);
    return res.send(buffer);
  } catch (err) {
    return atrapar(res, err, 'Error exportando el inventario');
  }
});

router.get('/inventarios/:id', ver, async (req, res) => {
  try {
    const inventario = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, inventario.warehouseId))) return;
    return responderConteo(req, res, inventario);
  } catch (err) {
    return atrapar(res, err, 'Error leyendo el inventario');
  }
});

router.patch('/inventarios/:id', gestionar, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    const inventario = await actualizarCabecera(req.params.id, req.body || {}, quien(req));
    return responderConteo(req, res, inventario);
  } catch (err) {
    return atrapar(res, err, 'Error actualizando el inventario');
  }
});

router.patch('/inventarios/:id/estado', ver, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    const inventario = await cambiarEstado(
      req.params.id,
      req.body?.estado,
      quien(req),
      { soloContar: !(await puedeGestionar(req)) },
    );
    return responderConteo(req, res, inventario);
  } catch (err) {
    return atrapar(res, err, 'Error cambiando el estado');
  }
});

router.post('/inventarios/:id/lineas', ver, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    const linea = await anadirProducto(
      req.params.id,
      req.body?.productId,
      quien(req),
      { soloContar: !(await puedeGestionar(req)), exportStocks },
    );
    return responderConteo(req, res, linea, 201);
  } catch (err) {
    return atrapar(res, err, 'Error añadiendo el producto');
  }
});

router.get('/inventarios/:id/fotos', ver, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    return res.json({ fotos: await listarFotos(req.params.id) });
  } catch (err) {
    return atrapar(res, err, 'Error listando las fotos');
  }
});

router.post('/inventarios/:id/fotos/preparar', ver, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    const foto = await prepararFoto({ inventarioId: req.params.id, ...req.body });
    return res.status(201).json(foto);
  } catch (err) {
    return atrapar(res, err, 'Error preparando la foto');
  }
});

router.post('/inventarios/:id/fotos/confirmar', ver, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    const foto = await confirmarFoto({
      inventarioId: req.params.id,
      numero: req.body?.numero,
      posicion: req.body?.posicion,
      s3Key: req.body?.s3Key,
    }, quien(req));
    return res.status(201).json(foto);
  } catch (err) {
    return atrapar(res, err, 'Error confirmando la foto');
  }
});

router.delete('/inventarios/:id/fotos/:numero/:posicion', ver, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    return res.json(await borrarFoto({
      inventarioId: req.params.id,
      numero: req.params.numero,
      posicion: req.params.posicion,
    }));
  } catch (err) {
    return atrapar(res, err, 'Error borrando la foto');
  }
});

router.put('/inventarios/:id/lineas/:productId', ver, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    const linea = await guardarLinea(
      req.params.id,
      req.params.productId,
      req.body || {},
      quien(req),
      { soloContar: !(await puedeGestionar(req)) },
    );
    return responderConteo(req, res, linea);
  } catch (err) {
    return atrapar(res, err, 'Error guardando la línea');
  }
});

router.delete('/inventarios/:id/lineas/:productId', gestionar, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    return res.json(await borrarLinea(req.params.id, req.params.productId));
  } catch (err) {
    return atrapar(res, err, 'Error borrando la línea');
  }
});

router.delete('/inventarios/:id', gestionar, async (req, res) => {
  try {
    const actual = await obtenerInventario(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    return res.json(await borrarInventario(req.params.id));
  } catch (err) {
    return atrapar(res, err, 'Error borrando el inventario');
  }
});

export default router;
