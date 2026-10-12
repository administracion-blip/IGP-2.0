/**
 * Remesas de pago a proveedores (Igp_Remesas).
 *
 * Permisos:
 *  - remesas.ver — listar y ver ficha
 *  - remesas.gestionar — crear, editar, generar fichero, ejecutar, anular, descartar pendientes
 *  - facturacion.cobrar_pagar — requerido además para ejecutar (crea pagos) y descartar pendientes
 */
import { errorPublico, responderError } from '../lib/http/responderError.js';
import { logger } from '../lib/logger.js';
import { Router } from 'express';
import crypto from 'crypto';
import {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../lib/db.js';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { queryLineasByFactura, queryPagosByFactura } from '../lib/dynamo/facturasRelacionadas.js';
import {
  indexarEmpresas,
  evaluarFacturaParaRemesa,
  resolverIbanOrdenante,
  calcularSaldoPendiente,
} from '../lib/remesas/resolverDatos.js';
import { validarIban } from '../lib/remesas/iban.js';
import { esCuentaDeSociedad } from '../lib/remesas/cuentaOrdenante.js';
import { truncarNombreFit } from '../lib/remesas/concepto.js';
import { aplicarClavesRemesa, conClavesRemesa } from '../lib/facturacion/clavesIndice.js';
import { generarFicheroRemesa } from '../lib/remesas/index.js';
import { facturaEnRemesaActiva } from '../lib/remesas/facturaEnRemesa.js';
import { normalizarLineasEntrada, recalcularLineasRemesa } from '../lib/remesas/recalcularLineas.js';
import { registrarPagoFactura } from '../lib/facturacion/registrarPago.js';
import { normalizeCif, getCifFromEmpresaItem, getNombreFromEmpresaItem } from '../lib/empresaCif.js';
import { cargarAlcance, permiteEmpresa, MENSAJE_SIN_ACCESO_EMPRESA } from '../lib/alcance.js';
import { filtrarLecturaPorEmpresa, permiteLecturaEmpresa } from '../lib/alcanceSociedad.js';

const router = Router();

/** [SEC S-08] Escrituras sobre una sociedad: bloquean siempre si está fuera del alcance. */
async function rechazaSociedadAjena(req, res, sociedadId) {
  if (permiteEmpresa(await cargarAlcance(req), sociedadId)) return false;
  res.status(403).json({ error: MENSAJE_SIN_ACCESO_EMPRESA });
  return true;
}
const TABLE = tables.remesas;

const ESTADOS = ['Borrador', 'Generada', 'Ejecutada', 'Anulada'];
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function slugNombreArchivoRemesa(nombre) {
  return String(nombre || 'sociedad')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'sociedad';
}

async function scanRemesas() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: TABLE,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function scanEmpresas() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.empresas,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function getEmpresa(idEmpresa) {
  if (!idEmpresa) return null;
  const r = await docClient.send(new GetCommand({ TableName: tables.empresas, Key: { id_empresa: idEmpresa } }));
  return r.Item || null;
}

function errorCuentaAjena(iban) {
  return `La cuenta ordenante ${iban} no es una cuenta registrada de la sociedad ordenante. Elige una de sus cuentas o dala de alta en la ficha de la empresa.`;
}

async function getRemesa(remesaId) {
  const r = await docClient.send(new GetCommand({ TableName: TABLE, Key: { remesaId } }));
  return r.Item || null;
}

function sumaLineas(lineas) {
  return round2((lineas || []).reduce((s, l) => s + (Number(l.importe) || 0), 0));
}

async function cargarFactura(id, { consistente = false } = {}) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.facturas,
      Key: await keyForFacturaPrincipalId(id),
      ...(consistente && { ConsistentRead: true }),
    }),
  );
  return r.Item || null;
}

async function recalcularDesdeFacturas(remesa) {
  const empresasIdx = indexarEmpresas(await scanEmpresas());
  return recalcularLineasRemesa(remesa, {
    cargarFactura,
    cargarLineasFactura: queryLineasByFactura,
    empresasIdx,
  });
}

function respuestaLineasInvalidas(res, invalidas) {
  return res.status(409).json({
    error: 'Hay facturas de la remesa que ya no se pueden pagar (estado, saldo o IBAN cambiados). Revalida la remesa antes de continuar.',
    invalidas,
  });
}

// ─── Listado ───

router.get('/remesas', requirePermission('remesas.ver'), async (req, res) => {
  try {
    // [SEC S-08]
    let items = await filtrarLecturaPorEmpresa(req, await scanRemesas(), (r) => r.sociedadId);
    const estado = String(req.query.estado || '').trim();
    if (estado) items = items.filter((r) => r.estado === estado);
    items.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ items });
  } catch (err) {
    responderError(res, err);
  }
});

// ─── Detalle ───

