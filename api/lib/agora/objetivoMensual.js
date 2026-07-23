/**
 * Consecución mensual «hasta ayer» para el card de Planning del Día.
 * Fuente de verdad del endpoint objetivo-mensual-card (solo porcentajes, sin importes).
 */
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { usuarioPuedeAccederLocal, jornadaNegocioHoyIso } from '../usuarioLocales.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cardCache = new Map();

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fechaComparacion(fecha) {
  const d = new Date(`${fecha}T12:00:00`);
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function ayerIso() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function mesEnCurso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const mStr = String(m + 1).padStart(2, '0');
  const ultimoDia = new Date(y, m + 1, 0).getDate();
  return {
    mes: `${y}-${mStr}`,
    inicio: `${y}-${mStr}-01`,
    fin: `${y}-${mStr}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

/** Días naturales desde la jornada de hoy hasta fin de mes (ambos inclusive). */
function diasNaturalesRestantes(jornadaHoy, fechaFinMes) {
  if (!RE_FECHA.test(jornadaHoy) || !RE_FECHA.test(fechaFinMes)) return 0;
  if (jornadaHoy > fechaFinMes) return 0;
  const d0 = new Date(`${jornadaHoy}T12:00:00`).getTime();
  const d1 = new Date(`${fechaFinMes}T12:00:00`).getTime();
  return Math.round((d1 - d0) / (24 * 60 * 60 * 1000)) + 1;
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function sumCloseoutItemAmount(item) {
  const arr = item?.InvoicePayments ?? item?.invoicePayments;
  let total = 0;
  if (Array.isArray(arr)) {
    for (const p of arr) {
      total += Number(p?.Amount ?? p?.amount ?? p?.Value ?? p?.value ?? 0) || 0;
    }
  }
  if (total === 0) {
    const amounts = item?.Amounts ?? item?.amounts ?? {};
    const gross = amounts.GrossAmount ?? amounts.grossAmount ?? amounts.Total ?? amounts.total;
    total = Number(gross) || 0;
  }
  return total;
}

async function queryTotalsByDay(workplaceId, dateFrom, dateTo) {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tables.salesCloseOuts,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :skFrom AND :skTo',
      ExpressionAttributeValues: {
        ':pk': workplaceId,
        ':skFrom': dateFrom,
        ':skTo': `${dateTo}\uffff`,
      },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  const totalsByDay = {};
  for (const item of items) {
    const sk = String(item.SK ?? item.sk ?? '').trim();
    const businessDay = (sk && /^\d{4}-\d{2}-\d{2}/.test(sk) ? sk.slice(0, 10) : (sk?.split('#')[0] ?? '')) || '';
    if (!businessDay || !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) continue;
    const total = sumCloseoutItemAmount(item);
    totalsByDay[businessDay] = (totalsByDay[businessDay] || 0) + total;
  }
  for (const d of Object.keys(totalsByDay)) {
    totalsByDay[d] = Math.round(totalsByDay[d] * 100) / 100;
  }
  return totalsByDay;
}

async function loadFestivosByFecha() {
  const map = new Map();
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tables.gestionFestivos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);

    for (const f of items) {
      const pk = String(f.PK ?? f.Fecha ?? f.FechaComparativa ?? '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(pk)) map.set(pk, f);
    }
  } catch {
    // tabla opcional
  }
  return map;
}

function buildFechaToComp(fechaInicio, fechaFin, festivosByFecha) {
  const fechaToComp = {};
  let minComp = '';
  let maxComp = '';
  const d = new Date(`${fechaInicio}T12:00:00`);
  const end = new Date(`${fechaFin}T12:00:00`);
  while (d <= end) {
    const fecha = d.toISOString().slice(0, 10);
    const festivo = festivosByFecha.get(fecha);
    const fc = festivo?.FechaComparativa && /^\d{4}-\d{2}-\d{2}$/.test(String(festivo.FechaComparativa).slice(0, 10))
      ? String(festivo.FechaComparativa).slice(0, 10)
      : fechaComparacion(fecha);
    fechaToComp[fecha] = fc;
    if (!minComp || fc < minComp) minComp = fc;
    if (!maxComp || fc > maxComp) maxComp = fc;
    d.setDate(d.getDate() + 1);
  }
  return { fechaToComp, minComp, maxComp };
}

/**
 * Calcula pctConsecucion = (sumRealHastaAyer / sumCompHastaAyer) × 100.
 * No expone importes.
 */
export async function calcPctConsecucionLocal(workplaceId, fechaInicioMes, fechaFinMes, hastaFecha, festivosByFecha, jornadaHoy = '') {
  if (!workplaceId) {
    return { pctConsecucion: null, sinDatos: true };
  }

  const { fechaToComp, minComp, maxComp } = buildFechaToComp(fechaInicioMes, fechaFinMes, festivosByFecha);
  if (!minComp || !maxComp) {
    return { pctConsecucion: null, sinDatos: true };
  }

  const [totalsReal, totalsComp] = await Promise.all([
    queryTotalsByDay(workplaceId, fechaInicioMes, fechaFinMes),
    queryTotalsByDay(workplaceId, minComp, maxComp),
  ]);

  let sumRealHastaAyer = 0;
  let sumCompHastaAyer = 0;
  let tieneDatosReales = false;

  const d = new Date(`${fechaInicioMes}T12:00:00`);
  const end = new Date(`${fechaFinMes}T12:00:00`);
  while (d <= end) {
    const fecha = d.toISOString().slice(0, 10);
    if (fecha <= hastaFecha) {
      const real = totalsReal[fecha] ?? 0;
      const fechaComp = fechaToComp[fecha];
      const comp = fechaComp ? (totalsComp[fechaComp] ?? 0) : 0;
      sumRealHastaAyer += real;
      sumCompHastaAyer += comp;
      if (real > 0) tieneDatosReales = true;
    }
    d.setDate(d.getDate() + 1);
  }

  // Objetivo de hoy = comparativa (año anterior + festivos) de la jornada de hoy.
  let objetivoHoy = null;
  if (jornadaHoy && RE_FECHA.test(jornadaHoy) && jornadaHoy >= fechaInicioMes && jornadaHoy <= fechaFinMes) {
    const fechaCompHoy = fechaToComp[jornadaHoy];
    objetivoHoy = fechaCompHoy ? Math.round((totalsComp[fechaCompHoy] ?? 0) * 100) / 100 : null;
  }

  if (!tieneDatosReales) {
    return { pctConsecucion: null, sinDatos: true, importeRealHastaAyer: 0, importeCompHastaAyer: 0, objetivoHoy };
  }

  const importeRealHastaAyer = Math.round(sumRealHastaAyer * 100) / 100;
  const importeCompHastaAyer = Math.round(sumCompHastaAyer * 100) / 100;

  if (sumCompHastaAyer === 0) {
    return { pctConsecucion: null, sinDatos: false, importeRealHastaAyer, importeCompHastaAyer, objetivoHoy };
  }

  return {
    pctConsecucion: round1((sumRealHastaAyer / sumCompHastaAyer) * 100),
    sinDatos: false,
    importeRealHastaAyer,
    importeCompHastaAyer,
    objetivoHoy,
  };
}

async function scanLocales() {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tables.locales,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Payload del card: porcentaje de consecución + objetivo del día, desvío por día
 * para recuperar y días naturales restantes hasta fin de mes.
 */
export async function buildObjetivoMensualCard(user) {
  const userKey = String(user?.id_usuario ?? user?.sub ?? user?.email ?? 'anon');
  const { mes, inicio: fechaInicioMes, fin: fechaFinMes } = mesEnCurso();
  const fechaHastaAyerStr = ayerIso();
  const hastaFecha =
    fechaHastaAyerStr < fechaInicioMes
      ? fechaInicioMes
      : fechaFinMes < fechaHastaAyerStr
        ? fechaFinMes
        : fechaHastaAyerStr;

  const jornadaHoy = jornadaNegocioHoyIso();
  const jornadaHoyEnMes = jornadaHoy >= fechaInicioMes && jornadaHoy <= fechaFinMes ? jornadaHoy : '';
  const diasRestantes = jornadaHoyEnMes ? diasNaturalesRestantes(jornadaHoyEnMes, fechaFinMes) : 0;

  const cacheKey = `${userKey}:${mes}:${hastaFecha}:${jornadaHoyEnMes}`;
  const cached = cardCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.payload;
  }

  const festivosByFecha = await loadFestivosByFecha();
  const todosLocales = await scanLocales();

  const visibles = [];
  for (const loc of todosLocales) {
    const id = loc.id_Locales ?? loc.id_locales;
    if (!id) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await usuarioPuedeAccederLocal(user, id);
    if (!ok) continue;
    visibles.push(loc);
  }

  visibles.sort((a, b) =>
    String(a.nombre ?? a.Nombre ?? '').localeCompare(String(b.nombre ?? b.Nombre ?? ''), 'es', { sensitivity: 'base' }),
  );

  const locales = await Promise.all(
    visibles.map(async (loc) => {
      const localId = String(loc.id_Locales ?? loc.id_locales ?? '');
      const nombre = String(loc.nombre ?? loc.Nombre ?? localId).trim();
      const workplaceId = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const {
        pctConsecucion,
        sinDatos,
        importeRealHastaAyer,
        importeCompHastaAyer,
        objetivoHoy,
      } = await calcPctConsecucionLocal(
        workplaceId,
        fechaInicioMes,
        fechaFinMes,
        hastaFecha,
        festivosByFecha,
        jornadaHoyEnMes,
      );

      // Desvío acumulado (positivo = vamos por debajo del comparable).
      const desvioAcumulado = Math.round(((importeCompHastaAyer ?? 0) - (importeRealHastaAyer ?? 0)) * 100) / 100;
      const extraPorDia =
        desvioAcumulado > 0 && diasRestantes > 0
          ? Math.round((desvioAcumulado / diasRestantes) * 100) / 100
          : 0;

      return {
        localId,
        nombre,
        pctConsecucion,
        sinDatos,
        objetivoHoy: objetivoHoy ?? null,
        desvioAcumulado,
        extraPorDia,
      };
    }),
  );

  const payload = { mes, hastaFecha, jornadaHoy: jornadaHoyEnMes || jornadaHoy, diasRestantes, locales };
  cardCache.set(cacheKey, { payload, cachedAt: Date.now() });
  return payload;
}

/**
 * Variante para el framework de Informes IA: además de la consecución, expone
 * importes agregados por local (real hasta ayer y comparativa del año anterior)
 * y un total del grupo. Reutiliza la misma maquinaria y el filtrado de locales
 * del usuario. NO modifica `buildObjetivoMensualCard` (que sigue sin importes).
 *
 * @param {object} user
 * @param {{ localId?: string }} [params] - filtro opcional a un local visible.
 */
export async function buildObjetivoMensualConImportes(user, params = {}) {
  const { mes, inicio: fechaInicioMes, fin: fechaFinMes } = mesEnCurso();
  const fechaHastaAyerStr = ayerIso();
  const hastaFecha =
    fechaHastaAyerStr < fechaInicioMes
      ? fechaInicioMes
      : fechaFinMes < fechaHastaAyerStr
        ? fechaFinMes
        : fechaHastaAyerStr;

  const festivosByFecha = await loadFestivosByFecha();
  const todosLocales = await scanLocales();
  const filtroLocalId = params.localId ? String(params.localId) : '';

  const visibles = [];
  for (const loc of todosLocales) {
    const id = loc.id_Locales ?? loc.id_locales;
    if (!id) continue;
    if (filtroLocalId && String(id) !== filtroLocalId) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await usuarioPuedeAccederLocal(user, id);
    if (!ok) continue;
    visibles.push(loc);
  }

  visibles.sort((a, b) =>
    String(a.nombre ?? a.Nombre ?? '').localeCompare(String(b.nombre ?? b.Nombre ?? ''), 'es', { sensitivity: 'base' }),
  );

  const locales = await Promise.all(
    visibles.map(async (loc) => {
      const localId = String(loc.id_Locales ?? loc.id_locales ?? '');
      const nombre = String(loc.nombre ?? loc.Nombre ?? localId).trim();
      const workplaceId = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const { pctConsecucion, sinDatos, importeRealHastaAyer, importeCompHastaAyer } = await calcPctConsecucionLocal(
        workplaceId,
        fechaInicioMes,
        fechaFinMes,
        hastaFecha,
        festivosByFecha,
      );
      return {
        localId,
        nombre,
        pctConsecucion,
        importeRealHastaAyer: importeRealHastaAyer ?? 0,
        importeCompHastaAyer: importeCompHastaAyer ?? 0,
        sinDatos,
      };
    }),
  );

  const totalReal = Math.round(locales.reduce((s, l) => s + (l.importeRealHastaAyer || 0), 0) * 100) / 100;
  const totalComp = Math.round(locales.reduce((s, l) => s + (l.importeCompHastaAyer || 0), 0) * 100) / 100;
  const pctGrupo = totalComp > 0 ? round1((totalReal / totalComp) * 100) : null;

  return {
    mes,
    hastaFecha,
    total: {
      importeRealHastaAyer: totalReal,
      importeCompHastaAyer: totalComp,
      pctConsecucion: pctGrupo,
    },
    locales,
  };
}
