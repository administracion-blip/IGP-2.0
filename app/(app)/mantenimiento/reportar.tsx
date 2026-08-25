import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import { useMantenimientoLocales, valorEnLocal } from './LocalesContext';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { apiFetch } from '../../utils/api';
import { formatCreadoEn } from '../../utils/formatFecha';

const AUTH_KEY = 'erp_user';

const ZONAS = ['barra', 'cocina', 'baños', 'almacén', 'sala', 'terraza', 'otros'] as const;
const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'] as const;
const MAX_FOTOS = 3;
const DESC_MAX = 120;

type SimilarIncidencia = {
  id_incidencia?: string;
  titulo?: string;
  descripcion?: string;
  zona?: string;
  estado?: string;
  fecha_creacion?: string | null;
  fotos?: string[];
};

function truncar(texto: string, max = DESC_MAX): string {
  const t = (texto ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}…`;
}

export default function ReportarIncidenciaScreen() {
  const router = useRouter();
  const { locales, loading: loadingLocales, error: localesError } = useMantenimientoLocales();
  const { width } = useWindowDimensions();
  const [userId, setUserId] = useState<string>('');
  const [userName, setUserName] = useState<string>('');
  const [registroTimestamp, setRegistroTimestamp] = useState<string>('');
  const [localId, setLocalId] = useState('');
  const [zona, setZona] = useState<(typeof ZONAS)[number]>('otros');
  const [prioridad, setPrioridad] = useState<(typeof PRIORIDADES)[number]>('media');
  const [titulo, setTitulo] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [fotos, setFotos] = useState<string[]>([]);
  const [fotosLoading, setFotosLoading] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [similares, setSimilares] = useState<SimilarIncidencia[]>([]);
  const [modalDuplicadosVisible, setModalDuplicadosVisible] = useState(false);

  const localesOpciones = useMemo(
    () =>
      locales
        .map((loc) => {
          const id = valorEnLocal(loc, 'id_Locales') ?? valorEnLocal(loc, 'id_locales') ?? '';
          const nombre = valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id;
          return { id, titulo: nombre || id || '—', icono: 'store' as const };
        })
        .filter((o) => o.id)
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es', { sensitivity: 'base' })),
    [locales],
  );

  useEffect(() => {
    if (localesOpciones.length > 0 && !localId) {
      setLocalId(localesOpciones[0].id);
    }
  }, [localesOpciones, localId]);

  useEffect(() => {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    setRegistroTimestamp(`${dd}/${mm}/${yy} ${hh}:${min}:${ss}`);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(AUTH_KEY).then((stored) => {
      if (stored) {
        try {
          const user = JSON.parse(stored) as { id_usuario?: string; Nombre?: string; Apellidos?: string; email?: string };
          setUserId(user.id_usuario ?? '');
          const nom = [user.Nombre, user.Apellidos].filter(Boolean).join(' ').trim();
          setUserName(nom || user.email || '');
        } catch {
          setUserId('');
          setUserName('');
        }
      }
    });
  }, []);

  const seleccionarFoto = async () => {
    if (fotos.length >= MAX_FOTOS) return;
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        setError('Se necesita permiso para acceder a la galería');
        return;
      }
      setFotosLoading(true);
      setError(null);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.6,
      });
      if (result.canceled || !result.assets?.[0]?.uri) {
        setFotosLoading(false);
        return;
      }
      const uri = result.assets[0].uri;
      const manipulated = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: 800 } }],
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (manipulated.base64 && fotos.length < MAX_FOTOS) {
        const dataUrl = `data:image/jpeg;base64,${manipulated.base64}`;
        setFotos((prev) => [...prev, dataUrl]);
      }
    } catch (e) {
      setError('No se pudo cargar la imagen');
    } finally {
      setFotosLoading(false);
    }
  };

  const quitarFoto = (index: number) => {
    setFotos((prev) => prev.filter((_, i) => i !== index));
  };

  const crearIncidencia = () => {
    const locId = localId.trim();
    const t = titulo.trim();
    setError(null);
    setEnviando(true);
    apiFetch('/api/mantenimiento/incidencias', {
      method: 'POST',
      body: JSON.stringify({
        local_id: locId,
        zona,
        categoria: 'otros',
        titulo: t,
        descripcion: descripcion.trim(),
        prioridad_reportada: prioridad,
        fotos: fotos.length > 0 ? fotos : undefined,
        creado_por_id_usuario: userId || undefined,
      }),
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean; incidencia?: unknown; error?: string }) => {
        if (data.ok) {
          setSuccessMessage('Incidencia reportada');
          setTimeout(() => router.replace('/mantenimiento/incidencias'), 300);
        } else {
          setError(data.error ?? 'Error al crear la incidencia');
        }
      })
      .catch((e) => setError(e.message ?? 'Error de conexión'))
      .finally(() => setEnviando(false));
  };

  const handleEnviar = async () => {
    const locId = localId.trim();
    const t = titulo.trim();
    if (!locId) {
      setError('Selecciona un local');
      return;
    }
    if (!t) {
      setError('El título es obligatorio');
      return;
    }
    if (!zona) {
      setError('Selecciona una zona');
      return;
    }
    setError(null);
    setEnviando(true);

    try {
      const res = await apiFetch('/api/mantenimiento/incidencias/similares', {
        method: 'POST',
        body: JSON.stringify({
          local_id: locId,
          titulo: t,
          descripcion: descripcion.trim(),
          zona,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; similares?: SimilarIncidencia[]; error?: string };
      if (res.ok && data.ok && Array.isArray(data.similares) && data.similares.length > 0) {
        setSimilares(data.similares);
        setModalDuplicadosVisible(true);
        setEnviando(false);
        return;
      }
    } catch (e) {
      console.warn('[reportar] comprobación de similares falló; se crea igual', e);
    }

    crearIncidencia();
  };

  const cerrarModalDuplicados = () => {
    setModalDuplicadosVisible(false);
  };

  const seguirCreando = () => {
    setModalDuplicadosVisible(false);
    crearIncidencia();
  };

  const verAbiertas = () => {
    setModalDuplicadosVisible(false);
    router.push('/mantenimiento/abiertas');
  };

  return (
    <KeyboardAvoidingView
      style={styles.wrapper}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Reportar incidencia</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {loadingLocales ? (
          <View style={[styles.formCard, styles.loadingWrap, { maxWidth: Math.min(width - 32, 480) }]}>
            <ActivityIndicator size="small" color="#0ea5e9" />
            <Text style={styles.loadingText}>Cargando locales…</Text>
          </View>
        ) : localesError ? (
          <View style={[styles.formCard, styles.loadingWrap, { maxWidth: Math.min(width - 32, 480) }]}>
            <MaterialIcons name="error-outline" size={20} color="#f87171" />
            <Text style={[styles.loadingText, { color: '#f87171' }]}>{localesError}</Text>
          </View>
        ) : (
          <View style={[styles.formCard, { maxWidth: Math.min(width - 32, 480) }]}>
            {successMessage ? (
              <View style={styles.successWrap}>
                <MaterialIcons name="check-circle" size={22} color="#16a34a" />
                <Text style={styles.successText}>{successMessage}</Text>
              </View>
            ) : null}
            <Text style={styles.registroLine}>
              {registroTimestamp}{userName ? ` · ${userName}` : ''}
            </Text>
            <View style={styles.field}>
              <SelectorDesplegable
                label="Local *"
                icono="store"
                iconoLista="store"
                tituloLista="Selecciona un local"
                placeholder="Selecciona un local"
                vacioTexto="No hay locales. Carga datos en Base de Datos."
                valorId={localId}
                opciones={localesOpciones}
                buscador
                buscadorPlaceholder="Buscar local…"
                onSeleccionar={setLocalId}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Zona *</Text>
              <View style={styles.selectWrap}>
                {ZONAS.map((z) => (
                  <TouchableOpacity
                    key={z}
                    style={[styles.optionBtn, zona === z && styles.optionBtnSelected]}
                    onPress={() => setZona(z)}
                  >
                    <Text style={[styles.optionText, zona === z && styles.optionTextSelected]}>{z}</Text>
                    {zona === z ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Prioridad</Text>
              <View style={styles.selectWrap}>
                {PRIORIDADES.map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[styles.optionBtn, prioridad === p && styles.optionBtnSelected]}
                    onPress={() => setPrioridad(p)}
                  >
                    <Text style={[styles.optionText, prioridad === p && styles.optionTextSelected]}>{p}</Text>
                    {prioridad === p ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Título *</Text>
              <TextInput
                style={styles.input}
                value={titulo}
                onChangeText={setTitulo}
                placeholder="Ej: Luz fundida en mostrador"
                placeholderTextColor="#94a3b8"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Descripción</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={descripcion}
                onChangeText={setDescripcion}
                placeholder="Detalles adicionales..."
                placeholderTextColor="#94a3b8"
                multiline
                numberOfLines={4}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Fotos (máx. {MAX_FOTOS})</Text>
              <View style={styles.fotosRow}>
                {fotos.map((uri, index) => (
                  <View key={index} style={styles.fotoSlot}>
                    <Image source={{ uri }} style={styles.fotoThumb} resizeMode="cover" />
                    <TouchableOpacity style={styles.fotoRemoveBtn} onPress={() => quitarFoto(index)}>
                      <MaterialIcons name="close" size={16} color="#fff" />
                    </TouchableOpacity>
                  </View>
                ))}
                {fotos.length < MAX_FOTOS && (
                  <TouchableOpacity
                    style={styles.fotoAddBtn}
                    onPress={seleccionarFoto}
                    disabled={fotosLoading}
                  >
                    {fotosLoading ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <>
                        <MaterialIcons name="add-a-photo" size={24} color="#94a3b8" />
                        <Text style={styles.fotoAddText}>+</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {error ? (
              <View style={styles.errorWrap}>
                <MaterialIcons name="error-outline" size={18} color="#f87171" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.buttonsRow}>
              <TouchableOpacity
                style={[styles.submitBtn, styles.cancelBtn]}
                onPress={() => router.replace('/mantenimiento/incidencias')}
                disabled={enviando}
              >
                <MaterialIcons name="cancel" size={20} color="#fff" />
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.submitBtn, styles.submitBtnPrimary, enviando && styles.submitBtnDisabled]}
                onPress={handleEnviar}
                disabled={enviando}
              >
                {enviando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <MaterialIcons name="send" size={20} color="#fff" />
                    <Text style={styles.submitBtnText}>Enviar incidencia</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      <Modal
        visible={modalDuplicadosVisible}
        transparent
        animationType="fade"
        onRequestClose={cerrarModalDuplicados}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={cerrarModalDuplicados}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Posible incidencia duplicada</Text>
                <TouchableOpacity onPress={cerrarModalDuplicados} style={styles.modalClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <Text style={styles.modalMessage}>
                Ya hay una incidencia abierta parecida en el mismo local. Revisa antes de crear otra.
              </Text>
              <ScrollView style={styles.similaresScroll} contentContainerStyle={styles.similaresScrollContent}>
                {similares.map((s, idx) => {
                  const fotosSim = Array.isArray(s.fotos) ? s.fotos.filter(Boolean).slice(0, 3) : [];
                  return (
                    <View key={s.id_incidencia ?? `sim-${idx}`} style={styles.similarCard}>
                      <Text style={styles.similarTitulo}>{s.titulo?.trim() || 'Sin título'}</Text>
                      <Text style={styles.similarMeta}>
                        {[s.estado, s.zona, formatCreadoEn(s.fecha_creacion)].filter(Boolean).join(' · ')}
                      </Text>
                      {s.descripcion?.trim() ? (
                        <Text style={styles.similarDesc}>{truncar(s.descripcion)}</Text>
                      ) : null}
                      {fotosSim.length > 0 ? (
                        <View style={styles.similarFotosRow}>
                          {fotosSim.map((uri, fi) => (
                            <Image key={`${s.id_incidencia}-f${fi}`} source={{ uri }} style={styles.similarFoto} resizeMode="cover" />
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.modalFooter}>
                <TouchableOpacity style={styles.modalBtnSecondary} onPress={cerrarModalDuplicados}>
                  <Text style={styles.modalBtnSecondaryText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalBtnOutline} onPress={verAbiertas}>
                  <Text style={styles.modalBtnOutlineText}>Ver abiertas</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalBtnPrimary} onPress={seguirCreando} disabled={enviando}>
                  <Text style={styles.modalBtnPrimaryText}>Seguir creando</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrapper: { flex: 1, backgroundColor: '#ffffff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, paddingHorizontal: 16, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24, alignItems: 'center' },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16 },
  loadingText: { fontSize: 12, color: '#64748b' },
  formCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  successWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#dcfce7',
    borderRadius: 8,
    marginBottom: 12,
  },
  successText: { fontSize: 14, fontWeight: '600', color: '#16a34a' },
  registroLine: { fontSize: 10, color: '#94a3b8', marginBottom: 12 },
  field: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6 },
  selectWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  optionBtnSelected: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  optionText: { fontSize: 12, color: '#475569' },
  optionTextSelected: { color: '#0ea5e9', fontWeight: '500' },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#fff',
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  fotosRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fotoSlot: { position: 'relative', width: 80, height: 80, borderRadius: 8, overflow: 'hidden', backgroundColor: '#f1f5f9' },
  fotoThumb: { width: '100%', height: '100%' },
  fotoRemoveBtn: { position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  fotoAddBtn: { width: 80, height: 80, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0', borderStyle: 'dashed', backgroundColor: '#f8fafc', alignItems: 'center', justifyContent: 'center' },
  fotoAddText: { fontSize: 20, color: '#94a3b8', marginTop: 2 },
  errorWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8 },
  errorText: { fontSize: 12, color: '#f87171' },
  buttonsRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
  },
  cancelBtn: { flex: 1, backgroundColor: '#dc2626' },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  submitBtnPrimary: { flex: 3, backgroundColor: '#0ea5e9' },
  submitBtnDisabled: { opacity: 0.7 },
  submitBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalContentWrap: {
    width: '100%',
    maxWidth: 520,
    padding: 24,
    alignItems: 'center',
    maxHeight: '92%',
  },
  modalCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  modalTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: '#0f172a' },
  modalClose: { padding: 2 },
  modalMessage: { fontSize: 13, color: '#475569', marginBottom: 12, lineHeight: 18 },
  similaresScroll: { maxHeight: 320 },
  similaresScrollContent: { gap: 10, paddingBottom: 4 },
  similarCard: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
  },
  similarTitulo: { fontSize: 14, fontWeight: '600', color: '#334155', marginBottom: 4 },
  similarMeta: { fontSize: 11, color: '#64748b', marginBottom: 6 },
  similarDesc: { fontSize: 12, color: '#475569', lineHeight: 16 },
  similarFotosRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  similarFoto: { width: 48, height: 48, borderRadius: 6, backgroundColor: '#e2e8f0' },
  modalFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
    justifyContent: 'flex-end',
  },
  modalBtnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  modalBtnSecondaryText: { fontSize: 13, fontWeight: '600', color: '#475569' },
  modalBtnOutline: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    backgroundColor: '#fff',
  },
  modalBtnOutlineText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  modalBtnPrimary: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  modalBtnPrimaryText: { fontSize: 13, fontWeight: '600', color: '#fff' },
});
