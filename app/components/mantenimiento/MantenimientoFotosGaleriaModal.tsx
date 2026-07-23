import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  Image,
  Platform,
  useWindowDimensions,
  type ImageStyle,
} from 'react-native';
import { createElement } from 'react';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';

type Props = {
  visible: boolean;
  fotos: string[];
  titulo?: string;
  onClose: () => void;
  resolverUriFoto: (uri: string) => string;
};

export function MantenimientoFotosGaleriaModal({
  visible,
  fotos,
  titulo,
  onClose,
  resolverUriFoto,
}: Props) {
  const { width } = useWindowDimensions();
  const { isCompact, shouldStackPanels } = useBreakpoint();

  const uris = useMemo(
    () => fotos.map((f) => resolverUriFoto(f)).filter(Boolean),
    [fotos, resolverUriFoto],
  );

  const imgSize = useMemo(() => {
    const maxW = Math.min(width - 48, 720);
    if (shouldStackPanels) return { width: maxW, height: Math.min(maxW * 0.75, 360) };
    const cols = uris.length > 1 ? 2 : 1;
    const cell = (maxW - (cols - 1) * 12) / cols;
    return { width: cell, height: Math.min(cell * 0.75, 320) };
  }, [width, shouldStackPanels, uris.length]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={[styles.card, isCompact && styles.cardCompact]}
        >
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={2}>
              {titulo?.trim() ? titulo : 'Fotos de la incidencia'}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Cerrar">
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>
          <Text style={styles.subtitle}>
            {uris.length} foto{uris.length !== 1 ? 's' : ''}
          </Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.grid} keyboardShouldPersistTaps="handled">
            {uris.map((uri, index) => (
              <View key={`${uri}-${index}`} style={[styles.photoWrap, { width: imgSize.width }]}>
                {Platform.OS === 'web' ? (
                  createElement('img', {
                    src: uri,
                    alt: `Foto ${index + 1}`,
                    style: {
                      width: imgSize.width,
                      height: imgSize.height,
                      objectFit: 'cover',
                      borderRadius: 8,
                      display: 'block',
                    },
                  })
                ) : (
                  <Image
                    source={{ uri }}
                    style={[styles.photo as ImageStyle, { width: imgSize.width, height: imgSize.height }]}
                    resizeMode="cover"
                  />
                )}
              </View>
            ))}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 760,
    maxHeight: '88%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  cardCompact: { maxWidth: '100%', maxHeight: '92%' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  title: { flex: 1, fontSize: 16, fontWeight: '700', color: '#334155' },
  closeBtn: { padding: 4 },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 12 },
  scroll: { flexGrow: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingBottom: 8 },
  photoWrap: { borderRadius: 8, overflow: 'hidden', backgroundColor: '#f1f5f9' },
  photo: { borderRadius: 8, backgroundColor: '#f1f5f9' },
});
