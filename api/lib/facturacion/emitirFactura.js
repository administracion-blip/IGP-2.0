import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables, keyForFacturaPrincipalId } from '../db.js';
import { queryLineasByFactura } from '../dynamo/facturasRelacionadas.js';
import crypto from 'crypto';

function now() {
  return new Date().toISOString();
}

function computeHash(factura) {
  const payload = JSON.stringify({
    id: factura.id_factura,
    serie: factura.serie,
    numero: factura.numero,
    tipo: factura.tipo,
    empresa_cif: factura.empresa_cif,
    fecha_emision: factura.fecha_emision,
    base_imponible: factura.base_imponible,
    total_iva: factura.total_iva,
    total_factura: factura.total_factura,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function registrarAuditoria(id_factura, accion, usuario_id, usuario_nombre, detalle) {
  const id_entrada = `AUD-${id_factura}-${Date.now()}`;
  await docClient.send(
    new PutCommand({
      TableName: tables.facturasAuditoria,
      Item: {
        id_entrada,
        id_factura,
        timestamp_accion: now(),
        accion,
        usuario_id: usuario_id || '',
        usuario_nombre: usuario_nombre || '',
        detalle: typeof detalle === 'string' ? detalle : JSON.stringify(detalle || {}),
      },
    }),
  );
}

/**
 * Valida si una factura puede emitirse o validarse (revisión OCR).
 * @returns {string[]} lista de errores (vacía = OK)
 */
export function validarDatosEmision(factura, lineas) {
  const errores = [];
  if (factura.tipo === 'IN') {
    if (!factura.emisor_nombre && !factura.emisor_cif) {
      errores.push('Datos de la empresa del grupo (ordenante) son obligatorios');
    }
    if (!factura.empresa_nombre && !factura.empresa_cif) {
      errores.push('Datos del proveedor (nombre o CIF) son obligatorios');
    }
  } else {
    if (!factura.empresa_nombre && !factura.empresa_cif) errores.push('Datos de empresa (nombre o CIF) obligatorios');
    if (!factura.empresa_cif) errores.push('CIF/NIF del cliente es obligatorio para facturas de venta');
  }
  if (!factura.fecha_emision) errores.push('La fecha de emisión es obligatoria');
  if (factura.tipo === 'OUT' && !factura.serie) errores.push('La serie es obligatoria');
  if ((factura.total_factura || 0) === 0) errores.push('La factura no puede tener importe 0');

  if (factura.tipo === 'OUT' && lineas.length === 0) errores.push('La factura debe tener al menos una línea');

  for (const l of lineas) {
    if (!l.descripcion) errores.push(`Línea ${l.id_linea}: falta descripción`);
    if ((l.cantidad || 0) <= 0) errores.push(`Línea ${l.id_linea}: cantidad debe ser mayor que 0`);
  }
  return errores;
}

/**
 * Emite o valida revisión de una factura por id.
 * @returns {Promise<{ ok: true, factura, esValidacionRevision } | { ok: false, status: number, error?: string, errores?: string[] }>}
 */
export async function emitirOValidarFacturaPorId(id, { usuario_id = '', usuario_nombre = '', soloRevision = false } = {}) {
  const existing = await docClient.send(
    new GetCommand({ TableName: tables.facturas, Key: await keyForFacturaPrincipalId(id) }),
  );
  if (!existing.Item) {
    return { ok: false, status: 404, error: 'Factura no encontrada' };
  }
  const factura = { ...existing.Item };

  const esValidacionRevision = factura.tipo === 'IN' && factura.estado === 'pendiente_revision';

  if (soloRevision) {
    if (!esValidacionRevision) {
      return {
        ok: false,
        status: 400,
        error: 'Solo se pueden validar facturas de gasto en pendiente de revisión',
      };
    }
  } else {
    const puedeEmitir = factura.estado === 'borrador' || esValidacionRevision;
    if (!puedeEmitir) {
      return {
        ok: false,
        status: 400,
        error: factura.tipo === 'IN'
          ? 'Solo se pueden emitir facturas en borrador o validar las pendientes de revisión'
          : 'Solo se pueden emitir facturas en borrador',
      };
    }
  }

  const lineas = await queryLineasByFactura(id);
  const errores = validarDatosEmision(factura, lineas);
  if (errores.length > 0) {
    return { ok: false, status: 400, error: 'Validación fiscal fallida', errores };
  }

  factura.estado = 'emitida';
  if (factura.tipo === 'IN') factura.estado = 'pendiente_pago';

  if (!factura.fecha_vencimiento && factura.condiciones_pago) {
    const diasMap = { contado: 0, '15_dias': 15, '30_dias': 30, '60_dias': 60, '90_dias': 90 };
    const dias = diasMap[factura.condiciones_pago];
    if (dias != null) {
      const base = new Date(factura.fecha_emision || now().slice(0, 10));
      base.setDate(base.getDate() + dias);
      factura.fecha_vencimiento = base.toISOString().slice(0, 10);
    }
  }

  factura.modificado_por = usuario_id || '';
  factura.modificado_en = now();
  factura.version = (factura.version || 1) + 1;

  factura.verifactu_hash = computeHash(factura);
  factura.verifactu_registro_alta = JSON.stringify({
    id_factura: factura.id_factura,
    fecha_emision: factura.fecha_emision,
    hash: factura.verifactu_hash,
    timestamp: now(),
  });

  await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
  const accionAuditoria = esValidacionRevision ? 'validacion_revision' : 'emision';
  await registrarAuditoria(id, accionAuditoria, usuario_id, usuario_nombre, {
    estado: factura.estado,
    hash: factura.verifactu_hash,
    estado_anterior: esValidacionRevision ? 'pendiente_revision' : 'borrador',
  });

  return { ok: true, factura, esValidacionRevision };
}
