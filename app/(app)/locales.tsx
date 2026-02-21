import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
  Image,
  useWindowDimensions,
  type ImageStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { MaterialIcons } from '@expo/vector-icons';
import { ICONS, ICON_SIZE } from '../constants/icons';
import { formatId6 } from '../utils/idFormat';

const MAX_IMAGEN_BASE64_LENGTH = 380000;

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const THUMBNAIL_COL_WIDTH = 72;
const MAX_TEXT_LENGTH = 30;

const COL_THUMBNAIL = '_thumbnail';

// Atributos exactos de la tabla igp_Locales en AWS (mismo orden que api/server.js TABLE_LOCALES_ATTRS).
const ATRIBUTOS_TABLA_LOCALES = ['id_Locales', 'Nombre', 'AgoraCode', 'Empresa', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Almacen origen', 'Sede', 'lat', 'lng', 'Imagen'] as const;

const ORDEN_COLUMNAS = [...ATRIBUTOS_TABLA_LOCALES];

const CAMPOS_FORM: { key: (typeof ATRIBUTOS_TABLA_LOCALES)[number]; label: string }[] = [
  { key: 'Nombre', label: 'Nombre' },
  { key: 'AgoraCode', label: 'AgoraCode' },
  { key: 'Empresa', label: 'Empresa' },
  { key: 'Direccion', label: 'Dirección' },
  { key: 'Cp', label: 'CP' },
  { key: 'Municipio', label: 'Municipio' },
  { key: 'Provincia', label: 'Provincia' },
  { key: 'Almacen origen', label: 'Almacén origen' },
  { key: 'Sede', label: 'Sede' },
  { key: 'lat', label: 'Lat' },
  { key: 'lng', label: 'Lng' },
  { key: 'Imagen', label: 'Imagen' },
];

const INITIAL_FORM = Object.fromEntries(CAMPOS_FORM.map((c) => [c.key, ''])) as Record<(typeof ATRIBUTOS_TABLA_LOCALES)[number], string>;

const SEDE_OPCIONES = ['Grupo Paripe'] as const;

const ALMACEN_SEPARATOR = ', ';

function parseAlmacenesOrigen(val: string | number | undefined): string[] {
  if (val == null || String(val).trim() === '') return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinAlmacenesOrigen(arr: string[]): string {
  return arr.filter(Boolean).join(ALMACEN_SEPARATOR);
}

type Local = Record<string, string | number | undefined>;

/** Ítem de igp_Empresas (API devuelve todos los atributos; puede incluir Sede/sede) */
type EmpresaItem = { id_empresa?: string; Nombre?: string; sede?: string; Sede?: string };

/** Ítem de igp_Almacenes (Id, Nombre, Descripcion, Direccion) */
type AlmacenItem = { Id?: string; Nombre?: string; Descripcion?: string; Direccion?: string };

type DireccionSuggestion = { description: string; place_id: string; lat?: number; lng?: number };

function truncar(val: string): string {
  if (val.length <= MAX_TEXT_LENGTH) return val;
  return val.slice(0, MAX_TEXT_LENGTH - 3) + '…';
}

export default function LocalesScreen() {
  const router = useRouter();
  const [locales, setLocales] = useState<Local[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [modalNuevoVisible, setModalNuevoVisible] = useState(false);
  const [editingLocalId, setEditingLocalId] = useState<string | null>(null);
  const [formNuevo, setFormNuevo] = useState<Record<string, string>>(INITIAL_FORM);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [direccionSuggestions, setDireccionSuggestions] = useState<DireccionSuggestion[]>([]);
  const [direccionConfigOk, setDireccionConfigOk] = useState<boolean | null>(null);
  const [direccionLoading, setDireccionLoading] = useState(false);
  const [direccionDropdownOpen, setDireccionDropdownOpen] = useState(false);
  const [sedeDropdownOpen, setSedeDropdownOpen] = useState(false);
  const [sedeSearchFilter, setSedeSearchFilter] = useState('');
  const [empresaDropdownOpen, setEmpresaDropdownOpen] = useState(false);
  const [empresaSearchFilter, setEmpresaSearchFilter] = useState('');
  const [empresasGrupoParipe, setEmpresasGrupoParipe] = useState<EmpresaItem[]>([]);
  const [almacenDropdownOpen, setAlmacenDropdownOpen] = useState(false);
  const [almacenSearchFilter, setAlmacenSearchFilter] = useState('');
  const [almacenes, setAlmacenes] = useState<AlmacenItem[]>([]);
  const [imagenLoading, setImagenLoading] = useState(false);
  const [modalCrearEmpresaVisible, setModalCrearEmpresaVisible] = useState(false);
  const [formCrearEmpresa, setFormCrearEmpresa] = useState({ Nombre: '', Cif: '' });
  const [guardandoCrearEmpresa, setGuardandoCrearEmpresa] = useState(false);
  const [errorCrearEmpresa, setErrorCrearEmpresa] = useState<string | null>(null);
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);
  const direccionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const abrirModalNuevo = () => {
    setEditingLocalId(null);
    setFormNuevo(INITIAL_FORM);
    setDireccionSuggestions([]);
    setDireccionConfigOk(null);
    setDireccionDropdownOpen(false);
    setSedeDropdownOpen(false);
    setSedeSearchFilter('');
    setEmpresaDropdownOpen(false);
    setEmpresaSearchFilter('');
    setAlmacenDropdownOpen(false);
    setAlmacenSearchFilter('');
    setModalNuevoVisible(true);
    setErrorForm(null);
  };
  const valorEnLocal = useCallback((local: Local, key: string) => {
    if (local[key] !== undefined && local[key] !== null) return local[key];
    const found = Object.keys(local).find((k) => k.toLowerCase() === key.toLowerCase());
    return found != null ? local[found] : undefined;
  }, []);

  const abrirModalEditar = (local: Local) => {
    const form: Record<string, string> = { ...INITIAL_FORM };
    for (const key of CAMPOS_FORM.map((c) => c.key)) {
      const v = valorEnLocal(local, key);
      form[key] = v != null ? String(v) : '';
    }
    setFormNuevo(form);
    const idVal = valorEnLocal(local, 'id_Locales');
    setEditingLocalId(idVal != null ? String(idVal) : null);
    setDireccionSuggestions([]);
    setDireccionConfigOk(null);
    setDireccionDropdownOpen(false);
    setSedeDropdownOpen(false);
    setSedeSearchFilter('');
    setEmpresaDropdownOpen(false);
    setEmpresaSearchFilter('');
    setAlmacenDropdownOpen(false);
    setAlmacenSearchFilter('');
    setModalNuevoVisible(true);
    setErrorForm(null);
  };
  const sedesFiltradasParaDropdown = useMemo(() => {
    const q = sedeSearchFilter.trim().toLowerCase();
    const list = !q ? [...SEDE_OPCIONES] : SEDE_OPCIONES.filter((s) => s.toLowerCase().includes(q));
    return [...list].sort((a, b) => a.localeCompare(b));
  }, [sedeSearchFilter]);
  const cerrarModalNuevo = () => {
    setModalNuevoVisible(false);
    setFormNuevo(INITIAL_FORM);
    setEditingLocalId(null);
    setDireccionSuggestions([]);
    setDireccionConfigOk(null);
    setDireccionDropdownOpen(false);
    setSedeDropdownOpen(false);
    setSedeSearchFilter('');
    setEmpresaDropdownOpen(false);
    setEmpresaSearchFilter('');
    setAlmacenDropdownOpen(false);
    setAlmacenSearchFilter('');
    setErrorForm(null);
  };

  const almacenesFiltradosParaDropdown = useMemo(() => {
    const q = almacenSearchFilter.trim().toLowerCase().replace(/\s+/g, ' ');
    const list = !q ? almacenes : almacenes.filter((a) => {
      const n = (a.Nombre ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const id = (a.Id ?? '').toLowerCase().trim();
      const qParts = q.split(/\s+/).filter(Boolean);
      const matchNombre = qParts.length === 0 ? true : qParts.every((part) => n.includes(part));
      const matchId = id.includes(q);
      return matchNombre || matchId;
    });
    return [...list].sort((a, b) => {
      const na = (a.Nombre ?? a.Id ?? '').toLowerCase();
      const nb = (b.Nombre ?? b.Id ?? '').toLowerCase();
      return na.localeCompare(nb);
    });
  }, [almacenes, almacenSearchFilter]);

  const empresasFiltradasParaDropdown = useMemo(() => {
    const q = empresaSearchFilter.trim().toLowerCase().replace(/\s+/g, ' ');
    const list = !q ? empresasGrupoParipe : empresasGrupoParipe.filter((e) => {
      const n = (e.Nombre ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const id = (e.id_empresa ?? '').toLowerCase().trim();
      const qParts = q.split(/\s+/).filter(Boolean);
      const matchNombre = qParts.length === 0 ? true : qParts.every((part) => n.includes(part));
      const matchId = id.includes(q);
      return matchNombre || matchId;
    });
    return [...list].sort((a, b) => {
      const na = (a.Nombre ?? a.id_empresa ?? '').toLowerCase();
      const nb = (b.Nombre ?? b.id_empresa ?? '').toLowerCase();
      return na.localeCompare(nb);
    });
  }, [empresasGrupoParipe, empresaSearchFilter]);

  const fetchDireccionSuggestions = useCallback((input: string) => {
    if (input.trim().length < 2) {
      setDireccionSuggestions([]);
      return;
    }
    setDireccionLoading(true);
    fetch(`${API_URL}/api/places/autocomplete?input=${encodeURIComponent(input.trim())}`)
      .then((res) => res.json())
      .then((data) => {
        setDireccionSuggestions(data.predictions || []);
        if (data.configOk === false) setDireccionConfigOk(false);
        else if (data.configOk === true) setDireccionConfigOk(true);
        else setDireccionConfigOk(null);
        setDireccionDropdownOpen(true);
      })
      .catch(() => {
        setDireccionSuggestions([]);
        setDireccionConfigOk(null);
      })
      .finally(() => setDireccionLoading(false));
  }, []);

  const onDireccionChange = useCallback(
    (text: string) => {
      setFormNuevo((prev) => ({ ...prev, Direccion: text }));
      if (direccionDebounceRef.current) clearTimeout(direccionDebounceRef.current);
      if (text.trim().length < 2) {
        setDireccionSuggestions([]);
        setDireccionDropdownOpen(false);
        return;
      }
      direccionDebounceRef.current = setTimeout(() => fetchDireccionSuggestions(text), 300);
    },
    [fetchDireccionSuggestions]
  );

  const onDireccionSelect = useCallback(
    (p: DireccionSuggestion) => {
      setDireccionDropdownOpen(false);
      setDireccionSuggestions([]);
      if (p.lat != null && p.lng != null) {
        setFormNuevo((prev) => ({
          ...prev,
          Direccion: p.description,
          lat: String(p.lat),
          lng: String(p.lng),
        }));
        return;
      }
      setFormNuevo((prev) => ({ ...prev, Direccion: p.description }));
      if (p.place_id) {
        fetch(`${API_URL}/api/places/details?place_id=${encodeURIComponent(p.place_id)}`)
          .then((res) => res.json())
          .then((data) => {
            if (data.lat != null && data.lng != null) {
              setFormNuevo((prev) => ({
                ...prev,
                lat: String(data.lat),
                lng: String(data.lng),
              }));
            }
          })
          .catch(() => {});
      }
    },
    []
  );

  const fetchCpAndFill = useCallback((cp: string) => {
    const normalized = cp?.trim().replace(/\s/g, '') || '';
    if (normalized.length !== 5 || !/^\d{5}$/.test(normalized)) return;
    fetch(`${API_URL}/api/codigo-postal?cp=${encodeURIComponent(normalized)}`)
      .then((r) => r.json())
      .then((data: { municipio?: string; provincia?: string }) => {
        const municipio = data.municipio?.trim() || '';
        const provincia = data.provincia?.trim() || '';
        if (municipio || provincia) {
          setFormNuevo((prev) => ({
            ...prev,
            Municipio: municipio || prev.Municipio,
            Provincia: provincia || prev.Provincia,
          }));
        }
      })
      .catch(() => {});
  }, []);

  const handleCpBlur = useCallback(() => {
    fetchCpAndFill(formNuevo.Cp ?? '');
  }, [formNuevo.Cp, fetchCpAndFill]);

  const handleCpChange = useCallback(
    (t: string) => {
      setFormNuevo((prev) => ({ ...prev, Cp: t }));
      const normalized = t.trim().replace(/\s/g, '');
      if (normalized.length === 5 && /^\d{5}$/.test(normalized)) fetchCpAndFill(normalized);
    },
    [fetchCpAndFill]
  );

  const seleccionarFoto = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        setErrorForm('Se necesita permiso para acceder a la galería');
        return;
      }
      setImagenLoading(true);
      setErrorForm(null);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]?.uri) {
        setImagenLoading(false);
        return;
      }
      const uri = result.assets[0].uri;
      let width = 800;
      let compress = 0.6;
      let manipulated = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width } }],
        { compress, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      while (manipulated.base64 && manipulated.base64.length > MAX_IMAGEN_BASE64_LENGTH && compress > 0.2) {
        compress -= 0.1;
        width = Math.round(width * 0.9);
        manipulated = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width } }],
          { compress, format: ImageManipulator.SaveFormat.JPEG, base64: true }
        );
      }
      if (manipulated.base64) {
        setFormNuevo((prev) => ({ ...prev, Imagen: `data:image/jpeg;base64,${manipulated.base64}` }));
      }
    } catch (e) {
      setErrorForm('No se pudo cargar la imagen');
    } finally {
      setImagenLoading(false);
    }
  }, []);

  const quitarFoto = useCallback(() => {
    setFormNuevo((prev) => ({ ...prev, Imagen: '' }));
  }, []);

  const ordenarPorId = useCallback((lista: Local[]) => {
    return [...lista].sort((a, b) => {
      const idA = valorEnLocal(a, 'id_Locales');
      const idB = valorEnLocal(b, 'id_Locales');
      const na = typeof idA === 'number' ? idA : parseInt(String(idA ?? 0).replace(/^0+/, ''), 10) || 0;
      const nb = typeof idB === 'number' ? idB : parseInt(String(idB ?? 0).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });
  }, [valorEnLocal]);

  const refetchLocales = useCallback(() => {
    fetch(`${API_URL}/api/locales`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setLocales(ordenarPorId(data.locales || []));
      })
      .catch((e) => setError(e.message || 'Error de conexión'));
  }, [ordenarPorId]);

  const guardarNuevo = async () => {
    const isEdit = editingLocalId != null;
    if (!formNuevo.Nombre?.trim()) {
      setErrorForm('Nombre es obligatorio');
      return;
    }
    setErrorForm(null);
    setGuardando(true);
    try {
      const body: Record<string, string | number> = {};
      for (const key of ATRIBUTOS_TABLA_LOCALES) {
        if (key === 'id_Locales') body[key] = isEdit ? editingLocalId! : próximoId;
        else body[key] = formNuevo[key] ?? '';
      }
      const res = await fetch(`${API_URL}/api/locales`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      refetchLocales();
      setSelectedRowIndex(null);
      cerrarModalNuevo();
    } catch (e) {
      setErrorForm('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const borrarSeleccionado = async () => {
    if (selectedRowIndex == null) return;
    const local = localesFiltrados[selectedRowIndex];
    const idVal = local ? valorEnLocal(local, 'id_Locales') : undefined;
    const id = idVal != null ? String(idVal) : '';
    if (!id) return;
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/locales`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_Locales: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetchLocales();
      setSelectedRowIndex(null);
    } catch (e) {
      setError('No se pudo conectar con el servidor');
    } finally {
      setGuardando(false);
    }
  };

  const abrirModalCrearEmpresa = () => {
    setFormCrearEmpresa({ Nombre: '', Cif: '' });
    setErrorCrearEmpresa(null);
    setModalCrearEmpresaVisible(true);
  };

  const cerrarModalCrearEmpresa = () => {
    setModalCrearEmpresaVisible(false);
    setFormCrearEmpresa({ Nombre: '', Cif: '' });
    setErrorCrearEmpresa(null);
  };

  const guardarCrearEmpresa = async () => {
    const nombre = formCrearEmpresa.Nombre?.trim();
    const cif = formCrearEmpresa.Cif?.trim();
    if (!nombre) {
      setErrorCrearEmpresa('Nombre es obligatorio');
      return;
    }
    if (!cif) {
      setErrorCrearEmpresa('CIF es obligatorio');
      return;
    }
    setErrorCrearEmpresa(null);
    setGuardandoCrearEmpresa(true);
    try {
      const res = await fetch(`${API_URL}/api/empresas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Nombre: nombre,
          Cif: cif,
          Sede: 'Grupo Paripe',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorCrearEmpresa(data.error || 'Error al crear empresa');
        return;
      }
      refetchEmpresas();
      setFormNuevo((prev) => ({ ...prev, Empresa: nombre }));
      setEmpresaDropdownOpen(false);
      setEmpresaSearchFilter('');
      cerrarModalCrearEmpresa();
    } catch (e) {
      setErrorCrearEmpresa('No se pudo conectar con el servidor');
    } finally {
      setGuardandoCrearEmpresa(false);
    }
  };

  const próximoId = (() => {
    if (!locales.length) return formatId6(1);
    const ids = locales.map((u) => {
      const v = valorEnLocal(u, 'id_Locales') ?? 0;
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/^0+/, ''), 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return formatId6(Math.max(0, ...ids) + 1);
  })();

  const seleccionarFila = (idx: number) => {
    setSelectedRowIndex((prev) => (prev === idx ? null : idx));
  };

  const toolbarBtns = [
    { id: 'crear', label: 'Crear registro', icon: ICONS.add },
    { id: 'editar', label: 'Editar', icon: ICONS.edit },
    { id: 'borrar', label: 'Borrar', icon: ICONS.delete },
  ];

  const getColWidth = useCallback(
    (col: string) => (col === COL_THUMBNAIL ? THUMBNAIL_COL_WIDTH : columnWidths[col] ?? DEFAULT_COL_WIDTH),
    [columnWidths]
  );

  // Columnas de visualización: id_Locales, miniatura virtual (_thumbnail), resto de atributos (siempre definidas aunque no haya filas)
  const columnas = useMemo(() => {
    const rest = ORDEN_COLUMNAS.filter((c) => c !== 'id_Locales');
    return ['id_Locales', COL_THUMBNAIL, ...rest];
  }, []);

  const tableWidth = useMemo(
    () => columnas.reduce((sum, col) => sum + getColWidth(col), 0),
    [columnas, getColWidth]
  );

  const { height: windowHeight } = useWindowDimensions();
  const scrollAreaHeight = Math.max(300, windowHeight - 280);

  const valorCelda = useCallback((local: Local, col: string) => {
    if (col.startsWith('id_')) {
      const key = Object.keys(local).find((k) => k.toLowerCase() === col.toLowerCase());
      const raw = key != null ? local[key] : (local as Record<string, unknown>)[col];
      return raw != null ? formatId6(raw as string | number) : '—';
    }
    if (local[col] !== undefined && local[col] !== null) return String(local[col]);
    const key = Object.keys(local).find((k) => k.toLowerCase() === col.toLowerCase());
    return key != null && local[key] != null ? String(local[key]) : '—';
  }, []);

  const localesFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return locales;
    return locales.filter((u) => {
      return columnas.some((col) => {
        const val = valorCelda(u, col);
        return val !== '—' && val.toLowerCase().includes(q);
      });
    });
  }, [locales, filtroBusqueda, columnas, valorCelda]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/locales`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setLocales(ordenarPorId(data.locales || []));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Error de conexión');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ordenarPorId]);

  const refetchEmpresas = useCallback(() => {
    fetch(`${API_URL}/api/empresas`)
      .then((res) => res.json())
      .then((data: { empresas?: EmpresaItem[] }) => {
        const list = data.empresas || [];
        setEmpresasGrupoParipe(list);
      })
      .catch(() => setEmpresasGrupoParipe([]));
  }, []);

  const refetchAlmacenes = useCallback(() => {
    fetch(`${API_URL}/api/almacenes`)
      .then((res) => res.json())
      .then((data: { almacenes?: AlmacenItem[] }) => {
        const list = data.almacenes || [];
        setAlmacenes(list);
      })
      .catch(() => setAlmacenes([]));
  }, []);

  useEffect(() => {
    refetchEmpresas();
  }, [refetchEmpresas]);

  useEffect(() => {
    refetchAlmacenes();
  }, [refetchAlmacenes]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const handleUp = () => {
      resizeRef.current = null;
      setResizingCol(null);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [resizingCol]);

  const handleResizeStart = (col: string, e: { nativeEvent?: { clientX: number }; clientX?: number }) => {
    if (Platform.OS === 'web') {
      const clientX = e.nativeEvent?.clientX ?? (e as { clientX: number }).clientX ?? 0;
      resizeRef.current = { col, startX: clientX, startWidth: getColWidth(col) };
      setResizingCol(col);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando locales…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Locales</Text>
      </View>

      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.map((btn) => (
            <View
              key={btn.id}
              style={styles.toolbarBtnWrap}
              {...(Platform.OS === 'web'
                ? ({
                    onMouseEnter: () => setHoveredBtn(btn.id),
                    onMouseLeave: () => setHoveredBtn(null),
                  } as object)
                : {})}
            >
              {hoveredBtn === btn.id && (
                <View style={styles.tooltip}>
                  <Text style={styles.tooltipText}>{btn.label}</Text>
                </View>
              )}
              <TouchableOpacity
                style={[
                  styles.toolbarBtn,
                  (btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null && styles.toolbarBtnDisabled,
                ]}
                onPress={() => {
                  if (btn.id === 'crear') abrirModalNuevo();
                  if (btn.id === 'editar' && selectedRowIndex != null) abrirModalEditar(localesFiltrados[selectedRowIndex]);
                  if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                }}
                disabled={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null)}
                accessibilityLabel={btn.label}
              >
                <MaterialIcons name={btn.icon} size={ICON_SIZE} color={guardando || ((btn.id === 'editar' || btn.id === 'borrar') && selectedRowIndex == null) ? '#94a3b8' : '#0ea5e9'} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor="#94a3b8"
          />
        </View>
      </View>

      <Text style={styles.subtitle}>
        {filtroBusqueda.trim() ? `${localesFiltrados.length} de ${locales.length} registro${locales.length !== 1 ? 's' : ''}` : `${locales.length} registro${locales.length !== 1 ? 's' : ''} en la tabla`}
      </Text>

      <ScrollView
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.scrollContentHorizontal}
        showsHorizontalScrollIndicator
      >
        <View style={[styles.tableWrapper, { minWidth: tableWidth }]}>
          <ScrollView
            style={[styles.scrollVertical, { maxHeight: scrollAreaHeight }]}
            contentContainerStyle={styles.scrollContentVertical}
            showsVerticalScrollIndicator
          >
            <View
              style={[
                styles.rowHeader,
                ...(Platform.OS === 'web' ? [{ position: 'sticky', top: 0, zIndex: 10 } as Record<string, unknown>] : []),
              ]}
            >
              {columnas.map((col) => (
                <View key={col} style={[styles.cellHeader, { width: getColWidth(col) }]}>
                  <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">
                    {col === COL_THUMBNAIL ? 'Foto' : col}
                  </Text>
                  {Platform.OS === 'web' && col !== COL_THUMBNAIL && (
                    <View
                      style={styles.resizeHandle}
                      {...({
                        onMouseDown: (e: { nativeEvent?: { clientX: number }; clientX?: number }) =>
                          handleResizeStart(col, e),
                      } as object)}
                    />
                  )}
                </View>
              ))}
            </View>
            {localesFiltrados.map((local, idx) => (
            <TouchableOpacity
              key={idx}
              style={[styles.row, selectedRowIndex === idx && styles.rowSelected]}
              onPress={() => seleccionarFila(idx)}
              activeOpacity={0.8}
            >
              {columnas.map((col) => {
                if (col === COL_THUMBNAIL) {
                  const imagenUri = valorCelda(local, 'Imagen');
                  const isImageUri =
                    imagenUri !== '—' &&
                    (imagenUri.startsWith('data:image') || imagenUri.startsWith('http://') || imagenUri.startsWith('https://'));
                  return (
                    <View key={col} style={[styles.cell, styles.cellThumbnail, { width: getColWidth(col) }]}>
                      {isImageUri ? (
                        <Image source={{ uri: imagenUri }} style={styles.thumbnailImg as ImageStyle} resizeMode="cover" />
                      ) : (
                        <View style={styles.thumbnailPlaceholder}>
                          <MaterialIcons name="image-not-supported" size={20} color="#94a3b8" />
                        </View>
                      )}
                    </View>
                  );
                }
                const raw = valorCelda(local, col);
                const text = raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw;
                const isAgoraCode = col === 'AgoraCode';
                return (
                  <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                    <Text
                      style={[styles.cellText, isAgoraCode && { fontSize: 13, fontWeight: '700' }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {text}
                    </Text>
                  </View>
                );
              })}
            </TouchableOpacity>
          ))}
          </ScrollView>
        </View>
      </ScrollView>

      <Modal visible={modalNuevoVisible} transparent animationType="fade" onRequestClose={cerrarModalNuevo}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalContentWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{editingLocalId != null ? 'Editar registro' : 'Nuevo registro'}</Text>
                  <TouchableOpacity onPress={cerrarModalNuevo} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <View style={styles.modalBodyRow}>
                  <View style={styles.modalIdSide}>
                    <Text style={styles.modalIdLabel}>ID</Text>
                    <Text style={styles.modalIdValue}>{formatId6(editingLocalId ?? próximoId)}</Text>
                  </View>
                  <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                    {CAMPOS_FORM.map((campo) =>
                      campo.key === 'Direccion' ? (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}</Text>
                          <View style={styles.direccionInputRow}>
                            <TextInput
                              style={[styles.formInput, { flex: 1 }]}
                              value={formNuevo.Direccion ?? ''}
                              onChangeText={onDireccionChange}
                              onBlur={() => setTimeout(() => setDireccionDropdownOpen(false), 200)}
                              placeholder="Escribe y elige una dirección…"
                              placeholderTextColor="#94a3b8"
                              autoCapitalize="words"
                            />
                            {formNuevo.Direccion ? (
                              <TouchableOpacity
                                style={styles.direccionVaciarBtn}
                                onPress={() => setFormNuevo((prev) => ({ ...prev, Direccion: '', lat: '', lng: '' }))}
                                activeOpacity={0.7}
                              >
                                <MaterialIcons name="clear" size={18} color="#64748b" />
                              </TouchableOpacity>
                            ) : null}
                          </View>
                          {direccionLoading && (
                            <View style={styles.direccionLoadingWrap}>
                              <ActivityIndicator size="small" color="#0ea5e9" />
                              <Text style={styles.direccionLoadingText}>Buscando…</Text>
                            </View>
                          )}
                          {direccionDropdownOpen && direccionSuggestions.length > 0 && (
                            <View style={styles.direccionDropdown}>
                              <ScrollView style={styles.direccionDropdownScroll} keyboardShouldPersistTaps="handled">
                                {[...direccionSuggestions].sort((a, b) => (a.description || '').localeCompare(b.description || '')).map((p, idx) => (
                                  <TouchableOpacity
                                    key={p.place_id || idx}
                                    style={styles.direccionOption}
                                    onPress={() => onDireccionSelect(p)}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="place" size={16} color="#64748b" style={styles.direccionOptionIcon} />
                                    <Text style={styles.direccionOptionText} numberOfLines={2}>
                                      {p.description}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </ScrollView>
                            </View>
                          )}
                          {direccionDropdownOpen && direccionSuggestions.length === 0 && !direccionLoading && (
                            <Text style={styles.direccionHint}>
                              {direccionConfigOk === false
                                ? 'No hay sugerencias en este momento. Comprueba la conexión o la configuración del servidor.'
                                : 'No hay resultados para esta búsqueda.'}
                            </Text>
                          )}
                          {direccionConfigOk === false && direccionSuggestions.length > 0 && (
                            <Text style={styles.direccionHint}>
                              Sugerencias con OpenStreetMap. Para usar Google Maps, configura GOOGLE_MAPS_API_KEY en api/.env.local
                            </Text>
                          )}
                        </View>
                      ) : campo.key === 'Empresa' ? (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}</Text>
                          <TouchableOpacity
                            style={[styles.formInput, styles.formInputRow]}
                            onPress={() => setEmpresaDropdownOpen((o) => !o)}
                            activeOpacity={0.7}
                          >
                            <Text style={[styles.formInputText, !formNuevo.Empresa && styles.formInputPlaceholder]} numberOfLines={1}>
                              {formNuevo.Empresa || `${campo.label}…`}
                            </Text>
                            <MaterialIcons name={empresaDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" style={styles.sedeChevron} />
                          </TouchableOpacity>
                          {empresaDropdownOpen && (
                            <View style={styles.empresaDropdownWrap}>
                              <TextInput
                                style={styles.empresaDropdownSearch}
                                value={empresaSearchFilter}
                                onChangeText={setEmpresaSearchFilter}
                                placeholder="Buscar empresa…"
                                placeholderTextColor="#94a3b8"
                              />
                              <ScrollView style={styles.empresaDropdownScroll} keyboardShouldPersistTaps="handled">
                                {formNuevo.Empresa ? (
                                  <TouchableOpacity
                                    style={[styles.empresaDropdownOption, styles.dropdownVaciarOption]}
                                    onPress={() => {
                                      setFormNuevo((prev) => ({ ...prev, Empresa: '' }));
                                      setEmpresaDropdownOpen(false);
                                      setEmpresaSearchFilter('');
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="clear" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
                                    <Text style={styles.dropdownVaciarText}>Vaciar</Text>
                                  </TouchableOpacity>
                                ) : null}
                                {empresasGrupoParipe.length === 0 ? (
                                  <>
                                    <View style={styles.empresaDropdownOption}>
                                      <Text style={styles.empresaDropdownOptionText}>Sin empresas</Text>
                                    </View>
                                    <TouchableOpacity
                                      style={[styles.empresaDropdownOption, styles.dropdownCrearNuevoOption]}
                                      onPress={() => {
                                        setEmpresaDropdownOpen(false);
                                        abrirModalCrearEmpresa();
                                      }}
                                      activeOpacity={0.7}
                                    >
                                      <MaterialIcons name="add-circle-outline" size={16} color="#0ea5e9" style={{ marginRight: 6 }} />
                                      <Text style={styles.dropdownCrearNuevoText}>Crear nueva empresa</Text>
                                    </TouchableOpacity>
                                  </>
                                ) : empresasFiltradasParaDropdown.length === 0 ? (
                                  <TouchableOpacity
                                    style={[styles.empresaDropdownOption, styles.dropdownCrearNuevoOption]}
                                    onPress={() => {
                                      setEmpresaDropdownOpen(false);
                                      abrirModalCrearEmpresa();
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="add-circle-outline" size={16} color="#0ea5e9" style={{ marginRight: 6 }} />
                                    <Text style={styles.dropdownCrearNuevoText}>Crear nueva empresa</Text>
                                  </TouchableOpacity>
                                ) : (
                                  <>
                                    {empresasFiltradasParaDropdown.map((emp) => {
                                      const nombre = emp.Nombre ?? emp.id_empresa ?? '';
                                      return (
                                        <TouchableOpacity
                                          key={emp.id_empresa ?? nombre}
                                          style={styles.empresaDropdownOption}
                                          onPress={() => {
                                            setFormNuevo((prev) => ({ ...prev, Empresa: nombre }));
                                            setEmpresaDropdownOpen(false);
                                            setEmpresaSearchFilter('');
                                          }}
                                          activeOpacity={0.7}
                                        >
                                          <Text style={styles.empresaDropdownOptionText}>{nombre || '—'}</Text>
                                        </TouchableOpacity>
                                      );
                                    })}
                                    <TouchableOpacity
                                      style={[styles.empresaDropdownOption, styles.dropdownCrearNuevoOption]}
                                      onPress={() => {
                                        setEmpresaDropdownOpen(false);
                                        abrirModalCrearEmpresa();
                                      }}
                                      activeOpacity={0.7}
                                    >
                                      <MaterialIcons name="add-circle-outline" size={16} color="#0ea5e9" style={{ marginRight: 6 }} />
                                      <Text style={styles.dropdownCrearNuevoText}>Crear nueva empresa</Text>
                                    </TouchableOpacity>
                                  </>
                                )}
                              </ScrollView>
                            </View>
                          )}
                        </View>
                      ) : campo.key === 'Almacen origen' ? (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}</Text>
                          <View style={styles.almacenChipsWrap}>
                            {parseAlmacenesOrigen(formNuevo['Almacen origen']).map((nombre) => (
                              <View key={nombre} style={styles.almacenChip}>
                                <Text style={styles.almacenChipText} numberOfLines={1}>{nombre}</Text>
                                <TouchableOpacity
                                  onPress={() => {
                                    const arr = parseAlmacenesOrigen(formNuevo['Almacen origen']).filter((n) => n !== nombre);
                                    setFormNuevo((prev) => ({ ...prev, 'Almacen origen': joinAlmacenesOrigen(arr) }));
                                  }}
                                  style={styles.almacenChipRemove}
                                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                >
                                  <MaterialIcons name="close" size={14} color="#64748b" />
                                </TouchableOpacity>
                              </View>
                            ))}
                            <TouchableOpacity
                              style={[styles.formInput, styles.formInputRow, styles.almacenAddBtn]}
                              onPress={() => setAlmacenDropdownOpen((o) => !o)}
                              activeOpacity={0.7}
                            >
                              <MaterialIcons name="add" size={18} color="#0ea5e9" style={{ marginRight: 4 }} />
                              <Text style={[styles.formInputText, styles.almacenAddText]}>Añadir almacén</Text>
                              <MaterialIcons name={almacenDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" style={styles.sedeChevron} />
                            </TouchableOpacity>
                          </View>
                          {almacenDropdownOpen && (
                            <View style={styles.empresaDropdownWrap}>
                              <TextInput
                                style={styles.empresaDropdownSearch}
                                value={almacenSearchFilter}
                                onChangeText={setAlmacenSearchFilter}
                                placeholder="Buscar almacén…"
                                placeholderTextColor="#94a3b8"
                              />
                              <ScrollView style={styles.empresaDropdownScroll} keyboardShouldPersistTaps="handled">
                                {parseAlmacenesOrigen(formNuevo['Almacen origen']).length > 0 ? (
                                  <TouchableOpacity
                                    style={[styles.empresaDropdownOption, styles.dropdownVaciarOption]}
                                    onPress={() => {
                                      setFormNuevo((prev) => ({ ...prev, 'Almacen origen': '' }));
                                      setAlmacenDropdownOpen(false);
                                      setAlmacenSearchFilter('');
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="clear" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
                                    <Text style={styles.dropdownVaciarText}>Vaciar todos</Text>
                                  </TouchableOpacity>
                                ) : null}
                                {almacenes.length === 0 ? (
                                  <View style={styles.empresaDropdownOption}>
                                    <Text style={styles.empresaDropdownOptionText}>Sin almacenes. Sincroniza desde el módulo Almacenes.</Text>
                                  </View>
                                ) : (() => {
                                  const yaSeleccionados = new Set(parseAlmacenesOrigen(formNuevo['Almacen origen']));
                                  const disponibles = almacenesFiltradosParaDropdown.filter((alm) => !yaSeleccionados.has(alm.Nombre ?? alm.Id ?? ''));
                                  return disponibles.length === 0 ? (
                                    <View style={styles.empresaDropdownOption}>
                                      <Text style={styles.empresaDropdownOptionText}>Todos los almacenes ya están asignados</Text>
                                    </View>
                                  ) : (
                                    disponibles.map((alm) => {
                                      const nombre = alm.Nombre ?? alm.Id ?? '';
                                      return (
                                        <TouchableOpacity
                                          key={alm.Id ?? nombre}
                                          style={styles.empresaDropdownOption}
                                          onPress={() => {
                                            const arr = [...parseAlmacenesOrigen(formNuevo['Almacen origen']), nombre];
                                            setFormNuevo((prev) => ({ ...prev, 'Almacen origen': joinAlmacenesOrigen(arr) }));
                                          }}
                                          activeOpacity={0.7}
                                        >
                                          <Text style={styles.empresaDropdownOptionText}>{nombre || '—'}</Text>
                                        </TouchableOpacity>
                                      );
                                    })
                                  );
                                })()}
                              </ScrollView>
                            </View>
                          )}
                        </View>
                      ) : campo.key === 'Sede' ? (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}</Text>
                          <TouchableOpacity
                            style={[styles.formInput, styles.formInputRow]}
                            onPress={() => setSedeDropdownOpen((o) => !o)}
                            activeOpacity={0.7}
                          >
                            <Text style={[styles.formInputText, !formNuevo.Sede && styles.formInputPlaceholder]} numberOfLines={1}>
                              {formNuevo.Sede || `${campo.label}…`}
                            </Text>
                            <MaterialIcons name={sedeDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" style={styles.sedeChevron} />
                          </TouchableOpacity>
                          {sedeDropdownOpen && (
                            <View style={styles.empresaDropdownWrap}>
                              <TextInput
                                style={styles.empresaDropdownSearch}
                                value={sedeSearchFilter}
                                onChangeText={setSedeSearchFilter}
                                placeholder="Buscar sede…"
                                placeholderTextColor="#94a3b8"
                              />
                              <ScrollView style={styles.empresaDropdownScroll} keyboardShouldPersistTaps="handled">
                                {formNuevo.Sede ? (
                                  <TouchableOpacity
                                    style={[styles.empresaDropdownOption, styles.dropdownVaciarOption]}
                                    onPress={() => {
                                      setFormNuevo((prev) => ({ ...prev, Sede: '' }));
                                      setSedeDropdownOpen(false);
                                      setSedeSearchFilter('');
                                    }}
                                    activeOpacity={0.7}
                                  >
                                    <MaterialIcons name="clear" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
                                    <Text style={styles.dropdownVaciarText}>Vaciar</Text>
                                  </TouchableOpacity>
                                ) : null}
                                {sedesFiltradasParaDropdown.length === 0 ? (
                                  <View style={styles.empresaDropdownOption}>
                                    <Text style={styles.empresaDropdownOptionText}>Sin resultados</Text>
                                  </View>
                                ) : (
                                  sedesFiltradasParaDropdown.map((opcion) => (
                                    <TouchableOpacity
                                      key={opcion}
                                      style={styles.empresaDropdownOption}
                                      onPress={() => {
                                        setFormNuevo((prev) => ({ ...prev, Sede: opcion }));
                                        setSedeDropdownOpen(false);
                                        setSedeSearchFilter('');
                                      }}
                                      activeOpacity={0.7}
                                    >
                                      <Text style={styles.empresaDropdownOptionText}>{opcion}</Text>
                                    </TouchableOpacity>
                                  ))
                                )}
                              </ScrollView>
                            </View>
                          )}
                        </View>
                      ) : campo.key === 'Imagen' ? (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}</Text>
                          <TouchableOpacity
                            style={styles.imagenButton}
                            onPress={seleccionarFoto}
                            disabled={imagenLoading}
                            activeOpacity={0.7}
                          >
                            {imagenLoading ? (
                              <ActivityIndicator size="small" color="#0ea5e9" />
                            ) : (
                              <>
                                <MaterialIcons name="add-photo-alternate" size={22} color="#0ea5e9" />
                                <Text style={styles.imagenButtonText}>Seleccionar foto</Text>
                              </>
                            )}
                          </TouchableOpacity>
                          {formNuevo.Imagen ? (
                            <View style={styles.imagenPreviewWrap}>
                              <Image source={{ uri: formNuevo.Imagen }} style={styles.imagenPreview as ImageStyle} resizeMode="cover" />
                              <TouchableOpacity style={styles.imagenQuitarBtn} onPress={quitarFoto} activeOpacity={0.7}>
                                <MaterialIcons name="close" size={18} color="#fff" />
                                <Text style={styles.imagenQuitarText}>Quitar</Text>
                              </TouchableOpacity>
                            </View>
                          ) : null}
                        </View>
                      ) : campo.key === 'Cp' ? (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}</Text>
                          <TextInput
                            style={styles.formInput}
                            value={formNuevo.Cp ?? ''}
                            onChangeText={handleCpChange}
                            onBlur={handleCpBlur}
                            placeholder={`${campo.label}…`}
                            placeholderTextColor="#94a3b8"
                            autoCapitalize="words"
                          />
                        </View>
                      ) : (
                        <View key={campo.key} style={styles.formGroup}>
                          <Text style={styles.formLabel}>{campo.label}</Text>
                          <TextInput
                            style={styles.formInput}
                            value={formNuevo[campo.key] ?? ''}
                            onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, [campo.key]: t }))}
                            placeholder={`${campo.label}…`}
                            placeholderTextColor="#94a3b8"
                            autoCapitalize="words"
                          />
                        </View>
                      )
                    )}
                  </ScrollView>
                </View>
                {errorForm ? <Text style={styles.modalError}>{errorForm}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtn} onPress={guardarNuevo} accessibilityLabel={editingLocalId != null ? 'Guardar' : 'Añadir'} disabled={guardando}>
                    {guardando ? <ActivityIndicator size="small" color="#0ea5e9" /> : <MaterialIcons name={editingLocalId != null ? 'save' : ICONS.add} size={ICON_SIZE} color="#0ea5e9" />}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalCrearEmpresaVisible} transparent animationType="fade" onRequestClose={cerrarModalCrearEmpresa}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
            <View style={[styles.modalCard, { maxWidth: 360 }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Crear nueva empresa</Text>
                <TouchableOpacity onPress={cerrarModalCrearEmpresa} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={[styles.modalBody, { maxHeight: 200 }]}>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Nombre *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formCrearEmpresa.Nombre}
                    onChangeText={(t) => setFormCrearEmpresa((prev) => ({ ...prev, Nombre: t }))}
                    placeholder="Nombre de la empresa"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="words"
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>CIF *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formCrearEmpresa.Cif}
                    onChangeText={(t) => setFormCrearEmpresa((prev) => ({ ...prev, Cif: t }))}
                    placeholder="CIF"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="characters"
                  />
                </View>
                {errorCrearEmpresa ? <Text style={styles.modalError}>{errorCrearEmpresa}</Text> : null}
              </View>
              <View style={styles.modalFooter}>
                <TouchableOpacity style={styles.modalFooterBtn} onPress={cerrarModalCrearEmpresa} activeOpacity={0.7}>
                  <Text style={{ color: '#64748b', fontSize: 14 }}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalFooterBtn, { flexDirection: 'row', alignItems: 'center' }]}
                  onPress={guardarCrearEmpresa}
                  disabled={guardandoCrearEmpresa}
                  activeOpacity={0.7}
                >
                  {guardandoCrearEmpresa ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <>
                      <MaterialIcons name="add" size={ICON_SIZE} color="#0ea5e9" />
                      <Text style={{ color: '#0ea5e9', fontSize: 14, marginLeft: 6 }}>Crear</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 140, maxWidth: 280, height: 32, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 8 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },
  toolbarBtnWrap: { position: 'relative' },
  tooltip: { position: 'absolute', bottom: '100%', alignSelf: 'center', marginBottom: 4, backgroundColor: '#334155', paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4, zIndex: 10 },
  tooltipText: { fontSize: 9, color: '#f8fafc', fontWeight: '400' },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  toolbarBtnDisabled: { opacity: 0.6 },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 8 },
  scroll: { flex: 1 },
  scrollContentVertical: { paddingBottom: 20 },
  scrollContentHorizontal: { paddingBottom: 20 },
  scrollVertical: { flex: 1 },
  tableWrapper: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  rowHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: { minWidth: MIN_COL_WIDTH, paddingVertical: 6, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#cbd5e1', position: 'relative' },
  cellHeaderText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#fff' },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  cellText: { fontSize: 11, color: '#475569', textAlign: 'center', alignSelf: 'stretch' },
  cellThumbnail: { alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 10 },
  thumbnailImg: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#e2e8f0' },
  thumbnailPlaceholder: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 420, padding: 24, alignItems: 'center' },
  modalCardTouch: { width: '100%' },
  modalCard: { width: '100%', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBodyRow: { flexDirection: 'row' },
  modalIdSide: { width: 56, paddingVertical: 12, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0', alignItems: 'center', justifyContent: 'flex-start' },
  modalIdLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', marginBottom: 2 },
  modalIdValue: { fontSize: 14, fontWeight: '600', color: '#334155' },
  modalBody: { flex: 1, maxHeight: 400, paddingHorizontal: 16, paddingVertical: 12 },
  formGroup: { marginBottom: 8 },
  formLabel: { fontSize: 10, fontWeight: '500', color: '#475569', marginBottom: 2 },
  formInput: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, fontSize: 13, color: '#334155' },
  formInputRow: { flexDirection: 'row', alignItems: 'center' },
  formInputText: { fontSize: 13, color: '#334155', flex: 1 },
  formInputPlaceholder: { color: '#94a3b8' },
  sedeChevron: { marginLeft: 4 },
  sedeDropdown: { marginTop: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', maxHeight: 120 },
  sedeOption: { paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  sedeOptionText: { fontSize: 13, color: '#334155' },
  empresaDropdownWrap: { marginTop: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', maxHeight: 200 },
  empresaDropdownSearch: { paddingVertical: 6, paddingHorizontal: 8, fontSize: 11, color: '#334155', backgroundColor: '#f8fafc', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  empresaDropdownScroll: { maxHeight: 150 },
  empresaDropdownOption: { paddingVertical: 5, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  empresaDropdownOptionText: { fontSize: 11, color: '#334155' },
  dropdownVaciarOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderBottomColor: '#e2e8f0' },
  dropdownVaciarText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  dropdownCrearNuevoOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0f9ff', borderBottomColor: '#e2e8f0' },
  dropdownCrearNuevoText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  direccionInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  direccionVaciarBtn: { padding: 6, backgroundColor: '#f1f5f9', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  direccionLoadingWrap: { marginTop: 4, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  direccionLoadingText: { fontSize: 12, color: '#64748b' },
  direccionHint: { marginTop: 4, fontSize: 11, color: '#64748b' },
  direccionDropdown: { marginTop: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, maxHeight: 200, overflow: 'hidden' },
  direccionDropdownScroll: { maxHeight: 150 },
  direccionOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  direccionOptionIcon: { marginRight: 8 },
  direccionOptionText: { flex: 1, fontSize: 11, color: '#334155' },
  almacenChipsWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  almacenChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#e0f2fe', borderWidth: 1, borderColor: '#bae6fd', borderRadius: 8, paddingVertical: 4, paddingLeft: 8, paddingRight: 4, maxWidth: 180 },
  almacenChipText: { fontSize: 11, color: '#0c4a6e', flex: 1 },
  almacenChipRemove: { padding: 2 },
  almacenAddBtn: { alignSelf: 'flex-start', minWidth: 140 },
  almacenAddText: { color: '#0ea5e9', fontWeight: '500' },
  imagenButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#f0f9ff', borderWidth: 1, borderColor: '#bae6fd', borderRadius: 8 },
  imagenButtonText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },
  imagenPreviewWrap: { marginTop: 8, position: 'relative', alignSelf: 'flex-start' },
  imagenPreview: { width: 120, height: 120, borderRadius: 8, backgroundColor: '#e2e8f0' },
  imagenQuitarBtn: { position: 'absolute', top: 4, right: 4, flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 6 },
  imagenQuitarText: { fontSize: 11, color: '#fff', fontWeight: '500' },
  modalError: { fontSize: 11, color: '#f87171', paddingHorizontal: 20, paddingVertical: 4 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  modalFooterBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
});
