import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../../../utils/api';
import type { ToastType } from '../../../components/Toast';

export const MAX_ESTILO_REF_IMAGENES = 3;

async function appendImagenAlFormData(form: FormData, uri: string, nombreArchivo: string, mimeType?: string) {
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

function EstiloImagenThumb({
  storageKey,
  onRemove,
  puedeQuitar,
}: {
  storageKey: string;
  onRemove?: () => void;
  puedeQuitar: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/marketing/imagen-url?key=${encodeURIComponent(storageKey)}`)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled) setUrl(d.url ?? null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  return (
    <View style={thumbStyles.wrap}>
      {loading ? (
        <ActivityIndicator size="small" color="#0ea5e9" />
      ) : url ? (
        <Image source={{ uri: url }} style={thumbStyles.img} resizeMode="cover" />
      ) : (
        <MaterialIcons name="broken-image" size={28} color="#94a3b8" />
      )}
      {puedeQuitar && onRemove ? (
        <TouchableOpacity style={thumbStyles.removeBtn} onPress={onRemove} accessibilityLabel="Quitar imagen">
          <MaterialIcons name="close" size={16} color="#fff" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

type Props = {
  keys: string[];
  onKeysChange: (keys: string[]) => void;
  puedeEditar: boolean;
  showToast: (titulo: string, msg: string, tipo?: ToastType) => void;
};

/**
 * Hasta 3 imágenes de referencia para identidad visual del local (S3 marketing/estilo-local/).
 */
export function EstiloVisualImagenesEditor({ keys, onKeysChange, puedeEditar, showToast }: Props) {
  const [subiendo, setSubiendo] = useState(false);

  async function elegirYSubir() {
    if (!puedeEditar || keys.length >= MAX_ESTILO_REF_IMAGENES || subiendo) return;
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        showToast('Permisos', 'Se necesita acceso a la galería para subir una imagen.', 'warning');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.85,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const nombre = asset.fileName ?? asset.uri.split('/').pop()?.split('?')[0] ?? 'referencia.jpg';

      setSubiendo(true);
      const form = new FormData();
      await appendImagenAlFormData(form, asset.uri, nombre, asset.mimeType ?? undefined);
      form.append('tipo', 'estilo-local');

      const res = await apiFetch('/api/marketing/upload-imagen', {
        method: 'POST',
        body: form,
        timeoutMs: 60_000,
      });
      const data = (await res.json()) as { error?: string; key?: string };
      if (!res.ok || !data.key) throw new Error(data.error || 'No se pudo subir la imagen');

      onKeysChange([...keys, data.key].slice(0, MAX_ESTILO_REF_IMAGENES));
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo subir', 'error');
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Referencias visuales (opcional, hasta {MAX_ESTILO_REF_IMAGENES})</Text>
      <Text style={styles.hint}>Ayudan a mantener coherencia de estilo al redactar o usar prompts.</Text>
      <View style={styles.row}>
        {keys.map((k, i) => (
          <EstiloImagenThumb
            key={k || String(i)}
            storageKey={k}
            puedeQuitar={puedeEditar}
            onRemove={puedeEditar ? () => onKeysChange(keys.filter((_, j) => j !== i)) : undefined}
          />
        ))}
        {puedeEditar && keys.length < MAX_ESTILO_REF_IMAGENES ? (
          <TouchableOpacity
            style={[styles.addSlot, subiendo && styles.addSlotDisabled]}
            onPress={elegirYSubir}
            disabled={subiendo}
            activeOpacity={0.7}
          >
            {subiendo ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <>
                <MaterialIcons name="add-photo-alternate" size={28} color="#0ea5e9" />
                <Text style={styles.addSlotText}>Añadir</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const thumbStyles = StyleSheet.create({
  wrap: {
    width: 88,
    height: 88,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  img: { width: '100%', height: '100%' },
  removeBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(220, 38, 38, 0.92)',
    borderRadius: 12,
    padding: 4,
  },
});

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569' },
  hint: { fontSize: 11, color: '#64748b', lineHeight: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 4 },
  addSlot: {
    width: 88,
    height: 88,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#7dd3fc',
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  addSlotDisabled: { opacity: 0.6 },
  addSlotText: { fontSize: 11, fontWeight: '600', color: '#0284c7' },
});