router.get('/remesas/:remesaId', requirePermission('remesas.ver'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    // [SEC S-08]
    if (!(await permiteLecturaEmpresa(req, remesa.sociedadId))) {
      return res.status(403).json({ error: MENSAJE_SIN_ACCESO_EMPRESA });
    }
    res.json({ remesa });
  } catch (err) {
    responderError(res, err);
  }
});

// ─── Crear ───

router.post('/remesas', requirePermission('remesas.gestionar'), async (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  const sociedadId = String(b.sociedadId || '').trim();
  const facturaIds = Array.isArray(b.facturaIds)
    ? [...new Set(b.facturaIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  const fechaEjecucion = String(b.fechaEjecucion || '').trim();
  const cuentaOrdenanteInput = String(b.cuentaOrdenante || '').trim();

  if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });
  if (!sociedadId) return res.status(400).json({ error: 'sociedadId es obligatorio' });
  if (facturaIds.length === 0) return res.status(400).json({ error: 'Seleccione al menos una factura' });
  if (fechaEjecucion && !RE_FECHA.test(fechaEjecucion)) {
    return res.status(400).json({ error: 'fechaEjecucion debe ser YYYY-MM-DD' });
  }

  try {
    // [SEC S-08]
    if (await rechazaSociedadAjena(req, res, sociedadId)) return;
    const [empresasItems, remesasActivas] = await Promise.all([scanEmpresas(), scanRemesas()]);
    const empresasIdx = indexarEmpresas(empresasItems);
    const empresaSoc = empresasIdx.byId.get(sociedadId);
    if (!empresaSoc) return res.status(400).json({ error: 'Sociedad ordenante no encontrada en maestro' });

    const lineas = [];
    const excluidas = [];
    let primeraFactura = null;

    for (const fid of facturaIds) {
      const dup = facturaEnRemesaActiva(remesasActivas, fid);
      if (dup) {
        excluidas.push({ id_factura: fid, motivo: `Ya incluida en remesa ${dup.nombre || dup.remesaId}` });
        continue;
      }
      const factura = await cargarFactura(fid);
      if (!factura) {
        excluidas.push({ id_factura: fid, motivo: 'Factura no encontrada' });
        continue;
      }
      if (!primeraFactura) primeraFactura = factura;
      const lineasFactura = await queryLineasByFactura(fid);
      const ev = evaluarFacturaParaRemesa(factura, lineasFactura, sociedadId, empresasIdx);
      if (ev.excluida) excluidas.push(ev.excluida);
      else if (ev.linea) lineas.push(ev.linea);
    }

    if (lineas.length === 0) {
      return res.status(400).json({ error: 'Ninguna factura válida para la remesa', excluidas });
    }

    let cuentaOrdenante = cuentaOrdenanteInput;
    if (!cuentaOrdenante) {
      const ibanOrd = resolverIbanOrdenante(sociedadId, primeraFactura, empresasIdx);
      if (!ibanOrd.valido) {
        return res.status(400).json({ error: ibanOrd.motivo || 'IBAN ordenante inválido' });
      }
      cuentaOrdenante = ibanOrd.iban;
    } else {
      const v = validarIban(cuentaOrdenante);
      if (!v.valido) return res.status(400).json({ error: v.motivo || 'IBAN ordenante inválido' });
      cuentaOrdenante = v.iban;
    }
    if (!(await esCuentaDeSociedad(cuentaOrdenante, empresaSoc, sociedadId))) {
      return res.status(400).json({ error: errorCuentaAjena(cuentaOrdenante) });
    }

    const usuario = req.user || {};
    const remesa = {
      remesaId: uuid(),
      nombre,
      banco: 'BBVA_FIT',
      estado: 'Borrador',
      sociedadId,
      sociedadNombre: truncarNombreFit(getNombreFromEmpresaItem(empresaSoc) || primeraFactura?.emisor_nombre || ''),
      sociedadCif: normalizeCif(getCifFromEmpresaItem(empresaSoc) || primeraFactura?.emisor_cif || ''),
      cuentaOrdenante,
      sufijoOrdenante: String(b.sufijoOrdenante || empresaSoc?.bbvaSufijoOrdenante || '').trim().slice(0, 3),
      fechaEjecucion: fechaEjecucion || '',
      lineas,
      excluidas,
      importeTotal: sumaLineas(lineas),
      generadaEn: null,
      ejecutadaEn: null,
      creadoPor: usuario.email || usuario.Nombre || usuario.id_usuario || '',
      creadoEn: now(),
      actualizadoEn: now(),
    };

    aplicarClavesRemesa(remesa);
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.status(201).json({ remesa, excluidas });
  } catch (err) {
    responderError(res, err);
  }
});

// ─── Editar borrador ───

