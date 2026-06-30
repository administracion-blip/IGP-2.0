import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Alert,
  Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { apiFetch } from '../../../utils/api';
import { useLocalToast } from '../../../components/Toast';
import { InputFecha } from '../../../components/InputFecha';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { useMarketingLocales, valorEnLocal } from '../LocalesContext';
import { IdentidadLocalPanel } from '../components/IdentidadLocalPanel';
import { formatId6 } from '../lib/formatId6';
import { appendImagenAlFormData } from '../lib/appendImagenFormData';
import { esIsoFechaValida, isoDateTimeToDmyFecha, isoToDmy } from '../lib/fechasUi';

type Propuesta = {
  id_propuesta: string;
  id_local: string;
  id_empresa?: string;
  tipo: string;
  redes: string[];
  fecha_sugerida: string;
  descripcion: string;
  imagen_referencia_url?: string;
  estado: string;
  creado_por?: string;
  creado_en?: string;
  aprobado_por?: string;
  aprobado_en?: string;
  comentario_rechazo?: string;
  prompt_generado?: string;
  imagen_final_url?: string;
  url_publicacion?: string;
  metricas?: Record<string, unknown>;
};

const TIPOS = ['Oferta', 'Evento', 'Novedad', 'Menu del dia', 'Agradecimiento', 'Cartel Musico', 'Otro'];
const REDES = ['instagram', 'facebook', 'tiktok'] as const;
type Red = (typeof REDES)[number];
type RefSegmentPropuesta = 'subir' | 'enlace';

function badgeStyles(estado: string): { backgroundColor: string; color: string } {
  switch (estado) {
    case 'pendiente':
      return { backgroundColor: '#fef3c7', color: '#b45309' };
    case 'aprobada':
      return { backgroundColor: '#d1fae5', color: '#047857' };
    case 'rechazada':
      return { backgroundColor: '#fee2e2', color: '#b91c1c' };
    case 'publicada':
      return { backgroundColor: '#dbeafe', color: '#1e40af' };
    default:
      return { backgroundColor: '#f1f5f9', color: '#475569' };
  }
}

