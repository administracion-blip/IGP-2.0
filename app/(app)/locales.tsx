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
  type ImageStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { MaterialIcons } from '@expo/vector-icons';
import { ICONS, ICON_SIZE } from '../constants/icons';
import { formatId6 } from '../utils/idFormat';
import { useAuth } from '../contexts/AuthContext';
import { useLocales } from '../contexts/LocalesContext';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { MIN_TOUCH } from '../constants/layout';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  typography,
  SPACING,
} from '../constants/theme';
import { SelectorDesplegable } from '../components/SelectorDesplegable';
import { apiFetch, errorMessage } from '../utils/api';
import {
  calcularProximoIdEmpresa,
  claveNombreEmpresa,
  crearEmpresaConIdLibre,
  normalizarIdEmpresa,
  resolverEmpresaPorNombre,
} from '../lib/empresaId';
import { calcularProximoIdLocal } from '../lib/localId';

const MAX_IMAGEN_BASE64_LENGTH = 380000;

/** Id centinela de la opción «Crear nueva empresa» dentro del desplegable de Empresa. */
const CREAR_EMPRESA_OPCION_ID = '__crear_empresa__';

const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 40;
const THUMBNAIL_COL_WIDTH = 72;
const MAX_TEXT_LENGTH = 30;

const COL_THUMBNAIL = '_thumbnail';

// Atributos exactos de la tabla igp_Locales en AWS (mismo orden que TABLE_LOCALES_ATTRS en api/routes/locales.js).
// `factorial_location_id` es opcional: ID de la location correspondiente en Factorial HR (cuadrante).
// `km_desplazamiento`: kilómetros de ida desde la sede central; los usa Mantenimiento para valorar el desplazamiento.
// `id_empresa`: vínculo estable con el maestro de empresas. Convive con `Empresa`, que sigue guardando el
// nombre porque otros módulos (abonos y rappel de compras) cruzan por nombre.
const ATRIBUTOS_TABLA_LOCALES = ['id_Locales', 'Nombre', 'AgoraCode', 'Empresa', 'id_empresa', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Almacen origen', 'Sede', 'lat', 'lng', 'km_desplazamiento', 'Imagen', 'factorial_location_id', 'ratio_personal', 'ratio_musicos', 'ratio_mercaderia'] as const;

// En la tabla se muestra el nombre de la empresa, no su id: el id no aporta nada al usuario en el listado.
const ORDEN_COLUMNAS = ATRIBUTOS_TABLA_LOCALES.filter((c) => c !== 'id_empresa');

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
  { key: 'km_desplazamiento', label: 'Km desde sede central' },
  { key: 'Imagen', label: 'Imagen' },
  { key: 'factorial_location_id', label: 'Factorial location ID' },
  { key: 'ratio_personal', label: 'Ratio personal (%)' },
  { key: 'ratio_musicos', label: 'Ratio músicos (%)' },
  { key: 'ratio_mercaderia', label: 'Ratio mercadería (%)' },
];

const COL_LABELS: Record<string, string> = {
  id_Locales: 'ID',
  [COL_THUMBNAIL]: 'Foto',
  Nombre: 'Nombre',
  AgoraCode: 'AgoraCode',
  Empresa: 'Empresa',
  Direccion: 'Dirección',
  Cp: 'CP',
  Municipio: 'Municipio',
  Provincia: 'Provincia',
  'Almacen origen': 'Almacén origen',
  Sede: 'Sede',
  lat: 'Lat',
  lng: 'Lng',
  km_desplazamiento: 'Km desplazamiento',
  Imagen: 'Imagen',
  factorial_location_id: 'Factorial',
  ratio_personal: 'Ratio personal',
  ratio_musicos: 'Ratio músicos',
  ratio_mercaderia: 'Ratio mercadería',
};

function labelColumna(col: string): string {
  return COL_LABELS[col] ?? col;
}

type CampoFormKey = (typeof CAMPOS_FORM)[number]['key'];

// Claves que viven en el formulario: las visibles más `id_empresa`, que no tiene campo propio
// porque lo rellena el desplegable de Empresa.
const CLAVES_FORM: (typeof ATRIBUTOS_TABLA_LOCALES)[number][] = [...CAMPOS_FORM.map((c) => c.key), 'id_empresa'];