router.patch('/remesas/:remesaId', requirePermission('remesas.gestionar'), async (req, res) => {
  const remesaId = req.params.remesaId;
  const b = req.body || {};

  try {
    const remesa = await getRemesa(remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (await rechazaSociedadAjena(req, res, remesa.sociedadId)) return; // [SEC S-08]

    if (b.accion === 'reabrir') {
      if (!['Generada'].includes(remesa.estado)) {
        return res.status(400).json({ error: 'Solo se puede reabrir una remesa Generada' });
      }
      remesa.estado = 'Borrador';
      remesa.generadaEn = null;
      remesa.actualizadoEn = now();
      aplicarClavesRemesa(remesa);
      await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
      return res.json({ remesa });
    }

    // Quitar facturas desde Generada: reabrir a Borrador en la misma operación
    const quitarFacturaIds =
      Array.isArray(b.quitarFacturaIds) && b.quitarFacturaIds.length > 0 ? b.quitarFacturaIds : null;
    if (quitarFacturaIds && remesa.estado === 'Generada') {
      remesa.estado = 'Borrador';
      remesa.generadaEn = null;
    }

    if (remesa.estado !== 'Borrador') {
      return res.status(400).json({ error: 'Solo se puede editar una remesa en Borrador' });
    }

    if (b.nombre !== undefined) remesa.nombre = String(b.nombre || '').trim();
    if (b.fechaEjecucion !== undefined) {
      const f = String(b.fechaEjecucion || '').trim();
      if (f && !RE_FECHA.test(f)) return res.status(400).json({ error: 'fechaEjecucion inválida' });
      remesa.fechaEjecucion = f;
    }
    if (b.cuentaOrdenante !== undefined) {
      const v = validarIban(b.cuentaOrdenante);
      if (!v.valido) return res.status(400).json({ error: v.motivo });
      if (!(await esCuentaDeSociedad(v.iban, await getEmpresa(remesa.sociedadId), remesa.sociedadId))) {
        return res.status(400).json({ error: errorCuentaAjena(v.iban) });
      }
      remesa.cuentaOrdenante = v.iban;
    }
    if (b.sufijoOrdenante !== undefined) {
      remesa.sufijoOrdenante = String(b.sufijoOrdenante || '').trim().slice(0, 3);
    }

    if (b.anadirFacturaIds && Array.isArray(b.anadirFacturaIds)) {
      const empresasIdx = indexarEmpresas(await scanEmpresas());
      const remesasActivas = await scanRemesas();
      const idsActuales = new Set((remesa.lineas || []).map((l) => String(l.id_factura ?? '').trim()));
      const nuevasExcluidas = [...(remesa.excluidas || [])];

      for (const fid of b.anadirFacturaIds.map((id) => String(id ?? '').trim())) {
        if (!fid || idsActuales.has(fid)) continue;
        const dup = facturaEnRemesaActiva(remesasActivas, fid, remesaId);
        if (dup) {
          nuevasExcluidas.push({ id_factura: fid, motivo: `Ya en remesa ${dup.nombre || dup.remesaId}` });
          continue;
        }
        const factura = await cargarFactura(fid);
        if (!factura) {
          nuevasExcluidas.push({ id_factura: fid, motivo: 'Factura no encontrada' });
          continue;
        }
        const lineasFactura = await queryLineasByFactura(fid);
        const ev = evaluarFacturaParaRemesa(factura, lineasFactura, remesa.sociedadId, empresasIdx);
        if (ev.excluida) nuevasExcluidas.push(ev.excluida);
        else if (ev.linea) {
          remesa.lineas = [...(remesa.lineas || []), ev.linea];
          idsActuales.add(fid);
        }
      }
      remesa.excluidas = nuevasExcluidas;
    }

    if (b.quitarFacturaIds && Array.isArray(b.quitarFacturaIds)) {
      const quitar = new Set(b.quitarFacturaIds);
      remesa.lineas = (remesa.lineas || []).filter((l) => !quitar.has(l.id_factura));
    }

    if (b.lineas !== undefined) {
      remesa.lineas = normalizarLineasEntrada(b.lineas, remesa.lineas);
    }

    if ((remesa.lineas || []).length === 0) {
      return res.status(400).json({ error: 'La remesa debe tener al menos una línea' });
    }

    remesa.importeTotal = sumaLineas(remesa.lineas);
    remesa.actualizadoEn = now();
    aplicarClavesRemesa(remesa);
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.json({ remesa });
  } catch (err) {
    responderError(res, err);
  }
});

// ─── Revalidar pendientes e IBAN ───

router.post('/remesas/:remesaId/revalidar', requirePermission('remesas.gestionar'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (await rechazaSociedadAjena(req, res, remesa.sociedadId)) return; // [SEC S-08]
    if (!['Borrador', 'Generada'].includes(remesa.estado)) {
      return res.status(400).json({ error: 'Solo se revalida en Borrador o Generada' });
    }

    const empresasIdx = indexarEmpresas(await scanEmpresas());
    const nuevasLineas = [];
    const excluidas = [];

    for (const linea of remesa.lineas || []) {
      const factura = await cargarFactura(linea.id_factura);
      if (!factura) {
        excluidas.push({ id_factura: linea.id_factura, motivo: 'Factura no encontrada' });
        continue;
      }
      const lineasFactura = await queryLineasByFactura(linea.id_factura);
      const ev = evaluarFacturaParaRemesa(factura, lineasFactura, remesa.sociedadId, empresasIdx);
      if (ev.excluida) {
        excluidas.push(ev.excluida);
        continue;
      }
      const nueva = ev.linea;
      const importePrev = round2(Number(linea.importe) || 0);
      nueva.importe = Math.min(importePrev > 0 ? importePrev : nueva.importe, nueva.importeMaximo);
      nueva.concepto = linea.concepto || nueva.concepto;
      nuevasLineas.push(nueva);
    }

    remesa.lineas = nuevasLineas;
    remesa.excluidas = excluidas;
    remesa.importeTotal = sumaLineas(nuevasLineas);
    remesa.actualizadoEn = now();
    if (remesa.estado === 'Generada') {
      remesa.estado = 'Borrador';
      remesa.generadaEn = null;
    }
    aplicarClavesRemesa(remesa);
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.json({ remesa, excluidas });
  } catch (err) {
    responderError(res, err);
  }
});

