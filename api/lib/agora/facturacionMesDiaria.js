/**
 * Facturación diaria del mes para la tarjeta del inicio.
 * Solo lectura: cajas en DynamoDB y festivos de comparativa. No escribe ni llama a Ágora.
 */
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6, usuarioPuedeAccederLocal } from '../usuarioLocales.js';
import { esSedeGrupoParipeLocal } from '../locales/sede.js';
import {
  buildFechaToComp,
  loadFestivosByFecha,
  queryTotalsByDay,
} from './objetivoMensual.js';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function ayerIso() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function partesMes(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || y < 2000 || y > 2100 || m < 1 || m > 12) {
    throw httpError(400, 'Año o mes no válido');
  }
  const ahora = new Date();
  const anioActual = ahora.getFullYear();
  const mesActual = ahora.getMonth() + 1;
  if (y > anioActual || (y === anioActual && m > mesActual)) {
    throw httpError(400, 'El mes indicado es futuro');
  }
  const mStr = String(m).padStart(2, '0');
  const ultimo = new Date(y, m, 0).getDate();
  return {
    enCurso: y === anioActual && m === mesActual,
    inicio: `${y}-${mStr}-01`,
    fin: `${y}-${mStr}-${String(ultimo).padStart(2, '0')}`,
  };
}

function diasDelMes(inicio, fin) {
  const dias = [];
  const cursor = new Date(`${inicio}T12:00:00`);
  const end = new Date(`${fin}T12:00:00`);
  while (cursor <= end) {
    dias.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

function idDeLocal(loc) {
  const raw = loc?.id_Locales ?? loc?.id_locales;
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return '';
  return formatId6(s);
}

function idsPedidos(localIds) {
  if (localIds == null) return null;
  const texto = String(localIds).trim();
  if (!texto) return null;
  const ids = texto
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .map((x) => formatId6(x));
  return new Set(ids);
}

async function escanearLocales() {
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

async function localesDelMes(user, localIds) {
  const todos = await escanearLocales();
  const asignados = [];
  for (const loc of todos) {
    const id = idDeLocal(loc);
    if (!id) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await usuarioPuedeAccederLocal(user, id);
    if (ok) asignados.push(loc);
  }
  const pedidos = idsPedidos(localIds);
  if (!pedidos) return asignados.filter(esSedeGrupoParipeLocal);
  const inter = asignados.filter((loc) => pedidos.has(idDeLocal(loc)));
  if (inter.length === 0) {
    throw httpError(403, 'Ningún local solicitado está entre tus locales');
  }
  return inter;
}

function sumarMapas(destino, origen) {
  for (const [fecha, importe] of Object.entries(origen || {})) {
    destino[fecha] = (destino[fecha] || 0) + importe;
  }
}

/**
 * @param {object} user Usuario del token.
 * @param {{ year: number, month: number, localIds?: string }} params
 */
export async function buildFacturacionMesDiaria(user, params = {}) {
  const { inicio, fin, enCurso } = partesMes(params.year, params.month);
  const corte = enCurso ? ayerIso() : fin;
  const locales = await localesDelMes(user, params.localIds);
  const festivos = await loadFestivosByFecha(inicio, fin);
  const { fechaToComp, minComp, maxComp } = buildFechaToComp(inicio, fin, festivos);

  const realPorDia = {};
  const compPorDia = {};
  await Promise.all(locales.map(async (loc) => {
    const workplaceId = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
    if (!workplaceId || !minComp || !maxComp) return;
    const [real, comp] = await Promise.all([
      queryTotalsByDay(workplaceId, inicio, fin),
      queryTotalsByDay(workplaceId, minComp, maxComp),
    ]);
    sumarMapas(realPorDia, real);
    sumarMapas(compPorDia, comp);
  }));

  let totalReal = 0;
  let objetivoAHoy = 0;
  let objetivoMes = 0;
  let ultimoDiaConDatos = null;

  const dias = diasDelMes(inicio, fin).map((fecha) => {
    const dentro = fecha <= corte;
    const real = dentro ? round2(realPorDia[fecha] ?? 0) : 0;
    const fechaComp = fechaToComp[fecha];
    const objetivo = round2(fechaComp ? (compPorDia[fechaComp] ?? 0) : 0);
    objetivoMes += objetivo;
    if (dentro) {
      totalReal += real;
      objetivoAHoy += objetivo;
      if (Object.prototype.hasOwnProperty.call(realPorDia, fecha) && (!ultimoDiaConDatos || fecha > ultimoDiaConDatos)) {
        ultimoDiaConDatos = fecha;
      }
    }
    return { fecha, real, objetivo };
  });

  totalReal = round2(totalReal);
  objetivoAHoy = round2(objetivoAHoy);
  objetivoMes = round2(objetivoMes);
  const consecucionPct = objetivoAHoy > 0 ? round1((totalReal / objetivoAHoy) * 100) : null;
  const proyeccionFinMes = objetivoAHoy > 0 ? round2((totalReal / objetivoAHoy) * objetivoMes) : null;

  return {
    dias,
    ultimoDiaConDatos,
    totalReal,
    objetivoAHoy,
    objetivoMes,
    consecucionPct,
    proyeccionFinMes,
    diferenciaRitmo: round2(totalReal - objetivoAHoy),
  };
}
