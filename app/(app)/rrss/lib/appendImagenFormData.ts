import { Platform } from 'react-native';

/** Adjunta un archivo de imagen local (`uri` file:// o blob en web) al FormData del upload marketing. */
export async function appendImagenAlFormData(
  form: FormData,
  uri: string,
  nombreArchivo: string,
  mimeType?: string,
) {
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    const blob = await res.blob();
    form.append('file', blob, nombreArchivo || 'imagen.jpg');
  } else {
    form.append('file', {
      uri,
      name: nombreArchivo || 'imagen.jpg',
      type: mimeType || 'image/jpeg',
    } as unknown as Blob);
  }
}