const INITIAL_FORM = Object.fromEntries(CLAVES_FORM.map((k) => [k, ''])) as Record<(typeof ATRIBUTOS_TABLA_LOCALES)[number], string>;

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
  const { localPermitido } = useAuth();
  const { refresh: refreshLocalesCompartidos } = useLocales();
  const { isPhone, isDesktop, shouldStackPanels, shouldStackToolbar, height: windowHeight } = useBreakpoint();
  const formDosColumnas = !isPhone;
  const modalCasiFull = isPhone || shouldStackPanels;
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
    for (const key of CLAVES_FORM) {
      const v = valorEnLocal(local, key);
      form[key] = v != null ? String(v) : '';
    }
    setFormNuevo(form);
    const idVal = valorEnLocal(local, 'id_Locales');
    setEditingLocalId(idVal != null ? String(idVal) : null);
    setDireccionSuggestions([]);
    setDireccionConfigOk(null);
    setDireccionDropdownOpen(false);
    setAlmacenDropdownOpen(false);
    setAlmacenSearchFilter('');
    setModalNuevoVisible(true);
    setErrorForm(null);
  };
  const sedeOpciones = useMemo(
    () => [
      { id: '', titulo: '(sin sede)' },
      ...[...SEDE_OPCIONES].sort((a, b) => a.localeCompare(b)).map((s) => ({ id: s, titulo: s })),
    ],
    [],
  );
  const cerrarModalNuevo = () => {
    setModalNuevoVisible(false);
    setFormNuevo(INITIAL_FORM);
    setEditingLocalId(null);
    setDireccionSuggestions([]);
    setDireccionConfigOk(null);
    setDireccionDropdownOpen(false);
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

  // Cada opción se identifica por el `id_empresa` del maestro y muestra el nombre: al seleccionar
  // se rellenan los dos campos del local (id y nombre como copia legible).
  // Se dejan fuera las empresas sin id (no hay vínculo estable que guardar) y las que no tienen
  // nombre (el local acabaría con el id de una empresa y el nombre de la anterior). Las dos son
  // fichas rotas del maestro: se arreglan allí, no desde aquí, y la pista lo indica.
  const empresaOpciones = useMemo(
    () => [
      ...empresasGrupoParipe
        .map((emp) => ({ id: normalizarIdEmpresa(emp.id_empresa), nombre: (emp.Nombre ?? '').trim() }))
        .filter(({ id, nombre }) => id !== '' && nombre !== '')
        .sort((a, b) => a.nombre.toLowerCase().localeCompare(b.nombre.toLowerCase()))
        .map(({ id, nombre }) => ({ id, titulo: nombre, icono: 'business' as const })),
      { id: CREAR_EMPRESA_OPCION_ID, titulo: 'Crear nueva empresa', icono: 'add-business' as const },
    ],
    [empresasGrupoParipe],
  );

  /** Cruce del nombre guardado con el maestro para los locales anteriores a la migración. */
  const empresaResuelta = useMemo(
    () => resolverEmpresaPorNombre(formNuevo.Empresa, empresasGrupoParipe),
    [formNuevo.Empresa, empresasGrupoParipe],
  );

  /**
   * Empresa vinculada al local que se está editando: el `id_empresa` guardado y, si el local es
   * anterior a la migración y solo tiene el nombre, el id que se resuelve desde ese nombre.
   */
  const empresaIdVinculado = useMemo(() => {
    const guardado = normalizarIdEmpresa(formNuevo.id_empresa);
    return guardado || empresaResuelta.id;
  }, [formNuevo.id_empresa, empresaResuelta.id]);

  /** Ficha del maestro a la que apunta el id vinculado (`null` si ese id ya no existe). */
  const empresaMaestroVinculada = useMemo(
    () => empresasGrupoParipe.find((e) => normalizarIdEmpresa(e.id_empresa) === empresaIdVinculado) ?? null,
    [empresasGrupoParipe, empresaIdVinculado],
  );

  /** Nombre actual en el maestro: es el que se guarda cuando el id casa. */
  const nombreEmpresaMaestro = (empresaMaestroVinculada?.Nombre ?? '').trim();

  /** Pista bajo el desplegable: confirma el vínculo o explica por qué no se ha podido establecer. */
  const pistaEmpresa = useMemo((): { texto: string; aviso: boolean } | null => {
    if (!empresasGrupoParipe.length) return null;
    const nombre = (formNuevo.Empresa ?? '').trim();
    if (empresaIdVinculado) {
      if (!empresaMaestroVinculada) {
        return { texto: `El ID ${empresaIdVinculado} guardado no existe en el maestro de empresas.`, aviso: true };
      }
      if (!nombreEmpresaMaestro) {
        return { texto: `La empresa ${empresaIdVinculado} no tiene nombre en el maestro. Ponle nombre en Empresas para que el local lo muestre bien.`, aviso: true };
      }
      if (claveNombreEmpresa(nombre) !== claveNombreEmpresa(nombreEmpresaMaestro)) {
        return { texto: `Vinculada al maestro con el ID ${empresaIdVinculado}. Al guardar se actualizará el nombre a «${nombreEmpresaMaestro}».`, aviso: false };
      }
      return { texto: `Vinculada al maestro de empresas con el ID ${empresaIdVinculado}.`, aviso: false };
    }
    if (!nombre) return null;
    if (empresaResuelta.estado === 'ambigua') {
      return { texto: `Hay varias empresas llamadas «${nombre}» en el maestro. Elígela en la lista para saber a cuál se factura.`, aviso: true };
    }
    if (empresaResuelta.estado === 'sin-id') {
      return { texto: `«${nombre}» está en el maestro pero sin ID válido. Corrígelo en Empresas para poder enlazarla.`, aviso: true };
    }
    return { texto: `«${nombre}» no coincide con ninguna empresa del maestro. Vuelve a elegirla en la lista para enlazarla.`, aviso: true };
  }, [
    empresasGrupoParipe,
    formNuevo.Empresa,
    empresaIdVinculado,
    empresaMaestroVinculada,
    nombreEmpresaMaestro,
    empresaResuelta.estado,
  ]);

  const fetchDireccionSuggestions = useCallback((input: string) => {
    if (input.trim().length < 2) {
      setDireccionSuggestions([]);
      return;
    }
    setDireccionLoading(true);
    apiFetch(`/api/places/autocomplete?input=${encodeURIComponent(input.trim())}`)
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
        apiFetch(`/api/places/details?place_id=${encodeURIComponent(p.place_id)}`)
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
    apiFetch(`/api/codigo-postal?cp=${encodeURIComponent(normalized)}`)
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
    apiFetch('/api/locales')
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
        // Se envía el id que muestra el desplegable, de modo que editar un local antiguo
        // que solo tenía el nombre deja el vínculo guardado sin tocar nada más.
        else if (key === 'id_empresa') body[key] = empresaIdVinculado;
        // El id es el vínculo fiable: cuando casa con el maestro se resincroniza el nombre,
        // que es lo que siguen cruzando abonos, rappel y compras.
        else if (key === 'Empresa') body[key] = nombreEmpresaMaestro || (formNuevo.Empresa ?? '');
        else if (key === 'Sede') body[key] = formNuevo.Sede || '';
        else body[key] = formNuevo[key] ?? '';
      }
      const res = await apiFetch('/api/locales', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorForm(data.error || 'Error al guardar');
        return;
      }
      refetchLocales();
      void refreshLocalesCompartidos();
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
      const res = await apiFetch('/api/locales', {
        method: 'DELETE',
        body: JSON.stringify({ id_Locales: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Error al borrar');
        return;
      }
      refetchLocales();
      void refreshLocalesCompartidos();
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
      const { empresa, idUsado } = await crearEmpresaConIdLibre({
        id_empresa: próximoIdEmpresa,
        Nombre: nombre,
        Cif: cif,
        Sede: 'Grupo Paripe',
      });
      // Alta local con el id realmente usado (puede diferir si hubo colisión).
      setEmpresasGrupoParipe((prev) =>
        prev.some((e) => String(e.id_empresa ?? '') === idUsado)
          ? prev
          : [
              ...prev,
              {
                id_empresa: idUsado,
                Nombre: empresa.Nombre ?? nombre,
                Sede: empresa.Sede ?? 'Grupo Paripe',
              },
            ],
      );
      refetchEmpresas();
      setFormNuevo((prev) => ({ ...prev, id_empresa: normalizarIdEmpresa(idUsado), Empresa: nombre }));
      cerrarModalCrearEmpresa();
    } catch (e) {
      setErrorCrearEmpresa(errorMessage(e, 'Error al crear empresa'));
    } finally {
      setGuardandoCrearEmpresa(false);
    }
  };

  /** Siguiente id libre del maestro de empresas (el alta rápida crea el registro con su id). */
  const próximoIdEmpresa = calcularProximoIdEmpresa(empresasGrupoParipe);

  const próximoId = calcularProximoIdLocal(locales);

  const seleccionarFila = (idx: number) => {
    setSelectedRowIndex((prev) => (prev === idx ? null : idx));
  };

  const toolbarSecundarios = [
    { id: 'editar' as const, label: 'Editar', icon: ICONS.edit },
    { id: 'borrar' as const, label: 'Borrar', icon: ICONS.delete },
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
    apiFetch('/api/locales')
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
    apiFetch('/api/empresas')
      .then((res) => res.json())
      .then((data: { empresas?: EmpresaItem[] }) => {
        const list = data.empresas || [];
        setEmpresasGrupoParipe(list);
      })
      .catch(() => setEmpresasGrupoParipe([]));
  }, []);

  const refetchAlmacenes = useCallback(() => {
    apiFetch('/api/almacenes')
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

  const inputStyle = [styles.formInput, isPhone && styles.formInputPhone];

  const renderCampo = (key: CampoFormKey, full?: boolean) => {
    const campo = CAMPOS_FORM.find((c) => c.key === key);
    if (!campo) return null;
    const wrapStyle = [
      styles.formGroup,
      formDosColumnas && (full ? styles.formFieldFull : styles.formFieldCol),
    ];

    if (key === 'Direccion') {
      return (
        <View
          key={key}
          style={[
            ...wrapStyle,
            styles.dropdownAnchor,
            direccionDropdownOpen && styles.dropdownAnchorOnTop,
          ]}
        >
          <Text style={styles.formLabel}>{campo.label}</Text>
          <View style={styles.direccionInputRow}>
            <TextInput
              style={[...inputStyle, { flex: 1 }]}
              value={formNuevo.Direccion ?? ''}
              onChangeText={onDireccionChange}
              onBlur={() => setTimeout(() => setDireccionDropdownOpen(false), 200)}
              placeholder="Escribe y elige una dirección…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
            />
            {formNuevo.Direccion ? (
              <TouchableOpacity
                style={styles.direccionVaciarBtn}
                onPress={() => setFormNuevo((prev) => ({ ...prev, Direccion: '', lat: '', lng: '' }))}
                activeOpacity={0.7}
              >
                <MaterialIcons name="clear" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
          {direccionLoading && (
            <View style={styles.direccionLoadingWrap}>
              <ActivityIndicator size="small" color={colors.accent} />
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
                    <MaterialIcons name="place" size={16} color={colors.textMuted} style={styles.direccionOptionIcon} />
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
      );
    }

    if (key === 'Empresa') {
      return (
        <View key={key} style={wrapStyle}>
          <Text style={styles.formLabel}>{campo.label}</Text>
          <SelectorDesplegable
            compact
            sinIconoTrigger
            icono="business"
            placeholder={`${campo.label}…`}
            tituloLista="Selecciona una empresa"
            iconoLista="business"
            buscador
            buscadorPlaceholder="Buscar empresa…"
            valorId={empresaIdVinculado}
            opciones={empresaOpciones}
            vacioTexto="Sin empresas"
            triggerStyle={inputStyle}
            triggerTextStyle={styles.formInputText}
            onSeleccionar={(id) => {
              if (id === CREAR_EMPRESA_OPCION_ID) {
                abrirModalCrearEmpresa();
                return;
              }
              const emp = empresasGrupoParipe.find((e) => normalizarIdEmpresa(e.id_empresa) === id);
              const nombre = (emp?.Nombre ?? '').trim();
              // Sin nombre el local guardaría el id de una empresa y el nombre de la anterior.
              if (!nombre) return;
              setFormNuevo((prev) => ({ ...prev, id_empresa: id, Empresa: nombre }));
            }}
          />
          {pistaEmpresa ? (
            <Text style={[styles.direccionHint, pistaEmpresa.aviso && styles.empresaHintAviso]}>
              {pistaEmpresa.texto}
            </Text>
          ) : null}
        </View>
      );
    }

    if (key === 'Almacen origen') {
      return (
        <View
          key={key}
          style={[
            ...wrapStyle,
            styles.dropdownAnchor,
            almacenDropdownOpen && styles.dropdownAnchorOnTop,
          ]}
        >
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
                  <MaterialIcons name="close" size={14} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity
              style={[...inputStyle, styles.formInputRow, styles.almacenAddBtn]}
              onPress={() => setAlmacenDropdownOpen((o) => !o)}
              activeOpacity={0.7}
            >
              <MaterialIcons name="add" size={18} color={colors.accent} style={{ marginRight: SPACING.xs }} />
              <Text style={[styles.formInputText, styles.almacenAddText]}>Añadir almacén</Text>
              <MaterialIcons name={almacenDropdownOpen ? 'expand-less' : 'expand-more'} size={18} color={colors.textMuted} style={styles.sedeChevron} />
            </TouchableOpacity>
          </View>
          {almacenDropdownOpen && (
            <View style={styles.empresaDropdownWrap}>
              <TextInput
                style={styles.empresaDropdownSearch}
                value={almacenSearchFilter}
                onChangeText={setAlmacenSearchFilter}
                placeholder="Buscar almacén…"
                placeholderTextColor={colors.textMuted}
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
                    <MaterialIcons name="clear" size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
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
      );
    }

    if (key === 'Sede') {
      return (
        <View key={key} style={wrapStyle}>
          <Text style={styles.formLabel}>{campo.label}</Text>
          <SelectorDesplegable
            compact
            sinIconoTrigger
            icono="location-city"
            placeholder={`${campo.label}…`}
            tituloLista="Selecciona una sede"
            iconoLista="location-city"
            buscador
            buscadorPlaceholder="Buscar sede…"
            valorId={formNuevo.Sede || ''}
            opciones={sedeOpciones}
            triggerStyle={inputStyle}
            triggerTextStyle={styles.formInputText}
            onSeleccionar={(id) => setFormNuevo((prev) => ({ ...prev, Sede: id }))}
          />
        </View>
      );
    }

    if (key === 'Imagen') {
      return (
        <View key={key} style={wrapStyle}>
          <Text style={styles.formLabel}>{campo.label}</Text>
          <TouchableOpacity
            style={styles.imagenButton}
            onPress={seleccionarFoto}
            disabled={imagenLoading}
            activeOpacity={0.7}
          >
            {imagenLoading ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <>
                <MaterialIcons name="add-photo-alternate" size={22} color={colors.accent} />
                <Text style={styles.imagenButtonText}>Seleccionar foto</Text>
              </>
            )}
          </TouchableOpacity>
          {formNuevo.Imagen ? (
            <View style={styles.imagenPreviewWrap}>
              <Image source={{ uri: formNuevo.Imagen }} style={styles.imagenPreview as ImageStyle} resizeMode="cover" />
              <TouchableOpacity style={styles.imagenQuitarBtn} onPress={quitarFoto} activeOpacity={0.7}>
                <MaterialIcons name="close" size={18} color={colors.surface} />
                <Text style={styles.imagenQuitarText}>Quitar</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      );
    }

    if (key === 'km_desplazamiento') {
      return (
        <View key={key} style={wrapStyle}>
          <Text style={styles.formLabel}>{campo.label}</Text>
          <TextInput
            style={inputStyle}
            value={formNuevo.km_desplazamiento ?? ''}
            onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, km_desplazamiento: t }))}
            placeholder="Ej. 12,5"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
          />
          <Text style={styles.direccionHint}>
            Kilómetros de ida desde la sede central hasta este local. Se usan para valorar el desplazamiento del técnico en Mantenimiento.
          </Text>
        </View>
      );
    }

    if (key === 'Cp') {
      return (
        <View key={key} style={wrapStyle}>
          <Text style={styles.formLabel}>{campo.label}</Text>
          <TextInput
            style={inputStyle}
            value={formNuevo.Cp ?? ''}
            onChangeText={handleCpChange}
            onBlur={handleCpBlur}
            placeholder={`${campo.label}…`}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
          />
        </View>
      );
    }

    return (
      <View key={key} style={wrapStyle}>
        <Text style={styles.formLabel}>{campo.label}</Text>
        <TextInput
          style={inputStyle}
          value={formNuevo[campo.key] ?? ''}
          onChangeText={(t) => setFormNuevo((prev) => ({ ...prev, [campo.key]: t }))}
          placeholder={`${campo.label}…`}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="words"
        />
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Cargando locales…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color={colors.danger} />
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={[styles.backBtn, isPhone && styles.backBtnPhone]}
          accessibilityLabel="Volver"
        >
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Locales</Text>
      </View>

      <View style={[styles.toolbarRow, shouldStackToolbar && styles.toolbarRowStacked]}>
        <View style={styles.toolbar}>
          <TouchableOpacity
            style={[styles.btnCrear, isPhone && styles.btnCrearPhone]}
            onPress={abrirModalNuevo}
            disabled={guardando}
            accessibilityLabel="Nuevo local"
          >
            <MaterialIcons name={ICONS.add} size={18} color={colors.surface} />
            <Text style={styles.btnCrearText}>Nuevo local</Text>
          </TouchableOpacity>
          {toolbarSecundarios.map((btn) => {
            const disabled = guardando || selectedRowIndex == null;
            return (
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
                {hoveredBtn === btn.id ? (
                  <View style={styles.tooltip}>
                    <Text style={styles.tooltipText}>{btn.label}</Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[
                    styles.toolbarBtn,
                    disabled && styles.toolbarBtnDisabled,
                    isPhone && styles.toolbarBtnPhone,
                  ]}
                  onPress={() => {
                    if (btn.id === 'editar' && selectedRowIndex != null) abrirModalEditar(localesFiltrados[selectedRowIndex]);
                    if (btn.id === 'borrar' && selectedRowIndex != null) borrarSeleccionado();
                  }}
                  disabled={disabled}
                  accessibilityLabel={btn.label}
                >
                  <MaterialIcons name={btn.icon} size={ICON_SIZE} color={disabled ? colors.textMuted : colors.textMuted} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
        <View style={[styles.searchWrap, shouldStackToolbar && styles.searchWrapStacked]}>
          <MaterialIcons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar en la tabla…"
            placeholderTextColor={colors.textMuted}
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
                    {labelColumna(col)}
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
                          <MaterialIcons name="image-not-supported" size={20} color={colors.textMuted} />
                        </View>
                      )}
                    </View>
                  );
                }
                const raw = valorCelda(local, col);
                const text = raw.length > MAX_TEXT_LENGTH ? truncar(raw) : raw;
                return (
                  <View key={col} style={[styles.cell, { width: getColWidth(col) }]}>
                    <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">
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
          <KeyboardAvoidingView
            style={[
              styles.modalWrap,
              formDosColumnas ? (isDesktop ? styles.modalWrapDesktop : styles.modalWrapTablet) : styles.modalWrapPhone,
              modalCasiFull && styles.modalWrapFull,
            ]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[styles.modalCardHost, modalCasiFull && styles.modalCardHostFull]}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <View style={styles.modalHeaderLeft}>
                    <Text style={styles.modalTitle} numberOfLines={1}>
                      {editingLocalId != null ? 'Editar local' : 'Nuevo local'}
                    </Text>
                    <Text style={styles.modalIdChip} numberOfLines={1}>
                      ID {formatId6(editingLocalId ?? próximoId)}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={cerrarModalNuevo} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
                <ScrollView
                  style={styles.modalBody}
                  contentContainerStyle={styles.modalBodyContent}
                  keyboardShouldPersistTaps="handled"
                >
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('Nombre')}
                    {renderCampo('AgoraCode')}
                  </View>
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('Empresa')}
                    {renderCampo('Sede')}
                  </View>
                  {renderCampo('Direccion', true)}
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('Cp')}
                    {renderCampo('Municipio')}
                  </View>
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('Provincia')}
                    {renderCampo('km_desplazamiento')}
                  </View>
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('lat')}
                    {renderCampo('lng')}
                  </View>
                  {renderCampo('Almacen origen', true)}
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('Imagen')}
                    {renderCampo('factorial_location_id')}
                  </View>
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('ratio_personal')}
                    {renderCampo('ratio_musicos')}
                  </View>
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    {renderCampo('ratio_mercaderia')}
                    {formDosColumnas ? <View style={styles.formFieldCol} /> : null}
                  </View>
                </ScrollView>
                {errorForm ? <Text style={styles.modalError}>{errorForm}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalBtnCancel} onPress={cerrarModalNuevo} disabled={guardando}>
                    <Text style={styles.modalBtnCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalBtnSave} onPress={guardarNuevo} disabled={guardando} accessibilityLabel="Guardar">
                    {guardando ? (
                      <ActivityIndicator size="small" color={colors.surface} />
                    ) : (
                      <Text style={styles.modalBtnSaveText}>Guardar</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>


      <Modal visible={modalCrearEmpresaVisible} transparent animationType="fade" onRequestClose={cerrarModalCrearEmpresa}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView
            style={[
              styles.modalWrap,
              formDosColumnas ? styles.modalWrapEmpresa : styles.modalWrapPhone,
            ]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardHostEmpresa}>
              <View style={styles.modalCardEmpresa}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Crear nueva empresa</Text>
                  <TouchableOpacity onPress={cerrarModalCrearEmpresa} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
                <View style={styles.modalBodyEmpresa}>
                  <View style={formDosColumnas ? styles.formRow2 : styles.formCol1}>
                    <View style={[styles.formGroup, formDosColumnas && styles.formFieldCol]}>
                      <Text style={styles.formLabel}>Nombre *</Text>
                      <TextInput
                        style={inputStyle}
                        value={formCrearEmpresa.Nombre}
                        onChangeText={(t) => setFormCrearEmpresa((prev) => ({ ...prev, Nombre: t }))}
                        placeholder="Nombre de la empresa"
                        placeholderTextColor={colors.textMuted}
                        autoCapitalize="words"
                      />
                    </View>
                    <View style={[styles.formGroup, formDosColumnas && styles.formFieldCol]}>
                      <Text style={styles.formLabel}>CIF *</Text>
                      <TextInput
                        style={inputStyle}
                        value={formCrearEmpresa.Cif}
                        onChangeText={(t) => setFormCrearEmpresa((prev) => ({ ...prev, Cif: t }))}
                        placeholder="CIF"
                        placeholderTextColor={colors.textMuted}
                        autoCapitalize="characters"
                      />
                    </View>
                  </View>
                </View>
                {errorCrearEmpresa ? <Text style={styles.modalError}>{errorCrearEmpresa}</Text> : null}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalBtnCancel} onPress={cerrarModalCrearEmpresa} activeOpacity={0.7}>
                    <Text style={styles.modalBtnCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalBtnSave}
                    onPress={guardarCrearEmpresa}
                    disabled={guardandoCrearEmpresa}
                    activeOpacity={0.7}
                  >
                    {guardandoCrearEmpresa ? (
                      <ActivityIndicator size="small" color={colors.surface} />
                    ) : (
                      <Text style={styles.modalBtnSaveText}>Crear</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: SPACING.md, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, backgroundColor: colors.bg },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.xs, gap: SPACING.sm },
  backBtn: {
    width: 36,
    height: 36,
    padding: 0,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  backBtnPhone: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
  },
  title: { fontSize: fontSizes[20], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, lineHeight: 26, color: colors.textStrong },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm, gap: SPACING.md, flexWrap: 'wrap' },
  toolbarRowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btnCrear: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIO_MEDIO,
  },
  btnCrearPhone: { minHeight: MIN_TOUCH },
  btnCrearText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 280,
    height: 32,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.sm,
  },
  searchWrapStacked: { maxWidth: '100%', width: '100%', flexGrow: 1 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textStrong, paddingVertical: 0 },
  toolbarBtnWrap: { position: 'relative' },
  /** El texto de 9 px sube al suelo de etiqueta (11). */
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: SPACING.xs,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
    borderRadius: 4,
    zIndex: 10,
  },
  tooltipText: { fontSize: typography.etiqueta.fontSize, color: colors.bg, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight },
  toolbarBtn: {
    padding: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  toolbarBtnPhone: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  toolbarBtnDisabled: { opacity: 0.6 },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginBottom: SPACING.sm },
  scroll: { flex: 1 },
  scrollContentVertical: { paddingBottom: 20 },
  scrollContentHorizontal: { paddingBottom: 20 },
  scrollVertical: { flex: 1 },
  tableWrapper: { borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, overflow: 'hidden', backgroundColor: colors.surface },
  rowHeader: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: SPACING.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    position: 'relative',
  },
  cellHeaderText: {
    fontSize: typography.etiqueta.fontSize,
    fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight,
    lineHeight: 14,
    letterSpacing: 0.1,
    color: colors.textMuted,
    textTransform: 'none',
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  rowSelected: {
    backgroundColor: colors.accentMuted,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
  },
  cell: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellText: { fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, lineHeight: 16, color: colors.textPrimary, textAlign: 'center', alignSelf: 'stretch' },
  cellThumbnail: { alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 10 },
  thumbnailImg: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.border },
  thumbnailPlaceholder: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  /** Más oscuro que colors.overlay. */
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalWrap: { flex: 1, maxHeight: '100%', justifyContent: 'center' },
  modalWrapDesktop: { maxWidth: 720, width: '100%', padding: 24 },
  modalWrapTablet: { maxWidth: 640, width: '100%', padding: 20 },
  modalWrapPhone: { maxWidth: '100%', width: '100%', padding: SPACING.md },
  modalWrapFull: { maxWidth: '100%', paddingHorizontal: SPACING.md },
  modalWrapEmpresa: { maxWidth: 520, width: '100%', padding: 20 },
  modalCardHost: { width: '100%', height: '88%', maxHeight: '88%' },
  modalCardHostFull: { height: '92%', maxHeight: '92%' },
  modalCardHostEmpresa: { width: '100%' },
  modalCard: {
    width: '100%',
    flex: 1,
    minHeight: 0,
    maxHeight: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalCardEmpresa: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexShrink: 0,
  },
  modalHeaderLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  modalTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textStrong, flexShrink: 1, minWidth: 0 },
  modalIdChip: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textMuted, flexShrink: 0 },
  modalClose: { padding: 4 },
  modalBody: { flex: 1, minHeight: 0, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md },
  modalBodyContent: { paddingBottom: 4 },
  modalBodyEmpresa: { paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md },
  formRow2: { flexDirection: 'row', gap: SPACING.md, alignItems: 'flex-start' },
  formCol1: { flexDirection: 'column' },
  formFieldCol: { flex: 1, minWidth: 0 },
  formFieldFull: { width: '100%' },
  formGroup: { marginBottom: 10 },
  formLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textMuted, marginBottom: SPACING.xs },
  formInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: 10,
    paddingVertical: SPACING.sm,
    fontSize: fontSizes[12],
    fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight,
    color: colors.textPrimary,
    minHeight: 36,
  },
  formInputPhone: { minHeight: MIN_TOUCH },
  formInputRow: { flexDirection: 'row', alignItems: 'center' },
  formInputText: { fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.textStrong, flex: 1 },
  formInputPlaceholder: { color: colors.textMuted },
  sedeChevron: { marginLeft: 4 },
  sedeDropdown: { marginTop: SPACING.xs, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, overflow: 'hidden', maxHeight: 120 },
  sedeOption: { paddingVertical: SPACING.sm, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.navActive },
  sedeOptionText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary },
  empresaDropdownWrap: {
    marginTop: SPACING.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    overflow: 'hidden',
    maxHeight: 200,
    zIndex: 31,
    ...(Platform.OS === 'web' ? ({ boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } as object) : { elevation: 16 }),
  },
  empresaDropdownSearch: { paddingVertical: 6, paddingHorizontal: SPACING.sm, fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary, backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: colors.border },
  empresaDropdownScroll: { maxHeight: 150 },
  empresaDropdownOption: { paddingVertical: 5, paddingHorizontal: SPACING.sm, borderBottomWidth: 1, borderBottomColor: colors.navActive },
  empresaDropdownOptionText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary },
  dropdownVaciarOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg, borderBottomColor: colors.border },
  dropdownVaciarText: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  dropdownAnchor: { position: 'relative', zIndex: 1, overflow: 'visible' },
  dropdownAnchorOnTop: { zIndex: 30, ...(Platform.OS !== 'web' ? { elevation: 12 } : {}) },
  direccionInputRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  direccionVaciarBtn: { padding: 6, backgroundColor: colors.navActive, borderRadius: RADIO_MEDIO, borderWidth: 1, borderColor: colors.border },
  direccionLoadingWrap: { marginTop: SPACING.xs, paddingVertical: SPACING.xs, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  direccionLoadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  direccionHint: { marginTop: SPACING.xs, fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
  empresaHintAviso: { color: colors.warning },
  direccionDropdown: {
    marginTop: SPACING.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    maxHeight: 200,
    overflow: 'hidden',
    zIndex: 31,
    ...(Platform.OS === 'web' ? ({ boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } as object) : { elevation: 16 }),
  },
  direccionDropdownScroll: { maxHeight: 150 },
  direccionOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, paddingHorizontal: SPACING.sm, borderBottomWidth: 1, borderBottomColor: colors.navActive },
  direccionOptionIcon: { marginRight: SPACING.sm },
  direccionOptionText: { flex: 1, fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textPrimary },
  almacenChipsWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  almacenChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.accentMuted, borderWidth: 1, borderColor: '#bae6fd', borderRadius: RADIO_MEDIO, paddingVertical: SPACING.xs, paddingLeft: SPACING.sm, paddingRight: SPACING.xs, maxWidth: 180 },
  almacenChipText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: '#0c4a6e', flex: 1 },
  almacenChipRemove: { padding: 2 },
  almacenAddBtn: { alignSelf: 'flex-start', minWidth: 140 },
  almacenAddText: { color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  imagenButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, paddingVertical: 10, paddingHorizontal: SPACING.md, backgroundColor: colors.accentMuted, borderWidth: 1, borderColor: '#bae6fd', borderRadius: RADIO_MEDIO },
  imagenButtonText: { fontSize: fontSizes[13], color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  imagenPreviewWrap: { marginTop: SPACING.sm, position: 'relative', alignSelf: 'flex-start' },
  imagenPreview: { width: 120, height: 120, borderRadius: RADIO_MEDIO, backgroundColor: colors.border },
  /** Más oscuro que colors.overlay. */
  imagenQuitarBtn: { position: 'absolute', top: 4, right: 4, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: SPACING.xs, paddingHorizontal: SPACING.sm, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: radius.sm },
  imagenQuitarText: { fontSize: typography.etiqueta.fontSize, color: colors.surface, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  modalError: { fontSize: fontSizes[12], fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight, color: colors.danger, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.xs, flexShrink: 0 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    flexShrink: 0,
  },
  modalBtnCancel: { paddingVertical: 10, paddingHorizontal: SPACING.lg },
  modalBtnCancelText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted },
  modalBtnSave: {
    backgroundColor: colors.accent,
    paddingVertical: 10,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.sm,
    minWidth: 100,
    alignItems: 'center',
  },
  modalBtnSaveText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },
});
