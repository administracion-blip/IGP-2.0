/**
 * Incentivos por producto — campañas de incentivo (Igp_Campanas).
 *
 * Permisos:
 *  - incentivos_producto.ver — listar y ver resultados
 *  - incentivos_producto.gestionar — crear, cerrar RRHH, archivar
 *  - incentivos_producto.editar — editar campaña (gestionar también vale)
 *  - incentivos_producto.borrar — borrar campaña (gestionar también vale)
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
import { requirePermission, hasPermission } from '../middleware/auth.js';
import {
  calcularResultadosCampana,
  resolverMargenesProductos,
  round2,
} from '../lib/campanas/campanaResultados.js';
import { campanaEnriquecida, campanaSePuedeBorrar, estadoEfectivo } from '../lib/campanas/campanaEstado.js';
import { daysBetweenInclusive, queryVentasPorLocalRango, getLastSalesLinesSync } from '../lib/dynamo/ventasProducto.js';

const router = Router();
const TABLE = tables.campanas;

// pct_coste: nuevo modelo (% sobre precio de compra). pct_margen: compatibilidad con campañas antiguas.
const TIPOS_INCENTIVO = ['eur_por_unidad', 'pct_coste', 'pct_margen'];
const DESTINATARIOS = ['individual', 'equipo'];
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const CAMPOS_INMUTABLES_ACTIVA = new Set([
  'productos', 'locales', 'fechaInicio', 'fechaFin',
  'tipoIncentivo', 'valorIncentivo', 'destinatario',
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

  let valorIncentivo = toNumber(body.valorIncentivo ?? existente?.valorIncentivo);
  if (!(valorIncentivo > 0)) errors.push('valorIncentivo debe ser mayor que 0');
  // Si escriben 10 para 10 %, normalizar a fracción 0.10
  if (['pct_coste', 'pct_margen'].includes(tipoIncentivo) && valorIncentivo > 1) {
    valorIncentivo = round2(valorIncentivo / 100);
  }

  const destinatario = String(body.destinatario ?? existente?.destinatario ?? 'equipo').trim();
  if (!DESTINATARIOS.includes(destinatario)) {
    errors.push(`destinatario debe ser ${DESTINATARIOS.join(' o ')}`);
  }

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
      productos,
      locales,
      tipoIncentivo,
      valorIncentivo,
      destinatario,
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
    let items = (await scanCampanas()).map(campanaEnriquecida);
    if (estado) items = items.filter((c) => c.estado === estado);
    items.sort((a, b) => (b.creadoEn || '').localeCompare(a.creadoEn || ''));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[campanas GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar campañas' });
  }
});

router.get('/campanas/ventas-sync', requirePermission('incentivos_producto.ver'), async (req, res) => {
  try {
    const lastSyncTs = await getLastSalesLinesSync(docClient);
    const lastSync = lastSyncTs ? new Date(lastSyncTs).toISOString() : null;
    const hoursSince = lastSyncTs != null
      ? Math.round((Date.now() - lastSyncTs) / (60 * 60 * 1000))
      : null;
    const stale = lastSyncTs == null || (hoursSince != null && hoursSince > 36);
    return res.json({ ok: true, lastSync, stale, hoursSince });
  } catch (err) {
    console.error('[campanas ventas-sync]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al consultar sync de ventas' });
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
    return res.json({ ok: true, item: campanaEnriquecida(r.Item) });
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
      locales: data.locales,
      productos: limpiarProductosParaGuardar(productosResueltos),
      fechaInicio: data.fechaInicio,
      fechaFin: data.fechaFin,
      tipoIncentivo: data.tipoIncentivo,
      valorIncentivo: data.valorIncentivo,
      destinatario: data.destinatario,
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
      item: campanaEnriquecida(item),
      warnings: responseWarnings.length > 0 ? responseWarnings : undefined,
    });
  } catch (err) {
    console.error('[campanas POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear campaña' });
  }
});

router.patch('/campanas/:campanaId', requirePermission('incentivos_producto.editar'), async (req, res) => {
  try {
    const campanaId = String(req.params.campanaId).trim();
    const body = req.body || {};

    const existing = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));
    if (!existing.Item) return res.status(404).json({ error: 'Campaña no encontrada' });

    if (body.estado !== undefined) {
      return res.status(400).json({
        error: 'El estado se calcula automáticamente según las fechas. Use archivar: true para archivar manualmente.',
      });
    }

    if (body.archivar === true || body.bonificar === true) {
      if (!(await hasPermission(req.user, 'incentivos_producto.gestionar'))) {
        return res.status(403).json({ error: 'Permiso insuficiente para cerrar o archivar campañas' });
      }
    }

    if (body.archivar === true) {
      if (estadoEfectivo(existing.Item) === 'Archivada') {
        return res.json({ ok: true, campanaId, item: campanaEnriquecida(existing.Item) });
      }
      if (estadoEfectivo(existing.Item) !== 'Bonificada') {
        return res.status(400).json({
          error: 'Solo se pueden archivar campañas revisadas y cerradas por RRHH (Bonificada).',
        });
      }
      const now = new Date().toISOString();
      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: { campanaId },
        UpdateExpression: 'SET archivadaManual = :am, archivadaEn = :ae, actualizadoEn = :u',
        ExpressionAttributeValues: {
          ':am': true,
          ':ae': now,
          ':u': now,
        },
      }));
      const updated = await docClient.send(new GetCommand({ TableName: TABLE, Key: { campanaId } }));
      return res.json({ ok: true, campanaId, item: campanaEnriquecida(updated.Item) });
    }

    if (body.bonificar === true) {
      if (estadoEfectivo(existing.Item) !== 'Finalizada') {
        return res.status(400).json({
          error: 'Solo se pueden cerrar campañas finalizadas pendientes de revisión RRHH.',
        });
      }
      const now = new Date().toISOString();
      const userId = req.user?.id_usuario ?? req.user?.id ?? null;
      const notas = body.bonificacionNotas != null ? String(body.bonificacionNotas).trim() : '';
      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: { campanaId },
        UpdateExpression: 'SET bonificadaEn = :be, bonificadaPor = :bp, actualizadoEn = :u'
          + (notas ? ', bonificacionNotas = :bn' : ''),
        ExpressionAttributeValues: {
          ':be': now,
          ':bp': userId != null ? String(userId) : '',
          ':u': now,
          ...(notas ? { ':bn': notas } : {}),
        },
      }));
      const updated = await docClient.send(new GetCommand({ TableName: TABLE, Key: { campanaId } }));
      return res.json({ ok: true, campanaId, item: campanaEnriquecida(updated.Item) });
    }

    if (estadoEfectivo(existing.Item) === 'Activa') {
      for (const campo of CAMPOS_INMUTABLES_ACTIVA) {
        if (body[campo] !== undefined) {
          return res.status(400).json({
            error: `No se puede modificar "${campo}" en una campaña en curso (Activa). Amplíe fechas antes del inicio o cree otra campaña.`,
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
    if (body.locales !== undefined) setField('locales', data.locales);
    if (body.productos !== undefined) setField('productos', productosGuardar);
    if (body.fechaInicio !== undefined) setField('fechaInicio', data.fechaInicio);
    if (body.fechaFin !== undefined) setField('fechaFin', data.fechaFin);
    if (body.tipoIncentivo !== undefined) setField('tipoIncentivo', data.tipoIncentivo);
    if (body.valorIncentivo !== undefined) setField('valorIncentivo', data.valorIncentivo);
    if (body.destinatario !== undefined) setField('destinatario', data.destinatario);
    if (body.notas !== undefined) setField('notas', data.notas);

    if (updates.length === 0) {
      return res.json({ ok: true, campanaId, item: campanaEnriquecida(existing.Item) });
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
      item: campanaEnriquecida(updated.Item),
      warnings: responseWarnings.length > 0 ? responseWarnings : undefined,
    });
  } catch (err) {
    console.error('[campanas PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar campaña' });
  }
});

router.delete('/campanas/:campanaId', requirePermission('incentivos_producto.borrar'), async (req, res) => {
  try {
    const campanaId = String(req.params.campanaId).trim();
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { campanaId },
    }));
    if (!existing.Item) return res.status(404).json({ error: 'Campaña no encontrada' });

    if (!campanaSePuedeBorrar(existing.Item)) {
      return res.status(400).json({
        error: 'No se puede borrar una campaña cerrada por RRHH (Bonificada). Archívela primero.',
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

/**
 * Detalle de ventas de la campaña: líneas agregadas (día/producto/camarero),
 * agrupadas por local y, dentro, por usuario, con líneas ordenadas por fecha.
 */
