import { Linking, Platform } from 'react-native';

/**
 * Valida y normaliza una URL externa: solo https, sin espacios.
 * Devuelve la URL canónica o null si no es válida.
 */
export function normalizarUrlHttps(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
}

/** Abre una URL https en nueva pestaña (web) o con el navegador del sistema (nativo). */
export async function abrirEnlaceExterno(raw: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = normalizarUrlHttps(raw);
  if (!url) {
    return { ok: false, error: 'La URL debe ser https:// válida. Configúrala en Ajustes.' };
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
