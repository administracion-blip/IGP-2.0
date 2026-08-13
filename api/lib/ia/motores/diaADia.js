/**
 * Motor determinista del briefing matutino «día a día».
 * Orquesta facturación YoY del día, objetivos MTD, ventas/hora dual,
 * excepciones sospechosas (>2€), top ventas por local, mantenimiento del día,
 * ratios por local y agrupaciones de objetivos.
 * Universo: locales Sede Grupo Paripe ∩ user.Locales.
 */
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { usuarioPuedeAccederLocal, jornadaNegocioInformeDefaultIso } from '../../usuarioLocales.js';
import { esSedeGrupoParipeLocal } from '../../locales/sede.js';
import {
  resolverFechaComparativa,
  buildFacturacionDiaYoY,
  buildObjetivoMensualConImportes,
} from '../../agora/objetivoMensual.js';
import { buildVentasPorHora, ejeHorasJornada } from '../../agora/ventasPorHora.js';
import { exportInvoices } from '../../agora/client.js';
import { buildExcepcionesFromInvoices } from '../../agora/excepcionesInvoice.js';
import { getAllUsersMap } from '../../dynamo/agoraUsuarios.js';
import { buildTopCamarerosFromVentasProducto } from '../../planning/topCamareros.js';
import { buildRatiosDiaLocal } from '../ratiosDiaLocal.js';
import { buildMantenimientoDia } from '../mantenimientoDia.js';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS_MVP = new Set(['invitacion', 'descuento']);
const UMBRAL_EXCEPCION_EUR = 2;
const TOPE_ITEMS = 40;
const TOPE_PEORES = 5;
const TOPE_VENTAS_LOCAL = 3;
const PK_AGRUPACIONES_OBJETIVOS = 'AGRUPACION_OBJETIVOS';

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function formatFechaEs(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!RE_FECHA.test(s)) return s;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Día siguiente en calendario local (sin UTC shift).
 * Input inválido → null.
 * @param {string} fechaIso YYYY-MM-DD
 * @returns {string|null}
 */
