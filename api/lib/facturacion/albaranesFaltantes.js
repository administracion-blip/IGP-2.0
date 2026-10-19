/**
 * Sanea el array `albaranes_faltantes` de una factura IN: albaranes que cita la
 * factura del proveedor y no aparecen en Ágora, anotados a mano como incidencia.
 */

import crypto from 'crypto';

export const MAX_ALBARANES_FALTANTES = 100;
export const MAX_NUMERO_DOC_PROVEEDOR = 60;
export const MAX_NOTA_ALBARAN_FALTANTE = 300;
const MAX_ID = 64;
const MAX_TEXTO_OTRA_EMPRESA = 200;

function str(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Nº de documento del proveedor comparable: solo letras/dígitos en mayúsculas
 * (`F26 004418` == `F26-004418`). Mismo criterio que `normDocProveedor` del front.
 */
export function normDocProveedor(valor) {
  return String(valor ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

/** '' si vacío; YYYY-MM-DD si lo es (admite sufijo de hora); null si no es fecha. */
function fechaDiaOVacia(v) {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function importeONull(v) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function isoONull(v) {
  const s = str(v);
  if (!s) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

function sanitizeOtraEmpresa(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {
    empresa_cif: str(v.empresa_cif).slice(0, MAX_TEXTO_OTRA_EMPRESA),
    empresa_nombre: str(v.empresa_nombre).slice(0, MAX_TEXTO_OTRA_EMPRESA),
    almacen: str(v.almacen).slice(0, MAX_TEXTO_OTRA_EMPRESA),
    fecha: fechaDiaOVacia(v.fecha) || '',
  };
  if (!out.empresa_cif && !out.empresa_nombre && !out.almacen && !out.fecha) return null;
  return out;
}

/**
 * @param {unknown} raw
 * @param {{
 *   ahoraIso: string,
 *   creado_por?: string,
 *   creado_por_id?: string,
 *   previos?: unknown,
 * }} ctx `previos` es el array guardado: los `creado_*` de un item ya existente
 *   (mismo `id`) salen de ahí y no del body; los de un item nuevo, del usuario.
 * @returns {{ ok: true, items: object[] } | { ok: false, error: string }}
 */
export function sanitizeAlbaranesFaltantes(raw, ctx) {
  if (raw == null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'albaranes_faltantes debe ser un array' };
  }
  if (raw.length > MAX_ALBARANES_FALTANTES) {
    return { ok: false, error: `Como máximo ${MAX_ALBARANES_FALTANTES} albaranes que faltan por factura` };
  }

  const ahora = str(ctx?.ahoraIso) || new Date().toISOString();
  const creadoPor = str(ctx?.creado_por);
  const creadoPorId = str(ctx?.creado_por_id);
  const previosPorId = new Map();
  if (Array.isArray(ctx?.previos)) {
    for (const p of ctx.previos) {
      const pid = str(p?.id);
      if (pid) previosPorId.set(pid, p);
    }
  }

  const items = [];
  const idsVistos = new Set();
  const normsVistos = new Set();

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    const pref = `albaranes_faltantes[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: `${pref}: item inválido` };
    }

    const numero = str(row.numero_doc_proveedor);
    if (!numero) return { ok: false, error: `${pref}: el nº de documento del proveedor es obligatorio` };
    if (numero.length > MAX_NUMERO_DOC_PROVEEDOR) {
      return { ok: false, error: `${pref}: el nº de documento no puede superar ${MAX_NUMERO_DOC_PROVEEDOR} caracteres` };
    }
    const norm = normDocProveedor(numero);
    if (!norm) return { ok: false, error: `${pref}: el nº de documento debe tener letras o dígitos` };
    if (normsVistos.has(norm)) {
      return { ok: false, error: `${pref}: el albarán ${numero} ya está anotado en esta factura` };
    }
    normsVistos.add(norm);

    let id = str(row.id);
    if (id.length > MAX_ID) return { ok: false, error: `${pref}: id inválido` };
    if (!id) id = crypto.randomUUID();
    if (idsVistos.has(id)) return { ok: false, error: `${pref}: id duplicado (${id})` };
    idsVistos.add(id);

    const fecha = fechaDiaOVacia(row.fecha_albaran);
    if (fecha === null) return { ok: false, error: `${pref}: fecha_albaran debe ser YYYY-MM-DD` };

    const nota = str(row.nota);
    if (nota.length > MAX_NOTA_ALBARAN_FALTANTE) {
      return { ok: false, error: `${pref}: la nota no puede superar ${MAX_NOTA_ALBARAN_FALTANTE} caracteres` };
    }

    const estado = str(row.estado) === 'resuelta' ? 'resuelta' : 'pendiente';
    let resueltaPor = null;
    let resueltaEn = null;
    if (estado === 'resuelta') {
      resueltaPor = str(row.resuelta_por) === 'auto' ? 'auto' : 'manual';
      resueltaEn = isoONull(row.resuelta_en) || ahora;
    }

    const previo = previosPorId.get(id);
    const creado = previo
      ? {
        creado_en: str(previo.creado_en) || ahora,
        creado_por: str(previo.creado_por),
        creado_por_id: str(previo.creado_por_id),
      }
      : { creado_en: ahora, creado_por: creadoPor, creado_por_id: creadoPorId };

    items.push({
      id,
      numero_doc_proveedor: numero,
      numero_norm: norm,
      fecha_albaran: fecha,
      importe: importeONull(row.importe),
      nota,
      estado,
      resuelta_por: resueltaPor,
      resuelta_en: resueltaEn,
      en_otra_empresa: sanitizeOtraEmpresa(row.en_otra_empresa),
      ...creado,
    });
  }

  return { ok: true, items };
}
