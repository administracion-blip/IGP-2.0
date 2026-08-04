/**
 * Ventas por hora (solo lectura) para el framework de Informes IA.
 *
 * Reutiliza la misma lógica probada del endpoint `/api/agora/invoices/sales-by-hour`:
 * pide las facturas de Ágora del día (`exportInvoices`) y las agrupa por hora del
 * reloj (`Date`/`DateTime` de cada factura) sumando `Totals.GrossAmount`.
 *
 * Filtra los locales del usuario igual que `buildObjetivoMensualConImportes`
 * (`usuarioPuedeAccederLocal`), resolviendo `agoraCode` como workplaceId. No se
 * persiste nada: el resultado lo cachea el propio framework de informes.
 *
 * No expone datos personales: solo local, hora e importes agregados.
 */
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { usuarioPuedeAccederLocal, jornadaNegocioInformeDefaultIso } from '../usuarioLocales.js';
import { exportInvoices } from './client.js';

/** Tramos horarios fijos para ayudar a la narración (hostelería). */
const FRANJAS = [
  { clave: 'madrugada', etiqueta: 'Madrugada (00–06)', desde: 0, hasta: 6 },
  { clave: 'manana', etiqueta: 'Mañana (06–12)', desde: 6, hasta: 12 },
  { clave: 'mediodia', etiqueta: 'Mediodía (12–17)', desde: 12, hasta: 17 },
  { clave: 'tarde', etiqueta: 'Tarde (17–21)', desde: 17, hasta: 21 },
  { clave: 'noche', etiqueta: 'Noche (21–24)', desde: 21, hasta: 24 },
];

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Extrae la hora (0-23) de una fecha/hora de Ágora (ISO o "YYYY-MM-DD HH:MM:SS"). */
function horaDesdeFecha(fechaStr) {
  if (!fechaStr) return null;
  const m = String(fechaStr).match(/[T\s](\d{2}):\d{2}/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

/** Localiza el array de facturas dentro de la respuesta de Ágora. */
function extraerFacturas(data) {
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

async function scanLocales() {
  const items = [];
  let lastKey = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await docClient.send(new ScanCommand({
      TableName: tables.locales,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Eje horario de jornada hostelera (10→23, 0→9).
 * Dado el conjunto de horas con actividad, emite la secuencia densa
 * desde la primera hasta la última según el orden de jornada.
 *
 * claveOrden(h) = h >= 10 ? h - 10 : h + 14
 *
 * @param {number[]} horasConActividad — horas 0–23 con venta
 * @returns {number[]}
 */
export function ejeHorasJornada(horasConActividad) {
  const horas = [...new Set(
    (Array.isArray(horasConActividad) ? horasConActividad : [])
      .map((h) => Number(h))
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),
  )];
  if (horas.length === 0) return [];

  const claveOrden = (h) => (h >= 10 ? h - 10 : h + 14);
  const deClave = (k) => (k <= 13 ? k + 10 : k - 14);

  let primera = Infinity;
  let ultima = -Infinity;
  for (const h of horas) {
    const k = claveOrden(h);
    if (k < primera) primera = k;
    if (k > ultima) ultima = k;
  }

  const out = [];
  for (let k = primera; k <= ultima; k += 1) {
    out.push(deClave(k));
  }
  return out;
}

/** Convierte un array de 24 horas en objeto compacto {hora: importe} (solo con ventas). */
function horasCompactas(arr) {
  const out = {};
  for (let h = 0; h < 24; h += 1) {
    if (arr[h] > 0) out[String(h)] = round2(arr[h]);
  }
  return out;
}

function horaPunta(arr) {
  let mejor = -1;
  let max = 0;
  for (let h = 0; h < 24; h += 1) {
    if (arr[h] > max) {
      max = arr[h];
      mejor = h;
    }
  }
  return mejor >= 0 ? { hora: mejor, importe: round2(max) } : null;
}

function resumenFranjas(arr) {
  return FRANJAS.map((f) => {
    let total = 0;
    for (let h = f.desde; h < f.hasta; h += 1) total += arr[h] || 0;
    return { franja: f.etiqueta, importe: round2(total) };
  }).filter((f) => f.importe > 0);
}

/**
 * @param {object} user
 * @param {{ localId?: string, fecha?: string, localIds?: string[] }} [params]
 */
export async function buildVentasPorHora(user, params = {}) {
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(params?.fecha || ''))
    ? String(params.fecha)
    : jornadaNegocioInformeDefaultIso();
  const filtroLocalId = params?.localId ? String(params.localId) : '';
  const localIdsSet = Array.isArray(params?.localIds)
    ? new Set(params.localIds.map((x) => String(x)))
    : null;

  if (localIdsSet && localIdsSet.size === 0) {
    return {
      fecha,
      numLocales: 0,
      total: { importe: 0, nFacturas: 0, horaPunta: null, porHora: {}, franjas: [] },
      locales: [],
    };
  }

  const todos = await scanLocales();
  const visibles = [];
  for (const loc of todos) {
    const id = loc.id_Locales ?? loc.id_locales;
    if (!id) continue;
    if (filtroLocalId && String(id) !== filtroLocalId) continue;
    if (localIdsSet && !localIdsSet.has(String(id))) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await usuarioPuedeAccederLocal(user, id);
    if (!ok) continue;
    const workplaceId = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
    if (!workplaceId) continue;
    visibles.push({
      localId: String(id),
      nombre: String(loc.nombre ?? loc.Nombre ?? id).trim(),
      workplaceId,
    });
  }

  visibles.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));

  const grupoHoras = new Array(24).fill(0);
  let grupoTotal = 0;
  let grupoFacturas = 0;

  const locales = await Promise.all(
    visibles.map(async (v) => {
      let data = null;
      try {
        data = await exportInvoices(fecha, [v.workplaceId]);
      } catch (err) {
        console.warn('[ia/ventas-hora] Ágora falló para', v.workplaceId, fecha, err.message || err);
        return { localId: v.localId, nombre: v.nombre, total: 0, nFacturas: 0, porHora: {}, sinDatos: true };
      }
      const facturas = extraerFacturas(data);
      const horas = new Array(24).fill(0);
      let total = 0;
      let n = 0;
      for (const inv of facturas) {
        const hora = horaDesdeFecha(inv?.Date ?? inv?.date ?? inv?.DateTime ?? inv?.dateTime);
        const gross = toNum(
          inv?.Totals?.GrossAmount ?? inv?.totals?.grossAmount ?? inv?.GrossAmount ?? inv?.grossAmount,
        );
        if (hora == null || !(gross > 0)) continue;
        horas[hora] += gross;
        total += gross;
        n += 1;
      }
      for (let h = 0; h < 24; h += 1) grupoHoras[h] += horas[h];
      grupoTotal += total;
      grupoFacturas += n;
      return {
        localId: v.localId,
        nombre: v.nombre,
        total: round2(total),
        nFacturas: n,
        porHora: horasCompactas(horas),
        sinDatos: n === 0,
      };
    }),
  );

  return {
    fecha,
    numLocales: locales.length,
    total: {
      importe: round2(grupoTotal),
      nFacturas: grupoFacturas,
      horaPunta: horaPunta(grupoHoras),
      porHora: horasCompactas(grupoHoras),
      franjas: resumenFranjas(grupoHoras),
    },
    locales,
  };
}
