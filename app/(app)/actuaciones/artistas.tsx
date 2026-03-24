import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  Switch,
  Platform,
  Pressable,
  KeyboardAvoidingView,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useLocalToast } from '../../components/Toast';
import { TablaBasica } from '../../components/TablaBasica';
import { ICON_SIZE } from '../../constants/icons';
import { API_BASE_URL as API_URL } from '../../utils/apiBaseUrl';
import { formatMoneda } from '../../utils/facturacion';

const ESTILOS_OPTS = [
  'pop', 'rock', 'flamenco', 'rumba', 'jazz', 'latina', 'electronica', 'comercial', 'urbana', 'versiones', 'chill', 'tributo',
];
const TIPO_OPTS = ['solista', 'duo', 'trio', 'banda', 'dj', 'tributo', 'animacion', 'espectaculo'];

const ESTILOS_OPTS_ORDEN = [...ESTILOS_OPTS].sort((a, b) => a.localeCompare(b, 'es'));
const TIPO_OPTS_ORDEN = [...TIPO_OPTS].sort((a, b) => a.localeCompare(b, 'es'));

function resumenSeleccion(arr: string[] | undefined, vacio: string): string {
  const a = arr?.filter(Boolean) ?? [];
  if (a.length === 0) return vacio;
  if (a.length <= 2) return a.join(', ');
  return `${a.slice(0, 2).join(', ')} +${a.length - 2}`;
}

async function appendImagenAlFormData(form: FormData, uri: string, nombreArchivo: string, mimeType?: string) {
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    const blob = await res.blob();
    const name = nombreArchivo || 'imagen.jpg';
    form.append('file', blob, name);
  } else {
    form.append(
      'file',
      {
        uri,
        name: nombreArchivo || 'imagen.jpg',
        type: mimeType || 'image/jpeg',
      } as unknown as Blob
    );
  }
}

const COLUMNAS_TABLA = ['Nombre', 'Imagen', 'Componentes', 'Tipo', 'Estilos', 'Activo', 'Teléfono', 'Email'] as const;

/** Matriz fija: franjas tarde/noche × tipo de día (coherente con api/lib/tarifaActuacion.js). */
type TipoDiaColumna = 'laborable' | 'fin_semana' | 'festivo';
type TarifaMatriz = {
  tarde: Record<TipoDiaColumna, number>;
  noche: Record<TipoDiaColumna, number>;
};

type TarifaRowLegacy = { codigo?: string; tipo_dia: string; franja: string; importe: number };
type Artista = {
  id_artista: string;
  nombre_artistico: string;
  componentes?: number;
  estilos_musicales?: string[];
  tipo_artista?: string[];
  imagen_key?: string;
  activo?: boolean;
  telefono_contacto?: string;
  email_contacto?: string;
  observaciones?: string;
  tarifas?: TarifaMatriz | TarifaRowLegacy[];
};

function tarifasMatrizVacia(): TarifaMatriz {
  return {
    tarde: { laborable: 0, fin_semana: 0, festivo: 0 },
    noche: { laborable: 0, fin_semana: 0, festivo: 0 },
  };
}

function normalizeTipoDiaKey(tipoDia: string): TipoDiaColumna {
  const t = String(tipoDia || '').toLowerCase();
  if (t === 'festivo') return 'festivo';
  if (t === 'fin_semana' || t === 'fin semana') return 'fin_semana';
  return 'laborable';
}

/** Lista antigua del API → matriz (mañana → tarde). */
function arrayTarifasToMatriz(arr: unknown): TarifaMatriz {
  const out = tarifasMatrizVacia();
  if (!Array.isArray(arr)) return out;
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const row = t as TarifaRowLegacy;
    let fr = String(row.franja || '').toLowerCase();
    if (fr === 'mañana' || fr === 'manana' || fr === 'morning') fr = 'tarde';
    if (fr !== 'tarde' && fr !== 'noche') continue;
    const tipo = normalizeTipoDiaKey(row.tipo_dia);
    const raw = Number(row.importe);
    if (!Number.isFinite(raw)) continue;
    out[fr as 'tarde' | 'noche'][tipo] = Math.round(raw * 100) / 100;
  }
  return out;
}

