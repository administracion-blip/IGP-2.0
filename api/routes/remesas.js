/**
 * Remesas de pago a proveedores (Igp_Remesas).
 *
 * Permisos:
 *  - remesas.ver — listar y ver ficha
 *  - remesas.gestionar — crear, editar, generar fichero, ejecutar, anular
 *  - facturacion.cobrar_pagar — requerido además para ejecutar (crea pagos)
 */
import { Router } from 'express';
import crypto from 'crypto';
import {
  ScanCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../lib/db.js';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { queryLineasByFactura } from '../lib/dynamo/facturasRelacionadas.js';
import {
  indexarEmpresas,
  evaluarFacturaParaRemesa,
  resolverIbanOrdenante,
  calcularSaldoPendiente,
} from '../lib/remesas/resolverDatos.js';
import { validarIban } from '../lib/remesas/iban.js';
import { truncarNombreFit } from '../lib/remesas/concepto.js';
import { generarFicheroRemesa } from '../lib/remesas/index.js';
import { facturaEnRemesaActiva } from '../lib/remesas/facturaEnRemesa.js';
import { registrarPagoFactura } from '../lib/facturacion/registrarPago.js';
import { normalizeCif, getCifFromEmpresaItem, getNombreFromEmpresaItem } from '../lib/empresaCif.js';

const router = Router();
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

async function getRemesa(remesaId) {
  const r = await docClient.send(new GetCommand({ TableName: TABLE, Key: { remesaId } }));
  return r.Item || null;
}

function sumaLineas(lineas) {
  return round2((lineas || []).reduce((s, l) => s + (Number(l.importe) || 0), 0));
}

async function cargarFactura(id) {
  const r = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
  );
  return r.Item || null;
}

function normalizarLineasEntrada(raw, existentes = []) {
  if (!Array.isArray(raw)) return existentes;
  const mapExistentes = new Map((existentes || []).map((l) => [l.id_factura, l]));
  return raw.map((l) => {
    const id = String(l.id_factura || '').trim();
    const prev = mapExistentes.get(id) || l;
    const importeMax = round2(Number(l.importeMaximo ?? prev.importeMaximo ?? prev.saldoPendiente ?? l.importe) || 0);
    let importe = round2(Number(l.importe ?? prev.importe) || 0);
    if (importe > importeMax) importe = importeMax;
    return {
      ...prev,
      ...l,
      id_factura: id,
      importe,
      importeMaximo: importeMax,
      concepto: String(l.concepto ?? prev.concepto ?? '').slice(0, 140),
    };
  }).filter((l) => l.id_factura);
}

// ─── Listado ───

