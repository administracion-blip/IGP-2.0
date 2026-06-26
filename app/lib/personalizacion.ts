import { apiFetch } from '../utils/api';

/**
 * Precio de venta mostrado = precio base × (1 + porcentaje/100). Sin efecto si el % es 0 o inválido.
 */
export function aplicarPorcentajeBeneficio(precioBase: number, porcentajeBeneficio: number): number {
  const base = Number(precioBase);
  if (!Number.isFinite(base)) return base;
  const pct = Number(porcentajeBeneficio);
  if (!Number.isFinite(pct) || pct === 0) return base;
  return base * (1 + pct / 100);
}

/**
 * Porcentaje de beneficio global (ajustes → personalización).
 * Nota: este endpoint requiere auth; si se llama sin sesión devuelve 0.
 */
export async function fetchPorcentajeBeneficio(): Promise<number> {
  try {
    const res = await apiFetch('/api/ajustes/personalizacion/app');
    const data = await res.json();
    if (!res.ok || !data?.ok || !data?.item) return 0;
    const p = (data.item as { PorcentajeBeneficio?: number }).PorcentajeBeneficio;
    const n = typeof p === 'number' ? p : parseFloat(String(p ?? ''));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Importe por hora por defecto (ajustes → personalización), en €/hora.
 * Usado como ratio inicial en RRHH → Horas por facturación cuando un local no
 * tiene ratio propio. Si se llama sin sesión o no está configurado, devuelve 0.
 */
export async function fetchImporteHoraDefecto(): Promise<number> {
  try {
    const res = await apiFetch('/api/ajustes/personalizacion/app');
    const data = await res.json();
    if (!res.ok || !data?.ok || !data?.item) return 0;
    const p = (data.item as { ImporteHoraDefecto?: number }).ImporteHoraDefecto;
    const n = typeof p === 'number' ? p : parseFloat(String(p ?? ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Obtiene la URI de imagen de personalización (data URL o http) desde Igp_Ajustes.
 * Endpoint PÚBLICO (no requiere token) — usado en el login antes de autenticar.
 * El parámetro `_baseUrl` se mantiene por compatibilidad con `login.tsx` pero se ignora.
 */
export async function fetchImagenApp(_baseUrl?: string): Promise<string | null> {
  try {
    const res = await apiFetch('/api/public/personalizacion/app-image', { timeoutMs: 8000 });
    const data = await res.json();
    if (!res.ok) return null;
    const uri = data?.imagen;
    return typeof uri === 'string' && uri.trim().length > 0 ? uri.trim() : null;
  } catch {
    return null;
  }
}
