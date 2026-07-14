import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { descargarPdfActivacion } from '../../lib/activacionPdf';
import {
  ActivacionFichaReporte,
  ActivacionEstadoBadge,
  activacionFichaStyles,
} from '../../components/ActivacionFichaReporte';
import {
  type Activacion,
  type ActivacionAdjunto,
  type ActivacionSesion,
} from '../../types/activaciones';

export default function ActivacionDetalleScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { hasPermiso } = useAuth();
  const puedeGestionar = hasPermiso('activaciones.gestionar');

  const [activacion, setActivacion] = useState<Activacion | null>(null);
  const [sesiones, setSesiones] = useState<ActivacionSesion[]>([]);
  const [adjuntos, setAdjuntos] = useState<ActivacionAdjunto[]>([]);
  const [loading, setLoading] = useState(true);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [rFicha, rSes, rAdj] = await Promise.all([
        apiFetch(`/api/activaciones/${id}`),
        apiFetch(`/api/activaciones/${id}/sesiones`),
        apiFetch(`/api/activaciones/${id}/adjuntos`),
      ]);
      const dFicha = await rFicha.json();
      if (!rFicha.ok) throw new Error(dFicha.error || 'No se pudo cargar la activación');
      setActivacion(dFicha.activacion as Activacion);
      const dSes = await rSes.json();
      setSesiones(rSes.ok && Array.isArray(dSes.sesiones) ? dSes.sesiones : []);
      const dAdj = await rAdj.json();
      setAdjuntos(rAdj.ok && Array.isArray(dAdj.adjuntos) ? dAdj.adjuntos : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );

  const descargarPdf = async () => {
    if (!activacion) return;
    if (Platform.OS !== 'web') {
      Alert.alert('PDF', 'La descarga de PDF está disponible en la versión web.');
      return;
    }
    setPdfLoading(true);
    try {
      await descargarPdfActivacion(activacion, sesiones);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'No se pudo generar el PDF');
    } finally {
      setPdfLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color="#0ea5e9" />
      </View>
    );
  }

  if (error || !activacion) {
    return (
      <View style={styles.centerBox}>
        <MaterialIcons name="error-outline" size={36} color="#f87171" />
        <Text style={styles.emptyText}>{error ?? 'Activación no encontrada.'}</Text>
        <TouchableOpacity onPress={cargar}>
          <Text style={styles.retry}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <ActivacionFichaReporte
          activacion={activacion}
          sesiones={sesiones}
          adjuntos={adjuntos}
          puedeGestionar={puedeGestionar}
          onGestionarSesiones={() =>
            router.push(`/reservas/activacion-sesiones?id=${activacion.id_activacion}` as never)
          }
          topBar={
            <View style={activacionFichaStyles.topBar}>
              <TouchableOpacity style={activacionFichaStyles.volverBtn} onPress={() => router.back()}>
                <MaterialIcons name="arrow-back" size={16} color="#475569" />
                <Text style={activacionFichaStyles.volverText}>Volver</Text>
              </TouchableOpacity>
              <View style={activacionFichaStyles.topActions}>
                <ActivacionEstadoBadge activacion={activacion} />
                <TouchableOpacity
                  style={[activacionFichaStyles.btnPdf, pdfLoading && activacionFichaStyles.btnDisabled]}
                  onPress={descargarPdf}
                  disabled={pdfLoading}
                >
                  {pdfLoading ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <MaterialIcons name="picture-as-pdf" size={16} color="#0ea5e9" />
                  )}
                  <Text style={activacionFichaStyles.btnPdfText}>{pdfLoading ? 'Generando…' : 'PDF'}</Text>
                </TouchableOpacity>
                {puedeGestionar ? (
                  <TouchableOpacity
                    style={activacionFichaStyles.btnEditar}
                    onPress={() => router.push(`/reservas/activacion-nueva?id=${activacion.id_activacion}` as never)}
                  >
                    <MaterialIcons name="edit" size={15} color="#fff" />
                    <Text style={activacionFichaStyles.btnEditarText}>Editar</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          }
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0' },
  scrollContent: { padding: 12, paddingBottom: 28, alignItems: 'center' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  retry: { fontSize: 13, fontWeight: '700', color: '#0ea5e9' },
});
