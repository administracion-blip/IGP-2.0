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
import { usuarioPuedeAccederLocal } from '../usuarioLocales.js';
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

function ayerIso() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
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
 * @param {{ localId?: string, fecha?: string }} [params]
 */
export async function buildVentasPorHora(user, params = {}) {
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(params?.fecha || '')) ? String(params.fecha) : ayerIso();
  const filtroLocalId = params?.localId ? String(params.localId) : '';

  const todos = await scanLocales();
  const visibles = [];
  for (const loc of todos) {
    const id = loc.id_Locales ?? loc.id_locales;
    if (!id) continue;
    if (filtroLocalId && String(id) !== filtroLocalId) continue;
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