// ─── Generar fichero Excel ───

router.get('/remesas/:remesaId/fichero', requirePermission('remesas.gestionar'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (await rechazaSociedadAjena(req, res, remesa.sociedadId)) return; // [SEC S-08]
    if (remesa.estado === 'Anulada') return res.status(400).json({ error: 'Remesa anulada' });
    if (remesa.estado === 'Ejecutada') return res.status(409).json({ error: 'La remesa ya está ejecutada' });
    if (!remesa.lineas?.length) return res.status(400).json({ error: 'Sin líneas en la remesa' });
    const estadoLeido = remesa.estado;

    if (!(await esCuentaDeSociedad(remesa.cuentaOrdenante, await getEmpresa(remesa.sociedadId), remesa.sociedadId))) {
      return res.status(409).json({
        error: `La cuenta ordenante ${remesa.cuentaOrdenante || '(vacía)'} ya no es una cuenta registrada de la sociedad ordenante. Revisa la cuenta de la remesa antes de generar el fichero.`,
      });
    }

    const recalculo = await recalcularDesdeFacturas(remesa);
    if (!recalculo.ok) return respuestaLineasInvalidas(res, recalculo.invalidas);
    remesa.lineas = recalculo.lineas;
    remesa.importeTotal = sumaLineas(remesa.lineas);

    const buffer = await generarFicheroRemesa(remesa);
    const fecha = (remesa.fechaEjecucion || now().slice(0, 10)).replace(/-/g, '');
    const nombreSlug = slugNombreArchivoRemesa(remesa.sociedadNombre);
    const cif = String(remesa.sociedadCif || 'remesa').replace(/[^A-Za-z0-9]/g, '');
    const filename = `remesa-${nombreSlug}-${cif}-${fecha}.xlsx`;

    remesa.estado = 'Generada';
    remesa.generadaEn = now();
    remesa.actualizadoEn = now();
    aplicarClavesRemesa(remesa);
    try {
      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: remesa,
        ConditionExpression: '#estado = :leido',
        ExpressionAttributeNames: { '#estado': 'estado' },
        ExpressionAttributeValues: { ':leido': estadoLeido },
      }));
    } catch (putErr) {
      if (putErr?.name === 'ConditionalCheckFailedException') {
        return res.status(409).json({ error: 'La remesa ha cambiado, vuelve a cargarla' });
      }
      throw putErr;
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    responderError(res, err);
  }
});

// ─── Ejecutar (registrar pagos) ───

