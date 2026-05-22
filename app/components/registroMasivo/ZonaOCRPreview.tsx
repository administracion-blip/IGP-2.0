import React from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import type { Borrador } from '../../types/registroMasivo';
import type { UseZonaOCRReturn } from '../../hooks/useZonaOCR';

/**
 * Panel derecho del registro masivo: muestra el preview del documento.
 *
 * Tiene dos modos:
 * - Si `zona.activa` está fijado y estamos en web, renderiza una imagen
 *   rasterizada del documento con un overlay donde el usuario dibuja un
 *   rectángulo (gestionado por el hook `useZonaOCR`).
 * - Si no, muestra el preview "normal": iframe para PDFs en web, `<img>`
 *   para imágenes, y un fallback de texto en el resto de plataformas.
 *
 * El overlay y los estilos web usan `as any` para sortear que `ViewStyle`
 * de RN no acepta propiedades CSS web (`overflow`, `userSelect`, `cursor`,
 * `objectFit`, etc.). Es deuda externa documentada del proyecto.
 */
export function ZonaOCRPreview({
  borrador,
  zona,
  onPreviewLoadError,
}: {
  borrador: Borrador;
  zona: UseZonaOCRReturn;
  /** Mensaje de error al cargar la imagen rasterizada del PDF. */
  onPreviewLoadError: (msg: string) => void;
}) {
  if (!borrador.archivo.previewUrl) {
    return (
      <View style={styles.previewFallbackWrap}>
        <Text style={styles.previewFallback}>Sin vista previa disponible</Text>
      </View>
    );
  }

  if (zona.activa && Platform.OS === 'web' && zona.imgSrc) {
    return (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#e2e8f0',
          userSelect: 'none',
        } as any}
      >
        {!zona.previewLoaded ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2,
            } as any}
          >
            <ActivityIndicator size="large" color="#0ea5e9" />
            <span style={{ position: 'absolute', bottom: 24, fontSize: 11, color: '#64748b' } as any}>
              Generando vista para selección…
            </span>
          </div>
        ) : null}
        <div
          style={{
            position: 'relative',
            maxWidth: '100%',
            maxHeight: '100%',
            display: 'inline-block',
          } as any}
        >
          <img
            src={zona.imgSrc}
            alt="Seleccionar zona"
            onLoad={() => zona.setPreviewLoaded(true)}
            onError={() => onPreviewLoadError('No se pudo cargar la imagen de selección')}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              display: 'block',
            } as any}
          />
          {zona.previewLoaded ? (
            <div
              onMouseDown={zona.handleMouseDown as any}
              onMouseMove={zona.handleMouseMove as any}
              onMouseUp={zona.handleMouseUp as any}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                height: '100%',
                cursor: zona.extracting
                  ? 'wait'
                  : 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\'%3E%3Cline x1=\'12\' y1=\'0\' x2=\'12\' y2=\'24\' stroke=\'%23ff00ff\' stroke-width=\'2\'/%3E%3Cline x1=\'0\' y1=\'12\' x2=\'24\' y2=\'12\' stroke=\'%23ff00ff\' stroke-width=\'2\'/%3E%3C/svg%3E") 12 12, crosshair',
                boxSizing: 'border-box',
              } as any}
            >
              {zona.rect && (
                <div
                  style={{
                    position: 'absolute',
                    left: Math.min(zona.rect.startX, zona.rect.endX),
                    top: Math.min(zona.rect.startY, zona.rect.endY),
                    width: Math.abs(zona.rect.endX - zona.rect.startX),
                    height: Math.abs(zona.rect.endY - zona.rect.startY),
                    border: '2px solid #ff00ff',
                    backgroundColor: 'rgba(255, 0, 255, 0.18)',
                    borderRadius: 3,
                    pointerEvents: 'none',
                  } as any}
                />
              )}
            </div>
          ) : null}
        </div>
        {zona.extracting ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(255,255,255,0.65)',
              zIndex: 4,
            } as any}
          >
            <ActivityIndicator size="large" color="#0ea5e9" />
          </div>
        ) : null}
      </div>
    );
  }

  if (borrador.archivo.tipo.includes('pdf')) {
    if (Platform.OS === 'web') {
      return (
        <iframe
          src={borrador.archivo.previewUrl}
          style={{ width: '100%', height: '100%', border: 'none' } as any}
          title="Vista previa"
        />
      );
    }
    return (
      <View style={styles.previewFallbackWrap}>
        <Text style={styles.previewFallback}>Vista previa no disponible en esta plataforma</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <img
        src={borrador.archivo.previewUrl}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } as any}
        alt="Vista previa"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  previewFallbackWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  previewFallback: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
});
