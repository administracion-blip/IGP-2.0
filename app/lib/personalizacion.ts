const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

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
 */
export async function fetchPorcentajeBeneficio(baseUrl = API_URL): Promise<number> {
  try {
    const res = await fetch(`${baseUrl}/api/ajustes/personalizacion/app`);
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
 * Obtiene la URI de imagen de personalización (data URL o http) desde Igp_Ajustes.
 */
export async function fetchImagenApp(baseUrl = API_URL): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ajustes/personalizacion/app`);
    const data = await res.json();
    if (!res.ok || !data?.ok || !data?.item) return null;
    const uri = data.item.ImagenApp;
    return typeof uri === 'string' && uri.trim().length > 0 ? uri.trim() : null;
  } catch {
    return null;
  }
}
