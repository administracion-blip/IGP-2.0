/**
 * Atributos de GSI (S-18), fase de escritura.
 *
 * Una clave de índice jamás puede valer ''. DynamoDB rechaza el Put entero
 * con ValidationException. Si el valor no es válido, el atributo se omite
 * (`remove`) y no entra en `set`.
 *
 * Las lecturas siguen en Scan: el histórico aún no tiene estos atributos.
 */

import { normalizeCif } from './empresaCif.js';

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function diaCalendarioValido(yyyyMmDd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return false;
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Día `YYYY-MM-DD` desde ISO (con o sin hora), `dd/mm/aaaa` o `dd/mm/aa`.
 * '' si no es una fecha reconocible.
 */
export function diaIso(valor) {
  const s = texto(valor);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const dia = s.slice(0, 10);
    return diaCalendarioValido(dia) ? dia : '';
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return diaCalendarioValido(iso) ? iso : '';
  }
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m2) {
    const iso = `20${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
    return diaCalendarioValido(iso) ? iso : '';
  }
  return '';
}

/**
 * Instante ISO si el valor ya lo es y su día es válido; si solo hay día,
 * `YYYY-MM-DD`. '' si no es válido.
 */
export function instanteIso(valor) {
  const s = texto(valor);
  const dia = diaIso(s);
  if (!dia) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s;
  return dia;
}

/** Separa claves escribibles de las que hay que omitir o borrar. */
export function partirClavesGsi(atributos) {
  const set = {};
  const remove = [];
  for (const [clave, valor] of Object.entries(atributos || {})) {
    if (!clave.startsWith('gsi_')) continue;
    if (valor == null || valor === '') remove.push(clave);
    else set[clave] = valor;
  }
  return { set, remove };
}

/** Funde `set` en el ítem y borra los atributos de `remove`. */
export function aplicarClavesGsi(item, claves) {
  if (!item || typeof item !== 'object') return item;
  for (const clave of claves?.remove || []) {
    if (typeof clave === 'string' && clave.startsWith('gsi_')) delete item[clave];
  }
  for (const [clave, valor] of Object.entries(claves?.set || {})) {
    if (!clave.startsWith('gsi_') || valor == null || valor === '') {
      delete item[clave];
      continue;
    }
    item[clave] = valor;
  }
  return item;
}

/** Quita cualquier `gsi_*` (líneas que no deben entrar en el índice). */
export function omitirClavesGsi(item) {
  if (!item || typeof item !== 'object') return item;
  for (const clave of Object.keys(item)) {
    if (clave.startsWith('gsi_')) delete item[clave];
  }
  return item;
}

/**
 * Añade SET/REMOVE de claves GSI a un UpdateExpression.
 * Mutar `values` con placeholders `:gsiN` que no choquen con los existentes.
 */
export function fusionarClavesUpdate(updateExpression, values, claves) {
  const vals = values || {};
  const sets = [];
  let n = 0;
  for (const [campo, valor] of Object.entries(claves?.set || {})) {
    if (valor == null || valor === '') continue;
    let ph = `:gsi${n}`;
    while (Object.prototype.hasOwnProperty.call(vals, ph)) {
      n += 1;
      ph = `:gsi${n}`;
    }
    n += 1;
    sets.push(`${campo} = ${ph}`);
    vals[ph] = valor;
  }
  let expr = String(updateExpression || '').trim();
  if (sets.length) {
    if (/^SET\b/.test(expr)) expr = expr.replace(/^SET\s+/, `SET ${sets.join(', ')}, `);
    else expr = `SET ${sets.join(', ')}${expr ? ` ${expr}` : ''}`;
  }
  const presentes = new Set(Object.keys(claves?.set || {}));
  const removes = (claves?.remove || []).filter((k) => k && !presentes.has(k));
  if (removes.length) {
    if (/\bREMOVE\b/.test(expr)) expr = `${expr}, ${removes.join(', ')}`;
    else expr = `${expr} REMOVE ${removes.join(', ')}`;
  }
  return { UpdateExpression: expr, ExpressionAttributeValues: vals };
}

/** igp_Empresas, GSI Cif-index. */
export function clavesEmpresa(cifRaw) {
  return partirClavesGsi({ gsi_cif: normalizeCif(cifRaw) });
}

/** Igp_ComprasAProveedor, GSI Mes-Fecha. `albaranFecha` ya es el día de la línea. */
export function clavesComprasProveedor(albaranFecha) {
  const fecha = diaIso(albaranFecha);
  return partirClavesGsi({
    gsi_mes: fecha ? fecha.slice(0, 7) : '',
    gsi_fecha: fecha,
  });
}

/**
 * Igp_Pedidos, GSIs Local-Fecha y Estado-Fecha.
 * `gsi_local` es LocalId recortado, sin formatId6.
 * `gsi_fecha` prefiere CompletadoEn (día) y, si no es válido, Fecha en ISO.
 */
export function clavesPedido({ LocalId, Estado, Fecha, CompletadoEn } = {}) {
  const local = texto(LocalId);
  const estado = texto(Estado) || 'Borrador';
  let fecha = '';
  const completado = texto(CompletadoEn);
  if (completado) fecha = diaIso(completado.slice(0, 10)) || diaIso(completado);
  if (!fecha) fecha = diaIso(Fecha);
  return partirClavesGsi({
    gsi_local: local,
    gsi_estado: estado,
    gsi_fecha: fecha,
  });
}

/** Igp_Actuaciones, GSIs Listado-Fecha y Artista-Fecha. */
export function clavesActuacion(item = {}) {
  const artista = texto(item.id_artista);
  const fecha = diaIso(item.fecha);
  const hora = item.hora_inicio == null || item.hora_inicio === '' ? '' : String(item.hora_inicio);
  return partirClavesGsi({
    gsi_listado: 'ACTUACION',
    gsi_artista: artista,
    gsi_fecha: fecha ? `${fecha}#${hora}` : '',
  });
}