router.get('/remesas', requirePermission('remesas.ver'), async (req, res) => {
  try {
    let items = await scanRemesas();
    const estado = String(req.query.estado || '').trim();
    if (estado) items = items.filter((r) => r.estado === estado);
    items.sort((a, b) => String(b.creadoEn || '').localeCompare(String(a.creadoEn || '')));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Detalle ───

router.get('/remesas/:remesaId', requirePermission('remesas.ver'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    res.json({ remesa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Crear ───

router.post('/remesas', requirePermission('remesas.gestionar'), async (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  const sociedadId = String(b.sociedadId || '').trim();
  const facturaIds = Array.isArray(b.facturaIds) ? b.facturaIds.map((id) => String(id).trim()).filter(Boolean) : [];
  const fechaEjecucion = String(b.fechaEjecucion || '').trim();
  const cuentaOrdenanteInput = String(b.cuentaOrdenante || '').trim();

  if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });
  if (!sociedadId) return res.status(400).json({ error: 'sociedadId es obligatorio' });
  if (facturaIds.length === 0) return res.status(400).json({ error: 'Seleccione al menos una factura' });
  if (fechaEjecucion && !RE_FECHA.test(fechaEjecucion)) {
    return res.status(400).json({ error: 'fechaEjecucion debe ser YYYY-MM-DD' });
  }

  try {
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

    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.status(201).json({ remesa, excluidas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Editar borrador ───

router.patch('/remesas/:remesaId', requirePermission('remesas.gestionar'), async (req, res) => {
  const remesaId = req.params.remesaId;
  const b = req.body || {};

  try {
    const remesa = await getRemesa(remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });

    if (b.accion === 'reabrir') {
      if (!['Generada'].includes(remesa.estado)) {
        return res.status(400).json({ error: 'Solo se puede reabrir una remesa Generada' });
      }
      remesa.estado = 'Borrador';
      remesa.generadaEn = null;
      remesa.actualizadoEn = now();
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
      remesa.cuentaOrdenante = v.iban;
    }
    if (b.sufijoOrdenante !== undefined) {
      remesa.sufijoOrdenante = String(b.sufijoOrdenante || '').trim().slice(0, 3);
    }

    if (b.anadirFacturaIds && Array.isArray(b.anadirFacturaIds)) {
      const empresasIdx = indexarEmpresas(await scanEmpresas());
      const remesasActivas = await scanRemesas();
      const idsActuales = new Set((remesa.lineas || []).map((l) => l.id_factura));
      const nuevasExcluidas = [...(remesa.excluidas || [])];

      for (const fid of b.anadirFacturaIds) {
        if (idsActuales.has(fid)) continue;
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
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.json({ remesa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Revalidar pendientes e IBAN ───

router.post('/remesas/:remesaId/revalidar', requirePermission('remesas.gestionar'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
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
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.json({ remesa, excluidas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Generar fichero Excel ───

router.get('/remesas/:remesaId/fichero', requirePermission('remesas.gestionar'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (remesa.estado === 'Anulada') return res.status(400).json({ error: 'Remesa anulada' });
    if (!remesa.lineas?.length) return res.status(400).json({ error: 'Sin líneas en la remesa' });

    const buffer = await generarFicheroRemesa(remesa);
    const fecha = (remesa.fechaEjecucion || now().slice(0, 10)).replace(/-/g, '');
    const nombreSlug = slugNombreArchivoRemesa(remesa.sociedadNombre);
    const cif = String(remesa.sociedadCif || 'remesa').replace(/[^A-Za-z0-9]/g, '');
    const filename = `remesa-${nombreSlug}-${cif}-${fecha}.xlsx`;

    remesa.estado = 'Generada';
    remesa.generadaEn = now();
    remesa.actualizadoEn = now();
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Ejecutar (registrar pagos) ───

router.post('/remesas/:remesaId/ejecutar', requirePermission('remesas.gestionar'), async (req, res) => {
  if (!(await hasPermission(req.user, 'facturacion.cobrar_pagar'))) {
    return res.status(403).json({ error: 'Permiso facturacion.cobrar_pagar requerido para ejecutar' });
  }

  const fecha = String(req.body?.fecha || '').trim() || now().slice(0, 10);
  if (!RE_FECHA.test(fecha)) return res.status(400).json({ error: 'fecha debe ser YYYY-MM-DD' });

  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (remesa.estado === 'Ejecutada') return res.status(409).json({ error: 'La remesa ya está ejecutada' });
    if (remesa.estado === 'Anulada') return res.status(400).json({ error: 'Remesa anulada' });
    if (!remesa.lineas?.length) return res.status(400).json({ error: 'Sin líneas' });

    const usuario = req.user || {};
    const metodo_pago = String(req.body?.metodo_pago || '').trim() || 'remesa';
    const referencia = String(req.body?.referencia || '').trim() || `Remesa ${remesa.remesaId}`;
    const observacionesGlobal = String(req.body?.observaciones ?? '').trim();

    // Fase 1: validar todas las líneas antes de crear pagos
    for (const linea of remesa.lineas) {
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

    // Fase 2: registrar pagos
    const pagosCreados = [];
    for (const linea of remesa.lineas) {
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
      });
      pagosCreados.push(result.pago);
    }

    remesa.estado = 'Ejecutada';
    remesa.ejecutadaEn = now();
    remesa.actualizadoEn = now();
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));

    res.json({ ok: true, remesa, pagos: pagosCreados });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── Anular ───

router.post('/remesas/:remesaId/anular', requirePermission('remesas.gestionar'), async (req, res) => {
  try {
    const remesa = await getRemesa(req.params.remesaId);
    if (!remesa) return res.status(404).json({ error: 'Remesa no encontrada' });
    if (!['Borrador', 'Generada'].includes(remesa.estado)) {
      return res.status(400).json({ error: 'Solo se anulan remesas en Borrador o Generada' });
    }
    remesa.estado = 'Anulada';
    remesa.actualizadoEn = now();
    await docClient.send(new PutCommand({ TableName: TABLE, Item: remesa }));
    res.json({ remesa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
