/**
 * Banca — conciliación de movimientos bancarios con facturas.
 *
 * Router aparte de `routes/banca.js` (importación de extractos y consulta de
 * movimientos) porque son dos fases distintas del módulo y aquí se cruza con
 * facturación: los permisos y los errores no son los mismos. Se monta en el
 * mismo prefijo `/api`.
 *
 * Aquí solo se validan la petición y los permisos y se traduce el resultado a
 * HTTP: el criterio de emparejamiento vive en `lib/banca/conciliacion/motor.js`
 * y la aplicación de pagos en `lib/banca/conciliacion/aplicar.js`.
 *
 * Permisos:
 * - Ver sugerencias: `banca.ver` (es una consulta).
 * - Aplicar y deshacer: `facturacion.cobrar_pagar`, porque el efecto real es
 *   crear o borrar un pago de factura. Que alguien pueda mirar el banco no debe
 *   permitirle mover el saldo de una factura.
 * - Descartar sugerencia e ignorar movimiento: `banca.importar` o
 *   `facturacion.cobrar_pagar`. Son escrituras sobre el movimiento —no sobre
 *   facturas— y `banca.importar` es el permiso de escritura del módulo; se
 *   admite también a quien puede pagar para que el flujo de conciliar y
 *   descartar lo pueda hacer una sola persona.
 */