router.post('/remesas/:remesaId/ejecutar', requirePermission('remesas.gestionar'), async (req, res) => {
  if (!(await hasPermission(req.user, 'facturacion.cobrar_pagar'))) {
    return res.status(403).json({ error: 'Permiso facturacion.cobrar_pagar requerido para ejecutar' });
  }

  const fecha = String(req.body?.fecha || '').trim() || now().slice(0, 10);
  if (!RE_FECHA.test(fecha)) return res.status(400).json({ error: 'fecha debe ser YYYY-MM-DD' });

  // Reclamo de la ejecución en curso (`procesandoToken`): una sola a la vez paga
  // y cierra las pendientes; se suelta al terminar o caduca a los 5 minutos.
  let tokenProceso = null;
  let remesaProceso = null;
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (await rechazaSociedadAjena(req, res, remesa.sociedadId)) return; // [SEC S-08]
    // Una ejecución que dejó líneas sin pagar se reanuda solo con esas líneas.
    const pendientesPrevias = Array.isArray(remesa.lineasPendientesPago) ? remesa.lineasPendientesPago : [];
    const reanudar = remesa.estado === 'Ejecutada' && pendientesPrevias.length > 0;
    if (remesa.estado === 'Ejecutada' && !reanudar) return res.status(409).json({ error: 'La remesa ya está ejecutada' });
    if (remesa.estado === 'Anulada') return res.status(400).json({ error: 'Remesa anulada' });
    if (!remesa.lineas?.length) return res.status(400).json({ error: 'Sin líneas' });

    const usuario = req.user || {};
    const metodo_pago = String(req.body?.metodo_pago || '').trim() || 'remesa';
    const referencia = String(req.body?.referencia || '').trim() || `Remesa ${remesa.remesaId}`;
    const observacionesGlobal = String(req.body?.observaciones ?? '').trim();

    // Al reanudar no se revalida la remesa entera: cada pendiente se clasifica
    // por separado (ver `clasificarPendientes`) y las que no se pueden pagar no
    // bloquean a las demás. Ejecutar por primera vez sigue siendo todo o nada.
    let lineasAPagar = remesa.lineas;
    const pagosCreados = [];
    const fallidas = [];
    const descartadasAhora = [];
    if (reanudar) {
      if (procesoActivo(remesa)) return res.status(409).json({ error: MENSAJE_EN_PROCESO });
      const token = uuid();
      const reclamada = await reclamarReanudacion(remesa, token);
      if (!reclamada) {
        const actual = await getRemesa(remesa.remesaId);
        return res.status(409).json({ error: procesoActivo(actual) ? MENSAJE_EN_PROCESO : 'La remesa ya está ejecutada' });
      }
      tokenProceso = token;
      remesaProceso = remesa;
      // Las pendientes y descartadas valen las del reclamo, no las de la primera lectura.
      Object.assign(remesa, reclamada);
      const c = await clasificarPendientes(remesa, remesa.lineasPendientesPago.map(String));
      lineasAPagar = c.aPagar;
      pagosCreados.push(...c.yaPagadas);
      fallidas.push(...c.fallidas);
      descartadasAhora.push(...c.descartadas);
    } else {
      const recalculo = await recalcularDesdeFacturas(remesa);
      if (!recalculo.ok) return respuestaLineasInvalidas(res, recalculo.invalidas);

      // Fase 1: validar todas las líneas antes de crear pagos
      for (const linea of lineasAPagar) {
        const factura = await cargarFactura(linea.id_factura);
        if (!factura) {
          return res.status(400).json({ error: `Factura ${linea.id_factura} no encontrada` });
        }
        const pendiente = calcularSaldoPendiente(factura);
        const importe = round2(Number(linea.importe) || 0);
        if (importe <= 0 || importe > pendiente + 0.001) {
          return res.status(400).json({
            error: `Importe inválido para factura ${linea.id_factura} (pendiente ${pendiente})`,
          });
        }
      }
    }

    // [SEC S-04] Reclamar remesa atómicamente antes de pagar. Todas las líneas
    // quedan pendientes desde el reclamo: si el proceso cae a mitad, la remesa
    // se puede reanudar en vez de quedarse Ejecutada con facturas sin pagar.
    if (!reanudar) {
      const tsEjecucion = now();
      const todas = remesa.lineas.map((l) => String(l.id_factura));
      const token = uuid();
      const remesaReclamada = { ...remesa, estado: 'Ejecutada', lineasPendientesPago: todas };
      try {
        await docClient.send(new UpdateCommand(conClavesRemesa({
          TableName: TABLE,
          Key: { remesaId: remesa.remesaId },
          UpdateExpression: 'SET estado = :ejecutada, ejecutadaEn = :ts, actualizadoEn = :ts, lineasPendientesPago = :pend, '
            + 'procesandoToken = :tok, procesandoDesde = :ts',
          ConditionExpression: 'estado = :generada OR estado = :borrador',
          ExpressionAttributeValues: {
            ':ejecutada': 'Ejecutada',
            ':generada': 'Generada',
            ':borrador': 'Borrador',
            ':ts': tsEjecucion,
            ':pend': todas,
            ':tok': token,
          },
        }, remesaReclamada)));
      } catch (claimErr) {
        if (claimErr?.name === 'ConditionalCheckFailedException') {
          return res.status(409).json({ error: 'La remesa ya está ejecutada o no se puede ejecutar' });
        }
        throw claimErr;
      }
      tokenProceso = token;
      remesa.estado = 'Ejecutada';
      remesa.lineasPendientesPago = todas;
      remesa.ejecutadaEn = tsEjecucion;
      remesa.actualizadoEn = tsEjecucion;
      remesaProceso = remesa;
    }

    // Fase 2: registrar pagos (idempotentes por línea). El fallo de una línea
    // (p. ej. 409 porque su factura cambió) no corta las demás.
    const totalLineas = lineasAPagar.length + pagosCreados.length + fallidas.length;
    for (const linea of lineasAPagar) {
      try {
        const factura = await cargarFactura(linea.id_factura);
        const pendiente = calcularSaldoPendiente(factura);
        const result = await registrarPagoFactura({
          id_factura: linea.id_factura,
          fecha,
          importe: round2(Number(linea.importe) || 0),
          metodo_pago,
          referencia,
          observaciones: observacionesGlobal || linea.concepto || '',
          usuario_id: usuario.id_usuario || usuario.sub || '',
          usuario_nombre: usuario.Nombre || usuario.email || '',
          importeMaximo: pendiente,
          idempotencyKey: claveIdempotenciaRemesa(remesa.remesaId, linea.id_factura),
        });
        pagosCreados.push(result.pago);
      } catch (err) {
        (req.log?.error ? req.log : logger).error(
          { err, remesaId: remesa.remesaId, id_factura: linea.id_factura },
          '[remesas/ejecutar] línea sin pagar',
        );
        const pub = errorPublico(err);
        fallidas.push({
          id_factura: linea.id_factura,
          error: pub.error,
          ...(pub.publico && err?.code && { code: err.code }),
          siguePendiente: true,
        });
      }
    }

    const pendientes = fallidas.filter((f) => f.siguePendiente).map((f) => String(f.id_factura));
    const tsFin = now();
    const descartadas = [
      ...(Array.isArray(remesa.pendientesDescartadas) ? remesa.pendientesDescartadas : []),
      ...descartadasAhora.map((d) => ({ ...d, por: 'sistema', en: tsFin })),
    ];
    const sets = ['actualizadoEn = :ts'];
    const valores = { ':ts': tsFin };
    if (pendientes.length > 0) {
      sets.push('lineasPendientesPago = :pend');
      valores[':pend'] = pendientes;
    }
    if (descartadasAhora.length > 0) {
      sets.push('pendientesDescartadas = :desc');
      valores[':desc'] = descartadas;
    }
    const quitar = ['procesandoToken', 'procesandoDesde', ...(pendientes.length > 0 ? [] : ['lineasPendientesPago'])];
    const remesaCerrada = { ...remesa, actualizadoEn: tsFin, lineasPendientesPago: pendientes };
    try {
      // Solo quien tiene el reclamo cierra: si caducó y otro lo tomó, su cierre manda.
      await docClient.send(new UpdateCommand(conClavesRemesa({
        TableName: TABLE,
        Key: { remesaId: remesa.remesaId },
        UpdateExpression: `SET ${sets.join(', ')} REMOVE ${quitar.join(', ')}`,
        ConditionExpression: 'procesandoToken = :tok',
        ExpressionAttributeValues: { ...valores, ':tok': tokenProceso },
      }, remesaCerrada)));
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      tokenProceso = null;
      (req.log?.warn ? req.log : logger).warn(
        { remesaId: remesa.remesaId },
        '[remesas/ejecutar] el reclamo caducó y lo tomó otra ejecución; no se cierra el estado',
      );
      return res.status(409).json({ ok: false, error: MENSAJE_EN_PROCESO, pagos: pagosCreados, fallidas });
    }
    tokenProceso = null;
    delete remesa.procesandoToken;
    delete remesa.procesandoDesde;
    remesa.actualizadoEn = tsFin;
    if (pendientes.length > 0) remesa.lineasPendientesPago = pendientes;
    else delete remesa.lineasPendientesPago;
    if (descartadasAhora.length > 0) remesa.pendientesDescartadas = descartadas;
    aplicarClavesRemesa(remesa);

    if (fallidas.length > 0) {
      const quitadas = fallidas.length - pendientes.length;
      return res.status(409).json({
        ok: false,
        code: 'REMESA_EJECUCION_PARCIAL',
        error: `Se han registrado ${pagosCreados.length} de ${totalLineas} pago(s). `
          + (pendientes.length > 0
            ? `${pendientes.length} factura(s) siguen pendientes; vuelve a ejecutar la remesa para pagarlas o descártalas. `
            : '')
          + (quitadas > 0
            ? `${quitadas} factura(s) se han quitado de pendientes porque ya no se pueden pagar (revisa el detalle).`
            : ''),
        remesa,
        pagos: pagosCreados,
        fallidas,
      });
    }
    res.json({ ok: true, remesa, pagos: pagosCreados });
  } catch (err) {
    if (tokenProceso) await liberarProceso(remesaProceso, tokenProceso, req);
    responderError(res, err);
  }
});

