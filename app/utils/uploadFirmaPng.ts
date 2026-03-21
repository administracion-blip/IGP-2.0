/**
 * Construye FormData con la imagen PNG de firma (base64 sin prefijo data:) para POST /actuaciones/item/:id/firma
 */
import { Platform } from 'react-native';
import {
  cacheDirectory,
  documentDirectory,
  writeAsStringAsync,
  EncodingType,
} from 'expo-file-system/legacy';

export async function buildFirmaFormData(base64PngRaw: string): Promise<FormData> {
  const raw = base64PngRaw.replace(/^data:image\/png;base64,/, '').trim();
  const formData = new FormData();
  if (Platform.OS === 'web') {
    const res = await fetch(`data:image/png;base64,${raw}`);
    const blob = await res.blob();
    formData.append('file', blob, 'firma.png');
  } else {
    const baseDir = cacheDirectory ?? documentDirectory;
    if (!baseDir) {
      throw new Error('No hay directorio de caché/documentos para guardar la firma.');
    }
    const uri = `${baseDir}firma_${Date.now()}.png`;
    await writeAsStringAsync(uri, raw, { encoding: EncodingType.Base64 });
    formData.append(
      'file',
      {
        uri,
        name: 'firma.png',
        type: 'image/png',
      } as unknown as Blob
    );
  }
  return formData;
}
