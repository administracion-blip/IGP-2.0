/**
 * Facturación mensual del almacén: la venta de la mercancía interna y el abono
 * del rappel.
 *
 * Router propio y no dentro de `pedidos.js` porque son dos cosas distintas: allí
 * vive el CRUD operativo del pedido (crearlo, prepararlo, completarlo) y aquí un
 * proceso contable que produce documentos fiscales, con su permiso, su cerrojo y
 * su trabajo programado. Meterlo en el router de pedidos, que ya pasa de las
 * 1200 líneas, mezclaría el día a día del almacén con la facturación del mes.
 *
 * Los dos flujos comparten router porque comparten dominio (el pedido), permiso
 * y configuración, pero **no** proceso: cada uno tiene su cerrojo, su serie y su
 * marca en el pedido, así que se lanzan por separado.
 *
 * La lógica vive en `api/lib/facturacion/facturarVentasInternas.js` y
 * `api/lib/facturacion/facturarRappel.js` porque la comparten el trabajo
 * programado y los scripts de ensayo, igual que en mantenimiento.
 */

import express from 'express';
import { requirePermission } from '../middleware/auth.js';
import {
  previsualizarFacturacionVentasInternas,
  generarFacturacionVentasInternas,
} from '../lib/facturacion/facturarVentasInternas.js';
import {
  previsualizarFacturacionRappel,
  generarFacturacionRappel,
} from '../lib/facturacion/facturarRappel.js';

const router = express.Router();

/** Qué se facturaría del periodo, sin escribir nada. Por defecto, el mes anterior. */
router.get(
  '/compras/facturacion/previsualizar',
  requirePermission('compras.facturar'),
  async (req, res) => {
    const periodo = (req.query.periodo ?? '').toString().trim();
    const r = await previsualizarFacturacionVentasInternas({ periodo });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    return res.json(r);
  }
);

/**
 * Genera las facturas del periodo en borrador. Si el periodo ya tenía factura
 * entre las dos sociedades, se crea otra aparte: nunca se añaden líneas a un
 * borrador existente, porque el usuario puede estar editándolo y su guardado
 * reescribe todas las líneas.
 */
router.post(
  '/compras/facturacion/generar',
  requirePermission('compras.facturar'),
  async (req, res) => {
    const body = req.body || {};
    const periodo = (body.periodo ?? '').toString().trim();
    const r = await generarFacturacionVentasInternas({
      periodo,
      usuario_id: (req.user?.sub ?? '').toString(),
      usuario_nombre: (req.user?.Nombre ?? req.user?.email ?? '').toString(),
      origen: req.isInternal ? 'automatico' : 'manual',
    });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    return res.json(r);
  }
);

// ─── Abonos de rappel ───

/** Qué se abonaría de rappel del periodo, sin escribir nada. */
router.get(
  '/compras/facturacion/rappel/previsualizar',
  requirePermission('compras.facturar'),
  async (req, res) => {
    const periodo = (req.query.periodo ?? '').toString().trim();
    const r = await previsualizarFacturacionRappel({ periodo });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    return res.json(r);
  }
);

/**
 * Genera los abonos de rappel del periodo en borrador, con importes negativos.
 * Mismo criterio que las ventas: si el periodo ya tenía abono entre las dos
 * sociedades se crea otro aparte, nunca se añaden líneas a un borrador existente.
 */
router.post(
  '/compras/facturacion/rappel/generar',
  requirePermission('compras.facturar'),
  async (req, res) => {
    const body = req.body || {};
    const periodo = (body.periodo ?? '').toString().trim();
    const r = await generarFacturacionRappel({
      periodo,
      usuario_id: (req.user?.sub ?? '').toString(),
      usuario_nombre: (req.user?.Nombre ?? req.user?.email ?? '').toString(),
      origen: req.isInternal ? 'automatico' : 'manual',
    });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    return res.json(r);
  }
);

export default router;
