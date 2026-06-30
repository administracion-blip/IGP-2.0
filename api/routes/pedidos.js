import express from 'express';
import { ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { hasPermission } from '../middleware/auth.js';
import { resolveTotalAportacionUnitaria } from '../lib/pedidos/rappelAcuerdo.js';

const router = express.Router();

const ESTADO_BORRADOR = 'Borrador';
const MAX_REINTENTOS_ID = 25;

/** Año (4 cifras) desde Fecha en ISO (YYYY-MM-DD) o dd/mm/aaaa; null si no se reconoce. */
function añoDesdeFecha(fecha) {
  const t = String(fecha ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return parseInt(t.slice(0, 4), 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return parseInt(m[3], 10);
  const m2 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) {
    let y = parseInt(m2[3], 10);
    if (y < 100) y += 2000;
    return y;
  }
  return null;
}

function buildPedidoId(año, n) {
  return `PED-${año}-${String(n).padStart(5, '0')}`;
}

/** Normaliza una fecha de pedido (ISO o dd/mm/aaaa) a 'YYYY-MM-DD'; '' si no se reconoce. */
function fechaPedidoToIso(fecha) {
  const s = String(fecha ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) return `20${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return '';
}

/** Mayor secuencial usado para PED-AAAA-NNNNN en un año (0 si no hay ninguno). */
async function maxSecuencialPedidoAño(año) {
  const re = new RegExp(`^PED-${año}-(\\d+)$`, 'i');
  let max = 0;
  let lastKey = null;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tables.pedidos,
      ProjectionExpression: 'Id',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const it of result.Items || []) {
      const m = String(it.Id ?? '').match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n)) max = Math.max(max, n);
      }
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return max;
}

/** Porcentaje de beneficio global (ajustes → personalización). 0 si no está configurado. */
async function getPorcentajeBeneficio() {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.ajustes,
      Key: { PK: 'personalizacion', SK: 'app' },
    }));
    const p = r.Item?.PorcentajeBeneficio;
    const n = typeof p === 'number' ? p : parseFloat(String(p ?? ''));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Estado actual de un pedido; null si no existe. */
async function getEstadoPedido(id) {
  const got = await docClient.send(new GetCommand({
    TableName: tables.pedidos,
    Key: { Id: id },
    ProjectionExpression: 'Estado',
  }));
  return got.Item ? String(got.Item.Estado ?? '') : null;
}

/**
 * Recalcula el estado de un pedido en función de cuántas líneas están preparadas,
 * para reflejar el avance del almacén sin intervención manual:
 *   - 0 preparadas        → 'Enviado'    (esperando preparación)
 *   - parcialmente        → 'Pendiente'  (en preparación)
 *   - todas preparadas    → 'Completado' (listo)
 * No toca pedidos en 'Borrador' (el bar aún lo está montando) ni los exportados.
 * Es tolerante a fallos: cualquier error se registra y no rompe la operación de línea.
 */
async function recomputarEstadoPorPreparacion(pedidoId) {
  try {
    const estadoActual = await getEstadoPedido(pedidoId);
    if (!estadoActual) return;
    if (estadoActual === ESTADO_BORRADOR || estadoActual === 'Exportado') return;

    const q = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
      ProjectionExpression: 'Preparada',
    }));
    const lineas = q.Items || [];
    const total = lineas.length;
    if (total === 0) return;
    const preparadas = lineas.filter((l) => !!l.Preparada).length;

    let nuevoEstado;
    if (preparadas === 0) nuevoEstado = 'Enviado';
    else if (preparadas === total) nuevoEstado = 'Completado';
    else nuevoEstado = 'Pendiente';

    if (nuevoEstado === estadoActual) return;
    await docClient.send(new UpdateCommand({
      TableName: tables.pedidos,
      Key: { Id: pedidoId },
      UpdateExpression: 'SET Estado = :e',
      ExpressionAttributeValues: { ':e': nuevoEstado },
    }));
  } catch (err) {
    console.error('[recomputarEstadoPorPreparacion]', err.message || err);
  }
}

// GET /pedidos
router.get('/pedidos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tables.pedidos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    // Calcular TotalAlbaran como suma de TotalLinea del detalle de cada pedido
    const lineasItems = [];
    let lineasLastKey = null;
    do {
      const lineasResult = await docClient.send(new ScanCommand({
        TableName: tables.pedidosLineas,
        ...(lineasLastKey && { ExclusiveStartKey: lineasLastKey }),
      }));
      lineasItems.push(...(lineasResult.Items || []));
      lineasLastKey = lineasResult.LastEvaluatedKey || null;
    } while (lineasLastKey);

    const totalesPorPedido = {};
    const conteoLineasPorPedido = {};
    for (const linea of lineasItems) {
      const pid = String(linea.PedidoId ?? '');
      if (!pid) continue;
      const totalLinea = Number(linea.TotalLinea ?? 0);
      totalesPorPedido[pid] = (totalesPorPedido[pid] ?? 0) + totalLinea;
      const c = conteoLineasPorPedido[pid] ?? { total: 0, preparadas: 0 };
      c.total += 1;
      if (linea.Preparada) c.preparadas += 1;
      conteoLineasPorPedido[pid] = c;
    }

    for (const p of items) {
      const pid = String(p.Id ?? '');
      p.TotalAlbaran = totalesPorPedido[pid] ?? 0;
      const c = conteoLineasPorPedido[pid] ?? { total: 0, preparadas: 0 };
      p.LineasTotal = c.total;
      p.LineasPreparadas = c.preparadas;
    }

    items.sort((a, b) => String(b.Fecha ?? b.Id ?? '').localeCompare(String(a.Fecha ?? a.Id ?? '')));
    res.json({ pedidos: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar pedidos' });
  }
});

/** Normaliza un nombre de empresa para comparar (trim + minúsculas, sin dobles espacios). */
function normalizarEmpresa(val) {
  return String(val ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// GET /pedidos/abonos?empresa=<nombre>&local=<id>&anio=2026&mes=06&modo=abonos|ventas
// Informe calculado por empresa y periodo. `local` y `mes` son opcionales.
//  - modo=abonos (defecto): suma de rappels (lo que el almacén debe abonar al local).
//    Incluye solo líneas con TotalRappel > 0, sin filtrar por estado del pedido.
//  - modo=ventas: suma de TotalLinea con margen (lo que se cobra a la sociedad).
//    Incluye solo pedidos 'Completado' y líneas con TotalLinea > 0.
// En ambos modos cada línea devuelve un campo genérico `Importe` con la métrica del modo.
router.get('/pedidos/abonos', async (req, res) => {
  const empresa = String(req.query.empresa ?? '').trim();
  const local = String(req.query.local ?? '').trim();
  const anio = String(req.query.anio ?? '').trim();
  const mes = String(req.query.mes ?? '').trim();
  const modo = String(req.query.modo ?? 'abonos').trim() === 'ventas' ? 'ventas' : 'abonos';
  if (!empresa) return res.status(400).json({ error: 'empresa obligatoria' });
  if (!/^\d{4}$/.test(anio)) return res.status(400).json({ error: 'anio inválido (AAAA)' });
  const prefijo = mes ? `${anio}-${mes.padStart(2, '0')}` : anio;
  try {
    // 1) Locales de la empresa (enlace por nombre: igp_Locales.empresa === empresa.Nombre).
    const localesRaw = [];
    let lastLoc = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tables.locales,
        ProjectionExpression: 'id_Locales, nombre, empresa',
        ...(lastLoc && { ExclusiveStartKey: lastLoc }),
      }));
      localesRaw.push(...(r.Items || []));
      lastLoc = r.LastEvaluatedKey || null;
    } while (lastLoc);

    const empresaNorm = normalizarEmpresa(empresa);
    const nombrePorLocalId = {};
    const localIdsEmpresa = new Set();
    for (const l of localesRaw) {
      if (normalizarEmpresa(l.empresa) !== empresaNorm) continue;
      const idLoc = String(l.id_Locales ?? '').trim();
      if (!idLoc) continue;
      nombrePorLocalId[idLoc] = String(l.nombre ?? idLoc).trim();
      if (!local || idLoc === local) localIdsEmpresa.add(idLoc);
    }

    if (localIdsEmpresa.size === 0) {
      return res.json({ ok: true, empresa, local: local || null, anio, mes: mes || null, modo, total: 0, items: [], pedidos: [] });
    }

    // 2) Pedidos de esos locales.
    const pedidos = [];
    let lastKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tables.pedidos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      pedidos.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);

    const pedidosPeriodo = pedidos.filter((p) => {
      const lid = String(p.LocalId ?? '').trim();
      if (!localIdsEmpresa.has(lid)) return false;
      // En ventas solo cuentan los pedidos ya completados (facturables).
      if (modo === 'ventas' && String(p.Estado ?? '').trim() !== 'Completado') return false;
      return String(p.Fecha ?? '').trim().startsWith(prefijo);
    });

    const items = [];
    const resumenPedidos = [];
    let total = 0;

    for (const p of pedidosPeriodo) {
      const pid = String(p.Id ?? '');
      if (!pid) continue;
      const localId = String(p.LocalId ?? '').trim();
      const localNombre = nombrePorLocalId[localId] || localId;
      const fechaPedido = String(p.Fecha ?? '').trim();
      const creadoEn = String(p.CreadoEn ?? '').trim();
      const esDevolucion = String(p.Tipo ?? 'Pedido').trim() === 'Devolucion';
      // Una devolución resta en ambos informes: en ventas anula el importe a cobrar
      // y en abonos anula el rappel que generó la compra original (neto = 0).
      const signo = esDevolucion ? -1 : 1;
      const q = await docClient.send(new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ExpressionAttributeValues: { ':pid': pid },
      }));
      let totalPedido = 0;
      for (const l of q.Items || []) {
        const base = modo === 'ventas' ? Number(l.TotalLinea ?? 0) : Number(l.TotalRappel ?? 0);
        if (!(base > 0)) continue;
        const importe = signo * base;
        items.push({
          PedidoId: pid,
          LineaIndex: l.LineaIndex ?? null,
          LocalId: localId,
          LocalNombre: localNombre,
          Fecha: fechaPedido,
          CreadoEn: creadoEn,
          Tipo: esDevolucion ? 'Devolucion' : 'Pedido',
          ProductId: String(l.ProductId ?? ''),
          ProductoNombre: String(l.ProductoNombre ?? ''),
          Cantidad: signo * Number(l.Cantidad ?? 0),
          VatRate: l.VatRate != null ? Number(l.VatRate) : null,
          Importe: importe,
        });
        totalPedido += importe;
      }
      if (totalPedido !== 0) {
        resumenPedidos.push({ Id: pid, LocalId: localId, LocalNombre: localNombre, Fecha: fechaPedido, Tipo: esDevolucion ? 'Devolucion' : 'Pedido', Importe: totalPedido });
        total += totalPedido;
      }
    }

    items.sort((a, b) => {
      const fc = String(a.Fecha).localeCompare(String(b.Fecha));
      if (fc !== 0) return fc;
      const lc = String(a.LocalNombre).localeCompare(String(b.LocalNombre), 'es', { sensitivity: 'base' });
      if (lc !== 0) return lc;
      const pc = String(a.PedidoId).localeCompare(String(b.PedidoId));
      if (pc !== 0) return pc;
      return Number(a.LineaIndex ?? 0) - Number(b.LineaIndex ?? 0);
    });
    resumenPedidos.sort((a, b) => String(a.Fecha).localeCompare(String(b.Fecha)));

    res.json({ ok: true, empresa, local: local || null, anio, mes: mes || null, modo, total, items, pedidos: resumenPedidos });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al calcular el informe' });
  }
});

// GET /pedidos/traspaso-export?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&incluirExportados=false
// Relación de artículos de pedidos COMPLETADOS en un rango de fechas, lista para
// generar el Excel de traspasos de Agora (una fila por línea de pedido).
router.get('/pedidos/traspaso-export', async (req, res) => {
  if (!(await hasPermission(req.user, 'pedidos.exportar_traspaso'))) {
    return res.status(403).json({ error: 'No tienes permiso para exportar traspasos' });
  }
  const desde = String(req.query.desde ?? '').trim();
  const hasta = String(req.query.hasta ?? '').trim();
  const incluirExportados = String(req.query.incluirExportados ?? '') === 'true';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return res.status(400).json({ error: 'desde y hasta son obligatorios (YYYY-MM-DD)' });
  }
  if (desde > hasta) {
    return res.status(400).json({ error: 'El rango de fechas es inválido (desde > hasta)' });
  }
  try {
    // 1) Pedidos completados del rango.
    const pedidos = [];
    let lastKey = null;
    do {
      const r = await docClient.send(new ScanCommand({
        TableName: tables.pedidos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      pedidos.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);

    const completadosRango = pedidos.filter((p) => {
      if (String(p.Estado ?? '').trim() !== 'Completado') return false;
      const iso = fechaPedidoToIso(p.Fecha);
      if (!iso || iso < desde || iso > hasta) return false;
      if (!incluirExportados && p.TraspasoExportadoEn) return false;
      return true;
    });

    // 2) Líneas de cada pedido → filas + resumen agregado por producto.
    const filas = [];
    const resumenMap = {};
    const pedidosResumen = [];
    let omitidas = 0;

    for (const p of completadosRango) {
      const pedidoId = String(p.Id ?? '');
      if (!pedidoId) continue;
      const fechaIso = fechaPedidoToIso(p.Fecha);
      const almacenOrigenId = String(p.AlmacenOrigenId ?? '').trim();
      const almacenDestinoId = String(p.AlmacenDestinoId ?? '').trim();

      const q = await docClient.send(new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ExpressionAttributeValues: { ':pid': pedidoId },
      }));
      const lineas = q.Items || [];
      let lineasValidas = 0;
      for (const l of lineas) {
        const productId = String(l.ProductId ?? '').trim();
        const cantidad = Number(l.Cantidad ?? 0);
        if (!productId || !(cantidad > 0)) { omitidas += 1; continue; }
        filas.push({
          pedidoId,
          fechaIso,
          almacenOrigenId,
          almacenDestinoId,
          productId,
          productoNombre: String(l.ProductoNombre ?? '').trim(),
          cantidad,
        });
        lineasValidas += 1;
        const rk = resumenMap[productId] || { productId, productoNombre: String(l.ProductoNombre ?? '').trim(), cantidad: 0 };
        rk.cantidad += cantidad;
        if (!rk.productoNombre && l.ProductoNombre) rk.productoNombre = String(l.ProductoNombre).trim();
        resumenMap[productId] = rk;
      }
      pedidosResumen.push({
        Id: pedidoId,
        Fecha: String(p.Fecha ?? ''),
        FechaIso: fechaIso,
        LocalId: String(p.LocalId ?? '').trim(),
        AlmacenOrigenId: almacenOrigenId,
        AlmacenDestinoId: almacenDestinoId,
        lineasValidas,
        sinAlmacenes: !almacenOrigenId || !almacenDestinoId,
        TraspasoExportadoEn: p.TraspasoExportadoEn ?? null,
        TraspasoExportadoPor: p.TraspasoExportadoPor ?? null,
      });
    }

    const resumen = Object.values(resumenMap).sort((a, b) =>
      String(a.productoNombre || a.productId).localeCompare(String(b.productoNombre || b.productId), 'es', { sensitivity: 'base' }),
    );
    pedidosResumen.sort((a, b) => String(a.FechaIso).localeCompare(String(b.FechaIso)) || String(a.Id).localeCompare(String(b.Id)));

    res.json({
      ok: true,
      desde,
      hasta,
      incluirExportados,
      pedidos: pedidosResumen,
      filas,
      resumen,
      omitidas,
      totalUnidades: filas.reduce((s, f) => s + f.cantidad, 0),
    });
  } catch (err) {
    console.error('[pedidos/traspaso-export]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al preparar la exportación de traspasos' });
  }
});

// POST /pedidos/traspaso-export/marcar  body: { pedidoIds: [] }
// Marca los pedidos como ya exportados (control de duplicados). Idempotente.
router.post('/pedidos/traspaso-export/marcar', async (req, res) => {
  if (!(await hasPermission(req.user, 'pedidos.exportar_traspaso'))) {
    return res.status(403).json({ error: 'No tienes permiso para exportar traspasos' });
  }
  const ids = Array.isArray(req.body?.pedidoIds) ? req.body.pedidoIds.map((x) => String(x).trim()).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'pedidoIds es obligatorio' });
  const now = new Date().toISOString();
  const email = String(req.user?.email ?? '').trim();
  let marcados = 0;
  for (const id of ids) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: tables.pedidos,
        Key: { Id: id },
        UpdateExpression: 'SET TraspasoExportadoEn = :t, TraspasoExportadoPor = :p',
        ExpressionAttributeValues: { ':t': now, ':p': email },
        ConditionExpression: 'attribute_exists(Id)',
      }));
      marcados += 1;
    } catch (e) {
      if (e?.name !== 'ConditionalCheckFailedException') {
        console.error('[pedidos/traspaso-export/marcar]', id, e.message || e);
      }
    }
  }
  res.json({ ok: true, marcados, exportadoEn: now });
});

// POST /pedidos — el Id se genera SIEMPRE en el servidor (correlativo atómico por año).
// Se ignora cualquier Id que envíe el cliente para evitar colisiones entre tablets.
router.post('/pedidos', async (req, res) => {
  const body = req.body || {};
  try {
    const ahora = new Date().toISOString();
    const fecha = String(body.Fecha ?? '').trim();
    const año = añoDesdeFecha(fecha) ?? new Date().getFullYear();
    const baseItem = {
      LocalId: String(body.LocalId ?? '').trim(),
      AlmacenOrigenId: String(body.AlmacenOrigenId ?? '').trim(),
      AlmacenDestinoId: String(body.AlmacenDestinoId ?? '').trim(),
      TotalAlbaran: typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran ?? 0)) || 0,
      Fecha: fecha,
      Estado: String(body.Estado ?? ESTADO_BORRADOR).trim() || ESTADO_BORRADOR,
      // Tipo de movimiento: 'Pedido' (general → local) o 'Devolucion' (local → general).
      Tipo: String(body.Tipo ?? 'Pedido').trim() === 'Devolucion' ? 'Devolucion' : 'Pedido',
      CreadoEn: body.CreadoEn ?? ahora,
      CreadoPor: String(body.CreadoPor ?? req.user?.email ?? '').trim(),
      Notas: String(body.Notas ?? '').trim(),
    };

    // Correlativo + escritura condicional con reintentos: si dos peticiones
    // calculan el mismo número, solo una gana y la otra reintenta con el siguiente.
    let n = (await maxSecuencialPedidoAño(año)) + 1;
    for (let intento = 0; intento < MAX_REINTENTOS_ID; intento++) {
      const id = buildPedidoId(año, n);
      const item = { Id: id, ...baseItem };
      try {
        await docClient.send(new PutCommand({
          TableName: tables.pedidos,
          Item: item,
          ConditionExpression: 'attribute_not_exists(Id)',
        }));
        return res.json({ ok: true, pedido: item });
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') {
          n += 1;
          continue;
        }
        throw err;
      }
    }
    return res.status(409).json({ error: 'No se pudo asignar un Id único para el pedido, inténtalo de nuevo' });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear pedido' });
  }
});

// PUT /pedidos
router.put('/pedidos', async (req, res) => {
  const body = req.body || {};
  const id = body.Id != null ? String(body.Id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para editar' });
  try {
    const got = await docClient.send(new GetCommand({ TableName: tables.pedidos, Key: { Id: id } }));
    const existing = got.Item;
    if (!existing) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Inmutabilidad: un pedido que ya salió de "Borrador" (lo envió el local)
    // solo puede modificarlo quien tenga el permiso de almacén central.
    const estadoExistente = String(existing.Estado ?? '');
    if (estadoExistente && estadoExistente !== ESTADO_BORRADOR) {
      if (!(await hasPermission(req.user, 'pedidos.editar_enviado'))) {
        return res.status(403).json({ error: 'No puedes modificar un pedido ya enviado' });
      }
    }
    const item = {
      Id: id,
      LocalId: body.LocalId != null ? String(body.LocalId).trim() : String(existing.LocalId ?? ''),
      AlmacenOrigenId: body.AlmacenOrigenId != null ? String(body.AlmacenOrigenId).trim() : String(existing.AlmacenOrigenId ?? ''),
      AlmacenDestinoId: body.AlmacenDestinoId != null ? String(body.AlmacenDestinoId).trim() : String(existing.AlmacenDestinoId ?? ''),
      TotalAlbaran: body.TotalAlbaran != null ? (typeof body.TotalAlbaran === 'number' ? body.TotalAlbaran : parseFloat(String(body.TotalAlbaran)) || 0) : (existing.TotalAlbaran ?? 0),
      Fecha: body.Fecha != null ? String(body.Fecha).trim() : String(existing.Fecha ?? ''),
      Estado: body.Estado != null ? String(body.Estado).trim() : String(existing.Estado ?? 'Borrador'),
      CreadoEn: existing.CreadoEn,
      CreadoPor: existing.CreadoPor,
      Notas: body.Notas != null ? String(body.Notas).trim() : String(existing.Notas ?? ''),
      // Tipo de movimiento: se preserva el existente; el cliente puede fijarlo si lo envía.
      Tipo: body.Tipo != null
        ? (String(body.Tipo).trim() === 'Devolucion' ? 'Devolucion' : 'Pedido')
        : (String(existing.Tipo ?? 'Pedido').trim() === 'Devolucion' ? 'Devolucion' : 'Pedido'),
      // Preservar el control de exportación de traspasos (no debe perderse al editar).
      ...(existing.TraspasoExportadoEn ? { TraspasoExportadoEn: existing.TraspasoExportadoEn } : {}),
      ...(existing.TraspasoExportadoPor ? { TraspasoExportadoPor: existing.TraspasoExportadoPor } : {}),
    };
    // Certificación de devolución: se sella la primera vez que el cliente lo solicita
    // (o se preserva la existente). Deja constancia de quién y cuándo.
    const certificaAhora = body.certificarDevolucion === true && !existing.DevolucionCertificadaEn;
    if (certificaAhora) {
      item.DevolucionCertificadaEn = new Date().toISOString();
      item.DevolucionCertificadaPor = String(req.user?.email ?? '').trim();
    } else if (existing.DevolucionCertificadaEn) {
      item.DevolucionCertificadaEn = existing.DevolucionCertificadaEn;
      item.DevolucionCertificadaPor = existing.DevolucionCertificadaPor ?? '';
    }
    await docClient.send(new PutCommand({ TableName: tables.pedidos, Item: item }));
    res.json({ ok: true, pedido: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar pedido' });
  }
});

// DELETE /pedidos — borra también todas las líneas (evita huérfanas si se reutiliza el mismo Id)
router.delete('/pedidos', async (req, res) => {
  const id = req.body?.Id != null ? String(req.body.Id).trim() : req.query?.id != null ? String(req.query.id).trim() : '';
  if (!id) return res.status(400).json({ error: 'Id es obligatorio para borrar' });
  try {
    const estadoExistente = await getEstadoPedido(id);
    if (estadoExistente != null) {
      // Borrar un pedido ya enviado requiere el permiso reforzado; borrar un
      // borrador requiere el permiso de borrado general.
      const permisoNecesario = estadoExistente && estadoExistente !== ESTADO_BORRADOR
        ? 'pedidos.borrar_enviado'
        : 'pedidos.borrar';
      if (!(await hasPermission(req.user, permisoNecesario))) {
        return res.status(403).json({ error: 'No tienes permiso para borrar este pedido' });
      }
    }
    let lastKey = null;
    do {
      const q = await docClient.send(new QueryCommand({
        TableName: tables.pedidosLineas,
        KeyConditionExpression: 'PedidoId = :pid',
        ExpressionAttributeValues: { ':pid': id },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const linea of q.Items || []) {
        const pid = String(linea.PedidoId ?? id);
        const li = linea.LineaIndex != null ? String(linea.LineaIndex).trim() : '';
        if (!li) continue;
        await docClient.send(new DeleteCommand({
          TableName: tables.pedidosLineas,
          Key: { PedidoId: pid, LineaIndex: li },
        }));
      }
      lastKey = q.LastEvaluatedKey || null;
    } while (lastKey);

    await docClient.send(new DeleteCommand({ TableName: tables.pedidos, Key: { Id: id } }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar pedido' });
  }
});

// GET /pedidos/:pedidoId/rappel-preview?productId=&cantidad=
// Calcula total aportación/rappel según acuerdo activo y fecha del pedido.
router.get('/pedidos/:pedidoId/rappel-preview', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const productId = String(req.query.productId ?? '').trim();
  const cantidad = typeof req.query.cantidad === 'number'
    ? req.query.cantidad
    : parseFloat(String(req.query.cantidad ?? '0').replace(',', '.')) || 0;
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  if (!productId) return res.status(400).json({ error: 'productId obligatorio' });
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tables.pedidos,
      Key: { Id: pedidoId },
      ProjectionExpression: 'Fecha',
    }));
    if (!got.Item) return res.status(404).json({ error: 'Pedido no encontrado' });
    const fechaPedido = String(got.Item.Fecha ?? '').trim();
    const totalAportacionUnitaria = await resolveTotalAportacionUnitaria(productId, fechaPedido);
    const totalRappel = cantidad * totalAportacionUnitaria;
    res.json({
      ok: true,
      fechaPedido,
      totalAportacionUnitaria,
      totalRappel,
    });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al calcular rappel' });
  }
});

// GET /pedidos/:pedidoId/lineas
router.get('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ lineas: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar líneas del pedido' });
  }
});

// GET /pedidos/:pedidoId/details
router.get('/pedidos/:pedidoId/details', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const items = (result.Items || []).sort((a, b) =>
      String(a.LineaIndex ?? '').localeCompare(String(b.LineaIndex ?? ''))
    );
    res.json({ details: items });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar detalles del pedido' });
  }
});

// POST /pedidos/:pedidoId/lineas
router.post('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  if (!pedidoId) return res.status(400).json({ error: 'pedidoId obligatorio' });
  const body = req.body || {};
  try {
    // Añadir líneas a un pedido ya enviado solo lo puede hacer el almacén central.
    const estadoPadre = await getEstadoPedido(pedidoId);
    if (estadoPadre && estadoPadre !== ESTADO_BORRADOR) {
      if (!(await hasPermission(req.user, 'pedidos.editar_enviado'))) {
        return res.status(403).json({ error: 'No puedes añadir líneas a un pedido ya enviado' });
      }
    }
    const result = await docClient.send(new QueryCommand({
      TableName: tables.pedidosLineas,
      KeyConditionExpression: 'PedidoId = :pid',
      ExpressionAttributeValues: { ':pid': pedidoId },
    }));
    const existing = result.Items || [];
    const maxIdx = existing.reduce((m, i) => {
      const n = parseInt(String(i.LineaIndex ?? '-1'), 10);
      return Number.isNaN(n) ? m : Math.max(m, n);
    }, -1);
    const lineaIndex = String(maxIdx + 1);
    const cantidad = typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad ?? 0)) || 0;
    const precioUnitario = typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario ?? 0)) || 0;
    // Precio de venta CONGELADO: se fija el % de beneficio vigente en este momento
    // y se guarda el precio resultante para que el total del albarán no cambie
    // si luego se modifica el % global.
    const pctBeneficio = await getPorcentajeBeneficio();
    const precioVenta = precioUnitario * (1 + pctBeneficio / 100);
    const totalLinea = cantidad * precioVenta;
    const vatRate = body.VatRate != null ? (typeof body.VatRate === 'number' ? body.VatRate : parseFloat(String(body.VatRate)) || 0) : undefined;

    const productId = String(body.ProductId ?? '').trim();
    const pedidoGot = await docClient.send(new GetCommand({
      TableName: tables.pedidos,
      Key: { Id: pedidoId },
      ProjectionExpression: 'Fecha, Tipo',
    }));
    const fechaPedido = String(pedidoGot.Item?.Fecha ?? '').trim();
    const esDevolucion = String(pedidoGot.Item?.Tipo ?? 'Pedido').trim() === 'Devolucion';
    // En devoluciones se calcula el MISMO rappel que una compra (aportación del
    // producto en la fecha). Así, al restarse en el informe, anula el rappel que
    // generó la compra original (neto = 0 para una botella comprada y devuelta).
    const totalAportacionUnitaria = productId
      ? await resolveTotalAportacionUnitaria(productId, fechaPedido)
      : 0;
    const totalRappelBody = body.TotalRappel != null
      ? (typeof body.TotalRappel === 'number' ? body.TotalRappel : parseFloat(String(body.TotalRappel)) || 0)
      : 0;
    const totalRappel = totalAportacionUnitaria > 0
      ? cantidad * totalAportacionUnitaria
      : totalRappelBody;

    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: productId,
      ProductoNombre: String(body.ProductoNombre ?? '').trim(),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      PorcentajeBeneficioAplicado: pctBeneficio,
      PrecioVenta: precioVenta,
      TotalLinea: totalLinea,
      Preparada: false,
      ...(totalAportacionUnitaria > 0 && { TotalAportacionUnitaria: totalAportacionUnitaria }),
      TotalRappel: totalRappel,
      ...(vatRate != null && !Number.isNaN(vatRate) && { VatRate: vatRate }),
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : undefined,
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : undefined,
      Notas: body.Notas != null ? String(body.Notas).trim() : undefined,
    };
    await docClient.send(new PutCommand({ TableName: tables.pedidosLineas, Item: item }));
    res.json({ ok: true, linea: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al crear línea' });
  }
});

// PUT /pedidos/:pedidoId/lineas
router.put('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  const body = req.body || {};
  try {
    const got = await docClient.send(new GetCommand({
      TableName: tables.pedidosLineas,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    const existing = got.Item || {};

    // ¿La petición solo marca/desmarca "Preparada"? Esa es la operación normal
    // del almacén al preparar y no debe exigir permiso de edición de contenido.
    const camposContenido = ['Cantidad', 'PrecioUnitario', 'ProductId', 'ProductoNombre', 'VatRate', 'TotalRappel', 'PurchaseUnitId', 'PurchaseUnitName', 'Notas'];
    const soloPreparada = body.Preparada != null && !camposContenido.some((c) => body[c] != null);

    if (!soloPreparada) {
      const estadoPadre = await getEstadoPedido(pedidoId);
      if (estadoPadre && estadoPadre !== ESTADO_BORRADOR) {
        if (!(await hasPermission(req.user, 'pedidos.editar_enviado'))) {
          return res.status(403).json({ error: 'No puedes modificar las líneas de un pedido ya enviado' });
        }
      }
    }

    const cantidad = body.Cantidad != null ? (typeof body.Cantidad === 'number' ? body.Cantidad : parseFloat(String(body.Cantidad)) || 0) : (existing.Cantidad ?? 0);
    const precioUnitario = body.PrecioUnitario != null ? (typeof body.PrecioUnitario === 'number' ? body.PrecioUnitario : parseFloat(String(body.PrecioUnitario)) || 0) : (existing.PrecioUnitario ?? 0);
    // Precio de venta congelado: se conserva el de la línea; si cambia el precio
    // base (re-selección de producto) se recalcula con el % ya aplicado a la línea.
    const pctAplicado = existing.PorcentajeBeneficioAplicado != null ? Number(existing.PorcentajeBeneficioAplicado) : null;
    let precioVenta;
    if (body.PrecioUnitario != null && pctAplicado != null) {
      precioVenta = precioUnitario * (1 + pctAplicado / 100);
    } else if (existing.PrecioVenta != null) {
      precioVenta = Number(existing.PrecioVenta);
    } else {
      precioVenta = precioUnitario * (1 + (pctAplicado ?? 0) / 100);
    }
    const totalLinea = cantidad * precioVenta;
    const preparada = body.Preparada != null ? !!body.Preparada : !!(existing.Preparada ?? false);

    const aportUnitExistente = existing.TotalAportacionUnitaria != null
      ? Number(existing.TotalAportacionUnitaria)
      : null;
    const aportUnit = aportUnitExistente != null && Number.isFinite(aportUnitExistente)
      ? aportUnitExistente
      : (Number(existing.Cantidad) > 0 && existing.TotalRappel != null
        ? Number(existing.TotalRappel) / Number(existing.Cantidad)
        : 0);
    const totalRappel = aportUnit > 0 ? cantidad * aportUnit : (existing.TotalRappel ?? 0);

    const item = {
      PedidoId: pedidoId,
      LineaIndex: lineaIndex,
      ProductId: body.ProductId != null ? String(body.ProductId).trim() : String(existing.ProductId ?? ''),
      ProductoNombre: body.ProductoNombre != null ? String(body.ProductoNombre).trim() : String(existing.ProductoNombre ?? ''),
      Cantidad: cantidad,
      PrecioUnitario: precioUnitario,
      ...(pctAplicado != null && { PorcentajeBeneficioAplicado: pctAplicado }),
      PrecioVenta: precioVenta,
      TotalLinea: totalLinea,
      Preparada: preparada,
      ...(aportUnitExistente != null && Number.isFinite(aportUnitExistente) && { TotalAportacionUnitaria: aportUnitExistente }),
      TotalRappel: typeof totalRappel === 'number' && Number.isFinite(totalRappel) ? totalRappel : 0,
      PurchaseUnitId: body.PurchaseUnitId != null ? String(body.PurchaseUnitId).trim() : (existing.PurchaseUnitId ?? undefined),
      PurchaseUnitName: body.PurchaseUnitName != null ? String(body.PurchaseUnitName).trim() : (existing.PurchaseUnitName ?? undefined),
      Notas: body.Notas != null ? String(body.Notas).trim() : (existing.Notas ?? undefined),
      ...((body.VatRate ?? existing.VatRate) != null && {
        VatRate: body.VatRate != null ? (typeof body.VatRate === 'number' ? body.VatRate : parseFloat(String(body.VatRate)) || 0) : existing.VatRate,
      }),
    };
    await docClient.send(new PutCommand({ TableName: tables.pedidosLineas, Item: item }));

    // Si la operación tocó el flag "Preparada", recalculamos el estado del pedido
    // (Enviado → Pendiente → Completado) para reflejar el avance del almacén.
    let estadoPedido;
    if (body.Preparada != null) {
      await recomputarEstadoPorPreparacion(pedidoId);
      estadoPedido = (await getEstadoPedido(pedidoId)) ?? undefined;
    }

    res.json({ ok: true, linea: item, ...(estadoPedido != null && { estadoPedido }) });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar línea' });
  }
});

// DELETE /pedidos/:pedidoId/lineas
router.delete('/pedidos/:pedidoId/lineas', async (req, res) => {
  const pedidoId = req.params.pedidoId?.trim();
  const lineaIndex = req.body?.LineaIndex != null ? String(req.body.LineaIndex).trim() : req.query?.lineaIndex != null ? String(req.query.lineaIndex).trim() : '';
  if (!pedidoId || !lineaIndex) return res.status(400).json({ error: 'pedidoId y LineaIndex obligatorios' });
  try {
    // Borrar líneas de un pedido ya enviado requiere el permiso reforzado.
    const estadoPadre = await getEstadoPedido(pedidoId);
    if (estadoPadre && estadoPadre !== ESTADO_BORRADOR) {
      if (!(await hasPermission(req.user, 'pedidos.borrar_enviado'))) {
        return res.status(403).json({ error: 'No puedes borrar líneas de un pedido ya enviado' });
      }
    }
    await docClient.send(new DeleteCommand({
      TableName: tables.pedidosLineas,
      Key: { PedidoId: pedidoId, LineaIndex: lineaIndex },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar línea' });
  }
});

export default router;
