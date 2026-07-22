import crypto from 'crypto';

export const MAX_ENLACES_PLANNING = 20;
export const PERMISO_ENLACE_DEFECTO = 'planning_dia.ver';
export const ICONO_ENLACE_DEFECTO = 'open-in-new';

const ICONO_REGEX = /^[a-z0-9_-]{1,40}$/i;
const PERMISO_REGEX = /^[a-z0-9_]+\.[a-z0-9_]+$/i;

/** Solo http(s):// con host; usado para enlaces externos configurables. */
export function normalizarUrlExterna(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
  return parsed.toString();
}

function iconoEnlaceValido(raw) {
  const s = String(raw ?? '').trim();
  if (!s || !ICONO_REGEX.test(s)) return ICONO_ENLACE_DEFECTO;
  return s;
}

function permisoEnlaceValido(raw) {
  const s = String(raw ?? '').trim();
  if (!s || !PERMISO_REGEX.test(s)) return PERMISO_ENLACE_DEFECTO;
  return s;
}

/**
 * Valida y normaliza el array Enlaces del ajuste planning_dia/enlaces.
 * @returns {{ ok: true, enlaces: object[] } | { ok: false, error: string }}
 */
export function sanitizarEnlacesPlanning(raw) {
  if (raw === undefined) return { ok: true, enlaces: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Enlaces debe ser una lista' };
  }
  if (raw.length > MAX_ENLACES_PLANNING) {
    return { ok: false, error: `Máximo ${MAX_ENLACES_PLANNING} enlaces` };
  }

  const enlaces = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== 'object') {
      return { ok: false, error: `Enlace ${i + 1}: formato inválido` };
    }
    const label = String(e.label ?? '').trim();
    if (!label) {
      return { ok: false, error: `Enlace ${i + 1}: el título es obligatorio` };
    }
    const url = normalizarUrlExterna(String(e.url ?? '').trim());
    if (!url) {
      return { ok: false, error: `Enlace «${label}»: URL http(s) inválida` };
    }
    enlaces.push({
      id: String(e.id ?? crypto.randomUUID()).trim() || crypto.randomUUID(),
      label,
      descripcion: String(e.descripcion ?? '').trim() || null,
      url,
      icon: iconoEnlaceValido(e.icon),
      permiso: permisoEnlaceValido(e.permiso),
      activo: e.activo !== false,
      orden: i,
    });
  }

  return { ok: true, enlaces };
}

/** Compat legacy UrlInventario → array Enlaces (solo lectura). */
export function enlacesDesdeItemAjuste(item) {
  if (!item) return [];
  if (Array.isArray(item.Enlaces) && item.Enlaces.length > 0) {
    const r = sanitizarEnlacesPlanning(item.Enlaces);
    return r.ok ? r.enlaces : [];
  }
  const legacy = typeof item.UrlInventario === 'string' ? item.UrlInventario.trim() : '';
  const url = legacy ? normalizarUrlExterna(legacy) : '';
  if (!url) return [];
  return [{
    id: 'legacy-inventario',
    label: 'Realizar inventario',
    descripcion: 'Abre la herramienta de inventario en una nueva pestaña',
    url,
    icon: 'fact-check',
    permiso: PERMISO_ENLACE_DEFECTO,
    activo: true,
    orden: 0,
  }];
}