/** Texto escrito en celda de tarifa (€) → número para estado/API. */
function parseEuroInputToNumber(t: string): number {
  let s = t.replace(/€/g, '').replace(/\s/g, '').trim();
  if (s === '') return 0;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Valor numérico → texto editable sin símbolo € (al enfocar la celda). */
function numeroATextoTarifaEditable(n: number): string {
  if (n === 0) return '';
  return new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
}

function sanitizeMatrizDesdeObj(obj: unknown): TarifaMatriz {
  const out = tarifasMatrizVacia();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const o = obj as Record<string, Record<string, unknown>>;
  for (const fr of ['tarde', 'noche'] as const) {
    const row = o[fr];
    if (!row || typeof row !== 'object') continue;
    for (const td of ['laborable', 'fin_semana', 'festivo'] as const) {
      const raw = Number(row[td]);
      out[fr][td] = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
    }
  }
  return out;
}

function tarifasDesdeApi(raw: Artista['tarifas']): TarifaMatriz {
  if (raw == null) return tarifasMatrizVacia();
  if (Array.isArray(raw)) return arrayTarifasToMatriz(raw);
  return sanitizeMatrizDesdeObj(raw);
}

const emptyArtista = (): Partial<Artista> => ({
  nombre_artistico: '',
  componentes: 1,
  estilos_musicales: [],
  tipo_artista: [],
  activo: true,
  telefono_contacto: '',
  email_contacto: '',
  observaciones: '',
});

function getValorCeldaArtista(item: Artista, col: string): string {
  switch (col) {
    case 'Nombre':
      return item.nombre_artistico?.trim() || '—';
    case 'Imagen':
      return item.imagen_key ? 'sí' : '—';
    case 'Componentes':
      return item.componentes != null ? String(item.componentes) : '—';
    case 'Tipo':
      return Array.isArray(item.tipo_artista) && item.tipo_artista.length ? item.tipo_artista.join(', ') : '—';
    case 'Estilos':
      return Array.isArray(item.estilos_musicales) && item.estilos_musicales.length ? item.estilos_musicales.join(', ') : '—';
    case 'Activo':
      return item.activo === false ? 'Inactivo' : 'Activo';
    case 'Teléfono':
      return item.telefono_contacto?.trim() || '—';
    case 'Email':
      return item.email_contacto?.trim() || '—';
    default:
      return '—';
  }
}

export default function ArtistasScreen() {
  const router = useRouter();
  const { show: showToast, ToastView } = useLocalToast();
  const [lista, setLista] = useState<Artista[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Artista> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tarifas, setTarifas] = useState<TarifaMatriz>(() => tarifasMatrizVacia());
  /** Celda de tarifa en edición: texto libre; al desenfocar se muestra formatMoneda. */
  const [focusedTarifa, setFocusedTarifa] = useState<{ key: string; text: string } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [confirmDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const [artistaToDelete, setArtistaToDelete] = useState<Artista | null>(null);
  const [pickerEstilosOpen, setPickerEstilosOpen] = useState(false);
  const [pickerTipoOpen, setPickerTipoOpen] = useState(false);
  /** Vista previa local (file:// / blob) tras elegir imagen */
  const [imagenPreviewUri, setImagenPreviewUri] = useState<string | null>(null);
  const [imagenSubiendo, setImagenSubiendo] = useState(false);
  /** URL firmada del servidor para mostrar foto guardada en el formulario */
  const [imagenUrlServidor, setImagenUrlServidor] = useState<string | null>(null);
  const [imagenUrlServidorLoading, setImagenUrlServidorLoading] = useState(false);
  /** Modal pantalla completa: ver imagen desde la tabla */
  const [vistaImagenOpen, setVistaImagenOpen] = useState(false);
  const [vistaImagenTitulo, setVistaImagenTitulo] = useState('');
  const [vistaImagenUrl, setVistaImagenUrl] = useState<string | null>(null);
  const [vistaImagenLoading, setVistaImagenLoading] = useState(false);
  const [vistaImagenError, setVistaImagenError] = useState<string | null>(null);

  const fetchLista = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/api/artistas`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setLista(d.artistas || []))
      .catch((e) => {
        setLista([]);
        setError(e instanceof Error ? e.message : 'Error de conexión');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchLista();
  }, [fetchLista]);

  /** Carga URL firmada para la miniatura del formulario cuando hay imagen en servidor y no hay preview local */
  useEffect(() => {
    if (!modalOpen || !editing?.id_artista || !editing.imagen_key) {
      setImagenUrlServidor(null);
      setImagenUrlServidorLoading(false);
      return;
    }
    if (imagenPreviewUri) {
      setImagenUrlServidorLoading(false);
      return;
    }
    let cancelled = false;
    setImagenUrlServidorLoading(true);
    setImagenUrlServidor(null);
    fetch(`${API_URL}/api/artistas/${editing.id_artista}/imagen-url`)
      .then((r) => r.json())
      .then((d: { url?: string | null }) => {
        if (!cancelled) {
          setImagenUrlServidor(d?.url ?? null);
          setImagenUrlServidorLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImagenUrlServidor(null);
          setImagenUrlServidorLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [modalOpen, editing?.id_artista, editing?.imagen_key, imagenPreviewUri]);

  const listaFiltrada = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter((a) => COLUMNAS_TABLA.some((col) => getValorCeldaArtista(a, col).toLowerCase().includes(q)));
  }, [lista, filtroBusqueda]);

  function abrirNuevo() {
    setEditing(emptyArtista());
    setTarifas(tarifasMatrizVacia());
    setFocusedTarifa(null);
    setImagenPreviewUri(null);
    setImagenUrlServidor(null);
    setModalError(null);
    setModalOpen(true);
  }

  function abrirEditar(a: Artista) {
    setEditing({ ...a });
    setTarifas(tarifasDesdeApi(a.tarifas));
    setFocusedTarifa(null);
    setImagenPreviewUri(null);
    setImagenUrlServidor(null);
    setModalError(null);
    setModalOpen(true);
  }

  function cerrarModal() {
    setModalOpen(false);
    setModalError(null);
    setFocusedTarifa(null);
    setImagenPreviewUri(null);
    setImagenUrlServidor(null);
  }

  const abrirVistaImagenDesdeTabla = useCallback(async (a: Artista) => {
    if (!a.imagen_key) return;
    setVistaImagenOpen(true);
    setVistaImagenTitulo(a.nombre_artistico?.trim() || 'Artista');
    setVistaImagenUrl(null);
    setVistaImagenError(null);
    setVistaImagenLoading(true);
    try {
      const r = await fetch(`${API_URL}/api/artistas/${a.id_artista}/imagen-url`);
      const d = (await r.json()) as { url?: string | null; error?: string };
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (!d.url) setVistaImagenError('No hay imagen disponible');
      else setVistaImagenUrl(d.url);
    } catch (e) {
      setVistaImagenError(e instanceof Error ? e.message : 'Error al cargar la imagen');
    } finally {
      setVistaImagenLoading(false);
    }
  }, []);

  const cerrarVistaImagen = useCallback(() => {
    setVistaImagenOpen(false);
    setVistaImagenUrl(null);
    setVistaImagenError(null);
  }, []);

  async function guardar() {
    if (!editing?.nombre_artistico?.trim()) {
      const msg = 'Indica el nombre artístico del artista o grupo.';
      setModalError(msg);
      showToast('Falta el nombre', msg, 'warning');
      return;
    }
    setModalError(null);
    setSaving(true);
    const tarifasPayload: TarifaMatriz = sanitizeMatrizDesdeObj(tarifas);
    const body: Record<string, unknown> = {
      nombre_artistico: editing.nombre_artistico,
      componentes: Number(editing.componentes) || 1,
      estilos_musicales: Array.isArray(editing.estilos_musicales) ? editing.estilos_musicales : [],
      tipo_artista: Array.isArray(editing.tipo_artista) ? editing.tipo_artista : [],
      imagen_key: editing.imagen_key ?? '',
      activo: editing.activo !== false,
      telefono_contacto: editing.telefono_contacto ?? '',
      email_contacto: editing.email_contacto ?? '',
      observaciones: editing.observaciones ?? '',
      tarifas: tarifasPayload,
    };
    try {
      const isNew = !editing.id_artista;
      const url = isNew
        ? `${API_URL}/api/artistas`
        : `${API_URL}/api/artistas/${editing.id_artista}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data: { error?: string; artista?: Artista } = {};
      try {
        data = text ? (JSON.parse(text) as { error?: string; artista?: Artista }) : {};
      } catch {
        throw new Error(text?.slice(0, 200) || `Respuesta no válida (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(data.error || `Error al guardar (HTTP ${res.status})`);
      setModalError(null);
      const artista = data.artista;
      const uriImagenPendiente = imagenPreviewUri;
      if (isNew && artista?.id_artista) {
        setEditing(artista);
        setTarifas(tarifasDesdeApi(artista.tarifas));
        if (uriImagenPendiente) {
          setImagenSubiendo(true);
          try {
            const up = await subirImagenAlServidor(artista.id_artista, uriImagenPendiente);
            if (up.imagen_key) {
              setEditing((prev) => (prev ? { ...prev, imagen_key: up.imagen_key } : prev));
            }
            setImagenPreviewUri(null);
            showToast('Guardado', 'Artista e imagen guardados correctamente.', 'success');
          } catch (imgErr) {
            showToast(
              'Artista guardado',
              imgErr instanceof Error ? `Imagen no subida: ${imgErr.message}` : 'No se pudo subir la imagen. Puedes intentarlo de nuevo desde el recuadro.',
              'warning'
            );
          } finally {
            setImagenSubiendo(false);
          }
        } else {
          showToast('Artista guardado', 'Los datos se han guardado correctamente.', 'success');
        }
      } else {
        setModalOpen(false);
        showToast('Artista guardado', 'Los datos se han guardado correctamente.', 'success');
      }
      fetchLista();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error desconocido';
      const hint =
        /fetch|NetworkError|Failed to fetch|aborted/i.test(msg)
          ? ` No se pudo conectar con ${API_URL}. Comprueba que el API esté en marcha y que EXPO_PUBLIC_API_URL sea correcto.`
          : '';
      setModalError(msg + hint);
      showToast('No se pudo guardar', msg + hint, 'error');
    } finally {
      setSaving(false);
    }
  }

  /** Sube archivo local al API; devuelve imagen_key */
  async function subirImagenAlServidor(idArtista: string, uri: string, mimeType?: string, fileName?: string) {
    const form = new FormData();
    const nombre =
      fileName || (uri.split('/').pop() ?? 'imagen.jpg').split('?')[0] || 'imagen.jpg';
    await appendImagenAlFormData(form, uri, nombre, mimeType ?? 'image/jpeg');
    const res = await fetch(`${API_URL}/api/artistas/${idArtista}/imagen`, { method: 'POST', body: form });
    const data = (await res.json()) as { error?: string; imagen_key?: string };
    if (!res.ok) {
      throw new Error(data.error || 'No se pudo subir la imagen');
    }
    return data;
  }

  /** Elige imagen: si aún no hay artista guardado, solo vista previa (se sube al pulsar Guardar). Si ya hay id, sube al momento. */
  async function elegirImagenFormulario() {
    if (imagenSubiendo) return;
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        showToast('Permisos', 'Se necesita acceso a la galería para elegir una imagen.', 'warning');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.85,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setImagenPreviewUri(asset.uri);
      if (!editing?.id_artista) {
        return;
      }
      setImagenSubiendo(true);
      try {
        const data = await subirImagenAlServidor(editing.id_artista, asset.uri, asset.mimeType ?? undefined, asset.fileName ?? undefined);
        if (data.imagen_key) {
          setEditing((prev) => (prev ? { ...prev, imagen_key: data.imagen_key } : prev));
        }
        setImagenPreviewUri(null);
        showToast('OK', 'Imagen guardada', 'success');
        fetchLista();
      } catch (e) {
        setImagenPreviewUri(null);
        showToast('Error', e instanceof Error ? e.message : 'No se pudo subir', 'error');
      } finally {
        setImagenSubiendo(false);
      }
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'No se pudo procesar la imagen', 'error');
    }
  }

  const solicitarBorrado = useCallback((item: Artista) => {
    setArtistaToDelete(item);
    setConfirmDeleteVisible(true);
  }, []);

  const cancelarBorrado = useCallback(() => {
    if (!deleting) {
      setConfirmDeleteVisible(false);
      setArtistaToDelete(null);
    }
  }, [deleting]);

  const confirmarBorrado = useCallback(async () => {
    if (!artistaToDelete?.id_artista) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_URL}/api/artistas/${artistaToDelete.id_artista}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast('No se pudo borrar', (data as { error?: string }).error || `HTTP ${res.status}`, 'error');
        return;
      }
      showToast('Eliminado', 'El artista se ha eliminado.', 'success');
      setSelectedRowIndex(null);
      setConfirmDeleteVisible(false);
      setArtistaToDelete(null);
      fetchLista();
    } catch (e) {
      showToast('Error', e instanceof Error ? e.message : 'Error de red', 'error');
    } finally {
      setDeleting(false);
    }
  }, [artistaToDelete, fetchLista, showToast]);

  function toggleEstilo(e: string) {
    if (!editing) return;
    const cur = new Set(editing.estilos_musicales || []);
    if (cur.has(e)) cur.delete(e);
    else cur.add(e);
    setEditing({ ...editing, estilos_musicales: [...cur] });
  }

  function toggleTipo(e: string) {
    if (!editing) return;
    const cur = new Set(editing.tipo_artista || []);
    if (cur.has(e)) cur.delete(e);
    else cur.add(e);
    setEditing({ ...editing, tipo_artista: [...cur] });
  }

  return (
    <View style={styles.screenWrap}>
      {ToastView}
      <TablaBasica<Artista>
        title="Artistas"
        onBack={() => router.back()}
        columnas={[...COLUMNAS_TABLA]}
        datos={listaFiltrada}
        getValorCelda={getValorCeldaArtista}
        loading={loading}
        error={error}
        onRetry={fetchLista}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        onCrear={abrirNuevo}
        onEditar={(item) => abrirEditar(item)}
        onBorrar={(item) => solicitarBorrado(item)}
        guardando={saving || deleting}
        emptyMessage="No hay artistas. Pulsa crear para añadir uno."
        emptyFilterMessage="Ningún artista coincide con la búsqueda"
        defaultColWidth={100}
        getColumnCellStyle={(col) => {
          if (col === 'Nombre') return { cell: { minWidth: 160 } };
          if (col === 'Imagen') return { cell: { width: 56, minWidth: 52, maxWidth: 64 } };
          return undefined;
        }}
        renderCell={(item, col, _defaultText) => {
          if (col === 'Imagen') {
            if (!item.imagen_key) {
              return <Text style={styles.cellImagenDash}>—</Text>;
            }
            return (
              <TouchableOpacity
                onPress={() => abrirVistaImagenDesdeTabla(item)}
                style={styles.cellImagenBtn}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityRole="button"
                accessibilityLabel="Ver imagen del artista"
              >
                <MaterialIcons name="photo-camera" size={20} color="#0ea5e9" />
              </TouchableOpacity>
            );
          }
          if (col === 'Activo') {
            const on = item.activo !== false;
            return (
              <View style={[styles.badge, on ? styles.badgeActivo : styles.badgeInactivo]}>
                <Text style={[styles.badgeText, on ? styles.badgeTextActivo : styles.badgeTextInactivo]}>{on ? 'Activo' : 'Inactivo'}</Text>
              </View>
            );
          }
          return null;
        }}
        extraToolbarRight={
          <TouchableOpacity style={styles.refreshBtn} onPress={fetchLista} disabled={loading} accessibilityLabel="Refrescar">
            {loading ? <ActivityIndicator size="small" color="#0ea5e9" /> : <MaterialIcons name="refresh" size={ICON_SIZE} color="#0ea5e9" />}
          </TouchableOpacity>
        }
      />

      <Modal visible={modalOpen} animationType="fade" transparent onRequestClose={cerrarModal}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
        >
          <Pressable style={styles.modalBackdrop} onPress={cerrarModal} accessibilityLabel="Cerrar formulario" />
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editing?.id_artista ? 'Editar artista' : 'Nuevo artista'}</Text>
              <TouchableOpacity onPress={cerrarModal}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              <Text style={styles.label}>Nombre artístico *</Text>
              <TextInput
                style={[styles.input, modalError ? styles.inputError : undefined]}
                value={editing?.nombre_artistico || ''}
                onChangeText={(t) => {
                  setModalError(null);
                  editing && setEditing({ ...editing, nombre_artistico: t });
                }}
                placeholder="Nombre o grupo"
              />
              <Text style={styles.label}>Componentes</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={String(editing?.componentes ?? 1)}
                onChangeText={(t) => editing && setEditing({ ...editing, componentes: parseInt(t, 10) || 1 })}
              />
              <Text style={styles.label}>Estilos musicales</Text>
              <TouchableOpacity
                style={styles.selectField}
                onPress={() => setPickerEstilosOpen(true)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Abrir lista de estilos musicales"
              >
                <Text
                  style={[styles.selectFieldText, !(editing?.estilos_musicales?.length) && styles.selectFieldPlaceholder]}
                  numberOfLines={3}
                >
                  {resumenSeleccion(editing?.estilos_musicales, 'Seleccionar estilos…')}
                </Text>
                <MaterialIcons name="arrow-drop-down" size={24} color="#64748b" />
              </TouchableOpacity>
              <Text style={styles.label}>Tipo artista</Text>
              <TouchableOpacity
                style={styles.selectField}
                onPress={() => setPickerTipoOpen(true)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Abrir lista de tipo de artista"
              >
                <Text
                  style={[styles.selectFieldText, !(editing?.tipo_artista?.length) && styles.selectFieldPlaceholder]}
                  numberOfLines={3}
                >
                  {resumenSeleccion(editing?.tipo_artista, 'Seleccionar tipos…')}
                </Text>
                <MaterialIcons name="arrow-drop-down" size={24} color="#64748b" />
              </TouchableOpacity>
              <View style={styles.rowBetween}>
                <Text style={styles.label}>Activo</Text>
                <Switch
                  value={editing?.activo !== false}
                  onValueChange={(v) => {
                    if (editing) setEditing({ ...editing, activo: v });
                  }}
                />
              </View>
              <Text style={styles.label}>Teléfono</Text>
              <TextInput
                style={styles.input}
                value={editing?.telefono_contacto || ''}
                onChangeText={(t) => editing && setEditing({ ...editing, telefono_contacto: t })}
                keyboardType="phone-pad"
              />
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={editing?.email_contacto || ''}
                onChangeText={(t) => editing && setEditing({ ...editing, email_contacto: t })}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Text style={styles.label}>Observaciones</Text>
              <TextInput
                style={[styles.input, { minHeight: 72 }]}
                multiline
                value={editing?.observaciones || ''}
                onChangeText={(t) => editing && setEditing({ ...editing, observaciones: t })}
              />

              <Text style={styles.label}>Imagen</Text>
              <View style={styles.imgSection}>
                <Text style={styles.imgStatus}>
                  {!editing?.id_artista
                    ? imagenPreviewUri
                      ? 'Vista previa lista. La imagen se subirá al pulsar «Guardar».'
                      : 'Puedes elegir una imagen; se subirá al crear el artista.'
                    : editing.imagen_key
                      ? 'Imagen guardada. Pulsa la foto para cambiarla.'
                      : 'Sin imagen en servidor. Pulsa el recuadro para elegir y subir.'}
                </Text>
                <Pressable
                  style={styles.imgPreviewTouchable}
                  onPress={() => !imagenSubiendo && elegirImagenFormulario()}
                  disabled={imagenSubiendo}
                  accessibilityRole="button"
                  accessibilityLabel="Elegir imagen del artista"
                >
                  {imagenPreviewUri ? (
                    <Image source={{ uri: imagenPreviewUri }} style={styles.imgPreview} resizeMode="cover" />
                  ) : imagenUrlServidorLoading ? (
                    <View style={styles.imgPreviewPlaceholder}>
                      <ActivityIndicator size="large" color="#0ea5e9" />
                      <Text style={styles.imgPreviewPlaceholderHint}>Cargando imagen…</Text>
                    </View>
                  ) : imagenUrlServidor ? (
                    <Image source={{ uri: imagenUrlServidor }} style={styles.imgPreview} resizeMode="cover" />
                  ) : editing?.imagen_key ? (
                    <View style={styles.imgPreviewPlaceholder}>
                      <MaterialIcons name="broken-image" size={40} color="#94a3b8" />
                      <Text style={styles.imgPreviewPlaceholderText}>No se pudo cargar la vista previa</Text>
                      <Text style={styles.imgPreviewPlaceholderHint}>Pulsa para sustituir</Text>
                    </View>
                  ) : (
                    <View style={styles.imgPreviewPlaceholder}>
                      <MaterialIcons name="add-photo-alternate" size={52} color="#94a3b8" />
                      <Text style={styles.imgPreviewPlaceholderText}>Toca para elegir imagen</Text>
                    </View>
                  )}
                  {imagenSubiendo ? (
                    <View style={styles.imgPreviewLoading}>
                      <ActivityIndicator size="large" color="#fff" />
                    </View>
                  ) : null}
                </Pressable>
                <Text style={styles.imgFormatHint}>
                  Formatos habituales: JPG, PNG, WebP. Si el artista aún no existe, la foto se sube al guardar.
                </Text>
              </View>

              <Text style={styles.label}>Tarifas (€)</Text>
              <View style={styles.tarifaHintBox}>
                <Text style={styles.tarifaHint}>
                  Tipo de día: festivo si aplica; si no, sábado/domingo = fin de semana; resto = laborable. Franjas: TARDE 12:00–22:59 (el tramo
                  09:31–11:59 se cobra como tarde). NOCHE 23:00–23:59 y 00:00–09:30.
                </Text>
              </View>
              <View style={styles.tarifaTable}>
                <View style={styles.tarifaTableRow}>
                  <View style={styles.tarifaTableCorner} />
                  {(['laborable', 'fin_semana', 'festivo'] as const).map((td) => (
                    <Text key={td} style={styles.tarifaTableHead}>
                      {td === 'laborable' ? 'Laborable' : td === 'fin_semana' ? 'Fin semana' : 'Festivo'}
                    </Text>
                  ))}
                </View>
                {(['tarde', 'noche'] as const).map((fr) => (
                  <View key={fr} style={[styles.tarifaTableRow, fr === 'noche' && styles.tarifaTableRowLast]}>
                    <View style={styles.tarifaFranjaLabel}>
                      <Text style={styles.tarifaFranjaTitle}>{fr === 'tarde' ? 'Tarde' : 'Noche'}</Text>
                    </View>
                    {(['laborable', 'fin_semana', 'festivo'] as const).map((td) => {
                      const cellKey = `${fr}-${td}`;
                      const imp = tarifas[fr][td];
                      const editingCell = focusedTarifa?.key === cellKey;
                      return (
                        <TextInput
                          key={cellKey}
                          style={styles.tarifaCellInput}
                          keyboardType="decimal-pad"
                          placeholder="0,00 €"
                          placeholderTextColor="#94a3b8"
                          value={
                            editingCell && focusedTarifa?.key === cellKey
                              ? focusedTarifa.text
                              : imp === 0
                                ? ''
                                : formatMoneda(imp)
                          }
                          onFocus={() => {
                            setFocusedTarifa({
                              key: cellKey,
                              text: numeroATextoTarifaEditable(imp),
                            });
                          }}
                          onChangeText={(t) => {
                            setFocusedTarifa({ key: cellKey, text: t });
                            const n = parseEuroInputToNumber(t);
                            setTarifas((prev) => ({
                              ...prev,
                              [fr]: { ...prev[fr], [td]: n },
                            }));
                          }}
                          onBlur={() => {
                            setFocusedTarifa(null);
                          }}
                        />
                      );
                    })}
                  </View>
                ))}
              </View>

              {modalError ? (
                <View style={styles.errorBanner}>
                  <MaterialIcons name="error-outline" size={18} color="#b91c1c" />
                  <Text style={styles.errorBannerText}>{modalError}</Text>
                </View>
              ) : null}

              <Pressable
                style={({ pressed }) => [styles.saveBtn, saving && styles.saveBtnDisabled, pressed && !saving && styles.saveBtnPressed]}
                onPress={() => guardar()}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Guardar artista"
              >
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Guardar</Text>}
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={vistaImagenOpen} transparent animationType="fade" onRequestClose={cerrarVistaImagen}>
        <View style={styles.vistaImagenOverlay}>
          <Pressable style={styles.vistaImagenBackdrop} onPress={cerrarVistaImagen} accessibilityLabel="Cerrar" />
          <View style={styles.vistaImagenCard} onStartShouldSetResponder={() => true}>
            <View style={styles.vistaImagenHeader}>
              <Text style={styles.vistaImagenTitle} numberOfLines={1}>
                {vistaImagenTitulo}
              </Text>
              <TouchableOpacity onPress={cerrarVistaImagen} accessibilityLabel="Cerrar">
                <MaterialIcons name="close" size={26} color="#fff" />
              </TouchableOpacity>
            </View>
            {vistaImagenLoading ? (
              <View style={styles.vistaImagenBody}>
                <ActivityIndicator size="large" color="#0ea5e9" />
              </View>
            ) : vistaImagenError ? (
              <View style={styles.vistaImagenBody}>
                <MaterialIcons name="error-outline" size={40} color="#f87171" />
                <Text style={styles.vistaImagenError}>{vistaImagenError}</Text>
              </View>
            ) : vistaImagenUrl ? (
              <View style={styles.vistaImagenImgWrap}>
                <Image source={{ uri: vistaImagenUrl }} style={styles.vistaImagenImg} resizeMode="contain" />
              </View>
            ) : (
              <View style={styles.vistaImagenBody}>
                <Text style={styles.vistaImagenError}>Sin imagen</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      <Modal visible={confirmDeleteVisible} transparent animationType="fade" onRequestClose={cancelarBorrado}>
        <Pressable style={styles.confirmOverlay} onPress={cancelarBorrado}>
          <Pressable style={styles.confirmCard} onPress={(e) => e.stopPropagation()}>
            <MaterialIcons name="warning" size={36} color="#f59e0b" style={{ alignSelf: 'center' }} />
            <Text style={styles.confirmTitle}>Eliminar artista</Text>
            <Text style={styles.confirmText}>
              ¿Eliminar <Text style={{ fontWeight: '700' }}>{artistaToDelete?.nombre_artistico || 'este artista'}</Text>? Esta acción no se puede deshacer.
            </Text>
            <View style={styles.confirmButtons}>
              <TouchableOpacity style={styles.confirmBtn} onPress={cancelarBorrado} disabled={deleting}>
                <Text style={styles.confirmBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, styles.confirmBtnDanger]} onPress={confirmarBorrado} disabled={deleting}>
                {deleting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.confirmBtnTextDanger}>Eliminar</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={pickerEstilosOpen} transparent animationType="fade" onRequestClose={() => setPickerEstilosOpen(false)}>
        <Pressable style={styles.dropdownOverlay} onPress={() => setPickerEstilosOpen(false)}>
          <View style={styles.dropdownCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.dropdownTitle}>Estilos musicales</Text>
            <Text style={styles.dropdownSubtitle}>Toca para marcar o desmarcar (orden alfabético)</Text>
            <ScrollView style={styles.dropdownList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {ESTILOS_OPTS_ORDEN.map((e) => {
                const on = (editing?.estilos_musicales || []).includes(e);
                return (
                  <TouchableOpacity
                    key={e}
                    style={[styles.dropdownRow, on && styles.dropdownRowOn]}
                    onPress={() => toggleEstilo(e)}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name={on ? 'check-box' : 'check-box-outline-blank'} size={22} color={on ? '#0ea5e9' : '#94a3b8'} />
                    <Text style={[styles.dropdownRowText, on && styles.dropdownRowTextOn]}>{e}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.dropdownDone} onPress={() => setPickerEstilosOpen(false)}>
              <Text style={styles.dropdownDoneText}>Listo</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={pickerTipoOpen} transparent animationType="fade" onRequestClose={() => setPickerTipoOpen(false)}>
        <Pressable style={styles.dropdownOverlay} onPress={() => setPickerTipoOpen(false)}>
          <View style={styles.dropdownCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.dropdownTitle}>Tipo de artista</Text>
            <Text style={styles.dropdownSubtitle}>Toca para marcar o desmarcar (orden alfabético)</Text>
            <ScrollView style={styles.dropdownList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {TIPO_OPTS_ORDEN.map((e) => {
                const on = (editing?.tipo_artista || []).includes(e);
                return (
                  <TouchableOpacity
                    key={e}
                    style={[styles.dropdownRow, on && styles.dropdownRowOn]}
                    onPress={() => toggleTipo(e)}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name={on ? 'check-box' : 'check-box-outline-blank'} size={22} color={on ? '#0ea5e9' : '#94a3b8'} />
                    <Text style={[styles.dropdownRowText, on && styles.dropdownRowTextOn]}>{e}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.dropdownDone} onPress={() => setPickerTipoOpen(false)}>
              <Text style={styles.dropdownDoneText}>Listo</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screenWrap: { flex: 1, backgroundColor: '#f8fafc' },
  cellImagenDash: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
  cellImagenBtn: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  vistaImagenOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  vistaImagenBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
  },
  vistaImagenCard: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    zIndex: 2,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1e293b',
  },
  vistaImagenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#0f172a',
  },
  vistaImagenTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: '#f8fafc', marginRight: 8 },
  vistaImagenBody: {
    minHeight: 180,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 12,
  },
  vistaImagenError: { color: '#fecaca', fontSize: 14, textAlign: 'center' },
  vistaImagenImgWrap: {
    width: '100%',
    backgroundColor: '#0f172a',
    alignItems: 'center',
  },
  vistaImagenImg: { width: '100%', height: 380, backgroundColor: '#0f172a' },
  refreshBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '600' },
  badgeActivo: { backgroundColor: '#dcfce7' },
  badgeInactivo: { backgroundColor: '#fee2e2' },
  badgeTextActivo: { color: '#16a34a' },
  badgeTextInactivo: { color: '#dc2626' },
  confirmOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    padding: 20,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 20,
  },
  confirmTitle: { fontSize: 17, fontWeight: '700', color: '#334155', textAlign: 'center', marginTop: 8 },
  confirmText: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 10, lineHeight: 20 },
  confirmButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 20 },
  confirmBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  confirmBtnDanger: { backgroundColor: '#dc2626', borderColor: '#dc2626' },
  confirmBtnText: { fontSize: 14, color: '#475569', fontWeight: '600' },
  confirmBtnTextDanger: { fontSize: 14, color: '#fff', fontWeight: '700' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '88%',
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingBottom: 16,
    overflow: 'hidden',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 12,
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#334155' },
  modalScroll: { padding: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4, marginTop: 10 },
  selectField: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    backgroundColor: '#f8fafc',
    gap: 6,
  },
  selectFieldText: { flex: 1, fontSize: 14, color: '#334155' },
  selectFieldPlaceholder: { color: '#94a3b8' },
  dropdownOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    padding: 20,
  },
  dropdownCard: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '70%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    overflow: 'hidden',
  },
  dropdownTitle: { fontSize: 17, fontWeight: '700', color: '#334155' },
  dropdownSubtitle: { fontSize: 11, color: '#64748b', marginTop: 4, marginBottom: 8 },
  dropdownList: { maxHeight: 320 },
  dropdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  dropdownRowOn: { backgroundColor: '#f0f9ff' },
  dropdownRowText: { flex: 1, fontSize: 14, color: '#334155' },
  dropdownRowTextOn: { fontWeight: '600', color: '#0369a1' },
  dropdownDone: {
    marginTop: 12,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dropdownDoneText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  imgSection: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#fafafa',
  },
  imgStatus: { fontSize: 13, color: '#475569', marginBottom: 8 },
  imgPreviewTouchable: {
    width: '100%',
    minHeight: 180,
    maxHeight: 220,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
  },
  imgPreview: { width: '100%', minHeight: 180, maxHeight: 220 },
  imgPreviewPlaceholder: {
    minHeight: 180,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    gap: 6,
  },
  imgPreviewPlaceholderText: { fontSize: 14, color: '#64748b', fontWeight: '600', textAlign: 'center' },
  imgPreviewPlaceholderHint: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
  imgPreviewLoading: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imgFormatHint: { fontSize: 11, color: '#94a3b8', marginTop: 8, lineHeight: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  tarifaHintBox: {
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  tarifaHint: { fontSize: 10, color: '#64748b', lineHeight: 14 },
  tarifaTable: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  tarifaTableRow: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  tarifaTableRowLast: { borderBottomWidth: 0 },
  tarifaTableCorner: { width: 72, minHeight: 36, borderRightWidth: 1, borderRightColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  tarifaTableHead: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    paddingVertical: 8,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    backgroundColor: '#f1f5f9',
  },
  tarifaFranjaLabel: {
    width: 72,
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  tarifaFranjaTitle: { fontSize: 12, fontWeight: '700', color: '#334155' },
  tarifaCellInput: {
    flex: 1,
    minWidth: 0,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    paddingHorizontal: 6,
    fontSize: 13,
    color: '#334155',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
    backgroundColor: '#fff',
  },
  saveBtn: { backgroundColor: '#0ea5e9', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 12 },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnPressed: { opacity: 0.85 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  inputError: { borderColor: '#f87171', backgroundColor: '#fff7ed' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorBannerText: { flex: 1, fontSize: 12, color: '#991b1b', lineHeight: 18 },
});
