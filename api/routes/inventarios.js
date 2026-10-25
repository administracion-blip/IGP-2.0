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
  cambiarEstado,
  crearInventario,
  guardarLinea,
  listarInventarios,
  obtenerInventario,
} from '../lib/inventarios/inventarios.js';
import { abrirConteo } from '../lib/inventarios/conteo.js';
import { guardarUmbral, leerUmbral } from '../lib/inventarios/umbral.js';

const router = Router();

const ver = requireAnyPermission('inventario.gestionar', 'inventario.contar');
const gestionar = requirePermission('inventario.gestionar');

function quien(req) {
  return req.user?.email || req.user?.sub || '';
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

router.get('/inventarios/plantillas', ver, async (req, res) => {
  try {
    const warehouseId = req.query.warehouseId;
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId es obligatorio' });
    if (!(await conAlmacen(req, res, warehouseId))) return;
    const plantillas = await listarPlantillas(warehouseId);
    return res.json({ plantillas });
  } catch (err) {
    return atrapar(res, err, 'Error listando plantillas');
  }
});

router.get('/inventarios/plantillas/:id', ver, async (req, res) => {
  try {
    const plantilla = await obtenerPlantilla(req.params.id);
    if (!(await conAlmacen(req, res, plantilla.warehouseId))) return;
    return res.json(plantilla);
  } catch (err) {
    return atrapar(res, err, 'Error leyendo la plantilla');
  }
});

router.post('/inventarios/plantillas', gestionar, async (req, res) => {
  try {
    if (!(await conAlmacen(req, res, req.body?.warehouseId))) return;
    const plantilla = await crearPlantilla(req.body || {}, quien(req));
    return res.status(201).json(plantilla);
  } catch (err) {
    return atrapar(res, err, 'Error creando la plantilla');
  }
});

router.put('/inventarios/plantillas/:id', gestionar, async (req, res) => {
  try {
    const actual = await obtenerPlantilla(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    const plantilla = await actualizarPlantilla(req.params.id, req.body || {}, quien(req));
    return res.json(plantilla);
  } catch (err) {
    return atrapar(res, err, 'Error actualizando la plantilla');
  }
});

router.delete('/inventarios/plantillas/:id', gestionar, async (req, res) => {
  try {
    const actual = await obtenerPlantilla(req.params.id);
    if (!(await conAlmacen(req, res, actual.warehouseId))) return;
    return res.json(await borrarPlantilla(req.params.id));
  } catch (err) {
    return atrapar(res, err, 'Error borrando la plantilla');
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
