import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';

/**
 * Lógica de agregación del informe diario por local.
 *
 * Reutiliza los endpoints existentes `/api/cajas/top` (facturación, comparativa,
 * cumplimiento y top por usuario) y `/api/agora/invoices/exceptions` (invitaciones,
 * descuentos, anulaciones) llamándolos por HTTP interno, sin duplicar su lógica.
 *
 * Config en Igp_Ajustes: PK='informes', SK='informe_diario'
 *   { Enabled, Days[], Times[], Roles[], TopLimit }
 */

export const INFORME_AJUSTE_PK = 'informes';
export const INFORME_AJUSTE_SK = 'informe_diario';

/** Día de negocio por defecto del informe: ayer (YYYY-MM-DD). */
export function diaAnterior(ref = new Date()) {
  const d = new Date(ref);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function normalizeLocalNombres(val) {
  if (Array.isArray(val)) {
    return val.filter((l) => l != null && String(l).trim() !== '').map((l) => String(l).trim());
  }
  if (val != null && String(val).trim() !== '') return [String(val).trim()];
  return [];
}

function scanAll(TableName) {
  return (async () => {
    const items = [];
    let lastKey = null;
    do {
      const r = await docClient.send(new ScanCommand({ TableName, ...(lastKey && { ExclusiveStartKey: lastKey }) }));
      items.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey || null;
    } while (lastKey);
    return items;
  })();
}

/** Mapa nombre de local (minúsculas) → agoraCode y agoraCode → nombre, desde el maestro igp_Locales. */
export async function cargarMapaLocales() {
  const locales = await scanAll(tables.locales);
  const nombreToAgora = new Map();
  const agoraToNombre = new Map();
  for (const loc of locales) {
    const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
    const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
    if (!code) continue;
    if (nombre) nombreToAgora.set(nombre.toLowerCase(), code);
    agoraToNombre.set(code, nombre || code);
  }
  return { nombreToAgora, agoraToNombre };
}

/**
 * Resuelve los destinatarios del informe: usuarios cuyo Rol está en `rolesPermitidos`
 * y que tienen locales asignados (campo `Local`, por nombre). Locales se mapean a agoraCode.
 * Decisión de diseño: si un usuario no tiene locales resolubles, NO se le envía nada
 * (evita fugas de datos con el "Local vacío = todos").
 */
export async function resolverDestinatarios({ rolesPermitidos, mapaLocales }) {
  const rolesSet = new Set((rolesPermitidos || []).map((r) => String(r).trim().toLowerCase()).filter(Boolean));
  if (rolesSet.size === 0) return [];

  const { nombreToAgora, agoraToNombre } = mapaLocales || (await cargarMapaLocales());
  const usuarios = await scanAll(tables.usuarios);
  const destinatarios = [];

  for (const u of usuarios) {
    const rol = String(u.Rol ?? '').trim().toLowerCase();
    if (!rolesSet.has(rol)) continue;
    const email = String(u.Email ?? '').trim();
    if (!email) continue;

    const nombresLocal = normalizeLocalNombres(u.Local);
    if (nombresLocal.length === 0) continue;

    const agoraCodes = [];
    const localesNombres = [];
    for (const nom of nombresLocal) {
      const code = nombreToAgora.get(nom.toLowerCase());
      if (code && !agoraCodes.includes(code)) {
        agoraCodes.push(code);
        localesNombres.push(agoraToNombre.get(code) || nom);
      }
    }
    if (agoraCodes.length === 0) continue;

    destinatarios.push({
      email,
      nombre: `${u.Nombre ?? ''} ${u.Apellidos ?? ''}`.trim() || email,
      rol: u.Rol ?? '',
      agoraCodes,
      localesNombres,
    });
  }

  return destinatarios;
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson(url, authHeader) {
  const res = await fetch(url, { headers: { Authorization: authHeader } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status} en ${url}`);
  }
  return data;
}

/**
 * Obtiene y estructura los datos del informe para un conjunto de locales (agoraCodes)
 * y un día de negocio. Devuelve facturación/comparativa/cumplimiento por local,
 * resumen de excepciones (invitaciones/descuentos/anulaciones) y top por usuario.
 */
export async function obtenerDatosInforme({ baseUrl, authHeader, businessDay, agoraCodes, topLimit = 10 }) {
  const wp = agoraCodes.join(',');
  const qsBase = `dateFrom=${businessDay}&dateTo=${businessDay}&workplaceIds=${encodeURIComponent(wp)}`;

  const [top, exc] = await Promise.all([
    fetchJson(`${baseUrl}/api/cajas/top?${qsBase}&limit=${topLimit}`, authHeader),
    fetchJson(`${baseUrl}/api/agora/invoices/exceptions?${qsBase}`, authHeader).catch((err) => ({ rows: [], _err: err.message })),
  ]);

  // Facturación + comparativa + cumplimiento por local (de objetivos)
  const porLocal = (top.objetivos || []).map((o) => ({
    nombre: o.nombre,
    workplaceId: o.workplaceId,
    real: toNumber(o.real),
    comparativa: toNumber(o.comparativa),
    variacionPct: o.variacionPct,
  }));
  porLocal.sort((a, b) => b.real - a.real);

  const totalReal = porLocal.reduce((s, l) => s + l.real, 0);
  const totalComp = porLocal.reduce((s, l) => s + l.comparativa, 0);
  const variacionPctTotal = totalComp > 0.001 ? ((totalReal / totalComp) - 1) * 100 : null;

  // Resumen de excepciones por tipo
  const resumenTipos = {};
  for (const row of exc.rows || []) {
    const tipo = String(row.Type ?? row.Tipo ?? '').toLowerCase() || 'otros';
    const importe = toNumber(row.Amount ?? row.Importe);
    if (!resumenTipos[tipo]) resumenTipos[tipo] = { tipo, count: 0, importe: 0 };
    resumenTipos[tipo].count += 1;
    resumenTipos[tipo].importe += importe;
  }
  const excepciones = Object.values(resumenTipos)
    .map((e) => ({ ...e, importe: Math.round(e.importe * 100) / 100 }))
    .sort((a, b) => b.importe - a.importe);

  // Top por usuario (camareros)
  const topUsuarios = (top.camareros || []).map((c) => ({
    rank: c.rank,
    nombre: c.nombre ?? c.name ?? c.UserName ?? c.userName ?? '—',
    amount: toNumber(c.amount),
    tickets: c.tickets ?? c.count ?? null,
  }));

  return {
    businessDay,
    porLocal,
    totalReal: Math.round(totalReal * 100) / 100,
    totalComp: Math.round(totalComp * 100) / 100,
    variacionPctTotal: variacionPctTotal != null ? Math.round(variacionPctTotal * 10) / 10 : null,
    excepciones,
    topUsuarios,
  };
}