export function fechaSiguienteIso(fechaIso) {
  const s = String(fechaIso || '').slice(0, 10);
  if (!RE_FECHA.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function formatEuros(n) {
  return `${Number(n || 0).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

function formatPctSigned(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

/** Label humano de la fecha/origen de comparativa. */
export function buildComparativaLabel(origen, fechaComparativa) {
  const f = formatFechaEs(fechaComparativa);
  if (origen === 'festivo') {
    return `Comparado con ${f} (día mapeado en festivos)`;
  }
  return `Comparado con ${f} (mismo día año anterior)`;
}

function enriquecerFacturacionItem(item) {
  const real = Number(item.real) || 0;
  const comparativa = Number(item.comparativa) || 0;
  const delta = item.delta != null ? Number(item.delta) : round2(real - comparativa);
  const sign = delta > 0 ? '+' : '';
  const diferenciaLabel = `Diferencia: ${sign}${Number(delta).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
  const variacionPct = comparativa > 0 ? round1((real / comparativa - 1) * 100) : null;
  const pctLabel = formatPctSigned(variacionPct);
  const variacionPctLabel = pctLabel == null
    ? null
    : `${pctLabel} respecto al día comparable`;
  return {
    ...item,
    delta,
    diferenciaLabel,
    variacionPct,
    variacionPctLabel,
  };
}

function enriquecerObjetivoItem(item) {
  const pctConsecucion = item.pctConsecucion != null ? Number(item.pctConsecucion) : null;
  const pctDesviacion = pctConsecucion != null ? round1(pctConsecucion - 100) : null;
  const real = Number(item.importeRealHastaAyer) || 0;
  const objetivo = Number(item.importeCompHastaAyer) || 0;
  const desvLabel = formatPctSigned(pctDesviacion);
  return {
    ...item,
    pctDesviacion,
    realLabel: `Real: ${formatEuros(real)}`,
    objetivoLabel: `Objetivo: ${formatEuros(objetivo)}`,
    pctDesviacionLabel: desvLabel == null ? null : `${desvLabel} vs objetivo`,
  };
}

function importeHora(porHora, hora) {
  if (!porHora || typeof porHora !== 'object') return 0;
  return round2(porHora[String(hora)] ?? porHora[hora] ?? 0);
}

/** Horas con importe > 0 en un mapa compacto {hora: importe}. */
function horasConVenta(porHora) {
  if (!porHora || typeof porHora !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(porHora)) {
    const h = parseInt(k, 10);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    if ((Number(v) || 0) > 0) out.push(h);
  }
  return out;
}

/** Serie densa en eje de jornada (10→23, 0→9) sobre unión real∪comp. */
function mergePorHora(realPorHora, compPorHora) {
  const union = [
    ...horasConVenta(realPorHora),
    ...horasConVenta(compPorHora),
  ];
  const eje = ejeHorasJornada(union);
  return eje.map((hora) => ({
    hora,
    real: importeHora(realPorHora, hora),
    comparativa: importeHora(compPorHora, hora),
  }));
}

function horaDesdeFecha(fechaStr) {
  if (!fechaStr) return null;
  const m = String(fechaStr).match(/[T\s](\d{2}):\d{2}/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

async function scanLocales() {
  const items = [];
  let lastKey = null;
  do {
    // eslint-disable-next-line no-await-in-loop
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
 * Universo del briefing: Sede Grupo Paripe ∩ locales del usuario ∩ filtro opcional.
 * @returns {Promise<Array<{ localId: string, nombre: string, workplaceId: string, factorial_location_id: string|null }>>}
 */
async function localesUniversoDiaADia(user, filtroLocalId = '') {
  const todos = await scanLocales();
  const visibles = [];
  for (const loc of todos) {
    if (!esSedeGrupoParipeLocal(loc)) continue;
    const id = loc.id_Locales ?? loc.id_locales;
    if (!id) continue;
    if (filtroLocalId && String(id) !== filtroLocalId) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await usuarioPuedeAccederLocal(user, id);
    if (!ok) continue;
    const workplaceId = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
    const fid = loc.factorial_location_id != null ? String(loc.factorial_location_id).trim() : '';
    visibles.push({
      localId: String(id),
      nombre: String(loc.nombre ?? loc.Nombre ?? id).trim(),
      workplaceId,
      factorial_location_id: fid || null,
    });
  }
  visibles.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
  return visibles;
}

function mergeVentasHoraComparativa(real, comp, fecha, fechaComparativa) {
  const grupoPorHora = mergePorHora(real?.total?.porHora, comp?.total?.porHora);
  const byLocal = new Map();

  for (const loc of real?.locales || []) {
    byLocal.set(String(loc.localId), {
      localId: String(loc.localId),
      nombre: loc.nombre,
      locReal: loc,
      locComp: null,
    });
  }
  for (const loc of comp?.locales || []) {
    const id = String(loc.localId);
    const prev = byLocal.get(id);
    if (prev) {
      prev.locComp = loc;
    } else {
      byLocal.set(id, {
        localId: id,
        nombre: loc.nombre,
        locReal: null,
        locComp: loc,
      });
    }
  }

  const locales = [...byLocal.values()]
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }))
    .map((v) => {
      const porHora = mergePorHora(v.locReal?.porHora, v.locComp?.porHora);
      const totalReal = round2(v.locReal?.total ?? 0);
      const totalComparativa = round2(v.locComp?.total ?? 0);
      return {
        localId: v.localId,
        nombre: v.nombre,
        porHora,
        totalReal,
        totalComparativa,
        sinDatos: Boolean((v.locReal?.sinDatos ?? true) && (v.locComp?.sinDatos ?? true)),
      };
    });

  return {
    fecha,
    fechaComparativa,
    grupo: {
      porHora: grupoPorHora,
      horaPuntaReal: real?.total?.horaPunta ?? null,
      horaPuntaComp: comp?.total?.horaPunta ?? null,
      totalReal: round2(real?.total?.importe ?? 0),
      totalComparativa: round2(comp?.total?.importe ?? 0),
    },
    locales,
  };
}

function emptyExcepciones(fecha, error = null) {
  return {
    fecha,
    resumen: {
      total: 0,
      porTipo: {
        invitacion: { count: 0, importe: 0 },
        descuento: { count: 0, importe: 0 },
      },
    },
    items: [],
    error,
  };
}

/**
 * Invitaciones y descuentos del día (MVP) para el briefing.
 * Recibe ya el universo filtrado (Paripe + usuario).
 */
async function buildExcepcionesSospechosas(visibles, fecha) {
  const conAgora = (visibles || []).filter((v) => v.workplaceId);
  if (conAgora.length === 0) return emptyExcepciones(fecha);

  let usersMap = new Map();
  try {
    usersMap = await getAllUsersMap(docClient, tables.agoraUsuarios);
  } catch (e) {
    console.warn('[ia/dia-a-dia] usersMap', e.message || e);
  }

  const byWorkplace = new Map(conAgora.map((v) => [v.workplaceId, v]));
  const rows = [];
  let fetchError = null;

  await Promise.all(
    conAgora.map(async (v) => {
      let facturas = [];
      try {
        const data = await exportInvoices(fecha, [v.workplaceId]);
        const unwrap = (d) => d?.Data ?? d?.data ?? d?.Result ?? d?.result ?? d?.Export ?? d?.export ?? d;
        const cur = unwrap(data);
        for (const key of ['Invoices', 'invoices']) {
          const arr = cur?.[key];
          if (Array.isArray(arr)) { facturas = arr; break; }
          if (Array.isArray(arr?.Items)) { facturas = arr.Items; break; }
          if (Array.isArray(arr?.items)) { facturas = arr.items; break; }
        }
        if (!facturas.length && Array.isArray(cur)) facturas = cur;
      } catch (err) {
        console.warn('[ia/dia-a-dia] excepciones Ágora', v.workplaceId, fecha, err.message || err);
        fetchError = err.message || 'No se pudieron cargar facturas Ágora';
        return;
      }
      const built = buildExcepcionesFromInvoices(facturas, {
        usersMap,
        workplaceId: v.workplaceId,
        workplaceName: v.nombre,
        businessDay: fecha,
      });
      for (const r of built) {
        if (!TIPOS_MVP.has(r.Type)) continue;
        rows.push({ row: r, local: v });
      }
    }),
  );

  const itemsAll = rows
    .map(({ row, local }) => {
      const wp = String(row.WorkplaceId ?? '');
      const locMeta = byWorkplace.get(wp) || local;
      return {
        tipo: row.Type,
        quien: row.UserName || null,
        localId: locMeta.localId,
        localNombre: locMeta.nombre,
        importe: round2(Number(row.Amount) || 0),
        cantidad: row.Quantity != null ? Number(row.Quantity) || 0 : null,
        producto: row.ProductName || null,
        motivo: row.Reason || null,
        ticket: row.TicketNumber || row.InvoiceNumber || null,
        hora: horaDesdeFecha(row.DateTime),
        discountRate: row.DiscountRate != null ? Number(row.DiscountRate) : null,
      };
    })
    .filter((it) => Number(it.importe) > UMBRAL_EXCEPCION_EUR);

  const porTipo = {
    invitacion: { count: 0, importe: 0 },
    descuento: { count: 0, importe: 0 },
  };
  for (const it of itemsAll) {
    if (!porTipo[it.tipo]) continue;
    porTipo[it.tipo].count += 1;
    porTipo[it.tipo].importe = round2(porTipo[it.tipo].importe + (Number(it.importe) || 0));
  }

  const items = [...itemsAll]
    .sort((a, b) => (b.importe || 0) - (a.importe || 0))
    .slice(0, TOPE_ITEMS);

  return {
    fecha,
    resumen: {
      total: itemsAll.length,
      porTipo: {
        invitacion: {
          count: porTipo.invitacion.count,
          importe: round2(porTipo.invitacion.importe),
        },
        descuento: {
          count: porTipo.descuento.count,
          importe: round2(porTipo.descuento.importe),
        },
      },
    },
    items,
    error: fetchError,
  };
}

/**
 * Top 3 ventas (ImporteBruto) por usuario y local del día del briefing.
 * Soft-fail por local: error → sinDatos + top [].
 */
async function buildTopVentasPorLocal(universo, fecha) {
  const locales = await Promise.all(
    (universo || []).map(async (loc) => {
      try {
        const top = await buildTopCamarerosFromVentasProducto(
          docClient,
          loc.localId,
          fecha,
          fecha,
          TOPE_VENTAS_LOCAL,
        );
        return {
          localId: loc.localId,
          nombre: loc.nombre,
          sinDatos: !top.length,
          top: (top || []).map((t) => ({
            rank: t.rank,
            userId: t.userId,
            userName: t.userName,
            amount: round2(t.amount),
          })),
        };
      } catch (err) {
        console.warn('[ia/dia-a-dia] topVentas', loc.localId, err.message || err);
        return {
          localId: loc.localId,
          nombre: loc.nombre,
          sinDatos: true,
          top: [],
        };
      }
    }),
  );
  return { fecha, locales };
}

async function loadAgrupacionesObjetivos() {
  try {
    const items = [];
    let lastKey = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const r = await docClient.send(new QueryCommand({
        TableName: tables.ajustes,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK_AGRUPACIONES_OBJETIVOS },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);

    return items
      .map((it) => ({
        id: String(it.SK ?? ''),
        nombre: typeof it.nombre === 'string' ? it.nombre : '',
        localIds: Array.isArray(it.localIds) ? it.localIds.map((x) => String(x)) : [],
        color: typeof it.color === 'string' && it.color ? it.color : '#0ea5e9',
        orden: typeof it.orden === 'number' ? it.orden : 0,
      }))
      .filter((a) => a.id)
      .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
  } catch (err) {
    console.warn('[ia/dia-a-dia] agrupaciones', err.message || err);
    return [];
  }
}

function agregarAgrupaciones(agrupacionesDef, localesObj) {
  const byId = new Map((localesObj || []).map((l) => [String(l.localId), l]));
  return (agrupacionesDef || []).map((ag) => {
    let importeRealHastaAyer = 0;
    let importeCompHastaAyer = 0;
    let localesIncluidos = 0;
    for (const id of ag.localIds || []) {
      const loc = byId.get(String(id));
      if (!loc) continue;
      localesIncluidos += 1;
      importeRealHastaAyer += Number(loc.importeRealHastaAyer) || 0;
      importeCompHastaAyer += Number(loc.importeCompHastaAyer) || 0;
    }
    importeRealHastaAyer = round2(importeRealHastaAyer);
    importeCompHastaAyer = round2(importeCompHastaAyer);
    const pctConsecucion = importeCompHastaAyer > 0
      ? round1((importeRealHastaAyer / importeCompHastaAyer) * 100)
      : null;
    const pctDesviacion = pctConsecucion != null ? round1(pctConsecucion - 100) : null;
    const desvLabel = formatPctSigned(pctDesviacion);
    return {
      id: ag.id,
      nombre: ag.nombre,
      color: ag.color,
      localIds: ag.localIds,
      importeRealHastaAyer,
      importeCompHastaAyer,
      pctConsecucion,
      pctDesviacion,
      localesIncluidos,
      realLabel: `Real: ${formatEuros(importeRealHastaAyer)}`,
      objetivoLabel: `Objetivo: ${formatEuros(importeCompHastaAyer)}`,
      pctDesviacionLabel: desvLabel == null ? null : `${desvLabel} vs objetivo`,
    };
  }).filter((a) => a.localesIncluidos > 0);
}

/**
 * @param {object} user
 * @param {{ fecha?: string, localId?: string }} [params]
 */
export async function buildDiaADia(user, params = {}) {
  const fecha = RE_FECHA.test(String(params?.fecha || ''))
    ? String(params.fecha).slice(0, 10)
    : jornadaNegocioInformeDefaultIso();
  const localId = params?.localId ? String(params.localId) : null;

  const { fechaComparativa, origen } = await resolverFechaComparativa(fecha);
  const comparativaLabel = buildComparativaLabel(origen, fechaComparativa);

  const universo = await localesUniversoDiaADia(user, localId || '');
  const localIds = universo.map((l) => l.localId);
  const paramsBuilders = {
    fecha,
    localId: localId || undefined,
    localIds,
  };

  // Objetivo del día foco (fecha informe + 1) para subapartado del resumen IA
  const fechaFoco = fechaSiguienteIso(fecha);

  const [
    facturacionRaw,
    objetivosRaw,
    ventasReal,
    ventasComp,
    excepcionesSospechosas,
    agrupacionesDef,
    topVentasPorLocal,
    mantenimientoDia,
    facturacionFocoRaw,
  ] = await Promise.all([
    buildFacturacionDiaYoY(user, paramsBuilders),
    buildObjetivoMensualConImportes(user, paramsBuilders),
    buildVentasPorHora(user, paramsBuilders),
    buildVentasPorHora(user, { ...paramsBuilders, fecha: fechaComparativa }),
    buildExcepcionesSospechosas(universo, fecha),
    loadAgrupacionesObjetivos(),
    buildTopVentasPorLocal(universo, fecha),
    buildMantenimientoDia(universo, fecha),
    buildFacturacionDiaYoY(user, { ...paramsBuilders, fecha: fechaFoco }),
  ]);

  const factLocales = (facturacionRaw.locales || []).map(enriquecerFacturacionItem);
  const factTotal = enriquecerFacturacionItem(facturacionRaw.total || {
    real: 0,
    comparativa: 0,
    delta: 0,
    pctVsComp: null,
  });

  const objLocales = (objetivosRaw.locales || []).map(enriquecerObjetivoItem);
  const objTotal = enriquecerObjetivoItem(objetivosRaw.total || {
    importeRealHastaAyer: 0,
    importeCompHastaAyer: 0,
    pctConsecucion: null,
  });

  const peoresPorCaida = [...objLocales]
    .filter((l) => !l.sinDatos && l.pctDesviacion != null && l.pctDesviacion < 0)
    .sort((a, b) => (a.pctDesviacion ?? 0) - (b.pctDesviacion ?? 0))
    .slice(0, TOPE_PEORES);

  const agrupaciones = agregarAgrupaciones(agrupacionesDef, objLocales);

  const factByLocal = new Map(factLocales.map((l) => [String(l.localId), l]));
  const ratiosLocales = universo.map((u) => ({
    localId: u.localId,
    nombre: u.nombre,
    facturacionReal: Number(factByLocal.get(u.localId)?.real) || 0,
    factorial_location_id: u.factorial_location_id,
  }));

  const ratiosPorLocal = await buildRatiosDiaLocal({ fecha, locales: ratiosLocales });

  const focoTotalComp = Number(facturacionFocoRaw?.total?.comparativa) || 0;
  const objetivoFacturacionHoy = {
    fecha: fechaFoco,
    fechaLabel: formatFechaEs(fechaFoco),
    fechaComparativa: facturacionFocoRaw?.fechaComparativa ?? null,
    comparativaLabel: buildComparativaLabel(
      facturacionFocoRaw?.origenComparativa,
      facturacionFocoRaw?.fechaComparativa,
    ),
    nota: 'Objetivo = facturación del día comparable (mismo criterio YoY/festivos que el resto del briefing). No es lo facturado del día analizado.',
    total: {
      objetivo: focoTotalComp,
      objetivoLabel: `Objetivo grupo: ${formatEuros(focoTotalComp)}`,
    },
    locales: (facturacionFocoRaw?.locales || [])
      .filter((l) => !l.sinDatos && (Number(l.comparativa) || 0) > 0)
      .map((l) => {
        const objetivo = Number(l.comparativa) || 0;
        return {
          localId: l.localId,
          nombre: l.nombre,
          objetivo,
          objetivoLabel: `Objetivo ${l.nombre}: ${formatEuros(objetivo)}`,
        };
      })
      .sort((a, b) => b.objetivo - a.objetivo),
  };

  return {
    fecha,
    fechaComparativa,
    origenComparativa: origen,
    comparativaLabel,
    localId,
    facturacion: {
      total: factTotal,
      locales: factLocales,
    },
    objetivos: {
      mes: objetivosRaw.mes,
      hastaFecha: objetivosRaw.hastaFecha,
      nota: objetivosRaw.nota,
      total: objTotal,
      locales: objLocales,
      peoresPorCaida,
      agrupaciones,
    },
    ratiosPorLocal,
    ventasHoraComparativa: mergeVentasHoraComparativa(
      ventasReal,
      ventasComp,
      fecha,
      fechaComparativa,
    ),
    excepcionesSospechosas,
    topVentasPorLocal,
    mantenimientoDia,
    objetivoFacturacionHoy,
  };
}