function confirmar(titulo: string, mensaje: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(typeof window !== 'undefined' && window.confirm(`${titulo}\n\n${mensaje}`));
  }
  return new Promise((resolve) => {
    Alert.alert(titulo, mensaje, [
      { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Aceptar', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}

function promptInput(titulo: string, mensaje: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return Promise.resolve(null);
    const v = window.prompt(`${titulo}\n${mensaje}`, '');
    return Promise.resolve(v);
  }
  return new Promise((resolve) => {
    Alert.prompt?.(
      titulo,
      mensaje,
      [
        { text: 'Cancelar', style: 'cancel', onPress: () => resolve(null) },
        { text: 'Aceptar', onPress: (v?: string) => resolve(v ?? '') },
      ],
      'plain-text'
    );
  });
}

export default function PropuestaDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = String(params.id || '');
  const { user, hasPermiso } = useAuth();
  const { locales, refetch: refetchLocales } = useMarketingLocales();
  const { show: showToast, ToastView } = useLocalToast();
  const esGestor = hasPermiso('marketing.gestionar');

  const userLocalesNorm = useMemo(
    () => (user?.Locales ?? []).map((l) => formatId6(l)).filter(Boolean),
    [user?.Locales]
  );

  const [propuesta, setPropuesta] = useState<Propuesta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [tipo, setTipo] = useState('');
  const [redesSel, setRedesSel] = useState<Red[]>([]);
  const [fechaSugerida, setFechaSugerida] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [imagenFinalUrl, setImagenFinalUrl] = useState('');
  const [urlPublicacion, setUrlPublicacion] = useState('');
  const [comentarioRechazo, setComentarioRechazo] = useState('');
  const [promptGenerado, setPromptGenerado] = useState('');

  // UI state
  const [imagenRefUrl, setImagenRefUrl] = useState<string | null>(null);
  const [refSegment, setRefSegment] = useState<RefSegmentPropuesta>('subir');
  const [refUrl, setRefUrl] = useState('');
  const [refUri, setRefUri] = useState<string | null>(null);
  const [refMime, setRefMime] = useState<string | undefined>(undefined);
  const [refName, setRefName] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/marketing/propuestas/${id}`);
      const data = (await res.json()) as { propuesta?: Propuesta; error?: string };
      if (!res.ok || !data.propuesta) throw new Error(data.error || 'No se pudo cargar la propuesta');
      const p = data.propuesta;
      setPropuesta(p);
      setTipo(p.tipo);
      setRedesSel((p.redes ?? []).filter((r): r is Red => REDES.includes(r as Red)));
      setFechaSugerida(p.fecha_sugerida?.slice(0, 10) ?? '');
      setDescripcion(p.descripcion ?? '');
      setImagenFinalUrl(p.imagen_final_url ?? '');
      setUrlPublicacion(p.url_publicacion ?? '');
      setComentarioRechazo(p.comentario_rechazo ?? '');
      setPromptGenerado(p.prompt_generado ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Carga presigned URL para la imagen de referencia si guardamos una S3 key.
  useEffect(() => {
    let cancelled = false;
    const ref = propuesta?.imagen_referencia_url ?? '';
    if (!ref) {
      setImagenRefUrl(null);
      return;
    }
    if (ref.startsWith('http')) {
      setImagenRefUrl(ref);
      return;
    }
    apiFetch(`/api/marketing/imagen-url?key=${encodeURIComponent(ref)}`)
      .then((r) => r.json())
      .then((d: { url?: string }) => {
        if (!cancelled && d.url) setImagenRefUrl(d.url);
      })
      .catch(() => {
        if (!cancelled) setImagenRefUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [propuesta?.imagen_referencia_url]);

  useEffect(() => {
    if (!propuesta) return;
    const ref = propuesta.imagen_referencia_url ?? '';
    if (ref.startsWith('http')) {
      setRefSegment('enlace');
      setRefUrl(ref);
    } else {
      setRefSegment('subir');
      setRefUrl('');
    }
    setRefUri(null);
    setRefMime(undefined);
    setRefName(undefined);
  }, [propuesta?.id_propuesta, propuesta?.imagen_referencia_url]);

  const imagenRefPreview = useMemo(() => {
    if (refSegment === 'enlace') {
      const u = refUrl.trim();
      return /^https?:\/\//i.test(u) ? u : null;
    }
    if (refUri) return refUri;
    return imagenRefUrl;
  }, [refSegment, refUrl, refUri, imagenRefUrl]);

  const localNombre = useMemo(() => {
    if (!propuesta) return '';
    const idLoc = formatId6(propuesta.id_local);
    const l = locales.find((x) => formatId6(valorEnLocal(x, 'id_Locales')) === idLoc);
    return l ? (valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? idLoc) : idLoc;
  }, [propuesta, locales]);

  const esPropia = !!user?.id_usuario && propuesta?.creado_por === user.id_usuario;
  const editableProponente = esPropia && propuesta?.estado === 'pendiente';
  const editableGestor = esGestor;
  const puedeEditarBasicos = editableProponente || editableGestor;
  const puedeEliminar =
    (esPropia && propuesta?.estado === 'pendiente') ||
    (esGestor && (propuesta?.estado === 'pendiente' || propuesta?.estado === 'rechazada'));

  const puedeEditarIdentidadDet =
    !!propuesta && (esGestor || userLocalesNorm.includes(formatId6(propuesta.id_local)));

  function toggleRed(r: Red) {
    if (!puedeEditarBasicos) return;
    setRedesSel((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  }

  function quitarImagenRef() {
    setRefUri(null);
    setRefMime(undefined);
    setRefName(undefined);
  }

  function cambiarRefSegmentDetalle(s: RefSegmentPropuesta) {
    if (!puedeEditarBasicos) return;
    setRefSegment(s);
    if (s === 'subir') setRefUrl('');
    else quitarImagenRef();
  }

  async function elegirImagenReferenciaDetalle() {
    if (!puedeEditarBasicos) return;
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
      setRefUri(asset.uri);
      setRefMime(asset.mimeType ?? undefined);
      setRefName(asset.fileName ?? undefined);
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo procesar la imagen', 'error');
    }
  }

  async function subirImagenReferencia(uri: string): Promise<string> {
    const form = new FormData();
    const nombre =
      refName || (uri.split('/').pop() ?? 'imagen.jpg').split('?')[0] || 'imagen.jpg';
    await appendImagenAlFormData(form, uri, nombre, refMime);
    form.append('tipo', 'referencia');
    const res = await apiFetch('/api/marketing/upload-imagen', { method: 'POST', body: form, timeoutMs: 60_000 });
    const data = (await res.json()) as { error?: string; key?: string };
    if (!res.ok || !data.key) throw new Error(data.error || 'No se pudo subir la imagen');
    return data.key;
  }

  async function guardarBasicos() {
    if (!propuesta) return;
    if (!esIsoFechaValida(fechaSugerida.trim())) {
      showToast('Fecha inválida', 'Indica una fecha válida (dd/mm/aaaa).', 'warning');
      return;
    }
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {
        tipo,
        redes: redesSel,
        fecha_sugerida: fechaSugerida.trim(),
        descripcion: descripcion.trim(),
      };

      let refTouched = false;
      let nuevaRef = '';
      if (refSegment === 'enlace') {
        refTouched = true;
        nuevaRef = refUrl.trim();
      } else if (refUri) {
        refTouched = true;
        nuevaRef = await subirImagenReferencia(refUri);
      }
      if (refTouched) {
        updates.imagen_referencia_url = nuevaRef;
      }

      if (esGestor) {
        updates.imagen_final_url = imagenFinalUrl.trim();
        updates.url_publicacion = urlPublicacion.trim();
        if (promptGenerado.trim()) updates.prompt_generado = promptGenerado;
      }
      const res = await apiFetch(`/api/marketing/propuestas/${propuesta.id_propuesta}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = (await res.json()) as { propuesta?: Propuesta; error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
      if (data.propuesta) {
        setPropuesta(data.propuesta);
        setFechaSugerida(data.propuesta.fecha_sugerida?.slice(0, 10) ?? '');
        quitarImagenRef();
      }
      showToast('Guardado', 'Cambios aplicados.', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error desconocido';
      showToast('Error', msg, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function aprobar() {
    if (!propuesta) return;
    if (!(await confirmar('Aprobar propuesta', '¿Confirmar aprobación?'))) return;
    setBusy('aprobar');
    try {
      const res = await apiFetch(`/api/marketing/propuestas/${propuesta.id_propuesta}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'aprobada' }),
      });
      const data = (await res.json()) as { propuesta?: Propuesta; error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo aprobar');
      if (data.propuesta) setPropuesta(data.propuesta);
      showToast('Aprobada', 'La propuesta queda aprobada.', 'success');
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function rechazar() {
    if (!propuesta) return;
    const motivo = await promptInput('Rechazar propuesta', 'Indica el motivo del rechazo:');
    if (motivo == null) return;
    if (!motivo.trim()) {
      showToast('Falta motivo', 'Debes indicar un comentario de rechazo.', 'warning');
      return;
    }
    setBusy('rechazar');
    try {
      const res = await apiFetch(`/api/marketing/propuestas/${propuesta.id_propuesta}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'rechazada', comentario_rechazo: motivo.trim() }),
      });
      const data = (await res.json()) as { propuesta?: Propuesta; error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo rechazar');
      if (data.propuesta) setPropuesta(data.propuesta);
      setComentarioRechazo(motivo.trim());
      showToast('Rechazada', 'La propuesta queda rechazada.', 'success');
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function marcarPublicada() {
    if (!propuesta) return;
    if (!urlPublicacion.trim()) {
      showToast('Falta URL', 'Introduce la URL de publicación antes de marcar como publicada.', 'warning');
      return;
    }
    if (!(await confirmar('Marcar publicada', '¿Confirmar?'))) return;
    setBusy('publicar');
    try {
      const res = await apiFetch(`/api/marketing/propuestas/${propuesta.id_propuesta}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'publicada', url_publicacion: urlPublicacion.trim() }),
      });
      const data = (await res.json()) as { propuesta?: Propuesta; error?: string };
      if (!res.ok) throw new Error(data.error || 'No se pudo marcar como publicada');
      if (data.propuesta) setPropuesta(data.propuesta);
      showToast('Publicada', 'Estado actualizado.', 'success');
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function regenerarPrompt() {
    if (!propuesta) return;
    setBusy('prompt');
    try {
      const res = await apiFetch(`/api/marketing/propuestas/${propuesta.id_propuesta}/prompt`, {
        method: 'POST',
      });
      const data = (await res.json()) as { prompt_generado?: string; error?: string };
      if (!res.ok || !data.prompt_generado) throw new Error(data.error || 'No se pudo generar el prompt');
      setPromptGenerado(data.prompt_generado);
      setPropuesta((prev) => (prev ? { ...prev, prompt_generado: data.prompt_generado } : prev));
      showToast('Prompt generado', 'Listo para usar en tu herramienta de generación de imágenes.', 'success');
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function copiarPromptGenerado() {
    const text = promptGenerado.trim();
    if (!text) {
      showToast('Vacío', 'No hay prompt para copiar.', 'warning');
      return;
    }
    try {
      await Clipboard.setStringAsync(text);
      showToast('Copiado', 'Prompt en el portapapeles.', 'success');
    } catch {
      showToast('Error', 'No se pudo copiar.', 'error');
    }
  }

  async function eliminar() {
    if (!propuesta) return;
    if (!(await confirmar('Eliminar propuesta', '¿Eliminar definitivamente?'))) return;
    setBusy('borrar');
    try {
      const res = await apiFetch(`/api/marketing/propuestas/${propuesta.id_propuesta}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || 'No se pudo eliminar');
      }
      showToast('Eliminada', 'La propuesta ha sido eliminada.', 'success');
      router.replace('/rrss');
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error desconocido', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando propuesta…</Text>
      </View>
    );
  }

  if (error || !propuesta) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
          </TouchableOpacity>
          <Text style={styles.title}>Propuesta</Text>
        </View>
        <View style={[styles.center, { padding: 32 }]}>
          <MaterialIcons name="error-outline" size={32} color="#f87171" />
          <Text style={styles.errorText}>{error || 'Propuesta no encontrada'}</Text>
          <TouchableOpacity style={styles.secondaryBtn} onPress={cargar}>
            <Text style={styles.secondaryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const estiloBadge = badgeStyles(propuesta.estado);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {propuesta.tipo}
        </Text>
        <View style={[styles.badge, { backgroundColor: estiloBadge.backgroundColor }]}>
          <Text style={[styles.badgeText, { color: estiloBadge.color }]}>{propuesta.estado}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.form}>
        {/* Local */}
        <View style={styles.field}>
          <Text style={styles.label}>Local</Text>
          <View style={styles.readonlyBox}>
            <MaterialIcons name="store" size={16} color="#64748b" />
            <Text style={styles.readonlyText}>{localNombre}</Text>
          </View>
        </View>

        <IdentidadLocalPanel
          idLocal={formatId6(propuesta.id_local)}
          nombreLocal={localNombre}
          puedeEditar={puedeEditarIdentidadDet}
          showToast={showToast}
          onGuardado={refetchLocales}
        />

        {/* Tipo */}
        <View style={styles.field}>
          <Text style={styles.label}>Tipo</Text>
          {puedeEditarBasicos ? (
            <SelectorDesplegable
              icono="category"
              tituloLista="Tipo de publicación"
              iconoLista="category"
              valorId={tipo}
              opciones={TIPOS.map((t) => ({ id: t, titulo: t }))}
              onSeleccionar={setTipo}
            />
          ) : (
            <View style={styles.readonlyBox}>
              <Text style={styles.readonlyText}>{tipo}</Text>
            </View>
          )}
        </View>

        {/* Redes */}
        <View style={styles.field}>
          <Text style={styles.label}>Redes</Text>
          <View style={styles.chipRow}>
            {REDES.map((r) => {
              const sel = redesSel.includes(r);
              return (
                <TouchableOpacity
                  key={r}
                  style={[styles.chip, sel && styles.chipSelected, !puedeEditarBasicos && styles.disabled]}
                  onPress={() => toggleRed(r)}
                  disabled={!puedeEditarBasicos}
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
          <Text style={styles.label}>Fecha sugerida</Text>
          {puedeEditarBasicos ? (
            <InputFecha
              valueIso={fechaSugerida}
              onChangeIso={setFechaSugerida}
              placeholder="dd/mm/aaaa"
              style={styles.dateInput}
            />
          ) : (
            <View style={styles.readonlyBox}>
              <MaterialIcons name="event" size={16} color="#64748b" />
              <Text style={styles.readonlyText}>{isoToDmy(fechaSugerida) || '—'}</Text>
            </View>
          )}
        </View>

        {/* Descripción */}
        <View style={styles.field}>
          <Text style={styles.label}>Descripción</Text>
          <TextInput
            style={[styles.input, styles.textarea, !puedeEditarBasicos && styles.disabled]}
            value={descripcion}
            onChangeText={setDescripcion}
            multiline
            editable={puedeEditarBasicos}
            placeholderTextColor="#94a3b8"
          />
        </View>

        {/* Imagen referencia */}
        <View style={styles.field}>
          <Text style={styles.label}>Imagen de referencia (opcional)</Text>
          {puedeEditarBasicos && (
            <>
              <Text style={styles.fieldSub}>
                Archivo en servidor o URL pública https (no ocupa tu espacio en el bucket).
              </Text>
              <View style={styles.segmentRow}>
                <TouchableOpacity
                  style={[styles.segmentChip, refSegment === 'subir' && styles.segmentChipSelected]}
                  onPress={() => cambiarRefSegmentDetalle('subir')}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[styles.segmentChipText, refSegment === 'subir' && styles.segmentChipTextSelected]}
                  >
                    Subir archivo
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.segmentChip, refSegment === 'enlace' && styles.segmentChipSelected]}
                  onPress={() => cambiarRefSegmentDetalle('enlace')}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[styles.segmentChipText, refSegment === 'enlace' && styles.segmentChipTextSelected]}
                  >
                    Enlace (URL)
                  </Text>
                </TouchableOpacity>
              </View>
              {refSegment === 'enlace' ? (
                <TextInput
                  style={styles.input}
                  value={refUrl}
                  onChangeText={setRefUrl}
                  placeholder="https://…"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              ) : refUri ? (
                <View style={styles.imagenWrap}>
                  <Image source={{ uri: refUri }} style={styles.imagenPreview} resizeMode="cover" />
                  <View style={styles.imagenActions}>
                    <TouchableOpacity style={styles.smallBtnImg} onPress={elegirImagenReferenciaDetalle}>
                      <MaterialIcons name="edit" size={16} color="#0ea5e9" />
                      <Text style={styles.smallBtnImgText}>Cambiar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.smallBtnImg, styles.smallBtnImgDanger]} onPress={quitarImagenRef}>
                      <MaterialIcons name="delete-outline" size={16} color="#dc2626" />
                      <Text style={[styles.smallBtnImgText, styles.smallBtnImgDangerText]}>Quitar</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity style={styles.uploadBtn} onPress={elegirImagenReferenciaDetalle} activeOpacity={0.7}>
                  <MaterialIcons name="add-photo-alternate" size={22} color="#0ea5e9" />
                  <Text style={styles.uploadBtnText}>Elegir imagen nueva</Text>
                </TouchableOpacity>
              )}
            </>
          )}
          {imagenRefPreview &&
            !(puedeEditarBasicos && refSegment === 'subir' && !!refUri) && (
            <View style={{ marginTop: puedeEditarBasicos ? 10 : 0 }}>
              {!puedeEditarBasicos && <Text style={styles.fieldSub}>Vista previa</Text>}
              <Image source={{ uri: imagenRefPreview }} style={styles.imagenPreview} resizeMode="cover" />
            </View>
          )}
          {puedeEditarBasicos &&
            refSegment === 'subir' &&
            !refUri &&
            !imagenRefUrl && (
              <Text style={styles.fieldSubMuted}>Sin imagen guardada. Elige una o cambia a enlace URL.</Text>
            )}
        </View>

        {/* Comentario rechazo (visible si rechazada) */}
        {propuesta.estado === 'rechazada' && (
          <View style={[styles.field, styles.warningBox]}>
            <Text style={styles.warningTitle}>Motivo del rechazo</Text>
            <Text style={styles.warningText}>{comentarioRechazo || '—'}</Text>
          </View>
        )}

        {/* Bloque gestor: prompt + URLs + métricas */}
        {esGestor && (
          <>
            <View style={styles.divider} />
            <Text style={styles.sectionTitle}>Gestión</Text>

            <View style={styles.field}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>Prompt generado (IA)</Text>
                <View style={styles.promptActions}>
                  <TouchableOpacity
                    style={[styles.smallBtnIcon, !promptGenerado.trim() && styles.disabled]}
                    onPress={copiarPromptGenerado}
                    disabled={!promptGenerado.trim()}
                    accessibilityRole="button"
                    accessibilityLabel="Copiar prompt al portapapeles"
                  >
                    <MaterialIcons name="content-copy" size={18} color="#0ea5e9" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.smallBtn, busy === 'prompt' && styles.disabled]}
                    onPress={regenerarPrompt}
                    disabled={busy === 'prompt'}
                  >
                    {busy === 'prompt' ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <MaterialIcons name="auto-awesome" size={16} color="#0ea5e9" />
                    )}
                    <Text style={styles.smallBtnText}>{promptGenerado ? 'Regenerar' : 'Generar'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={promptGenerado}
                onChangeText={setPromptGenerado}
                multiline
                placeholder="Aún no se ha generado prompt. Pulsa Generar."
                placeholderTextColor="#94a3b8"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>URL imagen final</Text>
              <TextInput
                style={styles.input}
                value={imagenFinalUrl}
                onChangeText={setImagenFinalUrl}
                placeholder="https://…"
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>URL publicación</Text>
              <TextInput
                style={styles.input}
                value={urlPublicacion}
                onChangeText={setUrlPublicacion}
                placeholder="https://instagram.com/…"
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
              />
            </View>
          </>
        )}

        {/* Acciones */}
        <View style={styles.actionsCol}>
          {puedeEditarBasicos && (
            <TouchableOpacity
              style={[styles.primaryBtn, saving && styles.disabled]}
              onPress={guardarBasicos}
              disabled={saving}
              activeOpacity={0.7}
            >
              {saving ? <ActivityIndicator color="#fff" /> : <MaterialIcons name="save" size={20} color="#fff" />}
              <Text style={styles.primaryBtnText}>{saving ? 'Guardando…' : 'Guardar cambios'}</Text>
            </TouchableOpacity>
          )}

          {esGestor && propuesta.estado === 'pendiente' && (
            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={[styles.successBtn, busy === 'aprobar' && styles.disabled]}
                onPress={aprobar}
                disabled={busy === 'aprobar'}
              >
                {busy === 'aprobar' ? <ActivityIndicator color="#fff" /> : <MaterialIcons name="check" size={20} color="#fff" />}
                <Text style={styles.primaryBtnText}>Aprobar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.dangerBtn, busy === 'rechazar' && styles.disabled]}
                onPress={rechazar}
                disabled={busy === 'rechazar'}
              >
                {busy === 'rechazar' ? <ActivityIndicator color="#fff" /> : <MaterialIcons name="close" size={20} color="#fff" />}
                <Text style={styles.primaryBtnText}>Rechazar</Text>
              </TouchableOpacity>
            </View>
          )}

          {esGestor && propuesta.estado === 'aprobada' && (
            <TouchableOpacity
              style={[styles.publishBtn, busy === 'publicar' && styles.disabled]}
              onPress={marcarPublicada}
              disabled={busy === 'publicar'}
            >
              {busy === 'publicar' ? <ActivityIndicator color="#fff" /> : <MaterialIcons name="campaign" size={20} color="#fff" />}
              <Text style={styles.primaryBtnText}>Marcar como publicada</Text>
            </TouchableOpacity>
          )}

          {puedeEliminar && (
            <TouchableOpacity
              style={[styles.dangerBtnOutline, busy === 'borrar' && styles.disabled]}
              onPress={eliminar}
              disabled={busy === 'borrar'}
            >
              {busy === 'borrar' ? (
                <ActivityIndicator color="#dc2626" />
              ) : (
                <MaterialIcons name="delete-outline" size={20} color="#dc2626" />
              )}
              <Text style={styles.dangerBtnOutlineText}>Eliminar propuesta</Text>
            </TouchableOpacity>
          )}
        </View>

        <Text style={styles.metaFooter}>
          Creada el {isoDateTimeToDmyFecha(propuesta.creado_en)}
          {propuesta.aprobado_en ? ` · Aprobada el ${isoDateTimeToDmyFecha(propuesta.aprobado_en)}` : ''}
        </Text>
      </ScrollView>
      {ToastView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  headerBtn: { padding: 6 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155', flex: 1 },
  badge: { paddingVertical: 4, paddingHorizontal: 12, borderRadius: 12 },
  badgeText: { fontSize: 11, fontWeight: '600', textTransform: 'capitalize' },
  form: { padding: 16, gap: 16 },
  field: { gap: 6 },
  fieldSub: { fontSize: 11, color: '#64748b', lineHeight: 15 },
  fieldSubMuted: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic' },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  promptActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  smallBtnIcon: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 6,
    backgroundColor: '#f0f9ff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: { fontSize: 12, fontWeight: '600', color: '#475569' },
  segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  segmentChip: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  segmentChipSelected: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  segmentChipText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  segmentChipTextSelected: { color: '#0ea5e9' },
  imagenWrap: { gap: 8 },
  imagenActions: { flexDirection: 'row', gap: 10 },
  smallBtnImg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    backgroundColor: '#f8fafc',
  },
  smallBtnImgDanger: { borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  smallBtnImgText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  smallBtnImgDangerText: { color: '#dc2626' },
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  uploadBtnText: { fontSize: 13, fontWeight: '500', color: '#0ea5e9' },
  readonlyBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  readonlyText: { fontSize: 13, color: '#334155' },
  input: {
    fontSize: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  textarea: { minHeight: 100, textAlignVertical: 'top' },
  dateInput: {
    fontSize: 13,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: '#334155',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 },
  chipSelected: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  chipText: { fontSize: 13, color: '#475569' },
  chipTextSelected: { color: '#0ea5e9', fontWeight: '600' },
  imagenPreview: { width: '100%', height: 240, borderRadius: 8, backgroundColor: '#f1f5f9' },
  warningBox: { padding: 12, backgroundColor: '#fef3c7', borderLeftWidth: 4, borderLeftColor: '#f59e0b', borderRadius: 6 },
  warningTitle: { fontSize: 12, fontWeight: '600', color: '#b45309' },
  warningText: { fontSize: 13, color: '#78350f' },
  divider: { height: 1, backgroundColor: '#e2e8f0', marginTop: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  smallBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: '#bae6fd', borderRadius: 6, backgroundColor: '#f0f9ff' },
  smallBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  errorText: { fontSize: 13, color: '#f87171', textAlign: 'center' },
  actionsCol: { gap: 10, marginTop: 8 },
  actionsRow: { flexDirection: 'row', gap: 10 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: '#0ea5e9', borderRadius: 10 },
  primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  successBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: '#10b981', borderRadius: 10 },
  dangerBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: '#ef4444', borderRadius: 10 },
  publishBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, backgroundColor: '#3b82f6', borderRadius: 10 },
  dangerBtnOutline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderWidth: 1, borderColor: '#fecaca', borderRadius: 10, backgroundColor: '#fef2f2' },
  dangerBtnOutlineText: { fontSize: 14, fontWeight: '600', color: '#dc2626' },
  secondaryBtn: { paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#fff' },
  secondaryBtnText: { fontSize: 13, color: '#475569', fontWeight: '500' },
  disabled: { opacity: 0.6 },
  metaFooter: { fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 12 },
});