const MENSAJE_EN_PROCESO = 'La remesa se está procesando';
/** Un reclamo de ejecución más antiguo se da por abandonado (proceso caído). */
const CADUCIDAD_PROCESO_MS = 5 * 60 * 1000;

const limiteCaducidad = () => new Date(Date.now() - CADUCIDAD_PROCESO_MS).toISOString();

function procesoActivo(remesa) {
  return Boolean(remesa?.procesandoToken) && String(remesa.procesandoDesde || '') >= limiteCaducidad();
}

/**
 * Reclama la reanudación de una remesa Ejecutada con pendientes. Devuelve la
 * remesa tal y como queda tras el reclamo, o null si otra ejecución la tiene o
 * ya no quedan pendientes.
 */
async function reclamarReanudacion(remesa, token) {
  const ts = now();
  try {
    const r = await docClient.send(new UpdateCommand(conClavesRemesa({
      TableName: TABLE,
      Key: { remesaId: remesa.remesaId },
      UpdateExpression: 'SET procesandoToken = :tok, procesandoDesde = :ts',
      ConditionExpression: 'estado = :ejecutada AND attribute_exists(lineasPendientesPago) '
        + 'AND (attribute_not_exists(procesandoToken) OR procesandoDesde < :caduca)',
      ExpressionAttributeValues: { ':tok': token, ':ts': ts, ':ejecutada': 'Ejecutada', ':caduca': limiteCaducidad() },
      ReturnValues: 'ALL_NEW',
    }, remesa)));
    return r.Attributes;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

/** Suelta el reclamo tras un error inesperado; si no se puede, caduca solo. */
async function liberarProceso(remesa, token, req) {
  const remesaId = remesa?.remesaId;
  if (!remesaId) return;
  try {
    await docClient.send(new UpdateCommand(conClavesRemesa({
      TableName: TABLE,
      Key: { remesaId },
      UpdateExpression: 'REMOVE procesandoToken, procesandoDesde',
      ConditionExpression: 'procesandoToken = :tok',
      ExpressionAttributeValues: { ':tok': token },
    }, remesa)));
  } catch (err) {
    (req.log?.warn ? req.log : logger).warn({ err, remesaId }, '[remesas/ejecutar] no se pudo soltar el reclamo');
  }
}

const claveIdempotenciaRemesa = (remesaId, idFactura) => `remesa:${remesaId}:${idFactura}`;

/**
 * Clasifica las pendientes de una remesa Ejecutada antes de reanudarla. El banco
 * ya recibió el fichero, así que una pendiente nunca debe bloquear a las demás:
 *
 *  - Ya tiene el pago de esta remesa (clave `remesa:<id>:<factura>`, lectura
 *    fuerte): estaba pagada y solo faltaba cerrar la pendiente → `yaPagadas`.
 *  - Factura no encontrada, anulada o sin saldo pendiente (pagada por otra vía):
 *    no se puede pagar sin deshacer algo a mano → sale de pendientes, queda en
 *    `pendientesDescartadas` (por 'sistema') y va en `fallidas` con
 *    `siguePendiente: false`.
 *  - Cualquier otro motivo (IBAN, estado en revisión, importe mayor que el saldo
 *    que queda…): puede corregirse → sigue pendiente, va en `fallidas` con
 *    `siguePendiente: true`; se reintenta en la próxima reanudación o se descarta
 *    con POST /remesas/:id/descartar-pendientes.
 */
async function clasificarPendientes(remesa, idsPendientes) {
  const empresasIdx = indexarEmpresas(await scanEmpresas());
  const lineasPorFactura = new Map((remesa.lineas || []).map((l) => [String(l.id_factura), l]));
  const yaPagadas = [];
  const aPagar = [];
  const fallidas = [];
  const descartadas = [];
  const definitiva = (id_factura, motivo) => {
    descartadas.push({ id_factura, motivo });
    fallidas.push({ id_factura, error: motivo, code: 'PENDIENTE_NO_PAGABLE', siguePendiente: false });
  };

  for (const id of idsPendientes) {
    const linea = lineasPorFactura.get(id);
    if (!linea) {
      definitiva(id, 'La factura ya no está en la remesa');
      continue;
    }
    const clave = claveIdempotenciaRemesa(remesa.remesaId, id);
    const previo = (await queryPagosByFactura(id, { consistente: true })).find((p) => p.idempotency_key === clave);
    if (previo) {
      yaPagadas.push(previo);
      continue;
    }
    const factura = await cargarFactura(id, { consistente: true });
    const pendiente = factura ? calcularSaldoPendiente(factura) : 0;
    if (!factura) {
      definitiva(id, 'Factura no encontrada');
      continue;
    }
    if (factura.estado === 'anulada') {
      definitiva(id, 'Factura anulada');
      continue;
    }
    if (pendiente <= 0) {
      definitiva(id, 'La factura ya no tiene saldo pendiente (pagada por otra vía)');
      continue;
    }
    const ev = await recalcularLineasRemesa({ ...remesa, lineas: [linea] }, {
      cargarFactura: async () => factura,
      cargarLineasFactura: queryLineasByFactura,
      empresasIdx,
    });
    const importe = round2(Number(linea.importe) || 0);
    const motivo = !ev.ok
      ? ev.invalidas[0]?.motivo || 'Factura no válida para la remesa'
      : (importe <= 0 || importe > pendiente + 0.001)
        ? `El importe de la remesa (${importe}) supera el pendiente de la factura (${pendiente})`
        : null;
    if (motivo) {
      fallidas.push({ id_factura: id, error: motivo, code: 'PENDIENTE_NO_PAGABLE', siguePendiente: true });
      continue;
    }
    aPagar.push(linea);
  }
  return { yaPagadas, aPagar, fallidas, descartadas };
}

// ─── Descartar pendientes de una remesa ejecutada ───

/**
 * Quita facturas de `lineasPendientesPago` sin tocar pagos: para pendientes que
 * se han resuelto fuera de la remesa. Queda registro en `pendientesDescartadas`.
 * Body: `{ facturaIds?: string[], motivo?: string }`; sin `facturaIds`, todas.
 */
router.post('/remesas/:remesaId/descartar-pendientes', requirePermission('remesas.gestionar'), async (req, res) => {
  if (!(await hasPermission(req.user, 'facturacion.cobrar_pagar'))) {
    return res.status(403).json({ error: 'Permiso facturacion.cobrar_pagar requerido para descartar pendientes' });
  }
  const b = req.body || {};
  if (b.facturaIds !== undefined && !Array.isArray(b.facturaIds)) {
    return res.status(400).json({ error: 'facturaIds debe ser una lista' });
  }
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (await rechazaSociedadAjena(req, res, remesa.sociedadId)) return; // [SEC S-08]
    const pendientes = Array.isArray(remesa.lineasPendientesPago) ? remesa.lineasPendientesPago.map(String) : [];
    if (remesa.estado !== 'Ejecutada' || pendientes.length === 0) {
      return res.status(409).json({ error: 'La remesa no tiene facturas pendientes de pago' });
    }
    if (procesoActivo(remesa)) return res.status(409).json({ error: MENSAJE_EN_PROCESO });
    const pedidas = Array.isArray(b.facturaIds)
      ? [...new Set(b.facturaIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
      : pendientes;
    if (pedidas.length === 0) return res.status(400).json({ error: 'Indica las facturas a descartar' });
    const ajenas = pedidas.filter((id) => !pendientes.includes(id));
    if (ajenas.length > 0) {
      return res.status(400).json({ error: `No están pendientes en esta remesa: ${ajenas.join(', ')}` });
    }

    const usuario = req.user || {};
    const ts = now();
    const motivo = String(b.motivo ?? '').trim().slice(0, 300);
    const restantes = pendientes.filter((id) => !pedidas.includes(id));
    const descartadas = [
      ...(Array.isArray(remesa.pendientesDescartadas) ? remesa.pendientesDescartadas : []),
      ...pedidas.map((id_factura) => ({
        id_factura,
        por: String(usuario.id_usuario || usuario.sub || usuario.email || ''),
        porNombre: String(usuario.Nombre || usuario.email || ''),
        en: ts,
        ...(motivo && { motivo }),
      })),
    ];
    const remesaTrasDescarte = { ...remesa, pendientesDescartadas: descartadas, actualizadoEn: ts, lineasPendientesPago: restantes };
    try {
      await docClient.send(new UpdateCommand(conClavesRemesa({
        TableName: TABLE,
        Key: { remesaId: remesa.remesaId },
        UpdateExpression: `SET pendientesDescartadas = :desc, actualizadoEn = :ts${restantes.length > 0 ? ', lineasPendientesPago = :rest' : ' REMOVE lineasPendientesPago'}`,
        ConditionExpression: `${remesa.actualizadoEn ? 'actualizadoEn = :leido' : 'attribute_not_exists(actualizadoEn)'} `
          + 'AND (attribute_not_exists(procesandoToken) OR procesandoDesde < :caduca)',
        ExpressionAttributeValues: {
          ':desc': descartadas,
          ':ts': ts,
          ':caduca': limiteCaducidad(),
          ...(remesa.actualizadoEn && { ':leido': remesa.actualizadoEn }),
          ...(restantes.length > 0 && { ':rest': restantes }),
        },
      }, remesaTrasDescarte)));
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        return res.status(409).json({ error: 'La remesa ha cambiado, vuelve a cargarla' });
      }
      throw err;
    }
    remesa.pendientesDescartadas = descartadas;
    remesa.actualizadoEn = ts;
    if (restantes.length > 0) remesa.lineasPendientesPago = restantes;
    else delete remesa.lineasPendientesPago;
    aplicarClavesRemesa(remesa);
    res.json({ ok: true, remesa, descartadas: pedidas });
  } catch (err) {
    responderError(res, err);
  }
});

// ─── Anular ───

router.post('/remesas/:remesaId/anular', requirePermission('remesas.gestionar'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (await rechazaSociedadAjena(req, res, remesa.sociedadId)) return; // [SEC S-08]
    if (!['Borrador', 'Generada'].includes(remesa.estado)) {
      return res.status(400).json({ error: 'Solo se anulan remesas en Borrador o Generada' });
    }
    remesa.estado = 'Anulada';
    remesa.actualizadoEn = now();
    aplicarClavesRemesa(remesa);
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.json({ remesa });
  } catch (err) {
    responderError(res, err);
  }
});

export default router;
