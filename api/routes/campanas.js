/**
 * Incentivos por producto — campañas de incentivo (Igp_Campanas).
 *
 * Permisos:
 *  - incentivos_producto.ver — listar y ver resultados
 *  - incentivos_producto.gestionar — crear, editar, activar, archivar
 *  - incentivos_producto.exportar — exportar informes (UI)
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import {
  ScanCommand,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { requirePermission } from '../middleware/auth.js';
import {
  calcularResultadosCampana,
  defaultBaselinePeriod,
  resolverMargenesProductos,
  round2,
} from '../lib/campanas/campanaResultados.js';
import { daysBetweenInclusive } from '../lib/dynamo/ventasProducto.js';

const router = Router();
const TABLE = tables.campanas;

const ESTADOS = ['Borrador', 'Activa', 'Finalizada', 'Archivada'];
const TIPOS_INCENTIVO = ['eur_por_unidad', 'pct_margen'];
const DESTINATARIOS = ['individual', 'equipo'];
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const CAMPOS_INMUTABLES_ACTIVA = new Set([
  'productos', 'locales', 'fechaInicio', 'fechaFin',
  'baselineInicio', 'baselineFin', 'tipoIncentivo', 'valorIncentivo', 'destinatario',
]);

async function scanCampanas() {
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

function normalizarProductos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      const productId = String(p?.productId ?? p?.id ?? '').trim();
      if (!productId) return null;
      const out = {
        productId,
        productName: String(p?.productName ?? p?.name ?? productId).trim(),
      };
      if (p?.margenUnitario != null && p?.margenUnitario !== '') {
        out.margenUnitario = round2(Number(p.margenUnitario));
      }
      return out;
    })
    .filter(Boolean);
}

function normalizarLocales(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((l) => String(l).trim()).filter(Boolean))];
}

function validarCampanaPayload(body, { esCreacion = false, existente = null } = {}) {
  const errors = [];
  const avisos = [];

  const nombre = String(body.nombre ?? existente?.nombre ?? '').trim();
  if (!nombre) errors.push('nombre es obligatorio');

  const fechaInicio = String(body.fechaInicio ?? existente?.fechaInicio ?? '').trim();
  const fechaFin = String(body.fechaFin ?? existente?.fechaFin ?? '').trim();
  if (!RE_FECHA.test(fechaInicio)) errors.push('fechaInicio debe ser YYYY-MM-DD');
  if (!RE_FECHA.test(fechaFin)) errors.push('fechaFin debe ser YYYY-MM-DD');
  if (RE_FECHA.test(fechaInicio) && RE_FECHA.test(fechaFin) && fechaInicio > fechaFin) {
    errors.push('fechaInicio no puede ser posterior a fechaFin');
  }

  let baselineInicio = String(body.baselineInicio ?? existente?.baselineInicio ?? '').trim();
  let baselineFin = String(body.baselineFin ?? existente?.baselineFin ?? '').trim();
  if (esCreacion && RE_FECHA.test(fechaInicio) && RE_FECHA.test(fechaFin)) {
    if (!baselineInicio || !baselineFin) {
      const def = defaultBaselinePeriod(fechaInicio, fechaFin);
      baselineInicio = def.baselineInicio;
      baselineFin = def.baselineFin;
    }
  }
  if (!RE_FECHA.test(baselineInicio)) errors.push('baselineInicio debe ser YYYY-MM-DD');
  if (!RE_FECHA.test(baselineFin)) errors.push('baselineFin debe ser YYYY-MM-DD');
  if (RE_FECHA.test(baselineInicio) && RE_FECHA.test(baselineFin) && baselineInicio > baselineFin) {
    errors.push('baselineInicio no puede ser posterior a baselineFin');
  }

  const productos = body.productos !== undefined
    ? normalizarProductos(body.productos)
    : normalizarProductos(existente?.productos);
  const locales = body.locales !== undefined
    ? normalizarLocales(body.locales)
    : normalizarLocales(existente?.locales);

  if (productos.length === 0) errors.push('al menos un producto es obligatorio');
  if (locales.length === 0) errors.push('al menos un local es obligatorio');

  const tipoIncentivo = String(body.tipoIncentivo ?? existente?.tipoIncentivo ?? '').trim();
  if (!TIPOS_INCENTIVO.includes(tipoIncentivo)) {
    errors.push(`tipoIncentivo debe ser ${TIPOS_INCENTIVO.join(' o ')}`);
  }

  const valorIncentivo = toNumber(body.valorIncentivo ?? existente?.valorIncentivo);
  if (!(valorIncentivo > 0)) errors.push('valorIncentivo debe ser mayor que 0');

  const destinatario = String(body.destinatario ?? existente?.destinatario ?? 'equipo').trim();
  if (!DESTINATARIOS.includes(destinatario)) {
    errors.push(`destinatario debe ser ${DESTINATARIOS.join(' o ')}`);
  }

  const estado = String(body.estado ?? existente?.estado ?? 'Borrador').trim();
  if (!ESTADOS.includes(estado)) errors.push(`estado debe ser uno de: ${ESTADOS.join(', ')}`);

  if (RE_FECHA.test(fechaInicio) && RE_FECHA.test(fechaFin)) {
    const dias = daysBetweenInclusive(fechaInicio, fechaFin);
    if (dias > 56) avisos.push('duracion_superior_8_semanas');
  }

  return {
    errors,
    avisos,
    data: {
      nombre,
      fechaInicio,
      fechaFin,
      baselineInicio,
      baselineFin,
      productos,
      locales,
      tipoIncentivo,
      valorIncentivo,
      destinatario,
      estado,
      notas: body.notas !== undefined
        ? String(body.notas ?? '').trim()
        : String(existente?.notas ?? '').trim(),
    },
  };
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function limpiarProductosParaGuardar(productos) {
  return productos.map(({ productId, productName, margenUnitario }) => {
    const out = { productId, productName };
    if (margenUnitario != null) out.margenUnitario = margenUnitario;
    return out;
  });
}

router.get('/campanas', requirePermission('incentivos_producto.ver'), async (req, res) => {
  try {
    const estado = String(req.query.estado || '').trim();
    let items = await scanCampanas();
    if (estado) items = items.filter((c) => String(c.estado) === estado);
    items.sort((a, b) => (b.creadoEn || '').localeCompare(a.creadoEn || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[campanas GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar campañas' });
  }
});

router.get('/campanas/:campanaId', requirePermission('incentivos_producto.ver'), async (req, res) => {
  try {
    const campanaId = String(req.params.campanaId).trim();
    const r = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));
    if (!r.Item) return res.status(404).json({ error: 'Campaña no encontrada' });
    return res.json({ ok: true, item: r.Item });
  } catch (err) {
    console.error('[campanas GET :id]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al cargar campaña' });
  }
});

router.get('/campanas/:campanaId/resultados', requirePermission('incentivos_producto.ver'), async (req, res) => {
  try {
    const campanaId = String(req.params.campanaId).trim();
    const r = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));
    if (!r.Item) return res.status(404).json({ error: 'Campaña no encontrada' });

    const resultados = await calcularResultadosCampana(docClient, r.Item);
    return res.json({ ok: true, campanaId, ...resultados });
  } catch (err) {
    console.error('[campanas resultados]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al calcular resultados' });
  }
});

router.post('/campanas', requirePermission('incentivos_producto.gestionar'), async (req, res) => {
  try {
    const body = req.body || {};
    const { errors, avisos, data } = validarCampanaPayload(body, { esCreacion: true });
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    const { productos: productosResueltos, warnings: margenWarnings } =
      await resolverMargenesProductos(docClient, data.productos);

    const now = new Date().toISOString();
    const campanaId = crypto.randomUUID();
    const item = {
      campanaId,
      nombre: data.nombre,
      estado: data.estado === 'Activa' ? 'Activa' : 'Borrador',
      locales: data.locales,
      productos: limpiarProductosParaGuardar(productosResueltos),
      fechaInicio: data.fechaInicio,
      fechaFin: data.fechaFin,
      tipoIncentivo: data.tipoIncentivo,
      valorIncentivo: data.valorIncentivo,
      destinatario: data.destinatario,
      baselineInicio: data.baselineInicio,
      baselineFin: data.baselineFin,
      notas: data.notas || undefined,
      creadoPor: String(req.user?.email ?? req.user?.Nombre ?? req.user?.id_usuario ?? '').trim() || undefined,
      creadoEn: now,
      actualizadoEn: now,
    };

    await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));

    const responseWarnings = [...margenWarnings];
    if (avisos.length > 0) responseWarnings.push(...avisos);

    return res.status(201).json({
      ok: true,
      campanaId,
      item,
      warnings: responseWarnings.length > 0 ? responseWarnings : undefined,
    });
  } catch (err) {
    console.error('[campanas POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear campaña' });
  }
});

router.patch('/campanas/:campanaId', requirePermission('incentivos_producto.gestionar'), async (req, res) => {
  try {
    const campanaId = String(req.params.campanaId).trim();
    const body = req.body || {};

    const existing = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));
    if (!existing.Item) return res.status(404).json({ error: 'Campaña no encontrada' });

    const estadoActual = String(existing.Item.estado || 'Borrador');
    if (estadoActual === 'Activa') {
      for (const campo of CAMPOS_INMUTABLES_ACTIVA) {
        if (body[campo] !== undefined) {
          return res.status(400).json({
            error: `No se puede modificar "${campo}" en una campaña Activa. Finalízala y crea otra.`,
          });
        }
      }
    }

    const merged = { ...existing.Item, ...body };
    const { errors, avisos, data } = validarCampanaPayload(merged, { existente: existing.Item });
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    let productosGuardar = limpiarProductosParaGuardar(data.productos);
    const margenWarnings = [];
    if (body.productos !== undefined) {
      const resolved = await resolverMargenesProductos(docClient, data.productos);
      productosGuardar = limpiarProductosParaGuardar(resolved.productos);
      margenWarnings.push(...resolved.warnings);
    }

    const updates = [];
    const names = {};
    const values = {};
    const setField = (key, val) => {
      const nk = `#${key}`;
      const vk = `:${key}`;
      names[nk] = key;
      values[vk] = val;
      updates.push(`${nk} = ${vk}`);
    };

    if (body.nombre !== undefined) setField('nombre', data.nombre);
    if (body.estado !== undefined) setField('estado', data.estado);
    if (body.locales !== undefined) setField('locales', data.locales);
    if (body.productos !== undefined) setField('productos', productosGuardar);
    if (body.fechaInicio !== undefined) setField('fechaInicio', data.fechaInicio);
    if (body.fechaFin !== undefined) setField('fechaFin', data.fechaFin);
    if (body.baselineInicio !== undefined) setField('baselineInicio', data.baselineInicio);
    if (body.baselineFin !== undefined) setField('baselineFin', data.baselineFin);
    if (body.tipoIncentivo !== undefined) setField('tipoIncentivo', data.tipoIncentivo);
    if (body.valorIncentivo !== undefined) setField('valorIncentivo', data.valorIncentivo);
    if (body.destinatario !== undefined) setField('destinatario', data.destinatario);
    if (body.notas !== undefined) setField('notas', data.notas);

    if (updates.length === 0) {
      return res.json({ ok: true, campanaId, item: existing.Item });
    }

    setField('actualizadoEn', new Date().toISOString());

    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { campanaId },
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));

    const updated = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));

    const responseWarnings = [...margenWarnings, ...avisos];

    return res.json({
      ok: true,
      campanaId,
      item: updated.Item,
      warnings: responseWarnings.length > 0 ? responseWarnings : undefined,
    });
  } catch (err) {
    console.error('[campanas PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar campaña' });
  }
});

router.delete('/campanas/:campanaId', requirePermission('incentivos_producto.gestionar'), async (req, res) => {
  try {
    const campanaId = String(req.params.campanaId).trim();
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));
    if (!existing.Item) return res.status(404).json({ error: 'Campaña no encontrada' });

    const estado = String(existing.Item.estado || '');
    if (!['Borrador', 'Archivada'].includes(estado)) {
      return res.status(400).json({
        error: 'Solo se pueden borrar campañas en estado Borrador o Archivada',
      });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));

    return res.json({ ok: true, campanaId });
  } catch (err) {
    console.error('[campanas DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al borrar campaña' });
  }
});

export default router;
