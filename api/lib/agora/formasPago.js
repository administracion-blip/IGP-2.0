/**
 * Maestro de formas de pago (tabla Igp_FormasPago) sincronizado desde Ágora.
 *
 * Centraliza:
 *  - El catálogo persistente de formas de pago (PK="PM", SK=agoraId).
 *  - La canonización de nombres (agrupar variantes en una columna estable).
 *  - El cálculo del teórico por método a partir de los cierres, agrupando por
 *    `canonico` (o por nombre si la forma aún no tiene canónico asignado).
 *
 * Una sola fuente de verdad para cierres teóricos y arqueo de caja: así ambos
 * muestran las mismas formas y ninguna se pierde en silencio.
 */
import { QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

const tableFormasPago = tables.formasPago;

/** Formas de pago históricas de Ágora (Guía 8.1.6 p.27) con su canónico estable. */
export const FORMAS_PAGO_CONOCIDAS = [
  { agoraId: 1, nombre: 'Efectivo', canonico: 'Efectivo', orden: 1 },
  { agoraId: 2, nombre: 'Tarjeta', canonico: 'Tarjeta', orden: 2 },
  { agoraId: 4, nombre: 'Pendiente de cobro', canonico: 'Pendiente de cobro', orden: 3 },
  { agoraId: 5, nombre: 'Prepago Transferencia', canonico: 'Prepago Transferencia', orden: 4 },
  { agoraId: 7, nombre: 'AgoraPay', canonico: 'AgoraPay', orden: 5 },
];

/** Nombres canónicos históricos, en orden de presentación. */
export const CANONICAL_PAYMENT_NAMES = FORMAS_PAGO_CONOCIDAS.map((f) => f.canonico);

/** Alias de nombres → canónico, para datos sin Id o con renombrados de Ágora. */
const ALIASES = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  'tarjeta manual': 'Tarjeta',
  card: 'Tarjeta',
  'pendiente de cobro': 'Pendiente de cobro',
  pending: 'Pendiente de cobro',
  'prepago transferencia': 'Prepago Transferencia',
  transferencia: 'Prepago Transferencia',
  agorapay: 'AgoraPay',
  'agora pay': 'AgoraPay',
};

const PAYMENT_ARRAY_KEYS = [
  'InvoicePayments', 'invoicePayments',
  'TicketPayments', 'ticketPayments',
  'DeliveryNotePayments', 'deliveryNotePayments',
  'SalesOrderPayments', 'salesOrderPayments',
];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Resuelve un nombre suelto a su canónico conocido, o null si no encaja. */
export function canonicalDesdeNombre(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  if (!k) return null;
  if (ALIASES[k]) return ALIASES[k];
  const exact = CANONICAL_PAYMENT_NAMES.find((c) => c.toLowerCase() === k);
  return exact ?? null;
}

/** Lee todas las formas de pago del maestro. Devuelve [] si la tabla está vacía. */
export async function listFormasPago() {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tableFormasPago,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'PM' },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) out.push(it);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  out.sort((a, b) => (Number(a.orden ?? 99) - Number(b.orden ?? 99)) || String(a.nombre || '').localeCompare(String(b.nombre || '')));
  return out;
}

/**
 * Construye un índice de resolución para clasificar pagos:
 *  - byId: agoraId → registro
 *  - byNombre: nombre normalizado → registro
 * Si la tabla está vacía, usa las formas conocidas como fallback.
 */
export function buildResolver(formas) {
  const list = Array.isArray(formas) && formas.length > 0
    ? formas
    : FORMAS_PAGO_CONOCIDAS.map((f) => ({ ...f, arquear: true, activo: true }));
  const byId = new Map();
  const byNombre = new Map();
  for (const f of list) {
    if (f.agoraId != null) byId.set(String(f.agoraId), f);
    if (f.nombre) byNombre.set(String(f.nombre).trim().toLowerCase(), f);
  }
  return { list, byId, byNombre };
}

/** Clave de agrupación visible de una forma: su canónico o, si no tiene, su nombre. */
export function grupoDeForma(forma) {
  if (!forma) return null;
  return (forma.canonico && String(forma.canonico).trim()) || String(forma.nombre || '').trim() || null;
}

/** Resuelve un pago (con MethodId/MethodName) a su grupo visible. */
function grupoDePago(p, resolver) {
  const id = p?.PaymentMethodId ?? p?.paymentMethodId ?? p?.MethodId ?? p?.methodId ?? p?.Id ?? p?.id;
  if (id != null && resolver.byId.has(String(id))) {
    return grupoDeForma(resolver.byId.get(String(id)));
  }
  const nombre = String(p?.MethodName ?? p?.methodName ?? p?.Name ?? p?.name ?? '').trim();
  if (nombre) {
    const f = resolver.byNombre.get(nombre.toLowerCase());
    if (f) return grupoDeForma(f);
    const canon = canonicalDesdeNombre(nombre);
    if (canon) return canon;
    return nombre; // forma desconocida: se muestra con su propio nombre, no se pierde
  }
  return null;
}

