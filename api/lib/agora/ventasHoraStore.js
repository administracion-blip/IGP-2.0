/**
 * Venta por hora de un local en una jornada, agregada desde las facturas de Ágora.
 *
 * - `agregarFacturasPorHora` es el criterio único (lo usan `/agora/invoices/sales-by-hour`,
 *   Informes IA y la Previsión por franjas): hora del reloj de `Date`/`DateTime`,
 *   suma de `Totals.GrossAmount`, ignora facturas sin hora o con bruto <= 0.
 * - `obtenerVentasHora` sirve días cerrados desde Igp_VentasHora (PK = workplaceId,
 *   SK = businessDay) y, si faltan, los pide a Ágora y los guarda. Hoy y futuros
 *   se devuelven vacíos sin consultar ni persistir.
 */
import { BatchGetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { exportInvoices } from './client.js';
import { toNumberSafe } from './excepcionesInvoice.js';
import { jornadaNegocioHoyIso } from '../usuarioLocales.js';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_GET_MAX = 100;
const BATCH_GET_INTENTOS = 8;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Extrae la hora (0-23) de una fecha/hora de Ágora (ISO o "YYYY-MM-DD HH:MM:SS"). */
export function horaDesdeFecha(fechaStr) {
  if (!fechaStr) return null;
  const m = String(fechaStr).match(/[T\s](\d{2}):\d{2}/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

/** Localiza el array de facturas dentro de la respuesta de Ágora. */
export function extraerFacturas(data) {
  if (!data) return [];
  const unwrap = (d) => d?.Data ?? d?.data ?? d?.Result ?? d?.result ?? d?.Export ?? d?.export ?? d;
  const cur = unwrap(data);
  for (const key of ['Invoices', 'invoices']) {
    const v = cur?.[key];
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.Items)) return v.Items;
    if (Array.isArray(v?.items)) return v.items;
  }
  return Array.isArray(cur) ? cur : [];
}

/**
 * Agrupa facturas por hora del reloj.
 * `porHora` solo lleva las horas con venta (claves '0'..'23'), sin redondear.
 *
 * @param {object[]} invoices
 * @param {{ toNum?: (v: unknown) => number }} [opciones] conversión del bruto
 * @returns {{ porHora: Record<string, number>, totalDia: number, nFacturas: number }}
 */
export function agregarFacturasPorHora(invoices, { toNum = toNumberSafe } = {}) {
  const porHora = {};
  let totalDia = 0;
  let nFacturas = 0;
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    const hora = horaDesdeFecha(inv?.Date ?? inv?.date ?? inv?.DateTime ?? inv?.dateTime);
    const gross = toNum(
      inv?.Totals?.GrossAmount ?? inv?.totals?.grossAmount ?? inv?.GrossAmount ?? inv?.grossAmount,
    );
    if (hora == null || !(gross > 0)) continue;
    porHora[hora] = (porHora[hora] ?? 0) + gross;
    totalDia += gross;
    nFacturas += 1;
  }
  return { porHora, totalDia, nFacturas };
}

// ─── Persistencia ───

export function claveVentasHora(workplaceId, businessDay) {
  return `${workplaceId}|${businessDay}`;
}

function esTablaInexistente(err) {
  return err?.name === 'ResourceNotFoundException';
}

let tablaAusente = false;
let avisoTablaAusente = false;

function marcarTablaAusente(err) {
  tablaAusente = true;
  if (!avisoTablaAusente) {
    avisoTablaAusente = true;
    console.warn(
      `[ventas-hora] La tabla ${tables.ventasHora} no existe (${err?.message || err}). `
        + 'Se consulta Ágora en vivo sin guardar. Créala con node api/scripts/create-ventas-hora-table.js',
    );
  }
}

/** True si la tabla Igp_VentasHora no existe (detectado en esta ejecución). */
export function ventasHoraSinTabla() {
  return tablaAusente;
}

/** Solo para tests. */
export function _reiniciarEstadoVentasHora() {
  tablaAusente = false;
  avisoTablaAusente = false;
  enVuelo.clear();
}

function normalizarDato(item, origen) {
  const porHora = {};
  const bruto = item?.porHora && typeof item.porHora === 'object' ? item.porHora : {};
  for (const [h, v] of Object.entries(bruto)) {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) porHora[String(h)] = n;
  }
  return {
    porHora,
    totalDia: Number(item?.totalDia) || 0,
    nFacturas: Number(item?.nFacturas) || 0,
    definitivo: item?.definitivo === true,
    actualizadoEn: item?.actualizadoEn ?? null,
    origen,
  };
}

/** BatchGet troceado de 100 con reintento de UnprocessedKeys. Map clave → ítem. */
async function leerDeTabla(pares) {
  const out = new Map();
  for (let i = 0; i < pares.length; i += BATCH_GET_MAX) {
    let pendientes = pares.slice(i, i + BATCH_GET_MAX).map((p) => ({ PK: p.workplaceId, SK: p.businessDay }));
    let intentos = 0;
    while (pendientes.length && intentos < BATCH_GET_INTENTOS) {
      intentos += 1;
      if (intentos > 1) await new Promise((r) => setTimeout(r, 50 * 2 ** intentos));
      const r = await docClient.send(new BatchGetCommand({
        RequestItems: { [tables.ventasHora]: { Keys: pendientes } },
      }));
      for (const it of r.Responses?.[tables.ventasHora] || []) {
        out.set(claveVentasHora(String(it.PK), String(it.SK)), it);
      }
      pendientes = r.UnprocessedKeys?.[tables.ventasHora]?.Keys || [];
    }
  }
  return out;
}

