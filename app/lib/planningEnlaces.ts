import { normalizarUrlExterna } from '../utils/enlaceExterno';

export type EnlacePlanning = {
  id: string;
  label: string;
  descripcion?: string;
  url: string;
  icon?: string;
  permiso?: string;
  activo?: boolean;
  orden?: number;
};

export const MAX_ENLACES_PLANNING = 20;
export const PERMISO_ENLACE_DEFECTO = 'planning_dia.ver';
export const ICONO_ENLACE_DEFECTO = 'open-in-new';

const ICONO_REGEX = /^[a-z0-9_-]{1,40}$/i;
const PERMISO_REGEX = /^[a-z0-9_]+\.[a-z0-9_]+$/i;

export function iconoEnlaceValido(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s || !ICONO_REGEX.test(s)) return ICONO_ENLACE_DEFECTO;
  return s;
}

export function permisoEnlaceValido(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s || !PERMISO_REGEX.test(s)) return PERMISO_ENLACE_DEFECTO;
  return s;
}

/** Migra UrlInventario legacy al array Enlaces si hace falta. */
export function enlacesDesdeItemAjuste(item: Record<string, unknown> | null | undefined): EnlacePlanning[] {
  if (!item) return [];

  const rawEnlaces = item.Enlaces;
  if (Array.isArray(rawEnlaces) && rawEnlaces.length > 0) {
    return normalizarListaEnlaces(rawEnlaces);
  }

  const legacy = typeof item.UrlInventario === 'string' ? item.UrlInventario.trim() : '';
  const url = legacy ? normalizarUrlExterna(legacy) : null;
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

export function normalizarListaEnlaces(raw: unknown[]): EnlacePlanning[] {
  const out: EnlacePlanning[] = [];
  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') return;
    const o = entry as Record<string, unknown>;
    const label = String(o.label ?? '').trim();
    const urlRaw = String(o.url ?? '').trim();
    const url = urlRaw ? normalizarUrlExterna(urlRaw) : null;
    if (!label || !url) return;

    out.push({
      id: String(o.id ?? crypto.randomUUID()).trim() || crypto.randomUUID(),
      label,
      descripcion: String(o.descripcion ?? '').trim() || undefined,
      url,
      icon: iconoEnlaceValido(o.icon),
      permiso: permisoEnlaceValido(o.permiso),
      activo: o.activo !== false,
      orden: Number.isFinite(Number(o.orden)) ? Number(o.orden) : idx,
    });
  });

  return out
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .slice(0, MAX_ENLACES_PLANNING)
    .map((e, i) => ({ ...e, orden: i }));
}

export function validarEnlacesParaGuardar(enlaces: EnlacePlanning[]): { ok: true; enlaces: EnlacePlanning[] } | { ok: false; error: string } {
  if (!Array.isArray(enlaces)) {
    return { ok: false, error: 'Enlaces debe ser una lista' };
  }
  if (enlaces.length > MAX_ENLACES_PLANNING) {
    return { ok: false, error: `Máximo ${MAX_ENLACES_PLANNING} enlaces` };
  }

  const normalizados: EnlacePlanning[] = [];
  for (let i = 0; i < enlaces.length; i++) {
    const e = enlaces[i];
    const label = String(e.label ?? '').trim();
    if (!label) {
      return { ok: false, error: `Enlace ${i + 1}: el título es obligatorio` };
    }
    const url = normalizarUrlExterna(String(e.url ?? '').trim());
    if (!url) {
      return { ok: false, error: `Enlace «${label}»: URL http(s) inválida` };
    }
    normalizados.push({
      id: String(e.id ?? crypto.randomUUID()).trim() || crypto.randomUUID(),
      label,
      descripcion: String(e.descripcion ?? '').trim() || undefined,
      url,
      icon: iconoEnlaceValido(e.icon),
      permiso: permisoEnlaceValido(e.permiso),
      activo: e.activo !== false,
      orden: i,
    });
  }

  return { ok: true, enlaces: normalizados };
}

export function enlacePlanningVisible(
  enlace: EnlacePlanning,
  hasPermiso: (p: string) => boolean,
): boolean {
  if (enlace.activo === false || !enlace.url) return false;
  const perm = enlace.permiso?.trim() || PERMISO_ENLACE_DEFECTO;
  return hasPermiso(perm);
}

export function crearEnlacePlanningVacio(orden: number): EnlacePlanning {
  return {
    id: crypto.randomUUID(),
    label: '',
    descripcion: '',
    url: '',
    icon: ICONO_ENLACE_DEFECTO,
    permiso: PERMISO_ENLACE_DEFECTO,
    activo: true,
    orden,
  };
}
