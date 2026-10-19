/**
 * Previsión de ventas por franjas.
 *
 * - POST /prevision-franjas/calcular: previsión por local/día/franja a partir de la
 *   venta por hora de la fecha comparativa (festivos o mismo día del año anterior).
 * - /prevision-franjas/escenarios: escenarios guardados (propios o globales).
 * - POST /prevision-franjas/ventas-hora/sync: rellena Igp_VentasHora (manual o planificador).
 */
import { Router } from 'express';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { requireLocales, requireAlcanceGlobal, desde } from '../middleware/alcance.js';
import { cargarAlcance, intersecarLocales } from '../lib/alcance.js';
import { responderError } from '../lib/http/responderError.js';
import { validarPeticionCalculo, calcularPrevision, MAX_LOCALES } from '../lib/prevision/calcular.js';
import {
  AMBITOS,
  normalizarAmbito,
  normalizarIdEscenario,
  validarDatosEscenario,
  listarEscenarios,
  crearEscenario,
  actualizarEscenario,
  borrarEscenario,
} from '../lib/prevision/escenarios.js';
import { sincronizarVentasHora, validarRangoSync } from '../lib/agora/ventasHoraSync.js';

const router = Router();

const permisoVer = requirePermission('prevision.ver');
const PERMISO_ESCENARIOS_GLOBALES = 'prevision.escenarios_globales';

router.post(
  '/prevision-franjas/calcular',
  permisoVer,
  requireLocales(desde.body('workplaceIds'), { obligatorio: true }),
  async (req, res) => {
    try {
      const peticion = validarPeticionCalculo(req.body);
      const workplaceIds = req.alcanceLocales;
      if (!workplaceIds.length) return res.status(400).json({ error: 'workplaceIds es obligatorio' });
      if (workplaceIds.length > MAX_LOCALES) {
        return res.status(400).json({ error: `No se pueden pedir más de ${MAX_LOCALES} locales` });
      }
      return res.json(await calcularPrevision({ workplaceIds, peticion }));
    } catch (err) {
      return responderError(res, err, { mensaje: 'No se pudo calcular la previsión' });
    }
  },
);

// ─── Escenarios ───

/** Escribir en el ámbito global exige además `prevision.escenarios_globales`. */
async function asegurarEscrituraAmbito(user, ambito) {
  if (ambito !== AMBITOS.GLOBAL) return;
  if (await hasPermission(user, PERMISO_ESCENARIOS_GLOBALES)) return;
  throw Object.assign(new Error('No tienes permiso para gestionar escenarios globales'), { status: 403 });
}

router.get('/prevision-franjas/escenarios', permisoVer, async (req, res) => {
  try {
    const alcance = await cargarAlcance(req);
    const escenarios = (await listarEscenarios(req.user)).map((e) => (
      alcance.global ? e : { ...e, workplaceIds: intersecarLocales(alcance, e.workplaceIds) }
    ));
    return res.json({ escenarios });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudieron cargar los escenarios' });
  }
});

router.post('/prevision-franjas/escenarios', permisoVer, async (req, res) => {
  try {
    const ambito = normalizarAmbito(req.body?.ambito);
    const datos = validarDatosEscenario(req.body);
    await asegurarEscrituraAmbito(req.user, ambito);
    return res.status(201).json({ escenario: await crearEscenario(req.user, ambito, datos) });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo guardar el escenario' });
  }
});

router.put('/prevision-franjas/escenarios', permisoVer, async (req, res) => {
  try {
    const ambito = normalizarAmbito(req.body?.ambito);
    const id = normalizarIdEscenario(req.body?.id);
    const datos = validarDatosEscenario(req.body);
    await asegurarEscrituraAmbito(req.user, ambito);
    return res.json({ escenario: await actualizarEscenario(req.user, ambito, id, datos) });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo actualizar el escenario' });
  }
});

router.delete('/prevision-franjas/escenarios', permisoVer, async (req, res) => {
  try {
    const ambito = normalizarAmbito(req.query?.ambito ?? req.body?.ambito);
    const id = normalizarIdEscenario(req.query?.id ?? req.body?.id);
    await asegurarEscrituraAmbito(req.user, ambito);
    await borrarEscenario(req.user, ambito, id);
    return res.json({ ok: true, id, ambito });
  } catch (err) {
    return responderError(res, err, { mensaje: 'No se pudo borrar el escenario' });
  }
});

// ─── Sincronización Igp_VentasHora ───

router.post(
  '/prevision-franjas/ventas-hora/sync',
  requirePermission('ajustes.sincronizaciones.ventas_hora'),
  requireAlcanceGlobal(),
  async (req, res) => {
    try {
      const fechaDesde = String(req.body?.fechaDesde ?? '').trim();
      const fechaHasta = String(req.body?.fechaHasta ?? '').trim();
      validarRangoSync(fechaDesde, fechaHasta);
      const bruto = req.body?.workplaceIds;
      if (bruto != null && (!Array.isArray(bruto) || bruto.length > MAX_LOCALES)) {
        return res.status(400).json({ error: `workplaceIds debe ser una lista de hasta ${MAX_LOCALES} locales` });
      }
      const resultado = await sincronizarVentasHora({
        fechaDesde,
        fechaHasta,
        workplaceIds: bruto,
        force: req.body?.force === true,
      });
      return res.json(resultado);
    } catch (err) {
      return responderError(res, err, { mensaje: 'No se pudo sincronizar la venta por hora' });
    }
  },
);

export default router;