/** Igp_MysteryGuest, GSI Local-Fecha. Acepta LocalId o localId. */
export function clavesMysteryGuest(item = {}) {
  const local = texto(item.LocalId ?? item.localId);
  const fecha = diaIso(item.FechaDia) || diaIso(item.Fecha) || diaIso(item.CreadoEn);
  return partirClavesGsi({ gsi_local: local, gsi_fecha: fecha });
}

/** Igp_Mantenimiento, GSI Tipo-Fecha. */
export function clavesMantenimiento(item = {}) {
  return partirClavesGsi({
    gsi_tipo: texto(item.tipo),
    gsi_fecha: instanteIso(item.fecha_creacion),
  });
}

/** Igp_Negociaciones, GSI Listado-Fecha. Solo el ítem META. */
export function clavesNegociacionMeta(meta = {}) {
  if (meta.SK != null && meta.SK !== 'META') {
    return { set: {}, remove: ['gsi_listado', 'gsi_fecha'] };
  }
  return partirClavesGsi({
    gsi_listado: 'NEG',
    gsi_fecha: diaIso(meta.fecha),
  });
}

/**
 * Igp_AcuerdosDetalles, GSI Producto.
 * Misma normalización que `idsProductoCoinciden`: sin ceros a la izquierda.
 */
export function clavesAcuerdoDetalle(productId) {
  const raw = texto(productId);
  if (!raw) return partirClavesGsi({ gsi_producto: '' });
  return partirClavesGsi({ gsi_producto: raw.replace(/^0+/, '') || '0' });
}

/** Igp_Refacturaciones, GSI Estado-Fecha. */
export function clavesRefacturacion(item = {}) {
  return partirClavesGsi({
    gsi_estado: texto(item.estado),
    gsi_fecha: instanteIso(item.creado_en),
  });
}

/** Igp_BankFiles, GSI Listado-Fecha. */
export function clavesFicheroBanca(item = {}) {
  return partirClavesGsi({
    gsi_listado: 'CARGA',
    gsi_fecha: instanteIso(item.importadoEn),
  });
}

/** Igp_BankMovements, GSI Fichero. */
export function clavesMovimientoBanca(hashFichero) {
  return partirClavesGsi({ gsi_fichero: texto(hashFichero) });
}
