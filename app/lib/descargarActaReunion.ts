import { Platform } from 'react-native';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { apiFetch } from '../utils/api';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(binary);
  // @ts-expect-error Buffer en entornos Node/web embebido
  return Buffer.from(bytes).toString('base64');
}

function nombreDesdeContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const m = header.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
  return m?.[1] ? decodeURIComponent(m[1].trim()) : fallback;
}

/**
 * Descarga el PDF del acta de una reunión vía API.
 * 200 → application/pdf; 409 → sin resumen; 404 → no visible.
 */
export async function descargarActaReunionPdf(idReunion: string): Promise<void> {
  const res = await apiFetch(
    `/api/reuniones/${encodeURIComponent(idReunion)}/acta.pdf`,
    { timeoutMs: 0 },
  );

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; mensaje?: string };
    if (res.status === 409) {
      throw new Error(err.error || err.mensaje || 'Aún no hay acta para descargar');
    }
    if (res.status === 404) {
      throw new Error(err.error || err.mensaje || 'Esta reunión no existe o ya no está disponible');
    }
    throw new Error(err.error || err.mensaje || 'No se pudo descargar el PDF del acta');
  }

  const buffer = await res.arrayBuffer();
  const fileName = nombreDesdeContentDisposition(
    res.headers.get('Content-Disposition'),
    `acta-reunion-${idReunion}.pdf`,
  );
  const contentType = res.headers.get('Content-Type') || 'application/pdf';

  if (Platform.OS === 'web') {
    const blob = new Blob([buffer], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  const base64 = arrayBufferToBase64(buffer);
  const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
  const fileUri = `${cacheDir}${fileName}`;
  await FileSystemLegacy.writeAsStringAsync(fileUri, base64, {
    encoding: FileSystemLegacy.EncodingType.Base64,
  });
  await Sharing.shareAsync(fileUri, { mimeType: contentType, dialogTitle: fileName });
}
