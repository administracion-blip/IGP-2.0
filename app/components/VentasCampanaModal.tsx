import { useEffect, useState } from 'react';
import {
  View,
  Modal,
  Pressable,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../utils/api';
import { VentasCampanaPanel } from './VentasCampanaPanel';
import type { DetalleVentasCampana, FiltroVentasCampana } from '../types/ventasCampana';

type Props = {
  visible: boolean;
  onClose: () => void;
  localesMap: Record<string, string>;
  /** Si no se pasan data/loading/error, se cargan con campanaId */
  campanaId?: string | null;
  nombreCampana?: string;
  data?: DetalleVentasCampana | null;
  loading?: boolean;
  error?: string | null;
  filtro?: FiltroVentasCampana;
  titulo?: string;
};

export function VentasCampanaModal({
  visible,
  onClose,
  localesMap,
  campanaId = null,
  nombreCampana,
  data: dataProp,
  loading: loadingProp,
  error: errorProp,
  filtro,
  titulo,
}: Props) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const usaDatosExternos = dataProp !== undefined;

  const [loadingInt, setLoadingInt] = useState(false);
  const [errorInt, setErrorInt] = useState<string | null>(null);
  const [dataInt, setDataInt] = useState<DetalleVentasCampana | null>(null);

  useEffect(() => {
    if (!visible || usaDatosExternos || !campanaId) return;
    let cancelado = false;
    setLoadingInt(true);
    setErrorInt(null);
    setDataInt(null);
    apiFetch(`/api/campanas/${campanaId}/ventas-detalle`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelado) return;
        if (d.error) throw new Error(d.error);
        setDataInt(d);
      })
      .catch((e) => {
        if (!cancelado) setErrorInt((e as Error).message || 'Error al cargar ventas');
      })
      .finally(() => {
        if (!cancelado) setLoadingInt(false);
      });
    return () => {
      cancelado = true;
    };
  }, [visible, campanaId, usaDatosExternos]);

  const loading = usaDatosExternos ? (loadingProp ?? false) : loadingInt;
  const error = usaDatosExternos ? (errorProp ?? null) : errorInt;
  const data = usaDatosExternos ? (dataProp ?? null) : dataInt;

  const tituloPanel = titulo
    ?? (nombreCampana ? `Ventas · ${nombreCampana}` : 'Ventas de la campaña');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.panel, wide && styles.panelWide]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <MaterialIcons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          </View>
          <VentasCampanaPanel
            loading={loading}
            error={error}
            data={data}
            localesMap={localesMap}
            filtro={filtro}
            titulo={tituloPanel}
            embedded
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: Platform.OS === 'web' ? 24 : 12,
  },
  panel: {
    backgroundColor: '#fff',
    borderRadius: 12,
    maxHeight: '92%',
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 16px 48px rgba(0,0,0,0.18)' } as object : { elevation: 12 }),
  },
  panelWide: { maxWidth: 860, height: '88%' },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 4,
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 2,
  },
  closeBtn: { padding: 8 },
});