async function guardarEnTabla(workplaceId, businessDay, dato) {
  if (tablaAusente) return;
  try {
    await docClient.send(new PutCommand({
      TableName: tables.ventasHora,
      Item: {
        PK: workplaceId,
        SK: businessDay,
        porHora: dato.porHora,
        totalDia: dato.totalDia,
        nFacturas: dato.nFacturas,
        definitivo: true,
        actualizadoEn: dato.actualizadoEn,
        fuente: 'agora',
      },
    }));
  } catch (err) {
    if (esTablaInexistente(err)) {
      marcarTablaAusente(err);
      return;
    }
    console.warn('[ventas-hora] No se pudo guardar', workplaceId, businessDay, err?.message || err);
  }
}

/** Peticiones a Ágora en curso, compartidas entre llamadas concurrentes. */
const enVuelo = new Map();

function pedirAAgora(workplaceId, businessDay, persistir) {
  const clave = claveVentasHora(workplaceId, businessDay);
  const existente = enVuelo.get(clave);
  if (existente) return existente;
  const promesa = (async () => {
    const data = await exportInvoices(businessDay, [workplaceId]);
    const agg = agregarFacturasPorHora(extraerFacturas(data));
    const porHora = {};
    for (const [h, v] of Object.entries(agg.porHora)) porHora[h] = round2(v);
    const dato = {
      porHora,
      totalDia: round2(agg.totalDia),
      nFacturas: agg.nFacturas,
      definitivo: true,
      actualizadoEn: new Date().toISOString(),
    };
    if (persistir) await guardarEnTabla(workplaceId, businessDay, dato);
    return { ...dato, origen: 'agora' };
  })().finally(() => {
    if (enVuelo.get(clave) === promesa) enVuelo.delete(clave);
  });
  enVuelo.set(clave, promesa);
  return promesa;
}

async function enParalelo(tareas, concurrencia) {
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.max(1, Math.min(concurrencia, tareas.length)) }, async () => {
    while (siguiente < tareas.length) {
      const i = siguiente;
      siguiente += 1;
      await tareas[i]();
    }
  });
  await Promise.all(trabajadores);
}

/**
 * Venta por hora para pares (local, jornada).
 *
 * @param {{ workplaceId: string, businessDay: string }[]} pares
 * @param {{ maxFetch?: number, concurrencia?: number, force?: boolean, hoyJornada?: string }} [opciones]
 *   `force`: ignora lo guardado y vuelve a pedir a Ágora los días cerrados.
 * @returns {Promise<Map<string, object>>} clave `${wp}|${dia}` →
 *   `{ porHora, totalDia, nFacturas, definitivo, actualizadoEn, origen: 'tabla'|'agora' }`
 *   | `{ noCerrado: true, porHora: {}, totalDia: 0, nFacturas: 0 }` (hoy o futuro)
 *   | `{ pendiente: true }` (superó maxFetch) | `{ error: true }` (Ágora falló).
 */
export async function obtenerVentasHora(pares, opciones = {}) {
  const {
    maxFetch = 120,
    concurrencia = 4,
    force = false,
    hoyJornada = jornadaNegocioHoyIso(),
  } = opciones;
  const resultado = new Map();

  const unicos = new Map();
  for (const p of Array.isArray(pares) ? pares : []) {
    const workplaceId = String(p?.workplaceId ?? '').trim();
    const businessDay = String(p?.businessDay ?? '').trim();
    if (!workplaceId || !RE_FECHA.test(businessDay)) continue;
    unicos.set(claveVentasHora(workplaceId, businessDay), { workplaceId, businessDay });
  }

  const cerrados = [];
  for (const [clave, p] of unicos) {
    if (p.businessDay < hoyJornada) cerrados.push(p);
    else resultado.set(clave, { noCerrado: true, porHora: {}, totalDia: 0, nFacturas: 0 });
  }
  if (!cerrados.length) return resultado;

  let faltan = cerrados;
  if (!force && !tablaAusente) {
    try {
      const guardados = await leerDeTabla(cerrados);
      faltan = [];
      for (const p of cerrados) {
        const clave = claveVentasHora(p.workplaceId, p.businessDay);
        const item = guardados.get(clave);
        if (item) resultado.set(clave, normalizarDato(item, 'tabla'));
        else faltan.push(p);
      }
    } catch (err) {
      if (!esTablaInexistente(err)) throw err;
      marcarTablaAusente(err);
    }
  }

  const limite = Math.max(0, Number.isFinite(maxFetch) ? maxFetch : faltan.length);
  const aPedir = faltan.slice(0, limite);
  for (const p of faltan.slice(limite)) {
    resultado.set(claveVentasHora(p.workplaceId, p.businessDay), { pendiente: true });
  }

  await enParalelo(
    aPedir.map((p) => async () => {
      const clave = claveVentasHora(p.workplaceId, p.businessDay);
      try {
        resultado.set(clave, await pedirAAgora(p.workplaceId, p.businessDay, !tablaAusente));
      } catch (err) {
        console.warn('[ventas-hora] Ágora falló para', p.workplaceId, p.businessDay, err?.message || err);
        resultado.set(clave, { error: true });
      }
    }),
    concurrencia,
  );

  return resultado;
}
