/**
 * Modal para capturar la firma dibujando; devuelve PNG en base64 (sin prefijo data:).
 */
import React, { useRef, useState } from 'react';
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
import SignatureCanvas, { type SignatureViewRef } from 'react-native-signature-canvas';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Base64 PNG (sin data URL) */
  onConfirm: (base64Png: string) => void;
  uploading?: boolean;
};

const WEB_STYLE = `
  .m-signature-pad { box-shadow: none; border: 1px solid #e2e8f0; border-radius: 8px; }
  .m-signature-pad--body { border: none; }
  .m-signature-pad--footer { display: flex; justify-content: space-between; padding: 8px; }
  body { background: #fff; }
`;

export function FirmaEnPantallaModal({ visible, onClose, onConfirm, uploading }: Props) {
  const sigRef = useRef<SignatureViewRef | null>(null);
  const [emptyHint, setEmptyHint] = useState(false);

  function handleOK(signature: string) {
    setEmptyHint(false);
    const raw = signature.replace(/^data:image\/png;base64,/, '').trim();
    if (!raw) {
      setEmptyHint(true);
      return;
    }
    onConfirm(raw);
  }

  function handleEmpty() {
    setEmptyHint(true);
  }

  function handleClear() {
    setEmptyHint(false);
    sigRef.current?.clearSignature();
  }

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
          <View style={styles.canvasWrap}>
            <SignatureCanvas
              ref={sigRef}
              onOK={handleOK}
              onEmpty={handleEmpty}
              onClear={handleClear}
              autoClear={false}
              descriptionText=""
              clearText="Limpiar"
              confirmText="Guardar firma"
              webStyle={WEB_STYLE}
              backgroundColor="#ffffff"
              penColor="#0f172a"
              minWidth={1.5}
              maxWidth={3}
              style={styles.signature}
            />
          </View>
          {emptyHint ? <Text style={styles.warn}>Firma en el área antes de guardar.</Text> : null}
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
  canvasWrap: {
    height: Platform.OS === 'web' ? 260 : 220,
    marginHorizontal: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
  },
  signature: { flex: 1 },
  warn: { fontSize: 12, color: '#dc2626', paddingHorizontal: 14, marginTop: 6 },
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
