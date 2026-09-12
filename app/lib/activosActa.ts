import { Linking, Platform } from 'react-native';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

export function nombreFicheroActaEntrega(entregaId?: string | null): string {
  const id = String(entregaId || '').trim();
  return id ? `acta-entrega-${id}.pdf` : 'acta-entrega.pdf';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(binary);
  // @ts-expect-error Buffer en entornos Node/web embebido
  return Buffer.from(bytes).toString('base64');
}

function clicEnlace(url: string, fileName?: string) {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = url;
  if (fileName) a.download = fileName;
  a.rel = 'noopener noreferrer';
  a.click();
}

/**
 * Descarga el PDF de un acta de entrega desde una URL firmada de S3.
 * En web: blob + atributo download; si CORS bloquea el fetch, clic en el href
 * (el backend ya manda Content-Disposition: attachment).
 */
export async function descargarActaEntregaPdf(url: string, fileName?: string): Promise<void> {
  const nombre = (fileName || '').trim() || 'acta-entrega.pdf';
  const destino = url.trim();
  if (!destino) throw new Error('No hay justificante para descargar');

  if (Platform.OS === 'web') {
    try {
      const res = await fetch(destino);
      if (!res.ok) throw new Error('No se pudo descargar el justificante');
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      clicEnlace(objectUrl, nombre);
      URL.revokeObjectURL(objectUrl);
    } catch {
      clicEnlace(destino, nombre);
    }
    return;
  }

  try {
    const res = await fetch(destino);
    if (!res.ok) throw new Error('No se pudo descargar el justificante');
    const buffer = await res.arrayBuffer();
    const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
    const fileUri = `${cacheDir}${nombre}`;
    await FileSystemLegacy.writeAsStringAsync(fileUri, arrayBufferToBase64(buffer), {
      encoding: FileSystemLegacy.EncodingType.Base64,
    });
    const puedeCompartir = await Sharing.isAvailableAsync();
    if (puedeCompartir) {
      await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: nombre });
      return;
    }
  } catch {
    /* fallback a abrir la URL firmada */
  }
  await Linking.openURL(destino);
}
