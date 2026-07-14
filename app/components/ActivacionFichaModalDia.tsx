import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
  Alert,
  TextInput,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../utils/api';
import { descargarPdfActivacion } from '../lib/activacionPdf';
import {
  ActivacionFichaReporte,
  ActivacionEstadoBadge,
  activacionFichaStyles,
} from './ActivacionFichaReporte';
import {
  type Activacion,
  type ActivacionAdjunto,
  type ActivacionSesion,
  type ActivacionSesionDia,
  ESTADO_SESION_META,
} from '../types/activaciones';

function confirmar(titulo: string, mensaje: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${titulo}\n\n${mensaje}`)) onOk();
    return;
  }
  Alert.alert(titulo, mensaje, [
    { text: 'No', style: 'cancel' },
    { text: 'Sí', style: 'destructive', onPress: onOk },
  ]);
}

type Props = {
  sesion: ActivacionSesionDia | null;
  visible: boolean;
  onClose: () => void;
  onSesionActualizada: () => void;
};

export function ActivacionFichaModalDia({ sesion, visible, onClose, onSesionActualizada }: Props) {
  const [activacion, setActivacion] = useState<Activacion | null>(null);
  const [sesiones, setSesiones] = useState<ActivacionSesion[]>([]);
  const [adjuntos, setAdjuntos] = useState<ActivacionAdjunto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accionando, setAccionando] = useState(false);
  const [incidenciaVisible, setIncidenciaVisible] = useState(false);
  const [incidenciaTexto, setIncidenciaTexto] = useState('');
  const [guardandoIncidencia, setGuardandoIncidencia] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  const cargar = useCallback(async () => {
    if (!sesion?.id_activacion) return;
    setLoading(true);
    setError(null);
    try {
      const [rFicha, rSes, rAdj] = await Promise.all([
        apiFetch(`/api/activaciones/${sesion.id_activacion}`),
        apiFetch(`/api/activaciones/${sesion.id_activacion}/sesiones`),
        apiFetch(`/api/activaciones/${sesion.id_activacion}/adjuntos`),
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
      setActivacion(null);
    } finally {
      setLoading(false);
    }
  }, [sesion?.id_activacion]);

  useEffect(() => {
    if (visible && sesion) {
      setIncidenciaVisible(false);
      setIncidenciaTexto('');
      cargar();
    } else if (!visible) {
      setActivacion(null);
      setSesiones([]);
      setAdjuntos([]);
      setError(null);
      setPdfLoading(false);
    }
  }, [visible, sesion, cargar]);

  const sesionActual = sesion
    ? sesiones.find((s) => s.id_sesion === sesion.id_sesion) ?? sesion
    : null;

  const patchSesion = useCallback(
    async (body: Record<string, string>) => {
      if (!sesion) return false;
      setAccionando(true);
      try {
        const r = await apiFetch(`/api/activaciones/sesiones/${sesion.id_sesion}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'No se pudo actualizar la sesión');
        await cargar();
        onSesionActualizada();
        return true;
      } catch (e) {
        Alert.alert('Error', e instanceof Error ? e.message : 'Error de red');
        return false;
      } finally {
        setAccionando(false);
      }
    },
    [sesion, cargar, onSesionActualizada],
  );

  const guardarIncidencia = async () => {
    setGuardandoIncidencia(true);
    const ok = await patchSesion({ incidencia: incidenciaTexto.trim() });
    setGuardandoIncidencia(false);
    if (ok) setIncidenciaVisible(false);
  };

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

  const footerAcciones =
    sesionActual && !loading && !error && activacion ? (
      <View style={styles.footerAcciones}>
        {accionando ? (
          <ActivityIndicator size="small" color="#0ea5e9" />
        ) : sesionActual.estado_sesion === 'programada' ? (
          <View style={styles.accionesRow}>
            <TouchableOpacity
              style={styles.btnCancelar}
              onPress={() =>
                confirmar('Cancelar activación', '¿Seguro que quieres cancelar esta sesión?', () =>
                  patchSesion({ estado_sesion: 'cancelada' }),
                )
              }
            >
              <MaterialIcons name="event-busy" size={16} color="#dc2626" />
              <Text style={styles.btnCancelarText}>Cancelar activación</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.btnRealizada}
              onPress={() => patchSesion({ estado_sesion: 'realizada' })}
            >
              <MaterialIcons name="check-circle" size={16} color="#fff" />
              <Text style={styles.btnRealizadaText}>Marcar como realizada</Text>
            </TouchableOpacity>
          </View>
        ) : sesionActual.estado_sesion === 'realizada' ? (
          <View style={styles.accionesRow}>
            <TouchableOpacity
              style={styles.btnIncidencia}
              onPress={() => {
                setIncidenciaTexto(sesionActual.incidencia ?? '');
                setIncidenciaVisible(true);
              }}
            >
              <MaterialIcons name="warning-amber" size={16} color="#d97706" />
              <Text style={styles.btnIncidenciaText}>
                {sesionActual.incidencia ? 'Editar incidencia' : 'Añadir incidencia'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    ) : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.modalShell} onPress={() => {}}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Ficha de activación</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialIcons name="close" size={24} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {loading ? (
              <View style={styles.centerBox}>
                <ActivityIndicator size="large" color="#0ea5e9" />
              </View>
            ) : error || !activacion ? (
              <View style={styles.centerBox}>
                <MaterialIcons name="error-outline" size={36} color="#f87171" />
                <Text style={styles.errorText}>{error ?? 'No se pudo cargar la ficha.'}</Text>
                <TouchableOpacity onPress={cargar}>
                  <Text style={styles.retry}>Reintentar</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ActivacionFichaReporte
                activacion={activacion}
                sesiones={sesiones}
                adjuntos={adjuntos}
                sesionDestacadaId={sesion?.id_sesion}
                topBar={
                  <View style={activacionFichaStyles.topBar}>
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
                        <Text style={activacionFichaStyles.btnPdfText}>
                          {pdfLoading ? 'Generando…' : 'PDF'}
                        </Text>
                      </TouchableOpacity>
                      {sesionActual ? (
                        <View
                          style={[
                            styles.badgeSesion,
                            {
                              backgroundColor:
                                (ESTADO_SESION_META[sesionActual.estado_sesion] ?? ESTADO_SESION_META.programada)
                                  .bg,
                            },
                          ]}
                        >
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '700',
                              color:
                                (ESTADO_SESION_META[sesionActual.estado_sesion] ?? ESTADO_SESION_META.programada)
                                  .text,
                            }}
                          >
                            Sesión:{' '}
                            {(ESTADO_SESION_META[sesionActual.estado_sesion] ?? ESTADO_SESION_META.programada).label}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                }
                footer={footerAcciones}
              />
            )}
          </ScrollView>

          {incidenciaVisible && sesionActual ? (
            <View style={styles.incidenciaPanel}>
              <Text style={styles.incidenciaPanelTitulo}>
                {sesionActual.incidencia ? 'Editar incidencia' : 'Añadir incidencia'}
              </Text>
              <TextInput
                style={styles.incidenciaInput}
                value={incidenciaTexto}
                onChangeText={setIncidenciaTexto}
                multiline
                placeholder="Describe qué ha ocurrido durante la activación…"
                placeholderTextColor="#94a3b8"
              />
              <View style={styles.incidenciaBtns}>
                <TouchableOpacity style={styles.incidenciaCancelar} onPress={() => setIncidenciaVisible(false)}>
                  <Text style={styles.incidenciaCancelarText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.guardarBtn, guardandoIncidencia && { opacity: 0.6 }]}
                  onPress={guardarIncidencia}
                  disabled={guardandoIncidencia}
                >
                  {guardandoIncidencia ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <MaterialIcons name="save" size={16} color="#fff" />
                  )}
                  <Text style={styles.guardarBtnText}>Guardar</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  modalShell: {
    width: '100%',
    maxWidth: 920,
    maxHeight: '92%',
    backgroundColor: '#e2e8f0',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    ...(Platform.OS === 'web' && ({ boxShadow: '0 8px 32px rgba(15,23,42,0.18)' } as object)),
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  modalScroll: { flex: 1 },
  modalScrollContent: { padding: 14, paddingBottom: 20, alignItems: 'center' },
  centerBox: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  errorText: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  retry: { fontSize: 13, fontWeight: '700', color: '#0ea5e9' },
  badgeSesion: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },

  footerAcciones: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 14,
    marginTop: 4,
  },
  accionesRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  btnCancelar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#fca5a5',
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  btnCancelarText: { fontSize: 13, fontWeight: '600', color: '#dc2626' },
  btnRealizada: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#16a34a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  btnRealizadaText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  btnIncidencia: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  btnIncidenciaText: { fontSize: 13, fontWeight: '600', color: '#b45309' },

  incidenciaPanel: {
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    padding: 14,
    gap: 8,
  },
  incidenciaPanelTitulo: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  incidenciaInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    color: '#0f172a',
    minHeight: 80,
    textAlignVertical: 'top',
  },
  incidenciaBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  incidenciaCancelar: { paddingHorizontal: 12, paddingVertical: 10 },
  incidenciaCancelarText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  guardarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#16a34a',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  guardarBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
