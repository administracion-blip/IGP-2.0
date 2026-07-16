import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

/** Copia texto al portapapeles (web y nativo). */
export async function copyToClipboard(texto: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
    await Clipboard.setStringAsync(texto);
    return true;
  } catch {
    return false;
  }
}
