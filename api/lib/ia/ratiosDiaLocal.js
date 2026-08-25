/**
 * Ratios del día por local para el briefing IA «día a día».
 * Personal: minutos reales Factorial × €/h RRHH (no salarios).
 * Mercadería (pedidos Completado) y músicos (actuaciones).
 * Denominador: facturación real del día (closeouts).
 */
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import {
  obtenerCuadrantePorLocales,
  CuadranteServicioError,
} from '../personal/cuadranteServicio.js';
import { cargarCosteHoraPorLocal } from './costeHoraRrhh.js';

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function ratioPct(gasto, facturacionReal) {
  const den = Number(facturacionReal) || 0;
  if (!(den > 0)) return null;
  return round1(((Number(gasto) || 0) / den) * 100);
}

/** Objetivo de ratio del maestro Locales (%, o null si no configurado). */
function parseRatioObjetivo(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function fechaPedidoToIso(fecha) {
  const s = String(fecha ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) return `20${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return '';
}

/** CompletadoEn (OK almacén) o Fecha pedido (legacy). */
function fechaReferenciaPedido(pedido) {
  const completadoEn = String(pedido?.CompletadoEn ?? '').trim();
  if (completadoEn) {
    const iso = fechaPedidoToIso(completadoEn.slice(0, 10));
    if (iso) return iso;
  }
  return fechaPedidoToIso(pedido?.Fecha) || String(pedido?.Fecha ?? '').trim().slice(0, 10);
}

function esActuacionCanceladaOAnulada(actuacion) {
  const e = String(actuacion?.estado ?? '').trim().toLowerCase();
  if (!e) return false;
  return e.includes('cancel') || e.includes('anul');
}

async function scanAll(tableName) {
  const items = [];
  let lastKey = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await docClient.send(new ScanCommand({
      TableName: tableName,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Gasto personal por local: (minutos_reales / 60) × €/h RRHH.
 * No usa salarios Factorial (coste_empresa / coste_bruto) ni minutos planificados.
 * Soft-fail si falta Factorial, €/h o la API falla.
 *
 * @param {Array<{ localId: string, factorial_location_id?: string|null }>} locales
 * @param {string} fecha
 * @returns {Promise<Map<string, {
 *   gasto: number|null,
 *   minutosReales?: number,
 *   costeHora?: number|null,
 *   aviso?: string,
 * }>>}
 */
async function gastoPersonalPorLocal(locales, fecha) {
  const out = new Map();
  const conFactorial = [];
  for (const loc of locales) {
    const id = String(loc.localId);
    const fid = loc.factorial_location_id != null ? String(loc.factorial_location_id).trim() : '';
    if (!fid) {
      out.set(id, { gasto: null, aviso: 'Sin Factorial configurado' });
    } else {
      conFactorial.push(id);
    }
  }

  if (conFactorial.length === 0) return out;

  const costeHoraMap = await cargarCosteHoraPorLocal(conFactorial);

  try {
    const cu = await obtenerCuadrantePorLocales({
      localIds: conFactorial,
      from: fecha,
      to: fecha,
    });
    for (const pl of cu.por_local || []) {
      const id = String(pl.local_id || '');
      const minutosReales = Math.max(0, Number(pl?.totales?.minutos_reales) || 0);
      const costeHora = costeHoraMap.get(id) ?? null;
      if (costeHora == null) {
        out.set(id, {
          gasto: null,
          minutosReales,
          costeHora: null,
          aviso: 'Sin importe €/h configurado (Ajustes → Importe por hora RRHH)',
        });
        continue;
      }
      const horas = minutosReales / 60;
      out.set(id, {
        gasto: round2(horas * costeHora),
        minutosReales,
        costeHora,
      });
    }
    for (const id of conFactorial) {
      if (out.has(id)) continue;
      const costeHora = costeHoraMap.get(id) ?? null;
      if (costeHora == null) {
        out.set(id, {
          gasto: null,
          minutosReales: 0,
          costeHora: null,
          aviso: 'Sin importe €/h configurado (Ajustes → Importe por hora RRHH)',
        });
      } else {
        out.set(id, { gasto: 0, minutosReales: 0, costeHora });
      }
    }
  } catch (err) {
    const msg = err instanceof CuadranteServicioError
      ? err.message
      : (err?.message || 'Error Factorial');
    console.warn('[ia/ratios] personal', msg);
    for (const id of conFactorial) {
      if (!out.has(id)) out.set(id, { gasto: null, aviso: 'Personal no disponible (Factorial)' });
    }
  }
  return out;
}

/**
 * Mercadería: pedidos Completado del día; suma TotalLinea (devoluciones restan).
 * @param {Set<string>} localIdsSet
 * @param {string} fecha
 */
async function gastoMercaderiaPorLocal(localIdsSet, fecha) {
  const out = new Map();
  for (const id of localIdsSet) out.set(id, 0);

  let pedidos;
  try {
    pedidos = await scanAll(tables.pedidos);
  } catch (err) {
    console.warn('[ia/ratios] pedidos', err.message || err);
    return out;
  }

  const delDia = pedidos.filter((p) => {
    if (String(p.Estado ?? '').trim() !== 'Completado') return false;
    const lid = String(p.LocalId ?? '').trim();
    if (!localIdsSet.has(lid)) return false;
    return fechaReferenciaPedido(p) === fecha;
  });

  await Promise.all(
    delDia.map(async (p) => {
      const pid = String(p.Id ?? '');
      const lid = String(p.LocalId ?? '').trim();
      if (!pid || !lid) return;
      const esDevolucion = String(p.Tipo ?? 'Pedido').trim() === 'Devolucion';
      const signo = esDevolucion ? -1 : 1;
      try {
        const q = await docClient.send(new QueryCommand({
          TableName: tables.pedidosLineas,
          KeyConditionExpression: 'PedidoId = :pid',
          ExpressionAttributeValues: { ':pid': pid },
        }));
        let total = 0;
        for (const l of q.Items || []) {
          const base = Number(l.TotalLinea ?? 0);
          if (!(base > 0)) continue;
          total += signo * base;
        }
        out.set(lid, round2((out.get(lid) || 0) + total));
      } catch (err) {
        console.warn('[ia/ratios] lineas pedido', pid, err.message || err);
      }
    }),
  );

  return out;
}

/**
 * Músicos: actuaciones del día; importe_final ?? importe_previsto.
 * Excluye canceladas/anuladas si el estado es reconocible.
 * @param {Set<string>} localIdsSet
 * @param {string} fecha
 */
async function gastoMusicosPorLocal(localIdsSet, fecha) {
  const out = new Map();
  for (const id of localIdsSet) out.set(id, 0);

  let actuaciones;
  try {
    actuaciones = await scanAll(tables.actuaciones);
  } catch (err) {
    console.warn('[ia/ratios] actuaciones', err.message || err);
    return out;
  }

  for (const a of actuaciones) {
    if (String(a.fecha ?? '').slice(0, 10) !== fecha) continue;
    const lid = String(a.id_local ?? '').trim();
    if (!localIdsSet.has(lid)) continue;
    if (esActuacionCanceladaOAnulada(a)) continue;
    const importe = a.importe_final != null && a.importe_final !== ''
      ? Number(a.importe_final)
      : Number(a.importe_previsto);
    if (!Number.isFinite(importe)) continue;
    out.set(lid, round2((out.get(lid) || 0) + importe));
  }
  return out;
}

/**
 * @param {{
 *   fecha: string,
 *   locales: Array<{
 *     localId: string,
 *     nombre: string,
 *     facturacionReal: number,
 *     factorial_location_id?: string|null,
 *     ratio_personal?: unknown,
 *     ratio_mercaderia?: unknown,
 *     ratio_musicos?: unknown,
 *   }>,
 * }} args
 */
export async function buildRatiosDiaLocal({ fecha, locales }) {
  const lista = Array.isArray(locales) ? locales : [];
  const localIdsSet = new Set(lista.map((l) => String(l.localId)));

  const [personalMap, mercaderiaMap, musicosMap] = await Promise.all([
    gastoPersonalPorLocal(lista, fecha),
    gastoMercaderiaPorLocal(localIdsSet, fecha),
    gastoMusicosPorLocal(localIdsSet, fecha),
  ]);

  return lista.map((loc) => {
    const id = String(loc.localId);
    const facturacionReal = round2(loc.facturacionReal || 0);
    const pers = personalMap.get(id) || { gasto: null };
    const gastoPersonal = pers.gasto;
    const gastoMercaderia = round2(mercaderiaMap.get(id) || 0);
    const gastoMusicos = round2(musicosMap.get(id) || 0);
    const avisos = [];
    if (pers.aviso) avisos.push(pers.aviso);

    return {
      localId: id,
      nombre: loc.nombre,
      facturacionReal,
      gastoPersonal,
      gastoMercaderia,
      gastoMusicos,
      ratioPersonal: gastoPersonal == null ? null : ratioPct(gastoPersonal, facturacionReal),
      ratioMercaderia: ratioPct(gastoMercaderia, facturacionReal),
      ratioMusicos: ratioPct(gastoMusicos, facturacionReal),
      objetivoPersonal: parseRatioObjetivo(loc.ratio_personal),
      objetivoMercaderia: parseRatioObjetivo(loc.ratio_mercaderia),
      objetivoMusicos: parseRatioObjetivo(loc.ratio_musicos),
      sinFacturacion: !(facturacionReal > 0),
      ...(pers.minutosReales != null ? { minutosRealesPersonal: pers.minutosReales } : {}),
      ...(pers.costeHora !== undefined ? { costeHoraPersonal: pers.costeHora } : {}),
      ...(avisos.length ? { avisos } : {}),
    };
  });
}
