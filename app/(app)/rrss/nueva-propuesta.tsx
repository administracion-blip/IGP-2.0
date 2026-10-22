import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import { useLocalToast } from '../../components/Toast';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useMarketingLocales, valorEnLocal } from './LocalesContext';
import { IdentidadLocalPanel } from './components/IdentidadLocalPanel';
import { formatId6 } from './lib/formatId6';
import { esIsoFechaValida } from './lib/fechasUi';
import { appendImagenAlFormData } from './lib/appendImagenFormData';

const TIPOS = ['Oferta', 'Evento', 'Novedad', 'Menu del dia', 'Agradecimiento', 'Cartel Musico', 'Otro'];
const REDES = ['instagram', 'facebook', 'tiktok'] as const;
type Red = (typeof REDES)[number];
type RefSegment = 'subir' | 'enlace';

export default function NuevaPropuestaScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { locales, loading: loadingLocales, refetch: refetchLocales } = useMarketingLocales();
  const { show: showToast, ToastView } = useLocalToast();
  const esGestor = hasPermiso('marketing.gestionar');

  const userLocalesNorm = useMemo(
    () => (user?.Locales ?? []).map((l) => formatId6(l)).filter(Boolean),
    [user?.Locales]
  );

  const localesElegibles = useMemo(() => {
    if (esGestor) return locales;
    return locales.filter((l) => {
      const id = formatId6(valorEnLocal(l, 'id_Locales'));
      return userLocalesNorm.includes(id);
    });
  }, [esGestor, locales, userLocalesNorm]);

  const [idLocal, setIdLocal] = useState('');
  const [tipo, setTipo] = useState<string>('Oferta');
  const [redesSel, setRedesSel] = useState<Red[]>(['instagram']);
  const [fechaSugerida, setFechaSugerida] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [refSegment, setRefSegment] = useState<RefSegment>('subir');
  const [refUrl, setRefUrl] = useState('');
  const [imagenUri, setImagenUri] = useState<string | null>(null);
  const [imagenMime, setImagenMime] = useState<string | undefined>(undefined);
  const [imagenName, setImagenName] = useState<string | undefined>(undefined);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preselecciona local si proponente con uno solo.
  useEffect(() => {
    if (esGestor) return;
    if (userLocalesNorm.length === 1 && !idLocal) setIdLocal(userLocalesNorm[0]);
  }, [esGestor, userLocalesNorm, idLocal]);

  function toggleRed(r: Red) {
    setRedesSel((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  }

  async function elegirImagen() {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        showToast('Permisos', 'Se necesita acceso a la galería para elegir una imagen.', 'warning');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.85,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setImagenUri(asset.uri);
      setImagenMime(asset.mimeType ?? undefined);
      setImagenName(asset.fileName ?? undefined);
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo procesar la imagen', 'error');
    }
  }

  function quitarImagen() {
    setImagenUri(null);
    setImagenMime(undefined);
    setImagenName(undefined);
  }

  function cambiarRefSegment(s: RefSegment) {
    setRefSegment(s);
    if (s === 'subir') setRefUrl('');
    else quitarImagen();
  }

  async function subirImagenReferencia(uri: string): Promise<string> {
    const form = new FormData();
    const nombre = imagenName || (uri.split('/').pop() ?? 'imagen.jpg').split('?')[0] || 'imagen.jpg';
    await appendImagenAlFormData(form, uri, nombre, imagenMime);
    form.append('tipo', 'referencia');
    const res = await apiFetch('/api/marketing/upload-imagen', { method: 'POST', body: form, timeoutMs: 60_000 });
    const data = (await res.json()) as { error?: string; key?: string };
    if (!res.ok || !data.key) throw new Error(data.error || 'No se pudo subir la imagen');
    return data.key;
  }

  async function guardar() {
    setError(null);
    if (!idLocal) {
      setError('Selecciona un local.');
      return;
    }
    if (!tipo) {
      setError('Selecciona un tipo de propuesta.');
      return;
    }
    if (redesSel.length === 0) {
      setError('Selecciona al menos una red.');
      return;
    }
    if (!esIsoFechaValida(fechaSugerida.trim())) {
      setError('Indica una fecha válida (dd/mm/aaaa).');
      return;
    }
    if (!descripcion.trim()) {
      setError('La descripción es obligatoria.');
      return;
    }
    setSaving(true);
    try {
      let imagen_referencia_url = '';
      if (refSegment === 'enlace') {
        imagen_referencia_url = refUrl.trim();
      } else if (imagenUri) {
        imagen_referencia_url = await subirImagenReferencia(imagenUri);
      }
      const body = {
        id_local: idLocal,
        tipo,
        redes: redesSel,
        fecha_sugerida: fechaSugerida.trim(),
        descripcion: descripcion.trim(),
        imagen_referencia_url,
      };
      const res = await apiFetch('/api/marketing/propuestas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string; propuesta?: { id_propuesta: string } };
      if (!res.ok) throw new Error(data.error || 'No se pudo crear la propuesta');
      showToast('Propuesta creada', 'Pendiente de revisión.', 'success');
      const id = data.propuesta?.id_propuesta;
      if (id) router.replace(`/rrss/propuesta/${id}`);
      else router.replace('/rrss');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error desconocido';
      setError(msg);
      showToast('Error', msg, 'error');
    } finally {
      setSaving(false);
    }
  }

  const localesMap = useMemo(() => {
    const m: Record<string, string> = {};
    locales.forEach((l) => {
      const id = formatId6(valorEnLocal(l, 'id_Locales'));
      const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
      if (id) m[id] = nombre;
    });
    return m;
  }, [locales]);

  const puedeEditarIdentidad = esGestor || userLocalesNorm.includes(idLocal);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.accent} />
        </TouchableOpacity>
        <Text style={styles.title}>Nueva propuesta</Text>
      </View>

      <ScrollView contentContainerStyle={styles.form}>
        {/* Local */}
        <View style={styles.field}>
          <SelectorDesplegable
            label="Local *"
            icono="store"
            placeholder="Selecciona un local"
            tituloLista="Selecciona un local"
            iconoLista="store"
            loading={loadingLocales}
            disabled={!esGestor && userLocalesNorm.length <= 1}
            valorId={idLocal}
            opciones={localesElegibles.map((l) => {
              const id = formatId6(valorEnLocal(l, 'id_Locales'));
              const nombre = valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? id;
              return { id, titulo: nombre || id || '—', icono: 'store' as const };
            })}
            onSeleccionar={setIdLocal}
          />
        </View>

        {!!idLocal && (
          <IdentidadLocalPanel
            idLocal={idLocal}
            nombreLocal={localesMap[idLocal] ?? idLocal}
            puedeEditar={puedeEditarIdentidad}
            showToast={showToast}
            onGuardado={refetchLocales}
          />
        )}

        {/* Tipo */}
        <View style={styles.field}>
          <SelectorDesplegable
            label="Tipo de publicación *"
            icono="category"
            tituloLista="Tipo de publicación"
            iconoLista="category"
            valorId={tipo}
            opciones={TIPOS.map((t) => ({ id: t, titulo: t }))}
            onSeleccionar={setTipo}
          />
        </View>

        {/* Redes */}
        <View style={styles.field}>
          <Text style={styles.label}>Redes *</Text>
          <View style={styles.chipRow}>
            {REDES.map((r) => {
              const sel = redesSel.includes(r);
              return (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, sel && styles.chipSelected]}
                  onPress={() => toggleRed(r)}
                >
                  <Text style={[styles.chipText, sel && styles.chipTextSelected]}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Fecha */}
        <View style={styles.field}>
          <Text style={styles.label}>Fecha sugerida *</Text>
          <InputFecha
            valueIso={fechaSugerida}
            onChangeIso={setFechaSugerida}
            placeholder="dd/mm/aaaa"
            style={styles.dateInput}
          />
        </View>

        {/* Descripción */}
        <View style={styles.field}>
          <Text style={styles.label}>Descripción *</Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            value={descripcion}
            onChangeText={setDescripcion}
            multiline
            numberOfLines={5}
            placeholder="Describe qué quieres comunicar (qué producto, qué evento, qué tono…)"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Imagen referencia */}
        <View style={styles.field}>
          <Text style={styles.label}>Imagen de referencia (opcional)</Text>
          <Text style={styles.fieldSub}>
            Sube un archivo (se guarda en el servidor) o pega una URL pública https para no ocupar espacio.
          </Text>
          <View style={styles.segmentRow}>
            <TouchableOpacity
              style={[styles.segmentChip, refSegment === 'subir' && styles.segmentChipSelected]}
              onPress={() => cambiarRefSegment('subir')}
              activeOpacity={0.7}
            >
              <Text style={[styles.segmentChipText, refSegment === 'subir' && styles.segmentChipTextSelected]}>
                Subir archivo
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segmentChip, refSegment === 'enlace' && styles.segmentChipSelected]}
              onPress={() => cambiarRefSegment('enlace')}
              activeOpacity={0.7}
            >
              <Text style={[styles.segmentChipText, refSegment === 'enlace' && styles.segmentChipTextSelected]}>
                Enlace (URL)
              </Text>
            </TouchableOpacity>
          </View>
          {refSegment === 'enlace' ? (
            <TextInput
              style={styles.input}
              value={refUrl}
              onChangeText={setRefUrl}
              placeholder="https://ejemplo.com/imagen.jpg"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          ) : imagenUri ? (
            <View style={styles.imagenWrap}>
              <Image source={{ uri: imagenUri }} style={styles.imagenPreview} resizeMode="cover" />
              <View style={styles.imagenActions}>
                <TouchableOpacity style={styles.smallBtn} onPress={elegirImagen}>
                  <MaterialIcons name="edit" size={16} color={colors.accent} />
                  <Text style={styles.smallBtnText}>Cambiar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.smallBtn, styles.smallBtnDanger]} onPress={quitarImagen}>
                  <MaterialIcons name="delete-outline" size={16} color={colors.danger} />
                  <Text style={[styles.smallBtnText, styles.smallBtnDangerText]}>Quitar</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity style={styles.uploadBtn} onPress={elegirImagen} activeOpacity={0.7}>
              <MaterialIcons name="add-photo-alternate" size={22} color={colors.accent} />
              <Text style={styles.uploadBtnText}>Elegir imagen</Text>
            </TouchableOpacity>
          )}
        </View>

        {error && (
          <View style={styles.errorBox}>
            <MaterialIcons name="error-outline" size={18} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.primaryBtn, saving && styles.disabled]}
            onPress={guardar}
            disabled={saving}
            activeOpacity={0.7}
          >
            {saving ? <ActivityIndicator color={colors.surface} /> : <MaterialIcons name="save" size={20} color={colors.surface} />}
            <Text style={styles.primaryBtnText}>{saving ? 'Guardando…' : 'Crear propuesta'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.back()} disabled={saving}>
            <Text style={styles.secondaryBtnText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
      {ToastView}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerBtn: { padding: 6 },
  title: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  form: { padding: 16, gap: 16 },
  field: { gap: 6 },
  fieldSub: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, lineHeight: 15 },
  label: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  segmentRow: { flexDirection: 'row', gap: SPACING.sm, marginBottom: 4 },
  segmentChip: {
    flex: 1,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    alignItems: 'center',
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  segmentChipSelected: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  segmentChipText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  segmentChipTextSelected: { color: colors.accent },
  input: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[14],
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  textarea: { minHeight: 100, textAlignVertical: 'top' },
  dateInput: {
    fontFamily: fontFamily.regular, fontSize: fontSizes[13],
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  chip: { paddingVertical: SPACING.sm, paddingHorizontal: 14, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  chipText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary },
  chipTextSelected: { color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  imagenWrap: { gap: SPACING.sm },
  imagenPreview: { width: '100%', height: 240, borderRadius: RADIO_MEDIO, backgroundColor: colors.navActive },
  imagenActions: { flexDirection: 'row', gap: 10 },
  smallBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: SPACING.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.bg },
  smallBtnDanger: { borderColor: '#fecaca', backgroundColor: statusColors.danger.bg },
  smallBtnText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  smallBtnDangerText: { color: colors.danger },
  uploadBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: 14, borderWidth: 1, borderColor: colors.borderStrong, borderStyle: 'dashed', borderRadius: RADIO_MEDIO, backgroundColor: colors.bg },
  uploadBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.accent },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, padding: 10, backgroundColor: statusColors.danger.bg, borderRadius: RADIO_MEDIO },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, flex: 1 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  primaryBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: SPACING.md, backgroundColor: colors.accent, borderRadius: radius.md },
  primaryBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  secondaryBtn: { paddingVertical: SPACING.md, paddingHorizontal: SPACING.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  secondaryBtnText: { fontSize: fontSizes[13], color: colors.textPrimary, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  disabled: { opacity: 0.6 },
});
