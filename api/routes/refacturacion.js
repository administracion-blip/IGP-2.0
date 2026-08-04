/**
 * Módulo Refacturación: líneas pendientes por sociedad destino y emisión
 * de factura OUT en borrador (numeración al emitir desde Facturación).
 *
 * Tabla Igp_Refacturaciones:
 *   PK = SOCIEDAD#<empresa_destino_id>
 *   SK = LINEA#<creado_en_iso>#<uuid>
 * Sin GSI: con empresa_destino_id → Query; sin ella → Scan filtrado (volumen bajo OK).
 */
import { Router } from 'express';
import {
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';
import { formatId6 } from '../lib/usuarioLocales.js';
import {
  getCifFromEmpresaItem,
  getNombreFromEmpresaItem,
} from '../lib/empresaCif.js';
import {
  cargarEmpresasPorId,
  datosEmpresaFiscal,
} from '../lib/facturacion/facturacionPeriodica.js';
import { construirFacturaConLineas } from '../lib/facturacion/construirFactura.js';
import {
  getSerieConfig,
  errorSerieTipoIncompatible,
} from '../lib/facturacion/series.js';
import {
  INCREMENTO_REFACTURACION_PCT,
  recalcularLineaRefacturacion,
  pareceFactura,
} from '../lib/facturacion/refacturacionCalculo.js';

const router = Router();

export { pareceFactura, INCREMENTO_REFACTURACION_PCT };

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function normalizarIdEmpresa(val) {
  const s = val != null ? String(val).trim() : '';
  if (!s) return '';
  const norm = formatId6(s);
  return norm === '000000' ? '' : norm;
}

function pkSociedad(empresaDestinoId) {
  return `SOCIEDAD#${normalizarIdEmpresa(empresaDestinoId) || String(empresaDestinoId).trim()}`;
}

function skLinea(creadoEn, idLinea) {
  return `LINEA#${creadoEn}#${idLinea}`;
}

function usuarioDesdeReq(req, body = {}) {
  const u = req.user || {};
  return {
    id: String(body.usuario_id || u.id_usuario || u.sub || u.email || '').trim(),
    nombre: String(body.usuario_nombre || u.Nombre || u.nombre || u.email || '').trim(),
  };
}

async function queryLineasSociedad(empresaDestinoId, { estado } = {}) {
  const pk = pkSociedad(empresaDestinoId);
  const items = [];
  let lastKey = null;
  const filterParts = [];
  const values = { ':pk': pk };
  const names = {};

  if (estado) {
    filterParts.push('#estado = :estado');
    values[':estado'] = String(estado);
    names['#estado'] = 'estado';
  }

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tables.refacturaciones,
        KeyConditionExpression: 'PK = :pk',
        ...(filterParts.length && {
          FilterExpression: filterParts.join(' AND '),
          ExpressionAttributeNames: names,
        }),
        ExpressionAttributeValues: values,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return items;
}

/**
 * Listado sin sociedad: Scan + FilterExpression.
 * Aceptable mientras el volumen de Igp_Refacturaciones sea bajo; si crece,
 * valorar GSI Estado-index (HASH estado, RANGE empresa_destino_id).
 */
async function scanLineasFiltradas({ estado } = {}) {
  const items = [];
  let lastKey = null;
  const filterParts = [];
  const values = {};
  const names = {};

  if (estado) {
    filterParts.push('#estado = :estado');
    values[':estado'] = String(estado);
    names['#estado'] = 'estado';
  }

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tables.refacturaciones,
        ...(filterParts.length && {
          FilterExpression: filterParts.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return items;
}

/** Localiza una línea por id_linea dentro de una sociedad (Query PK + filtro). */
async function encontrarLineaPorId(empresaDestinoId, idLinea) {
  const pk = pkSociedad(empresaDestinoId);
  let lastKey = null;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tables.refacturaciones,
        KeyConditionExpression: 'PK = :pk',
        FilterExpression: 'id_linea = :id',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':id': String(idLinea),
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    const hit = (result.Items || []).find((i) => String(i.id_linea) === String(idLinea));
    if (hit) return hit;
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return null;
}

function construirItemLinea(raw, { usuario, creadoEn, idLinea }) {
  const empresa_destino_id = normalizarIdEmpresa(raw.empresa_destino_id)
    || String(raw.empresa_destino_id || '').trim();
  if (!empresa_destino_id) {
    throw new Error('empresa_destino_id es obligatorio');
  }
  if (!String(raw.descripcion || '').trim()) {
    throw new Error('descripcion es obligatoria');
  }

  const calc = recalcularLineaRefacturacion(raw);
  const ts = creadoEn || now();
  const id = idLinea || uuid();

  return {
    PK: pkSociedad(empresa_destino_id),
    SK: skLinea(ts, id),
    id_linea: id,
    estado: 'pendiente',
    creado_en: ts,
    creado_por_id: usuario.id,
    creado_por_nombre: usuario.nombre,
    empresa_destino_id,
    empresa_destino_nombre: String(raw.empresa_destino_nombre || '').trim(),
    empresa_destino_cif: String(raw.empresa_destino_cif || '').trim(),
    descripcion: String(raw.descripcion || '').trim(),
    cantidad: calc.cantidad,
    precio_base_unitario: calc.precio_base_unitario,
    incremento_pct: calc.incremento_pct,
    precio_refacturado_unitario: calc.precio_refacturado_unitario,
    tipo_iva: calc.tipo_iva,
    descuento: calc.descuento,
    base_linea: calc.base_linea,
    iva_linea: calc.iva_linea,
    total_linea: calc.total_linea,
    doc_origen_s3_key: String(raw.doc_origen_s3_key || '').trim(),
    doc_origen_nombre: String(raw.doc_origen_nombre || '').trim(),
    proveedor_origen: String(raw.proveedor_origen || '').trim(),
    fecha_documento: String(raw.fecha_documento || '').trim(),
    factura_id: '',
    factura_numero: '',
    refacturada_en: '',
  };
}

// ─── POST /refacturacion/lineas ───
router.post(
  '/refacturacion/lineas',
  requirePermission('refacturacion.gestionar'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const lineasIn = Array.isArray(body.lineas) ? body.lineas : null;
      if (!lineasIn || lineasIn.length === 0) {
        return res.status(400).json({ error: 'lineas[] es obligatorio y no puede estar vacío' });
      }

      const usuario = usuarioDesdeReq(req, body);
      const guardadas = [];

      for (const raw of lineasIn) {
        let item;
        try {
          item = construirItemLinea(raw, { usuario });
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        await docClient.send(
          new PutCommand({ TableName: tables.refacturaciones, Item: item }),
        );
        guardadas.push(item);
      }

      res.json({ ok: true, lineas: guardadas });
    } catch (err) {
      console.error('[refacturacion] POST /lineas:', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── GET /refacturacion/lineas ───
router.get(
  '/refacturacion/lineas',
  requirePermission('refacturacion.ver'),
  async (req, res) => {
    try {
      const empresa_destino_id = String(req.query.empresa_destino_id || '').trim();
      const estado = String(req.query.estado || '').trim();

      let lineas;
      if (empresa_destino_id) {
        lineas = await queryLineasSociedad(empresa_destino_id, {
          estado: estado || undefined,
        });
      } else {
        // Sin sociedad: Scan filtrado (ver comentario en scanLineasFiltradas).
        lineas = await scanLineasFiltradas({ estado: estado || undefined });
      }

      lineas.sort((a, b) => String(b.creado_en || '').localeCompare(String(a.creado_en || '')));
      res.json({ ok: true, lineas });
    } catch (err) {
      console.error('[refacturacion] GET /lineas:', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── PATCH /refacturacion/lineas/:id ───
router.patch(
  '/refacturacion/lineas/:id',
  requirePermission('refacturacion.gestionar'),
  async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const body = req.body || {};
      const empresaActual = String(body.empresa_destino_id || '').trim();
      if (!id) return res.status(400).json({ error: 'id de línea obligatorio' });
      if (!empresaActual) {
        return res.status(400).json({
          error: 'empresa_destino_id actual es obligatorio para localizar la línea',
        });
      }

      const existente = await encontrarLineaPorId(empresaActual, id);
      if (!existente) return res.status(404).json({ error: 'Línea no encontrada' });
      if (existente.estado === 'refacturada') {
        return res.status(400).json({ error: 'No se puede editar una línea ya refacturada' });
      }

      // empresa_destino_id del body = sociedad actual (localizar).
      // Reasignación: empresa_destino_id_nueva / nueva_empresa_destino_id → Delete+Put.
      const nuevaEmpresaRaw = body.empresa_destino_id_nueva ?? body.nueva_empresa_destino_id;
      let empresaDestinoId = normalizarIdEmpresa(existente.empresa_destino_id)
        || String(existente.empresa_destino_id);
      let empresaDestinoNombre = existente.empresa_destino_nombre || '';
      let empresaDestinoCif = existente.empresa_destino_cif || '';

      if (nuevaEmpresaRaw != null && String(nuevaEmpresaRaw).trim()) {
        empresaDestinoId = normalizarIdEmpresa(nuevaEmpresaRaw)
          || String(nuevaEmpresaRaw).trim();
      }
      if (body.empresa_destino_nombre != null) {
        empresaDestinoNombre = String(body.empresa_destino_nombre).trim();
      }
      if (body.empresa_destino_cif != null) {
        empresaDestinoCif = String(body.empresa_destino_cif).trim();
      }

      const camposCalc = {
        cantidad: body.cantidad != null ? body.cantidad : existente.cantidad,
        precio_base_unitario: body.precio_base_unitario != null
          ? body.precio_base_unitario
          : existente.precio_base_unitario,
        tipo_iva: body.tipo_iva != null ? body.tipo_iva : existente.tipo_iva,
        descuento: body.descuento != null
          ? body.descuento
          : (body.descuento_pct != null ? body.descuento_pct : existente.descuento),
      };
      const calc = recalcularLineaRefacturacion(camposCalc);

      let estado = existente.estado;
      if (body.estado === 'descartada') estado = 'descartada';
      else if (body.estado === 'pendiente') estado = 'pendiente';

      const actualizado = {
        ...existente,
        empresa_destino_id: empresaDestinoId,
        empresa_destino_nombre: empresaDestinoNombre,
        empresa_destino_cif: empresaDestinoCif,
        descripcion: body.descripcion != null
          ? String(body.descripcion).trim()
          : existente.descripcion,
        cantidad: calc.cantidad,
        precio_base_unitario: calc.precio_base_unitario,
        incremento_pct: calc.incremento_pct,
        precio_refacturado_unitario: calc.precio_refacturado_unitario,
        tipo_iva: calc.tipo_iva,
        descuento: calc.descuento,
        base_linea: calc.base_linea,
        iva_linea: calc.iva_linea,
        total_linea: calc.total_linea,
        estado,
        modificado_en: now(),
      };

      if (body.doc_origen_s3_key != null) {
        actualizado.doc_origen_s3_key = String(body.doc_origen_s3_key).trim();
      }
      if (body.doc_origen_nombre != null) {
        actualizado.doc_origen_nombre = String(body.doc_origen_nombre).trim();
      }
      if (body.proveedor_origen != null) {
        actualizado.proveedor_origen = String(body.proveedor_origen).trim();
      }
      if (body.fecha_documento != null) {
        actualizado.fecha_documento = String(body.fecha_documento).trim();
      }

      const pkAnterior = existente.PK;
      const skAnterior = existente.SK;
      const pkNuevo = pkSociedad(empresaDestinoId);
      const cambiaSociedad = pkNuevo !== pkAnterior;

      if (cambiaSociedad) {
        // Reasignar sociedad cambia la PK. Put nuevo primero, luego Delete viejo:
        // si Put falla no se pierde; si Delete falla queda duplicado temporal (mejor que perder).
        actualizado.PK = pkNuevo;
        actualizado.SK = skLinea(existente.creado_en || now(), existente.id_linea);
        await docClient.send(
          new PutCommand({ TableName: tables.refacturaciones, Item: actualizado }),
        );
        await docClient.send(
          new DeleteCommand({
            TableName: tables.refacturaciones,
            Key: { PK: pkAnterior, SK: skAnterior },
          }),
        );
      } else {
        actualizado.PK = pkAnterior;
        actualizado.SK = skAnterior;
        await docClient.send(
          new PutCommand({ TableName: tables.refacturaciones, Item: actualizado }),
        );
      }

      res.json({ ok: true, linea: actualizado });
    } catch (err) {
      console.error('[refacturacion] PATCH /lineas/:id:', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── DELETE /refacturacion/lineas/:id ───
router.delete(
  '/refacturacion/lineas/:id',
  requirePermission('refacturacion.gestionar'),
  async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const empresa_destino_id = String(
        req.query.empresa_destino_id || req.body?.empresa_destino_id || '',
      ).trim();
      if (!id) return res.status(400).json({ error: 'id de línea obligatorio' });
      if (!empresa_destino_id) {
        return res.status(400).json({
          error: 'empresa_destino_id es obligatorio (query o body)',
        });
      }

      const existente = await encontrarLineaPorId(empresa_destino_id, id);
      if (!existente) return res.status(404).json({ error: 'Línea no encontrada' });
      if (existente.estado === 'refacturada') {
        return res.status(400).json({ error: 'No se puede borrar una línea ya refacturada' });
      }

      await docClient.send(
        new DeleteCommand({
          TableName: tables.refacturaciones,
          Key: { PK: existente.PK, SK: existente.SK },
        }),
      );

      res.json({ ok: true });
    } catch (err) {
      console.error('[refacturacion] DELETE /lineas/:id:', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── POST /refacturacion/emitir ───
router.post(
  '/refacturacion/emitir',
  requirePermission('refacturacion.gestionar'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const emisor_id = normalizarIdEmpresa(body.emisor_id) || String(body.emisor_id || '').trim();
      const empresa_destino_id = normalizarIdEmpresa(body.empresa_destino_id)
        || String(body.empresa_destino_id || '').trim();
      const serie = String(body.serie || '').trim();
      const fecha_emision = String(body.fecha_emision || now().slice(0, 10)).slice(0, 10);
      const lineas_ids = Array.isArray(body.lineas_ids)
        ? body.lineas_ids.map((x) => String(x).trim()).filter(Boolean)
        : [];

      if (!emisor_id) return res.status(400).json({ error: 'emisor_id es obligatorio' });
      if (!empresa_destino_id) {
        return res.status(400).json({ error: 'empresa_destino_id es obligatorio' });
      }
      if (!serie) return res.status(400).json({ error: 'serie es obligatoria' });
      if (lineas_ids.length === 0) {
        return res.status(400).json({ error: 'lineas_ids[] es obligatorio' });
      }

      // Emisor ≠ destino (decisión de producto cerrada).
      if (normalizarIdEmpresa(emisor_id) === normalizarIdEmpresa(empresa_destino_id)) {
        return res.status(400).json({
          error: 'El emisor y la sociedad destino no pueden ser la misma empresa',
        });
      }

      const idsSet = new Set(lineas_ids);
      const candidatas = await queryLineasSociedad(empresa_destino_id, { estado: 'pendiente' });
      const lineasSel = candidatas.filter((l) => idsSet.has(String(l.id_linea)));
      if (lineasSel.length === 0) {
        return res.status(400).json({
          error: 'No hay líneas pendientes que coincidan con lineas_ids para esa sociedad',
        });
      }
      if (lineasSel.length !== lineas_ids.length) {
        const encontradas = new Set(lineasSel.map((l) => String(l.id_linea)));
        const faltan = lineas_ids.filter((id) => !encontradas.has(id));
        return res.status(400).json({
          error: `Algunas líneas no están pendientes o no pertenecen a la sociedad: ${faltan.join(', ')}`,
        });
      }

      const empresasPorId = await cargarEmpresasPorId();
      const emisorItem = empresasPorId.get(normalizarIdEmpresa(emisor_id));
      const destinoItem = empresasPorId.get(normalizarIdEmpresa(empresa_destino_id));
      if (!emisorItem) {
        return res.status(404).json({ error: `Empresa emisora "${emisor_id}" no encontrada` });
      }
      if (!destinoItem) {
        return res.status(404).json({
          error: `Empresa destino "${empresa_destino_id}" no encontrada`,
        });
      }

      const emisora = datosEmpresaFiscal(emisorItem);
      const receptora = datosEmpresaFiscal(destinoItem);
      // Fallback de nombre/CIF desde la línea si el maestro viniera incompleto.
      if (!receptora.nombre) {
        receptora.nombre = lineasSel[0].empresa_destino_nombre || getNombreFromEmpresaItem(destinoItem);
      }
      if (!receptora.cif) {
        receptora.cif = lineasSel[0].empresa_destino_cif || getCifFromEmpresaItem(destinoItem);
      }

      const serieConfig = await getSerieConfig(serie);
      if (!serieConfig) {
        return res.status(404).json({ error: `Serie "${serie}" no encontrada` });
      }
      const errorTipoSerie = errorSerieTipoIncompatible(serieConfig, 'OUT');
      if (errorTipoSerie) return res.status(400).json({ error: errorTipoSerie });

      const usuario = usuarioDesdeReq(req, body);
      const id_factura = uuid();

      const lineasFactura = lineasSel.map((l) => ({
        descripcion: l.descripcion,
        cantidad: l.cantidad,
        precio_unitario: l.precio_refacturado_unitario,
        descuento_pct: l.descuento || 0,
        tipo_iva: l.tipo_iva,
      }));

      // Borrador OUT: numero=0 / numero_factura=''. NO llamar emitirOValidarFacturaPorId;
      // el correlativo se reserva al emitir desde Facturación.
      const { factura, lineas: lineasToSave } = construirFacturaConLineas({
        id_factura,
        numero: 0,
        numero_factura: '',
        datos: {
          tipo: 'OUT',
          serie,
          emisor_id: emisora.id || emisor_id,
          emisor_nombre: emisora.nombre,
          emisor_cif: emisora.cif,
          emisor_direccion: emisora.direccion,
          emisor_cp: emisora.cp,
          emisor_municipio: emisora.municipio,
          emisor_provincia: emisora.provincia,
          emisor_email: emisora.email,
          emisor_iban: emisora.iban,
          emisor_iban_alternativo: emisora.iban_alternativo,
          empresa_id: receptora.id || empresa_destino_id,
          empresa_nombre: receptora.nombre,
          empresa_cif: receptora.cif,
          empresa_direccion: receptora.direccion,
          empresa_cp: receptora.cp,
          empresa_municipio: receptora.municipio,
          empresa_provincia: receptora.provincia,
          empresa_email: receptora.email,
          fecha_emision,
          fecha_operacion: fecha_emision,
          observaciones: 'Refacturación entre sociedades del grupo',
          lineas: lineasFactura,
          usuario_id: usuario.id,
          usuario_nombre: usuario.nombre,
        },
      });

      // Campos de trazabilidad propios del módulo (construirFactura no los copia).
      factura.origen_refacturacion = true;
      factura.refacturacion_lineas_ids = lineasSel.map((l) => l.id_linea);

      await docClient.send(new PutCommand({ TableName: tables.facturas, Item: factura }));
      for (const linea of lineasToSave) {
        await docClient.send(
          new PutCommand({ TableName: tables.facturasLineas, Item: linea }),
        );
      }

      // Marcar líneas como refacturada solo si siguen pendientes (anti doble emisión).
      // factura_numero puede quedar vacío (borrador). Si ConditionExpression falla tras
      // crear la factura → 409 con factura_id (puede quedar borrador huérfano; mejor que 2 facturas).
      const refacturada_en = now();
      for (const l of lineasSel) {
        const marcado = {
          ...l,
          estado: 'refacturada',
          factura_id: id_factura,
          factura_numero: '',
          refacturada_en,
        };
        try {
          await docClient.send(
            new PutCommand({
              TableName: tables.refacturaciones,
              Item: marcado,
              ConditionExpression: '#estado = :pendiente',
              ExpressionAttributeNames: { '#estado': 'estado' },
              ExpressionAttributeValues: { ':pendiente': 'pendiente' },
            }),
          );
        } catch (e) {
          if (e?.name === 'ConditionalCheckFailedException') {
            console.error(
              '[refacturacion] conflicto al marcar línea tras emitir:',
              l.id_linea,
              e.message,
            );
            return res.status(409).json({
              error:
                'Conflicto: alguna línea ya no estaba pendiente (posible emisión concurrente). '
                + 'Puede haber quedado un borrador de factura huérfano; no reintentar a ciegas.',
              factura_id: id_factura,
              linea_conflicto: l.id_linea,
            });
          }
          throw e;
        }
      }

      res.json({
        ok: true,
        factura,
        factura_id: id_factura,
      });
    } catch (err) {
      console.error('[refacturacion] POST /emitir:', err);
      res.status(500).json({ error: err.message });
    }
  },
);

export default router;
