import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
  TextInput,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { InputFecha } from '../components/InputFecha';
import { useAuth } from '../contexts/AuthContext';
import {
  MG_CUESTIONARIO,
  mgEstadoInicialRespuestas,
  mgMediasPorCategoria,
  mgMediaGlobalCategorias,
} from '../lib/mysteryGuestCuestionario';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';
const MG_MAX_FOTOS_PRODUCTO = 6;

/** Web: reduce tamaño de data URL para no disparar el límite de DynamoDB. */
function resizeDataUrlWeb(dataUrl: string, maxW: number): Promise<string> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = w > maxW ? maxW / w : 1;
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, cw, ch);
      resolve(c.toDataURL('image/jpeg', 0.65));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

type Local = {
  id_Locales?: string;
  nombre?: string;
  Nombre?: string;
  agoraCode?: string;
  AgoraCode?: string;
};

type ValoracionMg = {
  id_MisteryGuest?: string;
  Fecha?: string;
  LocalId?: string;
  /** Legado (antes del cuestionario por categorías). */
  Servicio?: number;
  Producto?: number;
  Limpieza?: number;
  Valoracion?: number;
  Respuestas?: Record<string, number>;
  ExperienciaGeneral?: number;
  MediasPorCategoria?: Record<string, number>;
  MediaGlobal?: number;
  /** Categoría Producto: hasta 6 imágenes (data URL o URL). */
  ProductoFotos?: string[];
  ProductoComentario?: string;
  ServicioComentario?: string;
  LimpiezaComentario?: string;
  AmbienteComentario?: string;
  UsuarioId?: string;
  UsuarioNombre?: string;
  /** Día civil de la visita (filtros); opcional en registros antiguos. */
  FechaDia?: string;
  Notas?: string;
  CreadoEn?: string;
};

function formatLlegada(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
    return d.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '—';
  }
}

