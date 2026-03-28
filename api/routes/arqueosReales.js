/**
 * Arqueos reales (conteo manual) vs cierres teóricos — tabla Igp_ArqueosReales
 * PK = workplaceId, SK = yyyy-mm-dd#posId
 */
import express from 'express';
import { QueryCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();
const tableArqueos = tables.arqueosReales;
const tableCloseouts = tables.salesCloseOuts;

const PAYMENT_LABELS = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? round2(n) : 0;
}

function ensureArray(arr) {
  return Array.isArray(arr) ? arr : [];
}

/** Importes teóricos por método desde un ítem de cierre (InvoicePayments + otros pagos). */
function teoricoPorMetodo(item) {
  const out = {
    Efectivo: 0,
    Tarjeta: 0,
    'Pendiente de cobro': 0,
    'Prepago Transferencia': 0,
    AgoraPay: 0,
  };
  if (!item || typeof item !== 'object') return out;
  const payments = ensureArray(item.InvoicePayments ?? item.invoicePayments);
  for (const k of PAYMENT_LABELS) {
    const p = payments.find((x) => String(x?.MethodName ?? x?.methodName ?? '').trim() === k);
    if (p != null) {
      const n = Number(p?.Amount ?? p?.amount ?? 0) || 0;
      out[k] = round2(n);
    }
  }
  for (const key of ['TicketPayments', 'ticketPayments', 'DeliveryNotePayments', 'deliveryNotePayments', 'SalesOrderPayments', 'salesOrderPayments']) {
    const arr = ensureArray(item[key]);
    for (const p of arr) {
      const method = String(p?.MethodName ?? p?.methodName ?? '').trim();
      if (out[method] === undefined) continue;
      out[method] = round2(out[method] + (Number(p?.Amount ?? p?.amount ?? 0) || 0));
    }
  }
  for (const k of PAYMENT_LABELS) {
    const val = item[k];
    if (val != null && (typeof val === 'number' || (typeof val === 'string' && String(val).trim() !== ''))) {
      const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
      if (!Number.isNaN(n) && out[k] === 0) out[k] = round2(n);
    }
  }
  return out;
}

/** Suma teóricos de todos los cierres que coinciden con día + TPV. */
function mergeTeoricoAmounts(items) {
  const sum = {
    Efectivo: 0,
    Tarjeta: 0,
    'Pendiente de cobro': 0,
    'Prepago Transferencia': 0,
    AgoraPay: 0,
  };
  for (const it of items) {
    const t = teoricoPorMetodo(it);
    for (const k of PAYMENT_LABELS) sum[k] = round2(sum[k] + t[k]);
  }
  return sum;
}

/** Diferencias por método: real − teórico. */
function buildDiff(teorico, realParsed) {
  return {
    Efectivo: round2(realParsed.efectivoReal - teorico.Efectivo),
    Tarjeta: round2(realParsed.tarjetaReal - teorico.Tarjeta),
    'Pendiente de cobro': round2(realParsed.pendienteCobroReal - teorico['Pendiente de cobro']),
    'Prepago Transferencia': round2(realParsed.prepagoTransferenciaReal - teorico['Prepago Transferencia']),
    AgoraPay: round2(realParsed.agoraPayReal - teorico.AgoraPay),
  };
}

/** Suma algebraica de las diferencias por método (descuadre total). */
function sumDescuadreFromDiff(diff) {
  let s = 0;
  for (const k of PAYMENT_LABELS) s += diff[k];
  return round2(s);
}

// GET /api/cajas/arqueos-reales?workplaceId=&businessDay=opcional
router.get('/cajas/arqueos-reales', async (req, res) => {
  const workplaceId = String(req.query.workplaceId || '').trim();
  if (!workplaceId) return res.status(400).json({ error: 'workplaceId obligatorio' });
  const businessDay = String(req.query.businessDay || '').trim();
  try {
    const params = {
      TableName: tableArqueos,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': workplaceId },
    };
    if (businessDay && /^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
      params.KeyConditionExpression = 'PK = :pk AND begins_with(SK, :bd)';
      params.ExpressionAttributeValues = { ':pk': workplaceId, ':bd': businessDay };
    }
    const result = await docClient.send(new QueryCommand(params));
    const items = (result.Items || []).sort((a, b) => String(a.SK || '').localeCompare(String(b.SK || '')));
    res.json({ arqueos: items });
  } catch (err) {
    console.error('[cajas/arqueos-reales GET]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar arqueos' });
  }
});