router.get('/campanas/:campanaId/ventas-detalle', requirePermission('incentivos_producto.ver'), async (req, res) => {
  try {
    const campanaId = String(req.params.campanaId).trim();
    const r = await docClient.send(new GetCommand({ TableName: TABLE, Key: { campanaId } }));
    if (!r.Item) return res.status(404).json({ error: 'Campaña no encontrada' });
    const campana = r.Item;

    const locales = Array.isArray(campana.locales) ? campana.locales.map(String) : [];
    const productos = Array.isArray(campana.productos) ? campana.productos : [];
    const productIds = new Set(
      productos.map((p) => String(p.productId || '').trim()).filter(Boolean),
    );
    const fechaInicio = String(campana.fechaInicio || '').trim();
    const fechaFin = String(campana.fechaFin || '').trim();
    const tipoIncentivo = String(campana.tipoIncentivo || '').trim();
    let valorIncentivo = Number(campana.valorIncentivo) || 0;
    if (['pct_coste', 'pct_margen'].includes(tipoIncentivo) && valorIncentivo > 1) {
      valorIncentivo = round2(valorIncentivo / 100);
    }

    // Coste por producto (para el incentivo por línea)
    const costeMap = new Map();
    for (const pid of productIds) {
      const pr = await docClient.send(new GetCommand({
        TableName: tables.agoraProducts,
        Key: { PK: 'GLOBAL', SK: pid },
      }));
      costeMap.set(pid, Number(pr.Item?.CostPrice) || 0);
    }

    const incentivoLinea = (uds, costeUnitario) => {
      if (!(uds > 0) || !(valorIncentivo > 0)) return 0;
      if (tipoIncentivo === 'eur_por_unidad') return round2(uds * valorIncentivo);
      if (tipoIncentivo === 'pct_coste') return round2(uds * costeUnitario * valorIncentivo);
      return 0; // pct_margen no se detalla por línea (requiere margen medio)
    };

    const porLocal = [];
    for (const localId of locales) {
      const rows = (await queryVentasPorLocalRango(docClient, localId, fechaInicio, fechaFin))
        .filter((row) => productIds.has(String(row.ProductId)));

      const userMap = new Map();
      for (const row of rows) {
        const uid = String(row.AgoraUserId || '0');
        if (!userMap.has(uid)) {
          userMap.set(uid, {
            agoraUserId: uid,
            userName: String(row.UserName || '').trim() || null,
            lineas: [],
            totalUnidades: 0,
            totalImporte: 0,
            totalIncentivo: 0,
          });
        }
        const u = userMap.get(uid);
        const uds = Number(row.Unidades) || 0;
        const importe = Number(row.ImporteBruto) || 0;
        const coste = costeMap.get(String(row.ProductId)) || 0;
        const inc = incentivoLinea(uds, coste);
        u.lineas.push({
          fecha: String(row.Fecha || ''),
          productId: String(row.ProductId || ''),
          productName: String(row.ProductName || row.ProductId || ''),
          unidades: uds,
          importe: round2(importe),
          incentivo: inc,
        });
        u.totalUnidades += uds;
        u.totalImporte = round2(u.totalImporte + importe);
        u.totalIncentivo = round2(u.totalIncentivo + inc);
        if (!u.userName && row.UserName) u.userName = String(row.UserName).trim();
      }

      const porUsuario = [...userMap.values()]
        .map((u) => ({
          ...u,
          lineas: u.lineas.sort((a, b) => a.fecha.localeCompare(b.fecha)),
        }))
        .sort((a, b) => b.totalIncentivo - a.totalIncentivo);

      porLocal.push({
        localId,
        porUsuario,
        totalUnidades: round2(porUsuario.reduce((a, u) => a + u.totalUnidades, 0)),
        totalIncentivo: round2(porUsuario.reduce((a, u) => a + u.totalIncentivo, 0)),
      });
    }

    return res.json({ ok: true, campanaId, tipoIncentivo, valorIncentivo, porLocal });
  } catch (err) {
    console.error('[campanas ventas-detalle]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al cargar detalle de ventas' });
  }
});

export default router;
