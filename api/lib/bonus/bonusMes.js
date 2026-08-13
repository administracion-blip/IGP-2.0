/**
 * Orquestación Bonus RRHH: preview live, overlay de %, snapshot Dynamo.
 */

import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { buildObjetivoMensualConImportes } from '../agora/objetivoMensual.js';
import { esSedeGrupoParipeLocal } from '../locales/sede.js';
import {
  usuarioPuedeAccederLocal,
  usuarioTieneAlcanceGlobal,
} from '../usuarioLocales.js';
import { agregarIncentivosMes } from './bonusIncentivos.js';
import {
  baseFondo,
  desvGross,
  desvSinIvaFromGross,
  fondoComun,
  pctEfectivo,
  round2,
  sinIva,
  totalBonus,
} from './bonusCalculo.js';

export const VERSION_CALCULO = 'bonus-v2';
const RE_MES = /^\d{4}-\d{2}$/;

export function pkMes(mes) {
  return `MES#${mes}`;
}

export function skLocal(localId) {
  return `LOCAL#${localId}`;
}

/** Resuelve YYYY-MM → { mes, anio, mesNum, inicio, fin }. */
export function resolverRangoMes(anio, mes) {
  const y = Number(anio);
  const m = Number(mes);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new Error('anio inválido');
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error('mes inválido (1-12)');
  }
  const mStr = String(m).padStart(2, '0');
  const mesKey = `${y}-${mStr}`;
  const ultimoDia = new Date(y, m, 0).getDate();
  return {
    mes: mesKey,
    anio: y,
    mesNum: m,
    inicio: `${mesKey}-01`,
    fin: `${mesKey}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

export function parseMesKey(mesKey) {
  const key = String(mesKey || '').trim();
  if (!RE_MES.test(key)) throw new Error('mes debe ser YYYY-MM');
  const anio = Number(key.slice(0, 4));
  const mesNum = Number(key.slice(5, 7));
  return resolverRangoMes(anio, mesNum);
}

function emptyTotales() {
  return {
    realGross: 0,
    objGross: 0,
    desvGross: 0,
    desvSinIva: 0,
    incentivos: 0,
    baseFondo: 0,
    fondo: 0,
    total: 0,
  };
}

function sumTotales(items) {
  const t = emptyTotales();
  for (const it of items) {
    const incentivos = it.incentivosCampana ?? it.incentivos ?? 0;
    const fondo = it.fondo || 0;
    const total = it.total != null ? it.total : totalBonus(incentivos, fondo);
    t.realGross = round2(t.realGross + (it.realGross || 0));
    t.objGross = round2(t.objGross + (it.objGross || 0));
    t.desvGross = round2(t.desvGross + (it.desvGross || 0));
    t.desvSinIva = round2(t.desvSinIva + (it.desvSinIva || 0));
    t.incentivos = round2(t.incentivos + incentivos);
    t.baseFondo = round2(t.baseFondo + (it.baseFondo || 0));
    t.fondo = round2(t.fondo + fondo);
    t.total = round2(t.total + total);
  }
  return t;
}

async function scanLocalesMap() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.locales,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  const map = new Map();
  for (const loc of items) {
    const id = String(loc.id_Locales ?? loc.id_locales ?? '').trim();
    if (id) map.set(id, loc);
  }
  return map;
}

async function scanEmpresasMap() {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.empresas,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  const map = new Map();
  for (const e of items) {
    const id = String(e.id_empresa ?? '').trim();
    if (id) map.set(id, e);
  }
  return map;
}

function calcLocalRow({
  localId,
  localNombre,
  id_empresa,
  empresaNombre,
  realGross,
  objGross,
  incentivosCampana,
  incentivosDetalle,
  pctFondo,
  pctDefaultGlobal,
}) {
  const desvG = desvGross(realGross, objGross);
  const desvN = desvSinIvaFromGross(desvG);
  const base = baseFondo(desvN);
  const pctEff = pctEfectivo(pctFondo, pctDefaultGlobal);
  const fondo = fondoComun(base, pctEff);
  const inc = round2(incentivosCampana);
  const total = totalBonus(inc, fondo);
  const huecoGross = round2(Math.max(0, (Number(objGross) || 0) - (Number(realGross) || 0)));
  return {
    localId,
    localNombre,
    id_empresa,
    empresaNombre,
    realGross: round2(realGross),
    objGross: round2(objGross),
    realSinIva: sinIva(realGross),
    objSinIva: sinIva(objGross),
    desvGross: desvG,
    desvSinIva: desvN,
    huecoGross: huecoGross > 0 ? huecoGross : 0,
    incentivosCampana: inc,
    baseFondo: base,
    pctFondo: pctFondo == null || pctFondo === '' ? null : Number(pctFondo),
    pctEfectivo: pctEff,
    fondo,
    total,
    incentivosDetalle: Array.isArray(incentivosDetalle) ? incentivosDetalle : [],
  };
}

function agruparPorEmpresa(locales) {
  const byEmp = new Map();
  for (const loc of locales) {
    const empId = String(loc.id_empresa || '').trim() || '_sin_empresa';
    if (!byEmp.has(empId)) {
      byEmp.set(empId, {
        id_empresa: empId === '_sin_empresa' ? '' : empId,
        nombre: loc.empresaNombre || (empId === '_sin_empresa' ? 'Sin empresa' : empId),
        locales: [],
      });
    }
    byEmp.get(empId).locales.push(loc);
  }
  const empresas = [...byEmp.values()].map((emp) => {
    emp.locales.sort((a, b) =>
      String(a.localNombre || '').localeCompare(String(b.localNombre || ''), 'es', { sensitivity: 'base' }),
    );
    return {
      ...emp,
      totales: sumTotales(emp.locales),
    };
  });
  empresas.sort((a, b) =>
    String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', { sensitivity: 'base' }),
  );
  return empresas;
}

/**
 * Actor SOLO para el cálculo de cierre con todos los locales Paripe del grupo.
 * Eleva `rol` a Administrador para que `usuarioPuedeAccederLocal` no filtre;
 * no altera permisos del request ni el campo cerradoPor / actualizadoPor.
 */
export function userParaCalculoAlcanceTodos(user) {
  return { ...(user || {}), rol: 'Administrador' };
}

/**
 * Preview live del mes (objetivos MTD + incentivos hasta hastaFecha + %).
 *
 * Universo: Sede Grupo Paripe ∩ (locales del usuario si alcance !== 'todos').
 *
 * @param {object} user
 * @param {{
 *   anio: number,
 *   mes: number,
 *   pctDefaultGlobal?: number,
 *   pctPorLocal?: Record<string, number|null>,
 *   alcance?: 'usuario' | 'todos',
 * }} opts
 *   - alcance 'usuario' (default): Paripe ∩ Locales del user (GET preview).
 *   - alcance 'todos': todos los locales Paripe (cierre irreversible).
 */
export async function buildBonusMesPreview(user, {
  anio,
  mes,
  pctDefaultGlobal = 0,
  pctPorLocal = {},
  alcance = 'usuario',
} = {}) {
  const rango = resolverRangoMes(anio, mes);
  const fechaAncla = rango.fin;
  // Cierre: ignorar filtro de Locales del usuario (integridad del snapshot).
  const userCalculo = alcance === 'todos' ? userParaCalculoAlcanceTodos(user) : user;
  const objetivos = await buildObjetivoMensualConImportes(userCalculo, { fecha: fechaAncla });
  const hastaFecha = objetivos.hastaFecha || rango.fin;

  const [localesMap, empresasMap] = await Promise.all([
    scanLocalesMap(),
    scanEmpresasMap(),
  ]);

  // Tras scan: solo sede Grupo Paripe (mismo criterio que briefing dia_a_dia).
  // Si un local del objetivo no es Paripe, se excluye del preview/cierre/totales.
  const localesObjetivo = (objetivos.locales || []).filter((locObj) => {
    const metaLoc = localesMap.get(String(locObj.localId));
    return metaLoc && esSedeGrupoParipeLocal(metaLoc);
  });

  const localIds = localesObjetivo.map((l) => String(l.localId));
  const incentivosMap = await agregarIncentivosMes(docClient, {
    inicioMes: rango.inicio,
    hastaFecha,
    localIds,
  });

  const pctGlobal = Number(pctDefaultGlobal) || 0;
  const localesCalc = [];
  const avisos = [];

  for (const locObj of localesObjetivo) {
    const localId = String(locObj.localId);
    const metaLoc = localesMap.get(localId) || {};
    const idEmpresa = String(metaLoc.id_empresa ?? '').trim();
    const emp = idEmpresa ? empresasMap.get(idEmpresa) : null;
    const empresaNombre = emp
      ? String(emp.Nombre ?? emp.nombre ?? idEmpresa).trim()
      : (String(metaLoc.empresa ?? metaLoc.Empresa ?? '').trim() || (idEmpresa ? idEmpresa : 'Sin empresa'));

    if (!String(metaLoc.agoraCode ?? metaLoc.AgoraCode ?? '').trim() && locObj.sinDatos) {
      avisos.push(`Local ${locObj.nombre || localId} sin agoraCode / sin datos de closeout`);
    }

    const inc = incentivosMap.get(localId) || { totalIncentivo: 0, detalle: [] };
    const pctLocal = Object.prototype.hasOwnProperty.call(pctPorLocal, localId)
      ? pctPorLocal[localId]
      : null;

    localesCalc.push(calcLocalRow({
      localId,
      localNombre: locObj.nombre || localId,
      id_empresa: idEmpresa,
      empresaNombre,
      realGross: locObj.importeRealHastaAyer ?? 0,
      objGross: locObj.importeCompHastaAyer ?? 0,
      incentivosCampana: inc.totalIncentivo,
      incentivosDetalle: inc.detalle,
      pctFondo: pctLocal,
      pctDefaultGlobal: pctGlobal,
    }));
  }

  const empresas = agruparPorEmpresa(localesCalc);
  const totalesGrupo = sumTotales(localesCalc);

  return {
    mes: rango.mes,
    anio: rango.anio,
    hastaFecha,
    estado: 'borrador',
    pctDefaultGlobal: pctGlobal,
    empresas,
    totalesGrupo,
    avisos: avisos.length ? [...new Set(avisos)] : undefined,
    versionCalculo: VERSION_CALCULO,
  };
}

/** Lee META + LOCAL#* del mes. */
export async function getSnapshotMes(mesKey) {
  const mes = String(mesKey || '').trim();
  if (!RE_MES.test(mes)) throw new Error('mes debe ser YYYY-MM');

  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.bonusMensual,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pkMes(mes) },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);

  const meta = items.find((i) => i.SK === 'META') || null;
  const locales = items.filter((i) => String(i.SK || '').startsWith('LOCAL#'));
  return { meta, locales, items };
}

/** Respuesta GET desde snapshot cerrado (filtrado por locales del usuario). */
export async function snapshotToResponse(user, { meta, locales }) {
  const visibles = [];
  for (const loc of locales) {
    const localId = String(loc.localId || String(loc.SK || '').replace(/^LOCAL#/, ''));
    // eslint-disable-next-line no-await-in-loop
    const ok = await usuarioPuedeAccederLocal(user, localId);
    if (!ok) continue;
    visibles.push({
      localId,
      localNombre: loc.localNombre || localId,
      id_empresa: loc.id_empresa || '',
      empresaNombre: loc.empresaNombre || 'Sin empresa',
      realGross: loc.realGross ?? 0,
      objGross: loc.objGross ?? 0,
      realSinIva: loc.realSinIva ?? sinIva(loc.realGross),
      objSinIva: loc.objSinIva ?? sinIva(loc.objGross),
      desvGross: loc.desvGross ?? 0,
      desvSinIva: loc.desvSinIva ?? 0,
      huecoGross: loc.huecoGross ?? 0,
      incentivosCampana: loc.incentivosCampana ?? 0,
      baseFondo: loc.baseFondo ?? 0,
      pctFondo: loc.pctFondo ?? null,
      pctEfectivo: loc.pctEfectivo ?? pctEfectivo(loc.pctFondo, meta?.pctDefaultGlobal),
      fondo: loc.fondo ?? 0,
      total: loc.total != null
        ? loc.total
        : totalBonus(loc.incentivosCampana ?? 0, loc.fondo ?? 0),
      incentivosDetalle: Array.isArray(loc.incentivosDetalle) ? loc.incentivosDetalle : [],
    });
  }

  const empresas = agruparPorEmpresa(visibles);
  return {
    mes: meta.mes || String(meta.PK || '').replace(/^MES#/, ''),
    anio: meta.anio,
    hastaFecha: meta.hastaFecha,
    estado: meta.estado || 'cerrado',
    pctDefaultGlobal: meta.pctDefaultGlobal ?? 0,
    empresas,
    totalesGrupo: sumTotales(visibles),
    cerradoEn: meta.cerradoEn,
    cerradoPor: meta.cerradoPor,
    versionCalculo: meta.versionCalculo || 'desconocido',
  };
}

/**
 * Guarda % global y por local sin cerrar. 409 si ya cerrado.
 * - pctDefaultGlobal solo si el body lo incluye; requiere alcance global (403 si no).
 * - locales[]: solo se persisten los que usuarioPuedeAccederLocal permita.
 */
export async function savePcts(mesKey, input = {}, user) {
  const locales = Array.isArray(input.locales) ? input.locales : [];
  const mandaGlobal = Object.prototype.hasOwnProperty.call(input, 'pctDefaultGlobal');

  if (mandaGlobal) {
    const okGlobal = await usuarioTieneAlcanceGlobal(user);
    if (!okGlobal) {
      const err = new Error(
        'No tienes alcance global para cambiar el porcentaje por defecto del grupo',
      );
      err.status = 403;
      throw err;
    }
  }

  const rango = parseMesKey(mesKey);
  const { meta } = await getSnapshotMes(rango.mes);
  if (meta?.estado === 'cerrado') {
    const err = new Error('El mes ya está cerrado');
    err.status = 409;
    throw err;
  }

  const now = new Date().toISOString();
  const actor = {
    id_usuario: user?.id_usuario ?? user?.sub ?? null,
    nombre: user?.Nombre ?? user?.nombre ?? user?.email ?? null,
  };

  const pctGlobal = mandaGlobal
    ? Number(input.pctDefaultGlobal)
    : (meta?.pctDefaultGlobal ?? 0);

  const metaItem = {
    PK: pkMes(rango.mes),
    SK: 'META',
    anio: rango.anio,
    mes: rango.mes,
    estado: 'borrador',
    pctDefaultGlobal: pctGlobal,
    versionCalculo: VERSION_CALCULO,
    actualizadoEn: now,
    actualizadoPor: actor,
    ...(meta?.hastaFecha ? { hastaFecha: meta.hastaFecha } : {}),
    ...(meta?.totalesGrupo ? { totalesGrupo: meta.totalesGrupo } : {}),
  };
  await docClient.send(new PutCommand({ TableName: tables.bonusMensual, Item: metaItem }));

  for (const row of locales) {
    const localId = String(row.localId || '').trim();
    if (!localId) continue;
    // eslint-disable-next-line no-await-in-loop
    const permitido = await usuarioPuedeAccederLocal(user, localId);
    if (!permitido) continue;
    const existing = await docClient.send(new GetCommand({
      TableName: tables.bonusMensual,
      Key: { PK: pkMes(rango.mes), SK: skLocal(localId) },
    }));
    const prev = existing.Item || {};
    const item = {
      ...prev,
      PK: pkMes(rango.mes),
      SK: skLocal(localId),
      localId,
      pctFondo: row.pctFondo == null || row.pctFondo === '' ? null : Number(row.pctFondo),
      actualizadoEn: now,
    };
    // eslint-disable-next-line no-await-in-loop
    await docClient.send(new PutCommand({ TableName: tables.bonusMensual, Item: item }));
  }

  return { meta: metaItem };
}

/**
 * Recalcula, persiste META + LOCAL# y marca cerrado.
 */
export async function cerrarMes(mesKey, { pctDefaultGlobal, locales = [] } = {}, user) {
  const rango = parseMesKey(mesKey);
  const snap = await getSnapshotMes(rango.mes);
  if (snap.meta?.estado === 'cerrado') {
    const err = new Error('El mes ya está cerrado');
    err.status = 409;
    throw err;
  }

  const pctPorLocal = {};
  for (const loc of snap.locales) {
    const id = String(loc.localId || String(loc.SK || '').replace(/^LOCAL#/, ''));
    if (loc.pctFondo != null && loc.pctFondo !== '') pctPorLocal[id] = Number(loc.pctFondo);
  }
  for (const row of locales) {
    const id = String(row.localId || '').trim();
    if (!id) continue;
    pctPorLocal[id] = row.pctFondo == null || row.pctFondo === '' ? null : Number(row.pctFondo);
  }

  const pctGlobal = pctDefaultGlobal != null
    ? Number(pctDefaultGlobal)
    : (snap.meta?.pctDefaultGlobal ?? 0);

  // Cierre irreversible: snapshot con todos los locales Paripe (no filtrar por Locales del user).
  const preview = await buildBonusMesPreview(user, {
    anio: rango.anio,
    mes: rango.mesNum,
    pctDefaultGlobal: pctGlobal,
    pctPorLocal,
    alcance: 'todos',
  });

  const now = new Date().toISOString();
  const actor = {
    id_usuario: user?.id_usuario ?? user?.sub ?? null,
    nombre: user?.Nombre ?? user?.nombre ?? user?.email ?? null,
  };

  const metaItem = {
    PK: pkMes(rango.mes),
    SK: 'META',
    anio: rango.anio,
    mes: rango.mes,
    hastaFecha: preview.hastaFecha,
    estado: 'cerrado',
    pctDefaultGlobal: preview.pctDefaultGlobal,
    totalesGrupo: preview.totalesGrupo,
    cerradoEn: now,
    cerradoPor: actor,
    actualizadoEn: now,
    actualizadoPor: actor,
    versionCalculo: VERSION_CALCULO,
  };
  await docClient.send(new PutCommand({ TableName: tables.bonusMensual, Item: metaItem }));

  const flatLocales = preview.empresas.flatMap((e) => e.locales);
  for (const loc of flatLocales) {
    const item = {
      PK: pkMes(rango.mes),
      SK: skLocal(loc.localId),
      ...loc,
      actualizadoEn: now,
    };
    // eslint-disable-next-line no-await-in-loop
    await docClient.send(new PutCommand({ TableName: tables.bonusMensual, Item: item }));
  }

  return {
    ...preview,
    estado: 'cerrado',
    cerradoEn: now,
    cerradoPor: actor,
  };
}

/** Overlay de % guardados en Dynamo sobre un preview live. */
export function overlayPctsFromSnapshot(preview, snapLocales, meta) {
  const pctPorLocal = {};
  for (const loc of snapLocales || []) {
    const id = String(loc.localId || String(loc.SK || '').replace(/^LOCAL#/, ''));
    if (Object.prototype.hasOwnProperty.call(loc, 'pctFondo')) {
      pctPorLocal[id] = loc.pctFondo;
    }
  }
  const pctGlobal = meta?.pctDefaultGlobal != null
    ? Number(meta.pctDefaultGlobal)
    : preview.pctDefaultGlobal;

  const localesFlat = [];
  for (const emp of preview.empresas) {
    for (const loc of emp.locales) {
      const pctFondo = Object.prototype.hasOwnProperty.call(pctPorLocal, loc.localId)
        ? pctPorLocal[loc.localId]
        : loc.pctFondo;
      localesFlat.push(calcLocalRow({
        localId: loc.localId,
        localNombre: loc.localNombre,
        id_empresa: loc.id_empresa,
        empresaNombre: loc.empresaNombre,
        realGross: loc.realGross,
        objGross: loc.objGross,
        incentivosCampana: loc.incentivosCampana,
        incentivosDetalle: loc.incentivosDetalle,
        pctFondo,
        pctDefaultGlobal: pctGlobal,
      }));
    }
  }

  const empresas = agruparPorEmpresa(localesFlat);
  return {
    ...preview,
    pctDefaultGlobal: pctGlobal,
    empresas,
    totalesGrupo: sumTotales(localesFlat),
  };
}

export async function getMetaPcts(mesKey) {
  try {
    const r = await docClient.send(new GetCommand({
      TableName: tables.bonusMensual,
      Key: { PK: pkMes(mesKey), SK: 'META' },
    }));
    return r.Item || null;
  } catch {
    return null;
  }
}
