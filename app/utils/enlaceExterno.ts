import { Linking, Platform } from 'react-native';

const PROTOCOLOS_PERMITIDOS = new Set(['http:', 'https:']);

/**
 * Valida y normaliza una URL externa: http o https, con host, sin espacios.
 * Devuelve la URL canónica o null si no es válida.
 */
export function normalizarUrlExterna(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!PROTOCOLOS_PERMITIDOS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
}

/** @deprecated Usa normalizarUrlExterna */
export const normalizarUrlHttps = normalizarUrlExterna;

/** Abre una URL http(s) en nueva pestaña (web) o con el navegador del sistema (nativo). */
export async function abrirEnlaceExterno(raw: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = normalizarUrlExterna(raw);
  if (!url) {
    return { ok: false, error: 'La URL debe ser http:// o https:// válida. Configúrala en Ajustes.' };
  }
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const w = window.open(url, '_blank', 'noopener,noreferrer');
      if (!w) {
        // Popup bloqueado: fallback
        window.location.assign(url);
      }
      return { ok: true };
    }
    const can = await Linking.canOpenURL(url);
    if (!can) return { ok: false, error: 'No se puede abrir este enlace en el dispositivo.' };
    await Linking.openURL(url);
    return { ok: true };
  } catch {
    return { ok: false, error: 'No se pudo abrir el enlace.' };
  }
}
