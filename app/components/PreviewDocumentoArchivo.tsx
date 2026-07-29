import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

export type DocumentoPreviewArchivo = {
  nombre?: string;
  tipo: string;
  previewUrl: string;
};

type Props = {
  archivo: DocumentoPreviewArchivo | null | undefined;
  /** Título accesible del iframe (PDF). */
  tituloIframe?: string;
};

/**
 * Vista previa de un documento subido (PDF en iframe web, imagen en `<img>`).
 * Modo solo lectura, reutilizable en registro masivo, modales de alta, etc.
 */
export function PreviewDocumentoArchivo({ archivo, tituloIframe = 'Vista previa' }: Props) {
  if (!archivo?.previewUrl) {
    return (
      <View style={styles.fallbackWrap}>
        <Text style={styles.fallback}>Sin vista previa disponible</Text>
      </View>
    );
  }

  if (archivo.tipo.includes('pdf')) {
    if (Platform.OS === 'web') {
      return (
        <iframe
          src={archivo.previewUrl}
          style={{ width: '100%', height: '100%', border: 'none' } as React.CSSProperties}
          title={tituloIframe}
        />
      );
    }
    return (
      <View style={styles.fallbackWrap}>
        <Text style={styles.fallback}>Vista previa no disponible en esta plataforma</Text>
      </View>
    );
  }

  return (
    <View style={styles.imagenWrap}>
      <img
        src={archivo.previewUrl}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } as React.CSSProperties}
        alt={archivo.nombre || 'Vista previa'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fallbackWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  fallback: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
  imagenWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