import { Router } from 'express';
import { requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { limpiarIban } from '../lib/remesas/iban.js';
import { empresasPermitidasDelUsuario, facturaEmisorPermitido } from '../lib/usuarioLocales.js';
import { sugerirConciliaciones } from '../lib/banca/conciliacion/motor.js';
import { centimosAEuro } from '../lib/banca/conciliacion/estado.js';
import {
  getFactura,
  listarFacturasElegibles,
  listarMovimientosAbiertos,
  normalizarLimiteBarrido,
} from '../lib/banca/conciliacion/store.js';
import {
  HTTP_POR_CODIGO,
  aplicarConciliacion,
  descartarSugerenciaMovimiento,
  deshacerConciliacion,
  ignorarMovimiento,
} from '../lib/banca/conciliacion/aplicar.js';

const router = Router();

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS = new Set(['IN', 'OUT']);

function fechaOpcional(valor) {
  const v = String(valor || '').trim();
  return RE_FECHA.test(v) ? v : '';
}

function esVerdadero(valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'si' || v === 'sí';
}

/** Usuario para la auditoría: el id sale del token; el nombre visible, si lo hay. */
function usuarioDeReq(req) {
  return {
    id: req.user?.sub || req.user?.id_usuario || '',
    nombre: req.user?.Nombre || req.user?.email || '',
  };
}

/**
 * [SEC S-08] Dependencias de la capa de aplicación con el alcance de sociedades
 * del usuario ya metido dentro.
 *
 * Va por `getFactura` —la única puerta por la que aplicar y deshacer leen
 * facturas— en vez de por una comprobación suelta en cada endpoint: así una
 * factura fuera de alcance simplemente no existe para el usuario, que es
 * exactamente lo que responde facturación (404 «Factura no encontrada»), y no
 * hay que tocar la forma de `deps` ni repetir el filtro por cada camino.
 */
async function depsConAlcance(req) {
  const empresasOk = await empresasPermitidasDelUsuario(req.user);
  if (empresasOk == null) return {};
  return {
    async getFactura(idFactura) {
      const factura = await getFactura(idFactura);
      return factura && facturaEmisorPermitido(factura, empresasOk) ? factura : null;
    },
  };
}

/** Identificación del movimiento, común a los cuatro endpoints de escritura. */
function movimientoDeBody(body) {
  return {
    cuentaRef: limpiarIban(body?.cuentaRef) || String(body?.cuentaRef || '').trim(),
    movementHash: String(body?.movementHash || '').trim(),
    fechaOperacion: fechaOpcional(body?.fechaOperacion),
  };
}

function faltaMovimiento(res, { cuentaRef, movementHash }) {
  if (!cuentaRef || !movementHash) {
    res.status(400).json({ error: 'Indica cuentaRef y movementHash del movimiento' });
    return true;
  }
  return false;
}

/** Traduce el resultado de la capa de aplicación a una respuesta HTTP. */
function responder(res, resultado) {
  const status = Number(resultado?.status) || HTTP_POR_CODIGO[resultado?.code] || (resultado?.ok ? 200 : 400);
  const { mensaje, ...resto } = resultado || {};
  return res.status(status).json({
    ...resto,
    ...(mensaje && { error: mensaje, mensaje }),
  });
}

/** Los importes se devuelven en euros y en céntimos: euros para pintar, céntimos para calcular. */
function sugerenciaToApi(sugerencia) {
  return {
    ...sugerencia,
    importe: centimosAEuro(sugerencia.importeCentimos),
    conciliable: centimosAEuro(sugerencia.conciliableCentimos),
    asignado: centimosAEuro(sugerencia.asignadoCentimos),
    restoMovimiento: centimosAEuro(sugerencia.restoMovimientoCentimos),
    facturas: sugerencia.facturas.map((f) => ({
      ...f,
      saldoPendiente: centimosAEuro(f.saldoPendienteCentimos),
      asignado: centimosAEuro(f.asignadoCentimos),
      restoFactura: centimosAEuro(f.restoFacturaCentimos),
    })),
  };
}

function movimientoToApi(entrada) {
  return {
    ...entrada,
    importe: centimosAEuro(entrada.importeCentimos),
    conciliable: centimosAEuro(entrada.conciliableCentimos),
    sugerencias: entrada.sugerencias.map(sugerenciaToApi),
  };
}

/**
 * GET /api/banca/conciliacion/sugerencias
 *
 * Barre los movimientos abiertos del rango contra las facturas conciliables y
 * devuelve las sugerencias agrupadas por factura (que es como las consume el
 * listado de facturas) y por movimiento (como las consume la pantalla de banca).
 */
router.get('/banca/conciliacion/sugerencias', requirePermission('banca.ver'), async (req, res) => {
  const tipo = String(req.query.tipo || 'IN').trim().toUpperCase();
  if (!TIPOS.has(tipo)) {
    return res.status(400).json({ error: 'tipo debe ser IN (gasto) u OUT (venta)' });
  }
  const desde = fechaOpcional(req.query.desde);
  const hasta = fechaOpcional(req.query.hasta);
  if (req.query.desde && !desde) return res.status(400).json({ error: 'desde debe ser YYYY-MM-DD' });
  if (req.query.hasta && !hasta) return res.status(400).json({ error: 'hasta debe ser YYYY-MM-DD' });

  const empresaId = String(req.query.empresaId || '').trim();
  const limite = normalizarLimiteBarrido(req.query.limite ?? req.query.limit);

  const [facturas, movimientos] = await Promise.all([
    listarFacturasElegibles(tipo, { empresaId }),
    listarMovimientosAbiertos({ empresaId, desde, hasta, limite }),
  ]);

  // [SEC S-08] Las facturas se filtran por sociedad emisora permitida, igual que
  // en facturación: si no, la conciliación sería una puerta de atrás para ver
  // facturas de sociedades a las que el usuario no tiene acceso.
  const empresasOk = await empresasPermitidasDelUsuario(req.user);
  const visibles = facturas.filter((f) => facturaEmisorPermitido(f, empresasOk));

  const resultado = sugerirConciliaciones({ movimientos, facturas: visibles });

  res.json({
    ok: true,
    filtros: { tipo, empresaId, desde, hasta, limite },
    totales: resultado.totales,
    porFactura: resultado.porFactura.map((f) => ({
      ...f,
      sugerencias: f.sugerencias.map(sugerenciaToApi),
    })),
    porMovimiento: resultado.porMovimiento.map(movimientoToApi),
  });
});

/**
 * POST /api/banca/conciliacion/aplicar
 *
 * Cuerpo: `{ movementHash, cuentaRef, asignaciones: [{ id_factura, importe }],
 * fecha?, metodo_pago?, referencia?, observaciones? }`.
 *
 * Responde 207 cuando parte de las asignaciones falla: en la respuesta van las
 * aplicadas y las fallidas, y el movimiento queda con el estado que le toca
 * según lo realmente aplicado.
 */
router.post('/banca/conciliacion/aplicar', requirePermission('facturacion.cobrar_pagar'), async (req, res) => {
  const identidad = movimientoDeBody(req.body);
  if (faltaMovimiento(res, identidad)) return;

  const asignaciones = Array.isArray(req.body?.asignaciones) ? req.body.asignaciones : [];
  if (asignaciones.length === 0) {
    return res.status(400).json({ error: 'Indica al menos una factura en asignaciones' });
  }

  const resultado = await aplicarConciliacion({
    ...identidad,
    asignaciones,
    fecha: req.body?.fecha,
    metodo_pago: req.body?.metodo_pago,
    referencia: req.body?.referencia,
    observaciones: req.body?.observaciones,
    usuario: usuarioDeReq(req),
  }, await depsConAlcance(req));
  return responder(res, resultado);
});

/**
 * POST /api/banca/conciliacion/descartar — la factura no es de este movimiento.
 * Cuerpo: `{ movementHash, cuentaRef, id_factura }`.
 */
router.post(
  '/banca/conciliacion/descartar',
  requireAnyPermission('banca.importar', 'facturacion.cobrar_pagar'),
  async (req, res) => {
    const identidad = movimientoDeBody(req.body);
    if (faltaMovimiento(res, identidad)) return;

    const resultado = await descartarSugerenciaMovimiento({
      ...identidad,
      id_factura: req.body?.id_factura,
      usuario: usuarioDeReq(req),
    });
    return responder(res, resultado);
  },
);

/**
 * POST /api/banca/conciliacion/ignorar — el movimiento no es una factura
 * (comisión, traspaso, nómina). Con `ignorar: false` se revierte.
 * Cuerpo: `{ movementHash, cuentaRef, ignorar? }`.
 */
router.post(
  '/banca/conciliacion/ignorar',
  requireAnyPermission('banca.importar', 'facturacion.cobrar_pagar'),
  async (req, res) => {
    const identidad = movimientoDeBody(req.body);
    if (faltaMovimiento(res, identidad)) return;

    const resultado = await ignorarMovimiento({
      ...identidad,
      ignorar: req.body?.ignorar === undefined ? true : esVerdadero(req.body.ignorar),
      usuario: usuarioDeReq(req),
    });
    return responder(res, resultado);
  },
);

/**
 * DELETE /api/banca/conciliacion — deshace una conciliación: borra el pago que
 * creó y devuelve el importe al movimiento.
 *
 * Cuerpo: `{ movementHash, cuentaRef, id_factura, id_pago? }`. Va en el cuerpo y
 * no en la ruta porque la identidad del movimiento son dos valores y uno es un
 * IBAN, que en una URL obliga a encodings innecesarios.
 */
router.delete('/banca/conciliacion', requirePermission('facturacion.cobrar_pagar'), async (req, res) => {
  const identidad = movimientoDeBody(req.body);
  if (faltaMovimiento(res, identidad)) return;

  const idFactura = String(req.body?.id_factura || '').trim();
  if (!idFactura) return res.status(400).json({ error: 'Indica la factura cuya conciliación se deshace' });

  const resultado = await deshacerConciliacion({
    ...identidad,
    id_factura: idFactura,
    id_pago: req.body?.id_pago,
    usuario: usuarioDeReq(req),
  }, await depsConAlcance(req));
  return responder(res, resultado);
});

export default router;