/** Fecha/hora local en dd/mm/yyyy hh:mm (24 h). */
function dateToDmyHm(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${y} ${hh}:${mi}`;
}

function ahoraDmyHm(): string {
  return dateToDmyHm(new Date());
}

/** Parsea `dd/mm/yyyy hh:mm` a Date local. */
function parseDmyHm(s: string): Date | null {
  const t = s.trim().replace(/\s+/g, ' ');
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const y = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mi = parseInt(m[5], 10);
  if (y < 1900 || y > 2100) return null;
  if (d < 1 || d > 31 || mo < 0 || mo > 11) return null;
  if (hh < 0 || hh > 23 || mi < 0 || mi > 59) return null;
  const date = new Date(y, mo, d, hh, mi, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  return date;
}

function fechaVisitaToIso(s: string): string | null {
  const d = parseDmyHm(s);
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** YYYY-MM-DD del día civil de la visita (mismo criterio que el usuario ve en el formulario). */
function fechaVisitaDiaLocal(s: string): string | null {
  const d = parseDmyHm(s);
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Día de la semana en texto corto (tipo «ddd»), según la fecha/hora de la visita. */
function diaSemanaDdd(fechaForm: string): string {
  const d = parseDmyHm(fechaForm);
  if (!d) return '—';
  try {
    const raw = new Intl.DateTimeFormat('es-ES', { weekday: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'weekday')?.value;
    if (!raw) return '—';
    return raw.replace(/\./g, '').trim().toLowerCase();
  } catch {
    return d.toLocaleDateString('es-ES', { weekday: 'short' }).replace(/\./g, '').trim().toLowerCase();
  }
}

/** Muestra Fecha almacenada (ISO o solo yyyy-mm-dd) como dd/mm/yyyy hh:mm. */
function formatFechaVisitaStorage(raw: string | undefined): string {
  if (raw == null || raw === '') return '—';
  const u = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(u)) {
    const [y, mo, d] = u.split('-').map(Number);
    const dd = String(d).padStart(2, '0');
    const mm = String(mo).padStart(2, '0');
    return `${dd}/${mm}/${y} 00:00`;
  }
  try {
    const dt = new Date(u);
    if (Number.isNaN(dt.getTime())) return u.slice(0, 24);
    return dateToDmyHm(dt);
  } catch {
    return '—';
  }
}

function mesEnCurso(): { inicio: string; fin: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, '0');
  const ultimoDia = new Date(y, hoy.getMonth() + 1, 0).getDate();
  return {
    inicio: `${y}-${m}-01`,
    fin: `${y}-${m}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

function valorEnLocal(loc: Local, key: string): string | undefined {
  const k = Object.keys(loc).find((x) => x.toLowerCase() === key.toLowerCase());
  if (k == null) return undefined;
  const v = (loc as Record<string, unknown>)[k];
  return v != null ? String(v) : undefined;
}

function truncNotas(s: string, max = 48): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function StarRatingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <View style={styles.starRow}>
      <Text style={styles.starRowLabel} numberOfLines={2}>
        {label}
      </Text>
      <View style={styles.starsWrap}>
        {[1, 2, 3, 4, 5].map((n) => (
          <TouchableOpacity
            key={n}
            onPress={() => onChange(n)}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${n} de 5 estrellas`}
          >
            <MaterialIcons name={n <= value ? 'star' : 'star-border'} size={26} color={n <= value ? '#f59e0b' : '#cbd5e1'} />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const MG_COMENTARIO_H_MIN = 44;
const MG_COMENTARIO_H_MAX = 180;

type MgComentarioCatId = 'servicio' | 'producto' | 'limpieza' | 'ambiente';

const MG_COMENTARIO_LABELS: Record<MgComentarioCatId, { label: string; placeholder: string }> = {
  servicio: { label: 'Comentario sobre servicio', placeholder: 'Opcional…' },
  producto: { label: 'Comentario sobre el producto', placeholder: 'Observaciones sobre producto…' },
  limpieza: { label: 'Comentario sobre limpieza', placeholder: 'Opcional…' },
  ambiente: { label: 'Comentario sobre ambiente', placeholder: 'Opcional…' },
};

/** Multilínea compacta: crece con el texto hasta un máximo razonable. */
function MgComentarioCategoria({
  catId,
  value,
  onChangeText,
}: {
  catId: MgComentarioCatId;
  value: string;
  onChangeText: (t: string) => void;
}) {
  const { label, placeholder } = MG_COMENTARIO_LABELS[catId];
  const [contentH, setContentH] = useState(MG_COMENTARIO_H_MIN);
  const displayH = Math.min(MG_COMENTARIO_H_MAX, Math.max(MG_COMENTARIO_H_MIN, contentH));

  useEffect(() => {
    if (!value.trim()) setContentH(MG_COMENTARIO_H_MIN);
  }, [value]);

  return (
    <View style={styles.mgComentarioWrap}>
      <Text style={styles.formLabel}>{label}</Text>
      <TextInput
        style={[styles.mgCategoriaComentarioInput, { height: displayH }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        multiline
        textAlignVertical="top"
        scrollEnabled={contentH > MG_COMENTARIO_H_MAX}
        onContentSizeChange={(e) => {
          setContentH(e.nativeEvent.contentSize.height);
        }}
      />
    </View>
  );
}

/** Estrellas según la media global (solo lectura; coincide con la valoración guardada en servidor). */
function StarRowReadonly({ label, mediaGlobal }: { label: string; mediaGlobal: number }) {
  const n =
    Number.isFinite(mediaGlobal) && mediaGlobal > 0 ? Math.min(5, Math.max(1, Math.round(mediaGlobal))) : 0;
  return (
    <View style={styles.starRow}>
      <Text style={styles.starRowLabel} numberOfLines={3}>
        {label}
      </Text>
      <View style={styles.starsWrap} accessibilityRole="text" accessibilityLabel={`${label}: ${n} de 5 estrellas`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <MaterialIcons key={i} name={i <= n ? 'star' : 'star-border'} size={26} color={i <= n ? '#f59e0b' : '#cbd5e1'} />
        ))}
      </View>
    </View>
  );
}

/** Columnas Media / Exp.: ítems nuevos (cuestionario), o legado tres notas. */
function textoMediaYExp(v: ValoracionMg): { media: string; exp: string } {
  const exp = v.ExperienciaGeneral != null ? String(v.ExperienciaGeneral) : '—';
  if (v.MediaGlobal != null && v.MediaGlobal > 0) {
    return { media: String(v.MediaGlobal), exp };
  }
  if (v.MediasPorCategoria && Object.keys(v.MediasPorCategoria).length > 0) {
    const mg = mgMediaGlobalCategorias(v.MediasPorCategoria as Record<string, number>);
    if (mg > 0) return { media: String(mg), exp };
  }
  if (v.Respuestas && typeof v.Respuestas === 'object') {
    const medias = mgMediasPorCategoria(v.Respuestas as Record<string, number>);
    const mg = mgMediaGlobalCategorias(medias);
    if (mg > 0) return { media: String(mg), exp };
  }
  const s = v.Servicio;
  const p = v.Producto;
  const l = v.Limpieza;
  if (s != null && p != null && l != null) {
    const m = Math.round(((s + p + l) / 3) * 10) / 10;
    return { media: String(m), exp: '—' };
  }
  return { media: '—', exp };
}

export default function MysteryGuestScreen() {
  const router = useRouter();
  const { localPermitido, user } = useAuth();
  const rango = mesEnCurso();
  const [fechaDesde, setFechaDesde] = useState(rango.inicio);
  const [fechaHasta, setFechaHasta] = useState(rango.fin);
  const [locales, setLocales] = useState<Local[]>([]);
  const [loadingLocales, setLoadingLocales] = useState(true);
  const [localId, setLocalId] = useState('');
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);

  const [valoraciones, setValoraciones] = useState<ValoracionMg[]>([]);
  const [loadingLista, setLoadingLista] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [fechaForm, setFechaForm] = useState(() => ahoraDmyHm());
  const [localFormId, setLocalFormId] = useState('');
  const [respuestasForm, setRespuestasForm] = useState<Record<string, number>>(() => mgEstadoInicialRespuestas());
  const [productoFotos, setProductoFotos] = useState<string[]>([]);
  const [mgComentarios, setMgComentarios] = useState<Record<MgComentarioCatId, string>>({
    servicio: '',
    producto: '',
    limpieza: '',
    ambiente: '',
  });
  const [fotosProductoLoading, setFotosProductoLoading] = useState(false);
  const [notasForm, setNotasForm] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [guardandoForm, setGuardandoForm] = useState(false);
  const [formLocalDropdownOpen, setFormLocalDropdownOpen] = useState(false);

  const localesFiltrados = useMemo(() => {
    return locales.filter((l) =>
      localPermitido(String(valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '').trim())
    );
  }, [locales, localPermitido]);

  /** Orden alfabético por nombre (es), con desempate por id de local. */
  const localesOrdenados = useMemo(() => {
    return [...localesFiltrados].sort((a, b) => {
      const na = String(valorEnLocal(a, 'nombre') ?? valorEnLocal(a, 'Nombre') ?? '').trim();
      const nb = String(valorEnLocal(b, 'nombre') ?? valorEnLocal(b, 'Nombre') ?? '').trim();
      const cmp = na.localeCompare(nb, 'es', { sensitivity: 'base', numeric: true });
      if (cmp !== 0) return cmp;
      const ida = String(valorEnLocal(a, 'id_Locales') ?? '').trim();
      const idb = String(valorEnLocal(b, 'id_Locales') ?? '').trim();
      return ida.localeCompare(idb);
    });
  }, [localesFiltrados]);

  const nombrePorLocalId = useMemo(() => {
    const m: Record<string, string> = {};
    for (const loc of localesFiltrados) {
      const id = String(valorEnLocal(loc, 'id_Locales') ?? '').trim();
      const nom = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? id) || '—').trim();
      if (id) m[id] = nom;
    }
    return m;
  }, [localesFiltrados]);

  const etiquetaLocalSeleccionado = useMemo(() => {
    if (!localId) return 'Todos los locales';
    return nombrePorLocalId[localId] ?? localId;
  }, [localId, nombrePorLocalId]);

  const etiquetaLocalFormulario = useMemo(() => {
    if (!localFormId.trim()) return '— Seleccionar local —';
    return nombrePorLocalId[localFormId] ?? localFormId;
  }, [localFormId, nombrePorLocalId]);

  /** Nombre visible del usuario logueado (mismo criterio que se guarda en UsuarioNombre). */
  const textoUsuarioVisitante = useMemo(() => {
    if (!user) return '';
    const n = (user.Nombre || '').trim();
    if (n) return n;
    const e = (user.email || '').trim();
    if (e) return e;
    return String(user.id_usuario || '').trim();
  }, [user]);

  useEffect(() => {
    setLoadingLocales(true);
    fetch(`${API_URL}/api/locales`)
      .then((r) => r.json())
      .then((data: { locales?: Local[] }) => {
        setLocales(Array.isArray(data.locales) ? data.locales : []);
      })
      .catch(() => setLocales([]))
      .finally(() => setLoadingLocales(false));
  }, []);

  const buscar = useCallback(async () => {
    if (!fechaDesde || !fechaHasta) {
      setError('Indica fecha desde y hasta');
      return;
    }
    setError(null);
    setLoadingLista(true);
    try {
      const q = new URLSearchParams({
        fechaDesde,
        fechaHasta,
      });
      if (localId.trim()) q.set('localId', localId.trim());
      const res = await fetch(`${API_URL}/api/mystery-guest?${q.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al cargar');
        setValoraciones([]);
        return;
      }
      setValoraciones(Array.isArray(data.valoraciones) ? data.valoraciones : []);
    } catch {
      setError('No se pudo conectar con el servidor');
      setValoraciones([]);
    } finally {
      setLoadingLista(false);
    }
  }, [fechaDesde, fechaHasta, localId]);

  useEffect(() => {
    void buscar();
  }, [buscar]);

  const mediasFormPreview = useMemo(() => mgMediasPorCategoria(respuestasForm), [respuestasForm]);
  const mediaGlobalFormPreview = useMemo(() => mgMediaGlobalCategorias(mediasFormPreview), [mediasFormPreview]);

  const abrirFormulario = useCallback(() => {
    setFechaForm(ahoraDmyHm());
    setLocalFormId(localesOrdenados[0] ? String(valorEnLocal(localesOrdenados[0], 'id_Locales') ?? '').trim() : '');
    setRespuestasForm(mgEstadoInicialRespuestas());
    setProductoFotos([]);
    setMgComentarios({ servicio: '', producto: '', limpieza: '', ambiente: '' });
    setNotasForm('');
    setFormError(null);
    setFormOpen(true);
  }, [localesOrdenados]);

  const quitarFotoProducto = useCallback((index: number) => {
    setProductoFotos((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const agregarFotoProducto = useCallback(async () => {
    setFormError(null);
    if (Platform.OS === 'web') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = (ev) => {
        const fileList = (ev.target as HTMLInputElement).files;
        if (!fileList?.length) return;
        const files = Array.from(fileList);
        setFotosProductoLoading(true);
        void (async () => {
          try {
            const next: string[] = [];
            for (const f of files) {
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result as string);
                r.onerror = () => reject(new Error('lectura'));
                r.readAsDataURL(f);
              });
              next.push(await resizeDataUrlWeb(dataUrl, 900));
            }
            setProductoFotos((prev) => [...prev, ...next].slice(0, MG_MAX_FOTOS_PRODUCTO));
          } catch {
            setFormError('No se pudieron procesar algunas imágenes');
          } finally {
            setFotosProductoLoading(false);
          }
        })();
      };
      input.click();
      return;
    }
    if (productoFotos.length >= MG_MAX_FOTOS_PRODUCTO) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      setFormError('Se necesita permiso para acceder a la galería');
      return;
    }
    setFotosProductoLoading(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.65,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const uri = result.assets[0].uri;
      const manipulated = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: 900 } }],
        { compress: 0.55, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (manipulated.base64) {
        const dataUrl = `data:image/jpeg;base64,${manipulated.base64}`;
        setProductoFotos((prev) => (prev.length >= MG_MAX_FOTOS_PRODUCTO ? prev : [...prev, dataUrl]));
      }
    } catch {
      setFormError('No se pudo cargar la imagen');
    } finally {
      setFotosProductoLoading(false);
    }
  }, [productoFotos.length]);

  const enviarValoracion = useCallback(async () => {
    setFormError(null);
    const fechaIso = fechaVisitaToIso(fechaForm);
    const fechaDia = fechaVisitaDiaLocal(fechaForm);
    if (!fechaIso || !fechaDia) {
      setFormError('Indica fecha y hora válidas (dd/mm/aaaa hh:mm)');
      return;
    }
    if (!localFormId.trim()) {
      setFormError('Selecciona un local');
      return;
    }
    setGuardandoForm(true);
    try {
      const res = await fetch(`${API_URL}/api/mystery-guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Fecha: fechaIso,
          FechaDia: fechaDia,
          LocalId: localFormId.trim(),
          Respuestas: respuestasForm,
          ...(productoFotos.length > 0 ? { ProductoFotos: productoFotos } : {}),
          ...(mgComentarios.producto.trim() ? { ProductoComentario: mgComentarios.producto.trim() } : {}),
          ...(mgComentarios.servicio.trim() ? { ServicioComentario: mgComentarios.servicio.trim() } : {}),
          ...(mgComentarios.limpieza.trim() ? { LimpiezaComentario: mgComentarios.limpieza.trim() } : {}),
          ...(mgComentarios.ambiente.trim() ? { AmbienteComentario: mgComentarios.ambiente.trim() } : {}),
          ...(notasForm.trim() ? { Notas: notasForm.trim() } : {}),
          ...(user?.id_usuario ? { UsuarioId: String(user.id_usuario).trim() } : {}),
          ...(textoUsuarioVisitante ? { UsuarioNombre: textoUsuarioVisitante.slice(0, 256) } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || 'No se pudo guardar');
        return;
      }
      setFormOpen(false);
      await buscar();
    } catch {
      setFormError('No se pudo conectar con el servidor');
    } finally {
      setGuardandoForm(false);
    }
  }, [fechaForm, localFormId, respuestasForm, productoFotos, mgComentarios, notasForm, buscar, user, textoUsuarioVisitante]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Mystery Guest</Text>
      </View>

      <Text style={styles.intro}>
        Cuestionario por categorías (Servicio, Producto, Limpieza, Ambiente) con estrellas, media por grupo y valoración
        general de la experiencia. La tabla muestra los registros en orden de llegada. Filtra por fechas y, si quieres, por
        local.
      </Text>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Filtros</Text>
        <View style={styles.filaFechas}>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Desde</Text>
            <InputFecha
              value={fechaDesde}
              onChange={setFechaDesde}
              format="iso"
              placeholder="YYYY-MM-DD"
              style={styles.formInput}
            />
          </View>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Hasta</Text>
            <InputFecha
              value={fechaHasta}
              onChange={setFechaHasta}
              format="iso"
              placeholder="YYYY-MM-DD"
              style={styles.formInput}
            />
          </View>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Local</Text>
          {Platform.OS === 'web' ? (
            <select
              value={localId}
              onChange={(e) => setLocalId(e.target.value)}
              style={styles.selectNative as object}
            >
              <option value="">Todos los locales</option>
              {localesOrdenados.map((loc) => {
                const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? '').trim();
                const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                return (
                  <option key={idLoc || nombre} value={idLoc}>
                    {nombre || idLoc || '—'}
                  </option>
                );
              })}
            </select>
          ) : (
            <>
              <TouchableOpacity style={styles.selectTouchable} onPress={() => setLocalDropdownOpen(true)}>
                <Text style={[styles.selectTouchableText, !localId && styles.selectPlaceholder]} numberOfLines={1}>
                  {loadingLocales ? 'Cargando…' : etiquetaLocalSeleccionado}
                </Text>
                <MaterialIcons name="arrow-drop-down" size={24} color="#64748b" />
              </TouchableOpacity>
              <Modal visible={localDropdownOpen} transparent animationType="fade">
                <Pressable style={styles.modalOverlay} onPress={() => setLocalDropdownOpen(false)}>
                  <View style={styles.dropdownCard}>
                    <ScrollView keyboardShouldPersistTaps="handled">
                      <TouchableOpacity
                        style={styles.dropdownItem}
                        onPress={() => {
                          setLocalId('');
                          setLocalDropdownOpen(false);
                        }}
                      >
                        <Text style={styles.dropdownItemText}>Todos los locales</Text>
                      </TouchableOpacity>
                      {localesOrdenados.map((loc) => {
                        const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? '').trim();
                        const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                        return (
                          <TouchableOpacity
                            key={idLoc || nombre}
                            style={[styles.dropdownItem, localId === idLoc && styles.dropdownItemActive]}
                            onPress={() => {
                              setLocalId(idLoc);
                              setLocalDropdownOpen(false);
                            }}
                          >
                            <Text style={[styles.dropdownItemText, localId === idLoc && styles.dropdownItemTextActive]}>
                              {nombre || idLoc || '—'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                </Pressable>
              </Modal>
            </>
          )}
        </View>

        <View style={styles.botonesRow}>
          <TouchableOpacity style={styles.btnPrimary} onPress={buscar} disabled={loadingLista}>
            {loadingLista ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="search" size={20} color="#fff" />
            )}
            <Text style={styles.btnPrimaryText}>Buscar valoraciones</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnGhost} onPress={buscar} disabled={loadingLista}>
            <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
            <Text style={styles.btnGhostText}>Refrescar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.btnGhost}
            onPress={abrirFormulario}
            disabled={loadingLocales || localesFiltrados.length === 0}
          >
            <MaterialIcons name="add" size={20} color="#0ea5e9" />
            <Text style={styles.btnGhostText}>Nueva valoración</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.displayPanel}>
        <Text style={styles.displayTitle}>Registros (orden de llegada)</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {!loadingLista && !error && valoraciones.length === 0 ? (
          <Text style={styles.vacio}>
            No hay valoraciones en este rango. Pulsa «Nueva valoración» o ajusta los filtros.
          </Text>
        ) : null}
        {loadingLista ? (
          <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 16 }} />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
            <View style={styles.table}>
              <View style={[styles.tableRow, styles.tableHeaderRow]}>
                <Text style={[styles.th, styles.colNum]}>#</Text>
                <Text style={[styles.th, styles.colLlegada]}>Llegada</Text>
                <Text style={[styles.th, styles.colVisitante]}>Visitante</Text>
                <Text style={[styles.th, styles.colFecha]}>Fecha visita</Text>
                <Text style={[styles.th, styles.colLocal]}>Local</Text>
                <Text style={[styles.th, styles.colPunt]}>Media</Text>
                <Text style={[styles.th, styles.colPunt]}>Exp.</Text>
                <Text style={[styles.th, styles.colFotosProd]}>Fotos</Text>
                <Text style={[styles.th, styles.colNotas]}>Notas</Text>
              </View>
              {valoraciones.map((v, idx) => {
                const id = String(v.id_MisteryGuest ?? '');
                const lid = String(v.LocalId ?? '').trim();
                const nomLocal = (nombrePorLocalId[lid] ?? lid) || '—';
                const { media, exp } = textoMediaYExp(v);
                const visitante =
                  (v.UsuarioNombre != null && String(v.UsuarioNombre).trim()) ||
                  (v.UsuarioId != null && String(v.UsuarioId).trim()) ||
                  '';
                return (
                  <View key={id || `${v.Fecha}-${lid}-${idx}`} style={[styles.tableRow, idx % 2 === 1 && styles.tableRowAlt]}>
                    <Text style={[styles.td, styles.colNum]}>{idx + 1}</Text>
                    <Text style={[styles.td, styles.colLlegada]}>{formatLlegada(v.CreadoEn)}</Text>
                    <Text style={[styles.td, styles.colVisitante]} numberOfLines={2}>
                      {visitante || '—'}
                    </Text>
                    <Text style={[styles.td, styles.colFecha]}>{formatFechaVisitaStorage(v.Fecha)}</Text>
                    <Text style={[styles.td, styles.colLocal]} numberOfLines={2}>
                      {nomLocal}
                    </Text>
                    <Text style={[styles.td, styles.colPunt]}>{media}</Text>
                    <Text style={[styles.td, styles.colPunt]}>{exp}</Text>
                    <Text style={[styles.td, styles.colFotosProd]}>
                      {Array.isArray(v.ProductoFotos) && v.ProductoFotos.length > 0 ? String(v.ProductoFotos.length) : '—'}
                    </Text>
                    <Text style={[styles.td, styles.colNotas]} numberOfLines={3}>
                      {v.Notas ? truncNotas(v.Notas) : '—'}
                    </Text>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>

      <Modal visible={formOpen} animationType="fade" transparent onRequestClose={() => setFormOpen(false)}>
        <View style={styles.formOverlay}>
          <Pressable style={styles.formBackdrop} onPress={() => !guardandoForm && setFormOpen(false)} />
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Nueva valoración</Text>
            <Text style={styles.formHint}>
              Estrellas por pregunta (estilo reseñas). Se calcula la media por categoría y la media global; al final, la
              experiencia general.
            </Text>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={styles.formScroll}
              contentContainerStyle={styles.formScrollContent}
            >
              <View style={styles.formModalVisitanteBlock}>
                <Text style={styles.formLabel}>Visitante</Text>
                <TextInput
                  editable={false}
                  style={[styles.formModalInput, styles.formModalInputReadonly, styles.formModalVisitanteInput]}
                  value={textoUsuarioVisitante || '—'}
                  placeholder="—"
                  placeholderTextColor="#94a3b8"
                />
              </View>
              <View style={styles.formModalFechaLocalRow}>
                <View style={styles.formModalFechaLocalCol}>
                  <Text style={styles.formLabel}>Fecha de la visita</Text>
                  <View style={styles.formModalDatetimeRow}>
                    <TextInput
                      editable={false}
                      style={[styles.formModalInput, styles.formModalDatetimeInput, styles.formModalInputReadonly]}
                      value={fechaForm}
                      placeholder="dd/mm/aaaa hh:mm"
                      placeholderTextColor="#94a3b8"
                    />
                    <View style={styles.formModalDiaSemanaBox} pointerEvents="none" accessibilityElementsHidden>
                      <Text style={styles.formModalDiaSemanaText}>{diaSemanaDdd(fechaForm)}</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.formModalFechaLocalCol}>
                  <Text style={styles.formLabel}>Local</Text>
                  {Platform.OS === 'web' ? (
                    <select
                      value={localFormId}
                      onChange={(e) => setLocalFormId(e.target.value)}
                      style={styles.formModalSelectNative as object}
                    >
                      <option value="">— Seleccionar —</option>
                      {localesOrdenados.map((loc) => {
                        const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? '').trim();
                        const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                        return (
                          <option key={idLoc || nombre} value={idLoc}>
                            {nombre || idLoc || '—'}
                          </option>
                        );
                      })}
                    </select>
                  ) : (
                    <>
                      <TouchableOpacity style={styles.formModalSelectTouchable} onPress={() => setFormLocalDropdownOpen(true)}>
                        <Text style={[styles.selectTouchableText, !localFormId && styles.selectPlaceholder]} numberOfLines={1}>
                          {etiquetaLocalFormulario}
                        </Text>
                        <MaterialIcons name="arrow-drop-down" size={24} color="#64748b" />
                      </TouchableOpacity>
                      <Modal visible={formLocalDropdownOpen} transparent animationType="fade">
                        <Pressable style={styles.modalOverlay} onPress={() => setFormLocalDropdownOpen(false)}>
                          <View style={styles.dropdownCard}>
                            <ScrollView keyboardShouldPersistTaps="handled">
                              {localesOrdenados.map((loc) => {
                                const idLoc = String(valorEnLocal(loc, 'id_Locales') ?? '').trim();
                                const nombre = String((valorEnLocal(loc, 'nombre') ?? valorEnLocal(loc, 'Nombre') ?? idLoc) || '—').trim();
                                return (
                                  <TouchableOpacity
                                    key={idLoc || nombre}
                                    style={[styles.dropdownItem, localFormId === idLoc && styles.dropdownItemActive]}
                                    onPress={() => {
                                      setLocalFormId(idLoc);
                                      setFormLocalDropdownOpen(false);
                                    }}
                                  >
                                    <Text style={[styles.dropdownItemText, localFormId === idLoc && styles.dropdownItemTextActive]}>
                                      {nombre || idLoc || '—'}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </ScrollView>
                          </View>
                        </Pressable>
                      </Modal>
                    </>
                  )}
                </View>
              </View>
              {MG_CUESTIONARIO.map((cat) => (
                <View key={cat.id} style={styles.mgCategoryBlock}>
                  <View style={styles.mgCategoryHeader}>
                    <Text style={styles.mgCategoryTitle}>{cat.nombre}</Text>
                    <Text style={styles.mgCategoryMedia}>
                      Media: {mediasFormPreview[cat.id]?.toFixed(1) ?? '—'} / 5
                    </Text>
                  </View>
                  {cat.preguntas.map((pr) => (
                    <StarRatingRow
                      key={pr.id}
                      label={pr.texto}
                      value={respuestasForm[pr.id] ?? 3}
                      onChange={(n) => setRespuestasForm((prev) => ({ ...prev, [pr.id]: n }))}
                    />
                  ))}
                  {cat.id === 'servicio' || cat.id === 'limpieza' || cat.id === 'ambiente' ? (
                    <MgComentarioCategoria
                      catId={cat.id}
                      value={mgComentarios[cat.id]}
                      onChangeText={(t) => setMgComentarios((prev) => ({ ...prev, [cat.id]: t }))}
                    />
                  ) : null}
                  {cat.id === 'producto' ? (
                    <View style={styles.mgProductoExtra}>
                      <Text style={styles.formLabel}>Fotos del producto (máx. {MG_MAX_FOTOS_PRODUCTO})</Text>
                      <View style={styles.mgFotoGrid}>
                        {productoFotos.map((uri, fi) => (
                          <View key={`mg-foto-${fi}`} style={styles.mgFotoSlot}>
                            <Image source={{ uri }} style={styles.mgFotoThumb} />
                            <TouchableOpacity
                              style={styles.mgFotoRemove}
                              onPress={() => quitarFotoProducto(fi)}
                              accessibilityLabel="Quitar foto"
                            >
                              <MaterialIcons name="close" size={14} color="#fff" />
                            </TouchableOpacity>
                          </View>
                        ))}
                        {productoFotos.length < MG_MAX_FOTOS_PRODUCTO ? (
                          <TouchableOpacity
                            style={styles.mgFotoAdd}
                            onPress={agregarFotoProducto}
                            disabled={fotosProductoLoading || guardandoForm}
                            accessibilityLabel="Añadir foto"
                          >
                            {fotosProductoLoading ? (
                              <ActivityIndicator size="small" color="#0ea5e9" />
                            ) : (
                              <MaterialIcons name="add-a-photo" size={22} color="#0ea5e9" />
                            )}
                          </TouchableOpacity>
                        ) : null}
                      </View>
                      <MgComentarioCategoria
                        catId="producto"
                        value={mgComentarios.producto}
                        onChangeText={(t) => setMgComentarios((prev) => ({ ...prev, producto: t }))}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
              <View style={styles.mgResumenGlobal}>
                <Text style={styles.mgResumenGlobalLabel}>Media global (categorías)</Text>
                <Text style={styles.mgResumenGlobalValue}>{mediaGlobalFormPreview.toFixed(1)} / 5</Text>
              </View>
              <View style={styles.mgExperienciaBlock}>
                <Text style={styles.formLabel}>Valoración general de la experiencia</Text>
                <Text style={styles.mgExperienciaHint}>
                  Refleja la media global ({mediaGlobalFormPreview.toFixed(1)}); se guarda igual que las estrellas
                  mostradas.
                </Text>
                <StarRowReadonly
                  label="¿Cómo valoras tu experiencia en conjunto?"
                  mediaGlobal={mediaGlobalFormPreview}
                />
              </View>
              <Text style={styles.formLabel}>Notas (opcional)</Text>
              <TextInput
                style={styles.formTextarea}
                value={notasForm}
                onChangeText={setNotasForm}
                placeholder="Comentarios…"
                placeholderTextColor="#94a3b8"
                multiline
                numberOfLines={3}
              />
              {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
            </ScrollView>
            <View style={styles.formActions}>
              <TouchableOpacity
                style={styles.btnGhost}
                onPress={() => !guardandoForm && setFormOpen(false)}
                disabled={guardandoForm}
              >
                <Text style={styles.btnGhostText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnPrimary} onPress={enviarValoracion} disabled={guardandoForm}>
                {guardandoForm ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.btnPrimaryText}>Guardar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: '#f8fafc' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  intro: { fontSize: 13, color: '#64748b', marginBottom: 14, lineHeight: 18 },
  panel: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 12,
  },
  panelTitle: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  filaFechas: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  formGroup: { flex: 1, minWidth: 120, marginBottom: 10 },
  formLabel: { fontSize: 11, fontWeight: '500', color: '#64748b', marginBottom: 4 },
  formInput: {
    fontSize: 12,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    backgroundColor: '#fff',
    color: '#334155',
  },
  selectNative: {
    width: '100%',
    maxWidth: '100%',
    fontSize: 12,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    backgroundColor: '#fff',
    color: '#334155',
  },
  selectTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  selectTouchableText: { fontSize: 12, color: '#334155', flex: 1 },
  selectPlaceholder: { color: '#94a3b8' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.35)',
    justifyContent: 'center',
    padding: 24,
  },
  dropdownCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    maxHeight: 280,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  dropdownItem: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  dropdownItemActive: { backgroundColor: '#e0f2fe' },
  dropdownItemText: { fontSize: 13, color: '#334155' },
  dropdownItemTextActive: { fontWeight: '600', color: '#0369a1' },
  botonesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnGhost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  btnGhostText: { color: '#0284c7', fontWeight: '600', fontSize: 13 },
  displayPanel: {
    flex: 1,
    minHeight: 200,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  displayTitle: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 },
  errorText: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  vacio: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', lineHeight: 20 },
  tableScroll: { maxHeight: 520 },
  table: { minWidth: 900, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  tableHeaderRow: { backgroundColor: '#f1f5f9', borderBottomColor: '#e2e8f0' },
  tableRowAlt: { backgroundColor: '#fafafa' },
  th: { fontSize: 11, fontWeight: '700', color: '#475569', paddingVertical: 8, paddingHorizontal: 6 },
  td: { fontSize: 11, color: '#334155', paddingVertical: 8, paddingHorizontal: 6 },
  colNum: { width: 36, textAlign: 'center' },
  colLlegada: { width: 128, flexShrink: 0 },
  colVisitante: { width: 112, flexShrink: 0, maxWidth: 140 },
  colFecha: { width: 132, flexShrink: 0 },
  colLocal: { flex: 1, minWidth: 100 },
  colPunt: { width: 40, textAlign: 'center', flexShrink: 0 },
  colFotosProd: { width: 44, textAlign: 'center', flexShrink: 0 },
  colNotas: { flex: 1, minWidth: 120 },
  formOverlay: { flex: 1, justifyContent: 'center', padding: 16, backgroundColor: 'rgba(15,23,42,0.45)' },
  formBackdrop: { ...StyleSheet.absoluteFillObject },
  formCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    maxHeight: '90%' as never,
    maxWidth: 440,
    width: '100%' as never,
    alignSelf: 'center',
  },
  formTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  formHint: { fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 18 },
  formScroll: { maxHeight: 520 },
  /** Hueco respecto a la barra vertical del scroll (evita solaparse con la 5.ª estrella). */
  formScrollContent: {
    paddingBottom: 8,
    paddingRight: Platform.OS === 'web' ? 22 : 14,
  },
  /** Altura alineada entre fecha/hora y selector de local en el modal «Nueva valoración». */
  formModalInput: {
    fontSize: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    backgroundColor: '#fff',
    color: '#334155',
    minHeight: 44,
  },
  formModalVisitanteBlock: { width: '100%', marginBottom: 10 },
  formModalVisitanteInput: { width: '100%' as never, maxWidth: '100%' as never },
  formModalFechaLocalRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start', marginBottom: 4 },
  formModalFechaLocalCol: { flex: 1, minWidth: 140 },
  formModalInputReadonly: { backgroundColor: '#f1f5f9', color: '#475569' },
  formModalDatetimeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  formModalDatetimeInput: { flex: 1, minWidth: 0 },
  /** Mismo tamaño que el antiguo botón del calendario: solo texto del día (no interactivo). */
  formModalDiaSemanaBox: {
    width: 44,
    height: 44,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  formModalDiaSemanaText: { fontSize: 12, fontWeight: '700', color: '#0369a1', textTransform: 'lowercase' },
  formModalSelectNative: {
    width: '100%',
    maxWidth: '100%',
    fontSize: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    backgroundColor: '#fff',
    color: '#334155',
    minHeight: 44,
    boxSizing: 'border-box' as never,
  },
  formModalSelectTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#fff',
    minHeight: 44,
  },
  formTextarea: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    color: '#334155',
    minHeight: 72,
    textAlignVertical: 'top',
  },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  mgCategoryBlock: {
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  mgCategoryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  mgCategoryTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  mgCategoryMedia: { fontSize: 11, fontWeight: '600', color: '#0369a1' },
  starRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 },
  starRowLabel: { flex: 1, fontSize: 12, color: '#475569', paddingRight: 8 },
  starsWrap: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  mgResumenGlobal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    marginBottom: 12,
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  mgResumenGlobalLabel: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  mgResumenGlobalValue: { fontSize: 16, fontWeight: '800', color: '#0c4a6e' },
  mgExperienciaBlock: { marginBottom: 8 },
  mgExperienciaHint: { fontSize: 11, color: '#94a3b8', marginBottom: 8, lineHeight: 16 },
  mgProductoExtra: { marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  mgFotoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  mgFotoSlot: { width: 56, height: 56, borderRadius: 6, overflow: 'hidden', position: 'relative' as const },
  mgFotoThumb: { width: '100%', height: '100%' },
  mgFotoRemove: {
    position: 'absolute',
    top: 1,
    right: 1,
    backgroundColor: 'rgba(15,23,42,0.65)',
    borderRadius: 10,
    padding: 1,
  },
  mgFotoAdd: {
    width: 56,
    height: 56,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderStyle: 'dashed',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mgComentarioWrap: { marginTop: 10 },
  mgCategoriaComentarioInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    color: '#334155',
    textAlignVertical: 'top',
  },
});
