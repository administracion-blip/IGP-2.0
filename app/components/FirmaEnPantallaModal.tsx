/**
 * Modal para capturar la firma dibujando; devuelve PNG en base64 (sin prefijo data:).
 */
import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SignaturePad } from './signature';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Base64 PNG (sin data URL) */
  onConfirm: (base64Png: string) => void;
  uploading?: boolean;
};

export function FirmaEnPantallaModal({ visible, onClose, onConfirm, uploading }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Firma del artista</Text>
            <TouchableOpacity onPress={onClose} disabled={uploading} hitSlop={12}>
              <MaterialIcons name="close" size={24} color="#64748b" />
            </TouchableOpacity>
          </View>
          <Text style={styles.sub}>Dibuja con el dedo o el ratón en el recuadro.</Text>
          <View style={styles.padSection}>
            <SignaturePad
              height={Platform.OS === 'web' ? 260 : 220}
              onSave={(dataUrl) => {
                const raw = dataUrl.replace(/^data:image\/png;base64,/, '');
                onConfirm(raw);
              }}
            />
          </View>
          {uploading ? (
            <View style={styles.uploadingRow}>
              <ActivityIndicator color="#0ea5e9" />
              <Text style={styles.uploadingText}>Subiendo…</Text>
            </View>
          ) : null}
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={uploading}>
            <Text style={styles.cancelBtnText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    maxWidth: 440,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: 12,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: { fontSize: 17, fontWeight: '700', color: '#334155' },
  sub: { fontSize: 12, color: '#64748b', paddingHorizontal: 14, paddingTop: 8 },
  padSection: {
    marginHorizontal: 12,
    marginTop: 8,
  },
  uploadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  uploadingText: { fontSize: 13, color: '#64748b' },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { fontSize: 14, color: '#64748b', fontWeight: '600' },
});
