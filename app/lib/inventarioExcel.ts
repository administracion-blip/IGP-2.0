/**
 * Descarga el Excel del conteo (plantilla de Ágora). No cambia el estado.
 * Si hay líneas de dictado sin confirmar, pregunta antes.
 */
import { Platform } from 'react-native';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { apiFetch } from '../utils/api';

type Confirmar = (
  titulo: string,
  mensaje: string,
  opciones?: { confirmarLabel?: string; cancelarLabel?: string },
) => Promise<boolean>;

export type ResultadoExcel = 'descargado' | 'revisar' | 'error';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  if (typeof btoa !== 'undefined') return btoa(binary);
  return Buffer.from(bytes).toString('base64');
}

async function leerError(res: Response): Promise<{ error: string; pendientes: number }> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; pendientes?: unknown };
  const pendientes = Number(body.pendientes);
  return {
    error: typeof body.error === 'string' && body.error.trim() ? body.error : 'No se ha podido generar el Excel',
    pendientes: Number.isInteger(pendientes) && pendientes > 0 ? pendientes : 0,
  };
}

async function guardarFichero(res: Response): Promise<void> {
  const buffer = await res.arrayBuffer();
  const disp = res.headers.get('Content-Disposition') || '';
  const nombre = disp.match(/filename="?([^"]+)"?/)?.[1] || 'inventario.xlsx';
  const tipo = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (Platform.OS === 'web') {
    const blob = new Blob([buffer], { type: tipo });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
  const fileUri = `${cacheDir}${nombre}`;
  await FileSystemLegacy.writeAsStringAsync(fileUri, arrayBufferToBase64(buffer), {
    encoding: FileSystemLegacy.EncodingType.Base64,
  });
  await Sharing.shareAsync(fileUri, { mimeType: tipo, dialogTitle: nombre });
}

/** «Revisar» deja el resultado en revisar para abrir el dictado. No guarda el fichero. */
export async function descargarExcelConteo(
  inventarioId: string,
  confirmar: Confirmar,
): Promise<{ resultado: ResultadoExcel; error?: string }> {
  const id = encodeURIComponent(inventarioId);
  const pedir = (igualmente: boolean) => apiFetch(
    `/api/inventarios/${id}/excel?origen=conteo${igualmente ? '&igualmente=1' : ''}`,
    { timeoutMs: 0 },
  );
  try {
    let res = await pedir(false);
    if (res.status === 409) {
      const aviso = await leerError(res);
      if (aviso.pendientes > 0) {
        const seguir = await confirmar('Líneas sin confirmar', aviso.error, {
          confirmarLabel: 'Descargar igualmente',
          cancelarLabel: 'Revisar',
        });
        if (!seguir) return { resultado: 'revisar' };
        res = await pedir(true);
      } else {
        return { resultado: 'error', error: aviso.error };
      }
    }
    if (!res.ok) {
      const aviso = await leerError(res);
      return { resultado: 'error', error: aviso.error };
    }
    await guardarFichero(res);
    return { resultado: 'descargado' };
  } catch {
    return { resultado: 'error', error: 'No se ha podido generar el Excel' };
  }
}