/**
 * Teórico por grupo de forma de pago a partir de un ítem de cierre.
 * Suma todos los arrays de pagos. Devuelve { [grupo]: importe }.
 */
export function teoricoPorMetodo(item, resolver) {
  const out = {};
  if (!item || typeof item !== 'object') return out;
  const vistos = new Set();
  for (const key of PAYMENT_ARRAY_KEYS) {
    if (vistos.has(key.toLowerCase())) continue;
    const arr = item[key];
    if (!Array.isArray(arr)) continue;
    vistos.add(key.toLowerCase());
    for (const p of arr) {
      const grupo = grupoDePago(p, resolver);
      if (!grupo) continue;
      const amt = parseNum(p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? 0);
      out[grupo] = round2((out[grupo] ?? 0) + amt);
    }
  }
  return out;
}

/** Suma los teóricos de varios cierres en un único mapa por grupo. */
export function mergeTeoricoAmounts(items, resolver) {
  const sum = {};
  for (const it of items || []) {
    const t = teoricoPorMetodo(it, resolver);
    for (const [k, v] of Object.entries(t)) sum[k] = round2((sum[k] ?? 0) + v);
  }
  return sum;
}

/**
 * Upsert del maestro a partir de la lista de PaymentMethods de Ágora.
 * - Id conocido → actualiza nombre/activo/ultimaSync (no pisa canonico/arquear/orden).
 * - Id nuevo → lo crea (canonico de las conocidas si aplica, o null; arquear=true).
 * Devuelve { added, updated, nuevas: [{agoraId, nombre}] }.
 */
export async function upsertFormasFromAgora(list) {
  const hoy = new Date().toISOString();
  const fechaCorta = hoy.slice(0, 10);
  const existentes = await listFormasPago();
  const byId = new Map(existentes.map((f) => [String(f.agoraId), f]));
  const conocidaPorId = new Map(FORMAS_PAGO_CONOCIDAS.map((f) => [String(f.agoraId), f]));

  let added = 0;
  let updated = 0;
  const nuevas = [];

  for (const pm of Array.isArray(list) ? list : []) {
    const agoraId = pm?.Id ?? pm?.id;
    if (agoraId == null) continue;
    const sk = String(agoraId);
    const nombre = String(pm?.Name ?? pm?.name ?? '').trim() || `Forma ${sk}`;
    const activo = pm?.DeletionDate == null && pm?.deletionDate == null;

    if (byId.has(sk)) {
      await docClient.send(new UpdateCommand({
        TableName: tableFormasPago,
        Key: { PK: 'PM', SK: sk },
        UpdateExpression: 'SET nombre = :n, activo = :a, ultimaSync = :u',
        ExpressionAttributeValues: { ':n': nombre, ':a': activo, ':u': hoy },
      }));
      byId.set(sk, { ...byId.get(sk), nombre, activo });
      updated++;
    } else {
      const conocida = conocidaPorId.get(sk);
      const item = {
        PK: 'PM',
        SK: sk,
        agoraId: Number(agoraId),
        nombre,
        canonico: conocida ? conocida.canonico : null,
        arquear: true,
        activo,
        orden: conocida ? conocida.orden : 99,
        primeraDeteccion: fechaCorta,
        ultimaSync: hoy,
      };
      await docClient.send(new PutCommand({ TableName: tableFormasPago, Item: item }));
      byId.set(sk, item);
      added++;
      if (!conocida) nuevas.push({ agoraId: Number(agoraId), nombre });
    }
  }

  // Ágora no expone algunas formas canónicas (p.ej. "Efectivo"): las sembramos
  // para que existan en el maestro y se puedan configurar.
  for (const conocida of FORMAS_PAGO_CONOCIDAS) {
    const sk = String(conocida.agoraId);
    if (byId.has(sk)) continue;
    const item = {
      PK: 'PM',
      SK: sk,
      agoraId: conocida.agoraId,
      nombre: conocida.nombre,
      canonico: conocida.canonico,
      arquear: true,
      activo: true,
      orden: conocida.orden,
      primeraDeteccion: fechaCorta,
      ultimaSync: hoy,
    };
    await docClient.send(new PutCommand({ TableName: tableFormasPago, Item: item }));
    byId.set(sk, item);
    added++;
  }

  return { added, updated, nuevas };
}