// GET /api/cajas/arqueos-reales/compare?workplaceId=&businessDay=&posId=
router.get('/cajas/arqueos-reales/compare', async (req, res) => {
  const workplaceId = String(req.query.workplaceId || '').trim();
  const businessDay = String(req.query.businessDay || '').trim();
  const posId = String(req.query.posId ?? '').trim();
  if (!workplaceId || !businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay) || !posId) {
    return res.status(400).json({ error: 'workplaceId, businessDay (YYYY-MM-DD) y posId obligatorios' });
  }
  const skPrefix = `${businessDay}#${posId}#`;
  try {
    const qClose = await docClient.send(new QueryCommand({
      TableName: tableCloseouts,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': workplaceId, ':sk': skPrefix },
    }));
    const closeouts = qClose.Items || [];
    const teorico = mergeTeoricoAmounts(closeouts);

    const skArqueo = `${businessDay}#${posId}`;
    const getArqueo = await docClient.send(new GetCommand({
      TableName: tableArqueos,
      Key: { PK: workplaceId, SK: skArqueo },
    }));
    const real = getArqueo.Item || null;

    const realParsed = real
      ? {
          efectivoReal: parseNum(real.efectivoReal),
          tarjetaReal: parseNum(real.tarjetaReal),
          pendienteCobroReal: parseNum(real.pendienteCobroReal),
          prepagoTransferenciaReal: parseNum(real.prepagoTransferenciaReal),
          agoraPayReal: parseNum(real.agoraPayReal),
        }
      : {
          efectivoReal: 0,
          tarjetaReal: 0,
          pendienteCobroReal: 0,
          prepagoTransferenciaReal: 0,
          agoraPayReal: 0,
        };

    const diff = buildDiff(teorico, realParsed);
    const descuadreTotal = sumDescuadreFromDiff(diff);

    res.json({
      workplaceId,
      businessDay,
      posId,
      skArqueo,
      closeoutsCount: closeouts.length,
      teorico,
      real: realParsed,
      realGuardado: real,
      diff,
      descuadreTotal,
    });
  } catch (err) {
    console.error('[cajas/arqueos-reales/compare]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al comparar' });
  }
});

// PUT /api/cajas/arqueos-reales — crear o actualizar
router.put('/cajas/arqueos-reales', async (req, res) => {
  const body = req.body || {};
  const pk = String(body.PK ?? body.workplaceId ?? '').trim();
  const businessDay = String(body.BusinessDay ?? body.businessDay ?? '').trim();
  const posId = body.PosId ?? body.posId ?? '';
  if (!pk || !businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    return res.status(400).json({ error: 'PK (workplaceId) y BusinessDay (YYYY-MM-DD) obligatorios' });
  }
  if (posId === '' || posId == null) return res.status(400).json({ error: 'PosId obligatorio' });
  const posIdStr = String(posId).trim();
  const sk = `${businessDay}#${posIdStr}`;
  const now = new Date().toISOString();

  const existing = await docClient.send(new GetCommand({
    TableName: tableArqueos,
    Key: { PK: pk, SK: sk },
  })).then((r) => r.Item);

  const realParsed = {
    efectivoReal: parseNum(body.efectivoReal ?? body.efectivo_real),
    tarjetaReal: parseNum(body.tarjetaReal ?? body.tarjeta_real),
    pendienteCobroReal: parseNum(body.pendienteCobroReal ?? body.pendiente_cobro_real),
    prepagoTransferenciaReal: parseNum(body.prepagoTransferenciaReal ?? body.prepago_transferencia_real),
    agoraPayReal: parseNum(body.agoraPayReal ?? body.agora_pay_real),
  };

  const skPrefixClose = `${businessDay}#${posIdStr}#`;
  let descuadreTotal = 0;
  try {
    const qClose = await docClient.send(new QueryCommand({
      TableName: tableCloseouts,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefixClose },
    }));
    const teorico = mergeTeoricoAmounts(qClose.Items || []);
    const diff = buildDiff(teorico, realParsed);
    descuadreTotal = sumDescuadreFromDiff(diff);
  } catch (e) {
    console.error('[cajas/arqueos-reales PUT] descuadre', e.message || e);
    const diff = buildDiff(mergeTeoricoAmounts([]), realParsed);
    descuadreTotal = sumDescuadreFromDiff(diff);
  }

  const item = {
    PK: pk,
    SK: sk,
    BusinessDay: businessDay,
    PosId: posIdStr,
    PosName: body.PosName ?? body.posName ?? existing?.PosName ?? '',
    WorkplaceName: body.WorkplaceName ?? body.workplaceName ?? existing?.WorkplaceName ?? '',
    efectivoReal: realParsed.efectivoReal,
    tarjetaReal: realParsed.tarjetaReal,
    pendienteCobroReal: realParsed.pendienteCobroReal,
    prepagoTransferenciaReal: realParsed.prepagoTransferenciaReal,
    agoraPayReal: realParsed.agoraPayReal,
    descuadreTotal,
    descuadreActualizadoEn: now,
    creadoEn: existing?.creadoEn ?? now,
    actualizadoEn: now,
    usuarioId: body.usuarioId ?? body.usuario_id ?? existing?.usuarioId ?? '',
    usuarioNombre: body.usuarioNombre ?? body.usuario_nombre ?? existing?.usuarioNombre ?? '',
  };

  try {
    await docClient.send(new PutCommand({ TableName: tableArqueos, Item: item }));
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[cajas/arqueos-reales PUT]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al guardar arqueo' });
  }
});

// DELETE /api/cajas/arqueos-reales?PK=&SK=
router.delete('/cajas/arqueos-reales', async (req, res) => {
  const pk = String(req.query.PK ?? req.body?.PK ?? '').trim();
  const sk = String(req.query.SK ?? req.body?.SK ?? '').trim();
  if (!pk || !sk) return res.status(400).json({ error: 'PK y SK obligatorios' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableArqueos,
      Key: { PK: pk, SK: sk },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[cajas/arqueos-reales DELETE]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al eliminar' });
  }
});

export default router;
