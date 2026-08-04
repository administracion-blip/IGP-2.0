/**
 * Top camareros del mes para el card de Planning del Día.
 * Fuente: Igp_VentasProducto (sync sales-lines), misma lógica que incentivos por producto.
 */
import { docClient } from '../db.js';
import { jornadaNegocioHoyIso, usuarioPuedeAccederLocal, formatId6 } from '../usuarioLocales.js';
import {
  queryVentasPorLocalRango,
  getLastSalesLinesSync,
} from '../dynamo/ventasProducto.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cardCache = new Map();

/** Mes en curso (según jornada) desde el día 1 hasta el día anterior a la jornada. */
export function rangoMesHastaAyerJornada() {
  const jornadaHoy = jornadaNegocioHoyIso();
  const [y, m] = jornadaHoy.split('-');
  const dateFrom = `${y}-${m}-01`;
  const d = new Date(`${jornadaHoy}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const dateTo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sinDatos = dateTo < dateFrom;
  return { dateFrom, dateTo, jornadaHoy, sinDatos };
}

/**
 * Agrega ImporteBruto por AgoraUserId en un local y rango de fechas.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} ddb
 */
export async function buildTopCamarerosFromVentasProducto(ddb, localId, fechaDesde, fechaFin, limit = 3) {
  const rows = await queryVentasPorLocalRango(ddb, formatId6(localId), fechaDesde, fechaFin);
  const byUser = new Map();

  for (const r of rows) {
    const uid = String(r.AgoraUserId ?? '').trim();
    if (!uid || uid === '0') continue;

    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId: uid,
        userName: String(r.UserName ?? '').trim() || `#${uid}`,
        amount: 0,
      });
    }
    const u = byUser.get(uid);
    u.amount += Number(r.ImporteBruto) || 0;
    const name = String(r.UserName ?? '').trim();
    if (name && (u.userName === `#${uid}` || !u.userName)) {
      u.userName = name;
    }
  }

  return [...byUser.values()]
    .sort((a, b) => b.amount - a.amount || a.userName.localeCompare(b.userName, 'es'))
    .slice(0, limit)
    .map((u, i) => ({
      rank: i + 1,
      userId: u.userId,
      userName: u.userName,
      amount: Math.round((Number(u.amount) || 0) * 100) / 100,
    }));
}

/**
 * Payload del card planning: top 3 camareros del mes hasta ayer (jornada).
 * @param {object} user
 * @param {string} localId
 */
export async function buildTopCamarerosPlanningCard(user, localId) {
  const localIdFmt = formatId6(localId);
  const puede = await usuarioPuedeAccederLocal(user, localIdFmt);
  if (!puede) {
    const err = new Error('Sin acceso a este local');
    err.statusCode = 403;
    throw err;
  }

  const { dateFrom, dateTo, jornadaHoy, sinDatos } = rangoMesHastaAyerJornada();
  const userKey = String(user?.id_usuario ?? user?.sub ?? user?.email ?? 'anon');
  const cacheKey = `${userKey}:${localIdFmt}:${dateFrom}:${dateTo}`;
  const cached = cardCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.payload;
  }

  let camareros = [];
  if (!sinDatos) {
    camareros = await buildTopCamarerosFromVentasProducto(
      docClient,
      localIdFmt,
      dateFrom,
      dateTo,
      3,
    );
  }

  const lastSyncTs = await getLastSalesLinesSync(docClient);
  const payload = {
    localId: localIdFmt,
    dateFrom,
    dateTo,
    jornadaHoy,
    sinDatos,
    camareros,
    lastSyncVentas: lastSyncTs != null ? new Date(lastSyncTs).toISOString() : null,
    fuente: 'ventas_producto',
  };

  cardCache.set(cacheKey, { payload, cachedAt: Date.now() });
  return payload;
}
