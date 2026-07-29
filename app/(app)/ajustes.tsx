import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
  Switch,
  useWindowDimensions,
  Platform,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../utils/api';
import { EnlacesPlanningPanel } from '../components/ajustes/EnlacesPlanningPanel';
import { SelectorDesplegable } from '../components/SelectorDesplegable';
import { settingsCardWidth } from '../constants/layout';
import { useTarifasMantenimiento } from '../hooks/useTarifasMantenimiento';
import {
  useAjustesFacturacionMantenimiento,
  horaValida,
  DIA_GENERACION_DEFECTO,
  HORA_DEFECTO,
} from '../hooks/useAjustesFacturacionMantenimiento';
import { useAjustesFacturacionCompras } from '../hooks/useAjustesFacturacionCompras';
import { normalizarIdEmpresa, type EmpresaMaestro } from '../lib/empresaId';
import { labelPeriodo } from '../lib/facturacionPeriodica';
import type { SerieFactura } from '../utils/facturacion';

/** Límite aproximado para caber en un ítem DynamoDB (~400 KB con base64). */
const MAX_IMAGEN_BASE64_LENGTH = 380000;

type SyncConfig = {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  endpoint: string;
  permiso: string;
  descripcion: string;
  bodyBuilder?: () => Record<string, unknown>;
};

const SYNC_ITEMS: SyncConfig[] = [
  {
    id: 'agora_productos',
    label: 'Productos Agora',
    icon: 'inventory-2',
    endpoint: '/api/agora/products/sync',
    permiso: 'ajustes.sincronizaciones.agora_productos',
    descripcion: 'Sincroniza productos desde Agora al sistema local',
    bodyBuilder: () => ({ force: true }),
  },
  {
    id: 'agora_usuarios',
    label: 'Usuarios Agora',
    icon: 'person-pin',
    endpoint: '/api/agora/users/sync',
    permiso: 'ajustes.sincronizaciones.agora_usuarios',
    descripcion: 'Sincroniza usuarios (cajeros/operadores) desde Agora',
    bodyBuilder: () => ({ force: true }),
  },
  {
    id: 'compras_proveedor',
    label: 'Compras a Proveedor',
    icon: 'local-shipping',
    endpoint: '/api/agora/purchases/sync',
    permiso: 'ajustes.sincronizaciones.compras_proveedor',
    descripcion: 'Importa albaranes de entrada desde Agora (últimos 60 días)',
  },
  {
    id: 'closeouts',
    label: 'Cierres de Caja',
    icon: 'point-of-sale',
    endpoint: '/api/agora/closeouts/sync',
    permiso: 'ajustes.sincronizaciones.closeouts',
    descripcion: 'Sincroniza cierres de caja desde Agora',
  },
  {
    id: 'almacenes',
    label: 'Almacenes',
    icon: 'warehouse',
    endpoint: '/api/agora/warehouses/sync',
    permiso: 'ajustes.sincronizaciones.almacenes',
    descripcion: 'Sincroniza almacenes desde Agora',
  },
  {
    id: 'empleados_factorial',
    label: 'Empleados',
    icon: 'badge',
    endpoint: '/api/personal/employees/sync',
    permiso: 'ajustes.sincronizaciones.empleados',
    descripcion: 'Sincroniza empleados desde Factorial HR',
  },
  {
    id: 'formas_pago',
    label: 'Formas de Pago',
    icon: 'account-balance-wallet',
    endpoint: '/api/agora/payment-methods/sync',
    permiso: 'ajustes.sincronizaciones.closeouts',
    descripcion: 'Detecta y registra nuevas formas de pago desde Agora',
  },
];

/** Opciones de rango (en días naturales, terminando hoy) para el sync manual de ventas por producto. */
const VENTAS_SYNC_DAY_OPTIONS = [3, 5, 10] as const;

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABELS: Record<string, string> = {
  mon: 'L', tue: 'M', wed: 'X', thu: 'J', fri: 'V', sat: 'S', sun: 'D',
};

/** Roles que pueden recibir el informe diario (coincide con ROLES_VALIDOS del backend). */
const ROLES_INFORME = ['Administrador', 'SuperUser', 'Administracion', 'Local', 'Socio', 'Marketing'];

type SyncState = {
  syncing: boolean;
  result: string | null;
  error: string | null;
  lastSync: string | null;
  enabled: boolean;
  days: string[];
  times: string[];
  frequencyMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
};

type AjusteItem = {
  PK: string;
  SK: string;
  Nombre?: string;
  UltimaSync?: string;
  Estado?: string;
  Resultado?: string;
  Enabled?: boolean;
  Days?: string[];
  Times?: string[];
  FrequencyMinutes?: number | null;
  StartTime?: string | null;
  EndTime?: string | null;
  updatedAt?: string;
};

const defaultState = (): SyncState => ({
  syncing: false,
  result: null,
  error: null,
  lastSync: null,
  enabled: false,
  days: [],
  times: [],
  frequencyMinutes: null,
  startTime: null,
  endTime: null,
});

export default function AjustesScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { width: winWidth } = useWindowDimensions();

  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>(() => {
    const initial: Record<string, SyncState> = {};
    SYNC_ITEMS.forEach((s) => { initial[s.id] = defaultState(); });
    return initial;
  });

  const [loadingAjustes, setLoadingAjustes] = useState(true);

  const [imagenApp, setImagenApp] = useState('');
  const [porcentajeBeneficio, setPorcentajeBeneficio] = useState('');
  const [importeHoraDefecto, setImporteHoraDefecto] = useState('');
  const [loadingPersonalizacion, setLoadingPersonalizacion] = useState(true);
  const [guardandoPersonalizacion, setGuardandoPersonalizacion] = useState(false);
  const [imagenLoading, setImagenLoading] = useState(false);
  const [errorPersonalizacion, setErrorPersonalizacion] = useState<string | null>(null);

  // --- Tarifas de mantenimiento (PK='mantenimiento' / SK='desplazamiento') ---
  const {
    tarifas: tarifasMantenimiento,
    loading: loadingMantenimiento,
    error: errorCargaMantenimiento,
    guardar: guardarTarifasMantenimiento,
  } = useTarifasMantenimiento();
  const [precioKm, setPrecioKm] = useState('');
  const [importeHoraMantenimiento, setImporteHoraMantenimiento] = useState('');
  const [guardandoMantenimiento, setGuardandoMantenimiento] = useState(false);
  const [errorMantenimiento, setErrorMantenimiento] = useState<string | null>(null);

  // --- Facturación de mantenimiento (PK='mantenimiento' / SK='facturacion') ---
  const puedeAjustes = hasPermiso('ajustes.ver');
  /**
   * El backend exige `mantenimiento.facturar` para guardar este ajuste, mientras
   * el panel se ve con `ajustes.ver`. La configuración (quién emite, con qué
   * serie, si está activa) es útil de consultar, así que sin ese permiso se
   * muestra en solo lectura y sin ningún control que invite a guardar.
   */
  const facturacionSoloLectura = !hasPermiso('mantenimiento.facturar');
  const {
    ajustes: ajustesFacturacion,
    loading: loadingFacturacion,
    error: errorCargaFacturacion,
    guardar: guardarAjustesFacturacion,
  } = useAjustesFacturacionMantenimiento();
  const [facEmpresa, setFacEmpresa] = useState('');
  const [facSerie, setFacSerie] = useState('');
  const [facDia, setFacDia] = useState('');
  const [facHora, setFacHora] = useState('');
  const [facCondiciones, setFacCondiciones] = useState('');
  const [facEnabled, setFacEnabled] = useState(false);
  const [guardandoFacturacion, setGuardandoFacturacion] = useState(false);
  const [errorFacturacion, setErrorFacturacion] = useState<string | null>(null);
  const [empresasFacturacion, setEmpresasFacturacion] = useState<EmpresaMaestro[]>([]);
  const [loadingEmpresasFacturacion, setLoadingEmpresasFacturacion] = useState(true);
  const [seriesFacturacion, setSeriesFacturacion] = useState<SerieFactura[]>([]);
  const [loadingSeriesFacturacion, setLoadingSeriesFacturacion] = useState(true);

  // --- Facturación de ventas internas (PK='compras' / SK='facturacion') ---
  /** Mismo criterio que en mantenimiento: se consulta con `ajustes.ver`, se cambia con el permiso del módulo. */
  const comprasSoloLectura = !hasPermiso('compras.facturar');
  const {
    ajustes: ajustesCompras,
    ultimoPeriodoGenerado: ultimoPeriodoCompras,
    loading: loadingCompras,
    error: errorCargaCompras,
    guardar: guardarAjustesCompras,
  } = useAjustesFacturacionCompras();
  const [comEmpresaAlmacen, setComEmpresaAlmacen] = useState('');
  const [comSerieVentas, setComSerieVentas] = useState('');
  const [comSerieRappel, setComSerieRappel] = useState('');
  const [comDia, setComDia] = useState('');
  const [comHora, setComHora] = useState('');
  const [comCondiciones, setComCondiciones] = useState('');
  const [comEnabled, setComEnabled] = useState(false);
  const [guardandoCompras, setGuardandoCompras] = useState(false);
  const [errorCompras, setErrorCompras] = useState<string | null>(null);

  // --- Modal de configuración ---
  const [configModalId, setConfigModalId] = useState<string | null>(null);
  const [cfgEnabled, setCfgEnabled] = useState(false);
  const [cfgDays, setCfgDays] = useState<string[]>([]);
  const [cfgTimes, setCfgTimes] = useState<string[]>([]);
  const [cfgNewTime, setCfgNewTime] = useState('');
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgTimeError, setCfgTimeError] = useState<string | null>(null);

  // --- Informe diario por email ---
  const [infLoading, setInfLoading] = useState(true);
  const [infEnabled, setInfEnabled] = useState(false);
  const [infDays, setInfDays] = useState<string[]>([]);
  const [infTimes, setInfTimes] = useState<string[]>([]);
  const [infNewTime, setInfNewTime] = useState('');
  const [infTimeError, setInfTimeError] = useState<string | null>(null);
  const [infRoles, setInfRoles] = useState<string[]>([]);
  const [infTopLimit, setInfTopLimit] = useState('10');
  const [infSaving, setInfSaving] = useState(false);
  const [infForcing, setInfForcing] = useState(false);
  const [infDownloading, setInfDownloading] = useState(false);
  const [infResult, setInfResult] = useState<string | null>(null);
  const [infError, setInfError] = useState<string | null>(null);
  const [infLastRun, setInfLastRun] = useState<string | null>(null);
  const [infDestCount, setInfDestCount] = useState<number | null>(null);

  // --- Sync manual de ventas por producto (incentivos) ---
  const puedeVentasSync = hasPermiso('ajustes.sincronizaciones.ventas_producto');
  const [ventasSyncDays, setVentasSyncDays] = useState<number>(3);
  const [ventasSyncing, setVentasSyncing] = useState(false);
  const [ventasSyncResult, setVentasSyncResult] = useState<string | null>(null);
  const [ventasSyncError, setVentasSyncError] = useState<string | null>(null);
  const [ventasSyncLast, setVentasSyncLast] = useState<string | null>(null);

  const cargarEstados = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ajustes?categoria=sincronizaciones');
      const data = await res.json();
      if (data.ok && Array.isArray(data.items)) {
        setSyncStates((prev) => {
          const next = { ...prev };
          for (const item of data.items as AjusteItem[]) {
            const id = item.SK;
            if (next[id]) {
              next[id] = {
                ...next[id],
                lastSync: item.UltimaSync || item.updatedAt || null,
                result: item.Resultado || null,
                error: item.Estado === 'error' ? (item.Resultado || 'Error desconocido') : null,
                enabled: item.Enabled ?? false,
                days: Array.isArray(item.Days) ? item.Days : [],
                times: Array.isArray(item.Times) ? item.Times : [],
                frequencyMinutes: item.FrequencyMinutes ?? null,
                startTime: item.StartTime ?? null,
                endTime: item.EndTime ?? null,
              };
            }
          }
          return next;
        });
      }
    } catch (_) {}
    setLoadingAjustes(false);
  }, []);

  const cargarPersonalizacion = useCallback(async () => {
    setLoadingPersonalizacion(true);
    setErrorPersonalizacion(null);
    try {
      const res = await apiFetch('/api/ajustes/personalizacion/app');
      const data = await res.json();
      if (res.ok && data.ok && data.item) {
        const it = data.item as { ImagenApp?: string; PorcentajeBeneficio?: number; ImporteHoraDefecto?: number };
        setImagenApp(typeof it.ImagenApp === 'string' ? it.ImagenApp : '');
        setPorcentajeBeneficio(
          it.PorcentajeBeneficio != null && !Number.isNaN(Number(it.PorcentajeBeneficio))
            ? String(it.PorcentajeBeneficio)
            : ''
        );
        setImporteHoraDefecto(
          it.ImporteHoraDefecto != null && !Number.isNaN(Number(it.ImporteHoraDefecto))
            ? String(it.ImporteHoraDefecto)
            : ''
        );
      } else {
        setImagenApp('');
        setPorcentajeBeneficio('');
        setImporteHoraDefecto('');
      }
    } catch (_) {
      setImagenApp('');
      setPorcentajeBeneficio('');
      setImporteHoraDefecto('');
    } finally {
      setLoadingPersonalizacion(false);
    }
  }, []);

  useEffect(() => { cargarEstados(); }, [cargarEstados]);
  useEffect(() => { cargarPersonalizacion(); }, [cargarPersonalizacion]);

  const seleccionarImagenApp = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        setErrorPersonalizacion('Se necesita permiso para acceder a la galería');
        return;
      }
      setImagenLoading(true);
      setErrorPersonalizacion(null);
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
        setImagenApp(`data:image/jpeg;base64,${manipulated.base64}`);
      }
    } catch (_) {
      setErrorPersonalizacion('No se pudo cargar la imagen');
    } finally {
      setImagenLoading(false);
    }
  }, []);

  const quitarImagenApp = useCallback(() => {
    setImagenApp('');
  }, []);

  const guardarPersonalizacion = useCallback(async () => {
    setGuardandoPersonalizacion(true);
    setErrorPersonalizacion(null);
    try {
      const pctRaw = porcentajeBeneficio.trim().replace(',', '.');
      let porcentajeNum: number | null = null;
      if (pctRaw !== '') {
        const n = parseFloat(pctRaw);
        if (Number.isNaN(n) || n < 0 || n > 100) {
          setErrorPersonalizacion('El porcentaje debe ser un número entre 0 y 100');
          setGuardandoPersonalizacion(false);
          return;
        }
        porcentajeNum = Math.round(n * 100) / 100;
      }
      const impRaw = importeHoraDefecto.trim().replace(',', '.');
      let importeHoraNum: number | null = null;
      if (impRaw !== '') {
        const n = parseFloat(impRaw);
        if (Number.isNaN(n) || n < 0) {
          setErrorPersonalizacion('El importe por hora debe ser un número mayor o igual que 0');
          setGuardandoPersonalizacion(false);
          return;
        }
        importeHoraNum = Math.round(n * 100) / 100;
      }
      const res = await apiFetch('/api/ajustes', {
        method: 'POST',
        body: JSON.stringify({
          PK: 'personalizacion',
          SK: 'app',
          Nombre: 'Personalización',
          ImagenApp: imagenApp.trim(),
          PorcentajeBeneficio: porcentajeNum,
          ImporteHoraDefecto: importeHoraNum,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setErrorPersonalizacion(data.error || 'No se pudo guardar');
        return;
      }
    } catch (_) {
      setErrorPersonalizacion('Error de conexión al guardar');
    } finally {
      setGuardandoPersonalizacion(false);
    }
  }, [imagenApp, porcentajeBeneficio, importeHoraDefecto]);

  // Las tarifas se editan como texto (coma decimal); el hook manda mientras carga
  // o tras guardar, así el formulario nunca queda en blanco.
  useEffect(() => {
    if (loadingMantenimiento) return;
    setPrecioKm(String(tarifasMantenimiento.precioKm).replace('.', ','));
    setImporteHoraMantenimiento(String(tarifasMantenimiento.importeHora).replace('.', ','));
  }, [loadingMantenimiento, tarifasMantenimiento.precioKm, tarifasMantenimiento.importeHora]);

  const guardarMantenimiento = useCallback(async () => {
    const leer = (v: string): number | null => {
      const n = parseFloat(v.trim().replace(',', '.'));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
    };
    const km = leer(precioKm);
    const hora = leer(importeHoraMantenimiento);
    if (km == null || hora == null) {
      setErrorMantenimiento('El precio por kilómetro y el importe por hora deben ser números mayores que 0');
      return;
    }
    setGuardandoMantenimiento(true);
    setErrorMantenimiento(null);
    const err = await guardarTarifasMantenimiento({ precioKm: km, importeHora: hora });
    setErrorMantenimiento(err);
    setGuardandoMantenimiento(false);
  }, [precioKm, importeHoraMantenimiento, guardarTarifasMantenimiento]);

  // La empresa emisora y la serie se eligen de sus maestros, no se teclean.
  useEffect(() => {
    if (!puedeAjustes) return;
    let vivo = true;
    (async () => {
      try {
        const res = await apiFetch('/api/empresas');
        const data = await res.json();
        if (vivo && res.ok && Array.isArray(data.empresas)) setEmpresasFacturacion(data.empresas);
      } catch (_) {
      } finally {
        if (vivo) setLoadingEmpresasFacturacion(false);
      }
    })();
    (async () => {
      try {
        const res = await apiFetch('/api/facturacion/series');
        const data = await res.json();
        const lista = Array.isArray(data.series) ? data.series : Array.isArray(data) ? data : [];
        if (vivo) setSeriesFacturacion(lista as SerieFactura[]);
      } catch (_) {
      } finally {
        if (vivo) setLoadingSeriesFacturacion(false);
      }
    })();
    return () => { vivo = false; };
  }, [puedeAjustes]);

  // El hook manda mientras carga o tras guardar: el formulario nunca queda vacío
  // aunque el ajuste todavía no exista en la base de datos.
  useEffect(() => {
    if (loadingFacturacion) return;
    setFacEmpresa(ajustesFacturacion.idEmpresaEmisora);
    setFacSerie(ajustesFacturacion.serie);
    setFacDia(String(ajustesFacturacion.diaGeneracion));
    setFacHora(ajustesFacturacion.hora);
    setFacCondiciones(ajustesFacturacion.condicionesPago);
    setFacEnabled(ajustesFacturacion.enabled);
  }, [loadingFacturacion, ajustesFacturacion]);

  /** Sociedades del maestro, ordenadas por nombre y con su id de 6 dígitos. */
  const opcionesEmpresaFacturacion = useMemo(
    () =>
      empresasFacturacion
        .map((e) => {
          const id = normalizarIdEmpresa(e.id_empresa);
          const cif = String(e.Cif ?? '').trim();
          return {
            id,
            titulo: String(e.Nombre ?? '').trim() || `Empresa ${id}`,
            subtitulo: cif ? `${id} · ${cif}` : id,
          };
        })
        .filter((o) => o.id !== '')
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    [empresasFacturacion],
  );

  /** Solo series de venta activas: la sede central emite, no recibe. */
  const opcionesSerieFacturacion = useMemo(
    () =>
      seriesFacturacion
        .filter((s) => s.tipo === 'OUT' && s.activa !== false)
        .map((s) => ({
          id: s.serie,
          titulo: s.serie,
          subtitulo: String(s.descripcion ?? '').trim() || undefined,
        })),
    [seriesFacturacion],
  );

  /** Sociedad emisora con nombre, para el modo de solo lectura. */
  const nombreSociedadFacturacion = useMemo(() => {
    const opcion = opcionesEmpresaFacturacion.find((o) => o.id === facEmpresa);
    return opcion ? `${opcion.titulo} · ${opcion.id}` : facEmpresa;
  }, [opcionesEmpresaFacturacion, facEmpresa]);

  const empresaFacturacionDesconocida =
    !loadingEmpresasFacturacion &&
    facEmpresa !== '' &&
    !opcionesEmpresaFacturacion.some((o) => o.id === facEmpresa);
  const serieFacturacionDesconocida =
    !loadingSeriesFacturacion &&
    facSerie !== '' &&
    !opcionesSerieFacturacion.some((o) => o.id === facSerie);

  const guardarFacturacionMantenimiento = useCallback(async () => {
    const empresa = normalizarIdEmpresa(facEmpresa);
    if (!empresa) {
      setErrorFacturacion('Selecciona la sociedad que emite las facturas');
      return;
    }
    if (!facSerie.trim()) {
      setErrorFacturacion('Selecciona la serie de facturación');
      return;
    }
    const diaNum = parseInt(facDia.trim(), 10);
    if (!Number.isFinite(diaNum) || diaNum < 1 || diaNum > 31) {
      setErrorFacturacion('El día de generación debe ser un número entre 1 y 31');
      return;
    }
    if (!horaValida(facHora.trim())) {
      setErrorFacturacion('La hora debe tener el formato HH:MM (por ejemplo, 06:00)');
      return;
    }
    setGuardandoFacturacion(true);
    setErrorFacturacion(null);
    const err = await guardarAjustesFacturacion({
      idEmpresaEmisora: empresa,
      serie: facSerie.trim(),
      diaGeneracion: diaNum,
      hora: facHora.trim(),
      condicionesPago: facCondiciones.trim(),
      enabled: facEnabled,
    });
    setErrorFacturacion(err);
    setGuardandoFacturacion(false);
  }, [facEmpresa, facSerie, facDia, facHora, facCondiciones, facEnabled, guardarAjustesFacturacion]);

  // Mismo criterio que en mantenimiento: el hook manda mientras carga o tras
  // guardar, así el formulario nunca queda vacío aunque el ajuste no exista.
  useEffect(() => {
    if (loadingCompras) return;
    setComEmpresaAlmacen(ajustesCompras.idEmpresaAlmacenGeneral);
    setComSerieVentas(ajustesCompras.serieVentas);
    setComSerieRappel(ajustesCompras.serieRappel);
    setComDia(String(ajustesCompras.diaGeneracion));
    setComHora(ajustesCompras.hora);
    setComCondiciones(ajustesCompras.condicionesPago);
    setComEnabled(ajustesCompras.enabled);
  }, [loadingCompras, ajustesCompras]);

  /** Sociedad del Almacén General con nombre, para el modo de solo lectura. */
  const nombreSociedadAlmacen = useMemo(() => {
    const opcion = opcionesEmpresaFacturacion.find((o) => o.id === comEmpresaAlmacen);
    return opcion ? `${opcion.titulo} · ${opcion.id}` : comEmpresaAlmacen;
  }, [opcionesEmpresaFacturacion, comEmpresaAlmacen]);

  const empresaAlmacenDesconocida =
    !loadingEmpresasFacturacion &&
    comEmpresaAlmacen !== '' &&
    !opcionesEmpresaFacturacion.some((o) => o.id === comEmpresaAlmacen);
  const serieVentasDesconocida =
    !loadingSeriesFacturacion &&
    comSerieVentas !== '' &&
    !opcionesSerieFacturacion.some((o) => o.id === comSerieVentas);
  const serieRappelDesconocida =
    !loadingSeriesFacturacion &&
    comSerieRappel !== '' &&
    !opcionesSerieFacturacion.some((o) => o.id === comSerieRappel);

  const guardarFacturacionCompras = useCallback(async () => {
    const empresa = normalizarIdEmpresa(comEmpresaAlmacen);
    if (!empresa) {
      setErrorCompras('Selecciona la sociedad que emite las facturas del Almacén General');
      return;
    }
    if (!comSerieVentas.trim()) {
      setErrorCompras('Selecciona la serie de las facturas de ventas internas');
      return;
    }
    if (!comSerieRappel.trim()) {
      setErrorCompras('Selecciona la serie de los abonos de rappel');
      return;
    }
    const diaNum = parseInt(comDia.trim(), 10);
    if (!Number.isFinite(diaNum) || diaNum < 1 || diaNum > 31) {
      setErrorCompras('El día de generación debe ser un número entre 1 y 31');
      return;
    }
    if (!horaValida(comHora.trim())) {
      setErrorCompras('La hora debe tener el formato HH:MM (por ejemplo, 06:00)');
      return;
    }
    setGuardandoCompras(true);
    setErrorCompras(null);
    const err = await guardarAjustesCompras({
      idEmpresaAlmacenGeneral: empresa,
      serieVentas: comSerieVentas.trim(),
      serieRappel: comSerieRappel.trim(),
      diaGeneracion: diaNum,
      hora: comHora.trim(),
      condicionesPago: comCondiciones.trim(),
      enabled: comEnabled,
    });
    setErrorCompras(err);
    setGuardandoCompras(false);
  }, [
    comEmpresaAlmacen,
    comSerieVentas,
    comSerieRappel,
    comDia,
    comHora,
    comCondiciones,
    comEnabled,
    guardarAjustesCompras,
  ]);

  const ejecutarSync = useCallback(async (item: SyncConfig) => {
    setSyncStates((prev) => ({
      ...prev,
      [item.id]: { ...prev[item.id], syncing: true, result: null, error: null },
    }));

    try {
      const body = item.bodyBuilder ? item.bodyBuilder() : {};
      const res = await apiFetch(item.endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();

      let resultMsg = '';
      if (data.skipped) {
        resultMsg = data.message || 'Sincronización omitida (reciente)';
      } else if (data.added != null || data.updated != null || data.unchanged != null) {
        resultMsg = `Añadidos: ${data.added ?? 0} | Actualizados: ${data.updated ?? 0} | Sin cambios: ${data.unchanged ?? 0}`;
      } else if (data.totalUpserted != null) {
        resultMsg = `Registros sincronizados: ${data.totalUpserted}`;
      } else if (data.totalFetched != null) {
        resultMsg = `Registros obtenidos: ${data.totalFetched} | Guardados: ${data.totalUpserted ?? 0}`;
      } else if (data.upserted != null) {
        resultMsg = `Sincronizados: ${data.upserted}`;
      } else {
        resultMsg = data.ok ? 'Sincronización completada' : (data.error || 'Error desconocido');
      }

      const ahora = new Date().toISOString();
      setSyncStates((prev) => ({
        ...prev,
        [item.id]: {
          ...prev[item.id],
          syncing: false,
          result: resultMsg,
          error: data.ok ? null : (data.error || 'Error'),
          lastSync: data.ok ? ahora : prev[item.id].lastSync,
        },
      }));

      try {
        await apiFetch('/api/ajustes', {
          method: 'POST',
          body: JSON.stringify({
            PK: 'sincronizaciones',
            SK: item.id,
            Nombre: item.label,
            UltimaSync: ahora,
            Estado: data.ok ? 'ok' : 'error',
            Resultado: resultMsg,
          }),
        });
      } catch (_) {}
    } catch (err: any) {
      setSyncStates((prev) => ({
        ...prev,
        [item.id]: {
          ...prev[item.id],
          syncing: false,
          result: null,
          error: err?.message || 'Error de conexión',
        },
      }));
    }
  }, []);

  // --- Config modal helpers ---
  const abrirConfig = useCallback((id: string) => {
    const st = syncStates[id] ?? defaultState();
    setCfgEnabled(st.enabled);
    setCfgDays([...st.days]);
    setCfgTimes([...st.times].sort());
    setCfgNewTime('');
    setCfgTimeError(null);
    setConfigModalId(id);
  }, [syncStates]);

  const toggleDay = useCallback((day: string) => {
    setCfgDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  }, []);

  const addTime = useCallback(() => {
    const t = cfgNewTime.trim();
    if (!/^\d{2}:\d{2}$/.test(t)) {
      setCfgTimeError('Formato: HH:MM');
      return;
    }
    const [hh, mm] = t.split(':').map(Number);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      setCfgTimeError('Hora inválida');
      return;
    }
    if (cfgTimes.includes(t)) {
      setCfgTimeError('Ya existe');
      return;
    }
    setCfgTimes((prev) => [...prev, t].sort());
    setCfgNewTime('');
    setCfgTimeError(null);
  }, [cfgNewTime, cfgTimes]);

  const removeTime = useCallback((t: string) => {
    setCfgTimes((prev) => prev.filter((x) => x !== t));
  }, []);

  const guardarConfig = useCallback(async () => {
    if (!configModalId) return;
    setCfgSaving(true);
    try {
      await apiFetch(`/api/ajustes/sincronizaciones/${configModalId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          Enabled: cfgEnabled,
          Days: cfgDays,
          Times: cfgTimes,
        }),
      });
      setSyncStates((prev) => ({
        ...prev,
        [configModalId]: {
          ...prev[configModalId],
          enabled: cfgEnabled,
          days: [...cfgDays],
          times: [...cfgTimes],
        },
      }));
      setConfigModalId(null);
    } catch (_) {}
    setCfgSaving(false);
  }, [configModalId, cfgEnabled, cfgDays, cfgTimes]);

  // --- Informe diario: cargar / guardar / forzar envío ---
  const cargarInforme = useCallback(async () => {
    setInfLoading(true);
    try {
      const res = await apiFetch('/api/ajustes/informes/informe_diario');
      const data = await res.json();
      if (res.ok && data.ok && data.item) {
        const it = data.item as AjusteItem & { Roles?: string[]; TopLimit?: number };
        setInfEnabled(it.Enabled ?? false);
        setInfDays(Array.isArray(it.Days) ? it.Days : []);
        setInfTimes(Array.isArray(it.Times) ? [...it.Times].sort() : []);
        setInfRoles(Array.isArray(it.Roles) ? it.Roles : []);
        setInfTopLimit(it.TopLimit != null ? String(it.TopLimit) : '10');
        setInfLastRun((it as { UltimaEjecucion?: string }).UltimaEjecucion || null);
        setInfResult(it.Resultado || null);
      }
    } catch (_) {}
    try {
      const res = await apiFetch('/api/informes/diario/destinatarios');
      const data = await res.json();
      if (res.ok && data.ok) setInfDestCount(data.count ?? 0);
    } catch (_) {}
    setInfLoading(false);
  }, []);

  useEffect(() => { cargarInforme(); }, [cargarInforme]);

  const cargarVentasSync = useCallback(async () => {
    if (!puedeVentasSync) return;
    try {
      const res = await apiFetch('/api/campanas/ventas-sync');
      const data = await res.json();
      if (res.ok && data.ok) setVentasSyncLast(data.lastSync ?? null);
    } catch (_) {}
  }, [puedeVentasSync]);

  useEffect(() => { cargarVentasSync(); }, [cargarVentasSync]);

  const ejecutarVentasSync = useCallback(async () => {
    setVentasSyncing(true);
    setVentasSyncResult(null);
    setVentasSyncError(null);
    try {
      const hoy = new Date();
      const fechaFin = hoy.toISOString().slice(0, 10);
      const inicio = new Date(hoy);
      inicio.setDate(inicio.getDate() - (ventasSyncDays - 1));
      const fechaInicio = inicio.toISOString().slice(0, 10);

      const res = await apiFetch('/api/agora/sales-lines/full-sync', {
        method: 'POST',
        body: JSON.stringify({ fechaInicio, fechaFin }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setVentasSyncError(data.error || 'No se pudo sincronizar');
        return;
      }
      const errCount = Array.isArray(data.errors) ? data.errors.length : 0;
      setVentasSyncResult(
        `${data.daysProcessed ?? ventasSyncDays} días · ${data.totalItems ?? 0} registros`
        + (errCount > 0 ? ` · ${errCount} error(es)` : ''),
      );
      setVentasSyncLast(new Date().toISOString());
    } catch (err: any) {
      setVentasSyncError(err?.message || 'Error de conexión');
    } finally {
      setVentasSyncing(false);
    }
  }, [ventasSyncDays]);

  const toggleInfDay = useCallback((day: string) => {
    setInfDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }, []);

  const toggleInfRol = useCallback((rol: string) => {
    setInfRoles((prev) => (prev.includes(rol) ? prev.filter((r) => r !== rol) : [...prev, rol]));
  }, []);

  const addInfTime = useCallback(() => {
    const t = infNewTime.trim();
    if (!/^\d{2}:\d{2}$/.test(t)) { setInfTimeError('Formato: HH:MM'); return; }
    const [hh, mm] = t.split(':').map(Number);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) { setInfTimeError('Hora inválida'); return; }
    if (infTimes.includes(t)) { setInfTimeError('Ya existe'); return; }
    setInfTimes((prev) => [...prev, t].sort());
    setInfNewTime('');
    setInfTimeError(null);
  }, [infNewTime, infTimes]);

  const removeInfTime = useCallback((t: string) => {
    setInfTimes((prev) => prev.filter((x) => x !== t));
  }, []);

  const guardarInforme = useCallback(async () => {
    setInfSaving(true);
    setInfError(null);
    try {
      const limit = Math.max(1, Math.min(50, parseInt(infTopLimit, 10) || 10));
      const res = await apiFetch('/api/ajustes', {
        method: 'POST',
        body: JSON.stringify({
          PK: 'informes',
          SK: 'informe_diario',
          Nombre: 'Informe diario',
          Enabled: infEnabled,
          Days: infDays,
          Times: infTimes,
          Roles: infRoles,
          TopLimit: limit,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setInfError(data.error || 'No se pudo guardar'); return; }
      setInfTopLimit(String(limit));
      cargarInforme();
    } catch (_) {
      setInfError('Error de conexión al guardar');
    } finally {
      setInfSaving(false);
    }
  }, [infEnabled, infDays, infTimes, infRoles, infTopLimit, cargarInforme]);

  const forzarEnvioInforme = useCallback(async () => {
    setInfForcing(true);
    setInfError(null);
    setInfResult(null);
    try {
      const res = await apiFetch('/api/informes/diario/enviar', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setInfError(data.error || 'No se pudo enviar el informe');
        return;
      }
      const errCount = Array.isArray(data.errores) ? data.errores.length : 0;
      setInfResult(`Enviados ${data.enviados ?? 0}/${data.total ?? 0}${errCount > 0 ? ` · ${errCount} error(es)` : ''} (${data.businessDay})`);
      setInfLastRun(new Date().toISOString());
    } catch (err: any) {
      setInfError(err?.message || 'Error de conexión');
    } finally {
      setInfForcing(false);
    }
  }, []);

  const descargarInforme = useCallback(async () => {
    setInfDownloading(true);
    setInfError(null);
    setInfResult(null);
    try {
      const res = await apiFetch('/api/informes/diario/descargar', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || data.error || !data.pdfBase64) {
        setInfError(data.error || 'No se pudo generar el informe');
        return;
      }
      const filename = data.filename || 'informe-diario.pdf';
      if (Platform.OS === 'web') {
        const bin = atob(data.pdfBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
        const fileUri = `${cacheDir}${filename}`;
        await FileSystemLegacy.writeAsStringAsync(fileUri, data.pdfBase64, { encoding: FileSystemLegacy.EncodingType.Base64 });
        await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: filename });
      }
      setInfResult(`Informe descargado (${data.businessDay}).`);
    } catch (err: any) {
      setInfError(err?.message || 'Error de conexión');
    } finally {
      setInfDownloading(false);
    }
  }, []);

  function formatFechaHora(iso: string | null): string {
    if (!iso) return 'Nunca';
    try {
      const d = new Date(iso);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
    } catch { return iso; }
  }

  const visibleItems = SYNC_ITEMS.filter((s) => hasPermiso(s.permiso));
  const configItem = configModalId ? SYNC_ITEMS.find((s) => s.id === configModalId) : null;

  const gridCardStyle = useMemo(() => {
    const w = settingsCardWidth(winWidth);
    if (w === '100%') return { width: '100%' as const };
    return { width: w, maxWidth: w };
  }, [winWidth]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={20} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ajustes</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <MaterialIcons name="sync" size={18} color="#0369a1" />
            <Text style={styles.sectionTitle}>Sincronizaciones</Text>
          </View>
          <Text style={styles.sectionDesc}>
            Gestiona las sincronizaciones de datos con sistemas externos (Agora).
          </Text>

          {loadingAjustes ? (
            <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
          ) : visibleItems.length === 0 && !puedeVentasSync ? (
            <Text style={styles.emptyText}>No tienes permisos para ninguna sincronización</Text>
          ) : (
            <View style={styles.cardsGrid}>
              {visibleItems.map((item) => {
                const st = syncStates[item.id] ?? defaultState();
                return (
                  <View key={item.id} style={[styles.card, gridCardStyle]}>
                    {/* Cabecera */}
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, st.error ? styles.cardIconError : st.result ? styles.cardIconOk : styles.cardIconDefault]}>
                        <MaterialIcons name={item.icon} size={20} color={st.error ? '#dc2626' : st.result ? '#059669' : '#0369a1'} />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>{item.label}</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>{item.descripcion}</Text>
                      </View>
                      <TouchableOpacity onPress={() => abrirConfig(item.id)} style={styles.cardConfigBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <MaterialIcons name="settings" size={18} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>

                    {/* Estado enabled + última sync */}
                    <View style={styles.cardStatusRow}>
                      <View style={[styles.statusBadge, st.enabled ? styles.statusBadgeOn : styles.statusBadgeOff]}>
                        <View style={[styles.statusDot, st.enabled ? styles.statusDotOn : styles.statusDotOff]} />
                        <Text style={[styles.statusText, st.enabled ? styles.statusTextOn : styles.statusTextOff]}>
                          {st.enabled ? 'Automático' : 'Manual'}
                        </Text>
                      </View>
                      <View style={styles.cardMetaRow}>
                        <MaterialIcons name="schedule" size={11} color="#94a3b8" />
                        <Text style={styles.cardMetaText}>{formatFechaHora(st.lastSync)}</Text>
                      </View>
                    </View>

                    {/* Días y horas programadas (solo si enabled) */}
                    {st.enabled && (st.days.length > 0 || st.times.length > 0) && (
                      <View style={styles.scheduleRow}>
                        {st.days.length > 0 && (
                          <View style={styles.daysPreview}>
                            {DAY_KEYS.map((dk) => (
                              <View key={dk} style={[styles.dayChipSmall, st.days.includes(dk) && styles.dayChipSmallActive]}>
                                <Text style={[styles.dayChipSmallText, st.days.includes(dk) && styles.dayChipSmallTextActive]}>
                                  {DAY_LABELS[dk]}
                                </Text>
                              </View>
                            ))}
                          </View>
                        )}
                        {st.times.length > 0 && (
                          <Text style={styles.timesPreview} numberOfLines={1}>
                            {st.times.join(' · ')}
                          </Text>
                        )}
                      </View>
                    )}

                    {/* Resultado / Error */}
                    {st.result && !st.error && (
                      <View style={styles.resultBox}>
                        <MaterialIcons name="check-circle" size={12} color="#059669" />
                        <Text style={styles.resultText} numberOfLines={2}>{st.result}</Text>
                      </View>
                    )}
                    {st.error && (
                      <View style={styles.errorBox}>
                        <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                        <Text style={styles.errorText} numberOfLines={2}>{st.error}</Text>
                      </View>
                    )}

                    {/* Botón sync */}
                    <TouchableOpacity
                      style={[styles.syncBtn, st.syncing && styles.syncBtnDisabled]}
                      onPress={() => ejecutarSync(item)}
                      disabled={st.syncing}
                      activeOpacity={0.7}
                    >
                      {st.syncing ? (
                        <>
                          <ActivityIndicator size="small" color="#fff" />
                          <Text style={styles.syncBtnText}>Sincronizando…</Text>
                        </>
                      ) : (
                        <>
                          <MaterialIcons name="sync" size={15} color="#fff" />
                          <Text style={styles.syncBtnText}>Sincronizar</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                );
              })}

              {/* Card especial: sync manual de ventas por producto (incentivos) */}
              {puedeVentasSync && (
                <View style={[styles.card, gridCardStyle]}>
                  <View style={styles.cardTop}>
                    <View style={[styles.cardIconWrap, ventasSyncError ? styles.cardIconError : ventasSyncResult ? styles.cardIconOk : styles.cardIconDefault]}>
                      <MaterialIcons name="receipt-long" size={20} color={ventasSyncError ? '#dc2626' : ventasSyncResult ? '#059669' : '#0369a1'} />
                    </View>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardTitle} numberOfLines={1}>Ventas por producto</Text>
                      <Text style={styles.cardDesc} numberOfLines={2}>
                        Re-sincroniza las líneas de venta de Agora (incentivos) de los últimos días.
                      </Text>
                    </View>
                    <View style={{ width: 22 }} />
                  </View>

                  {/* Estado + última sync (igual que el resto de cards) */}
                  <View style={styles.cardStatusRow}>
                    <View style={[styles.statusBadge, styles.statusBadgeOff]}>
                      <View style={[styles.statusDot, styles.statusDotOff]} />
                      <Text style={[styles.statusText, styles.statusTextOff]}>Manual</Text>
                    </View>
                    <View style={styles.cardMetaRow}>
                      <MaterialIcons name="schedule" size={11} color="#94a3b8" />
                      <Text style={styles.cardMetaText}>{formatFechaHora(ventasSyncLast)}</Text>
                    </View>
                  </View>

                  {/* Selector de rango compacto */}
                  <View style={styles.daySelRow}>
                    {VENTAS_SYNC_DAY_OPTIONS.map((n) => {
                      const active = ventasSyncDays === n;
                      return (
                        <TouchableOpacity
                          key={n}
                          style={[styles.daySelChip, active && styles.daySelChipActive]}
                          onPress={() => setVentasSyncDays(n)}
                          disabled={ventasSyncing}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.daySelText, active && styles.daySelTextActive]}>{n} días</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {ventasSyncResult && !ventasSyncError && (
                    <View style={styles.resultBox}>
                      <MaterialIcons name="check-circle" size={12} color="#059669" />
                      <Text style={styles.resultText} numberOfLines={2}>{ventasSyncResult}</Text>
                    </View>
                  )}
                  {ventasSyncError && (
                    <View style={styles.errorBox}>
                      <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                      <Text style={styles.errorText} numberOfLines={2}>{ventasSyncError}</Text>
                    </View>
                  )}

                  <TouchableOpacity
                    style={[styles.syncBtn, ventasSyncing && styles.syncBtnDisabled]}
                    onPress={ejecutarVentasSync}
                    disabled={ventasSyncing}
                    activeOpacity={0.7}
                  >
                    {ventasSyncing ? (
                      <>
                        <ActivityIndicator size="small" color="#fff" />
                        <Text style={styles.syncBtnText}>Sincronizando…</Text>
                      </>
                    ) : (
                      <>
                        <MaterialIcons name="sync" size={15} color="#fff" />
                        <Text style={styles.syncBtnText}>Sincronizar</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>

        {hasPermiso('ajustes.ver') && (
          <View style={styles.section}>
            <View style={styles.persoHeaderRow}>
              <View style={styles.persoHeaderTitleBlock}>
                <MaterialIcons name="palette" size={18} color="#0369a1" />
                <Text style={styles.sectionTitle}>Personalización</Text>
              </View>
              {!loadingPersonalizacion && (
                <TouchableOpacity
                  style={[styles.persoSaveHeaderBtn, guardandoPersonalizacion && styles.persoSaveHeaderBtnDisabled]}
                  onPress={guardarPersonalizacion}
                  disabled={guardandoPersonalizacion}
                  activeOpacity={0.75}
                  accessibilityLabel="Guardar personalización"
                >
                  {guardandoPersonalizacion ? (
                    <ActivityIndicator size="small" color="#047857" />
                  ) : (
                    <>
                      <MaterialIcons name="save" size={14} color="#047857" />
                      <Text style={styles.persoSaveHeaderBtnText}>Guardar</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.sectionDesc}>
              Imagen de la aplicación y porcentaje de beneficio por defecto.
            </Text>

            {loadingPersonalizacion ? (
              <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
            ) : (
              <View style={styles.cardsGrid}>
                <View style={[styles.card, gridCardStyle]}>
                  <View style={styles.cardTop}>
                    <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                      <MaterialIcons name="image" size={20} color="#0369a1" />
                    </View>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardTitle} numberOfLines={1}>Imagen app</Text>
                      <Text style={styles.cardDesc} numberOfLines={2}>
                        Logo o imagen para la aplicación (se comprime al guardar).
                      </Text>
                    </View>
                    <View style={{ width: 22 }} />
                  </View>
                  {imagenApp ? (
                    <Image source={{ uri: imagenApp }} style={styles.persoCardThumb} resizeMode="contain" />
                  ) : (
                    <View style={styles.persoCardThumbPlaceholder}>
                      <MaterialIcons name="image" size={28} color="#cbd5e1" />
                      <Text style={styles.persoImagePlaceholderText}>Sin imagen</Text>
                    </View>
                  )}
                  <View style={styles.persoCardActions}>
                    <TouchableOpacity
                      style={[styles.persoMiniBtn, imagenLoading && { opacity: 0.6 }]}
                      onPress={seleccionarImagenApp}
                      disabled={imagenLoading}
                    >
                      {imagenLoading ? (
                        <ActivityIndicator size="small" color="#0ea5e9" />
                      ) : (
                        <>
                          <MaterialIcons name="photo-library" size={14} color="#0369a1" />
                          <Text style={styles.persoMiniBtnText}>Elegir</Text>
                        </>
                      )}
                    </TouchableOpacity>
                    {!!imagenApp && (
                      <TouchableOpacity style={styles.persoMiniBtnDanger} onPress={quitarImagenApp}>
                        <MaterialIcons name="delete-outline" size={14} color="#dc2626" />
                        <Text style={styles.persoMiniBtnTextDanger}>Quitar</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                <View style={[styles.card, gridCardStyle]}>
                  <View style={styles.cardTop}>
                    <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                      <MaterialIcons name="percent" size={20} color="#0369a1" />
                    </View>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardTitle} numberOfLines={1}>Porcentaje de beneficio</Text>
                      <Text style={styles.cardDesc} numberOfLines={2}>
                        Margen por defecto (0–100). Vacío si no aplica.
                      </Text>
                    </View>
                    <View style={{ width: 22 }} />
                  </View>
                  <View style={styles.persoPctRowCard}>
                    <TextInput
                      style={styles.persoPctInputCard}
                      value={porcentajeBeneficio}
                      onChangeText={setPorcentajeBeneficio}
                      placeholder="0"
                      placeholderTextColor="#94a3b8"
                      keyboardType="decimal-pad"
                    />
                    <Text style={styles.persoPctSuffix}>%</Text>
                  </View>
                </View>

                <View style={[styles.card, gridCardStyle]}>
                  <View style={styles.cardTop}>
                    <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                      <MaterialIcons name="schedule" size={20} color="#0369a1" />
                    </View>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardTitle} numberOfLines={1}>Importe por hora (RRHH)</Text>
                      <Text style={styles.cardDesc} numberOfLines={2}>
                        € por hora por defecto en Horas por facturación. Se puede editar por local.
                      </Text>
                    </View>
                    <View style={{ width: 22 }} />
                  </View>
                  <View style={styles.persoPctRowCard}>
                    <TextInput
                      style={styles.persoPctInputCard}
                      value={importeHoraDefecto}
                      onChangeText={setImporteHoraDefecto}
                      placeholder="0"
                      placeholderTextColor="#94a3b8"
                      keyboardType="decimal-pad"
                    />
                    <Text style={styles.persoPctSuffix}>€/h</Text>
                  </View>
                </View>

                {errorPersonalizacion ? (
                  <View style={[styles.errorBox, { width: '100%' }]}>
                    <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                    <Text style={styles.errorText}>{errorPersonalizacion}</Text>
                  </View>
                ) : null}
              </View>
            )}
          </View>
        )}

        {hasPermiso('ajustes.ver') && (
          <View style={styles.section}>
            <View style={styles.persoHeaderRow}>
              <View style={styles.persoHeaderTitleBlock}>
                <MaterialIcons name="build" size={18} color="#0369a1" />
                <Text style={styles.sectionTitle}>Tarifas de mantenimiento</Text>
              </View>
              {!loadingMantenimiento && (
                <TouchableOpacity
                  style={[styles.persoSaveHeaderBtn, guardandoMantenimiento && styles.persoSaveHeaderBtnDisabled]}
                  onPress={guardarMantenimiento}
                  disabled={guardandoMantenimiento}
                  activeOpacity={0.75}
                  accessibilityLabel="Guardar tarifas de mantenimiento"
                >
                  {guardandoMantenimiento ? (
                    <ActivityIndicator size="small" color="#047857" />
                  ) : (
                    <>
                      <MaterialIcons name="save" size={14} color="#047857" />
                      <Text style={styles.persoSaveHeaderBtnText}>Guardar</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.sectionDesc}>
              Precios por defecto al valorar una reparación de Mantenimiento. Se pueden ajustar parte a parte.
            </Text>

            {loadingMantenimiento ? (
              <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
            ) : (
              <View style={styles.cardsGrid}>
                <View style={[styles.card, gridCardStyle]}>
                  <View style={styles.cardTop}>
                    <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                      <MaterialIcons name="directions-car" size={20} color="#0369a1" />
                    </View>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardTitle} numberOfLines={1}>Precio por kilómetro</Text>
                      <Text style={styles.cardDesc} numberOfLines={2}>
                        € por km del desplazamiento del técnico. Los km salen de la ficha del local.
                      </Text>
                    </View>
                    <View style={{ width: 22 }} />
                  </View>
                  <View style={styles.persoPctRowCard}>
                    <TextInput
                      style={styles.persoPctInputCard}
                      value={precioKm}
                      onChangeText={setPrecioKm}
                      placeholder="7,25"
                      placeholderTextColor="#94a3b8"
                      keyboardType="decimal-pad"
                    />
                    <Text style={styles.persoPctSuffix}>€/km</Text>
                  </View>
                </View>

                <View style={[styles.card, gridCardStyle]}>
                  <View style={styles.cardTop}>
                    <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                      <MaterialIcons name="handyman" size={20} color="#0369a1" />
                    </View>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardTitle} numberOfLines={1}>Importe por hora (técnico)</Text>
                      <Text style={styles.cardDesc} numberOfLines={2}>
                        € por hora de mano de obra en las reparaciones de Mantenimiento.
                      </Text>
                    </View>
                    <View style={{ width: 22 }} />
                  </View>
                  <View style={styles.persoPctRowCard}>
                    <TextInput
                      style={styles.persoPctInputCard}
                      value={importeHoraMantenimiento}
                      onChangeText={setImporteHoraMantenimiento}
                      placeholder="30"
                      placeholderTextColor="#94a3b8"
                      keyboardType="decimal-pad"
                    />
                    <Text style={styles.persoPctSuffix}>€/h</Text>
                  </View>
                </View>

                {errorMantenimiento || errorCargaMantenimiento ? (
                  <View style={[styles.errorBox, { width: '100%' }]}>
                    <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                    <Text style={styles.errorText}>{errorMantenimiento ?? errorCargaMantenimiento}</Text>
                  </View>
                ) : null}
              </View>
            )}
          </View>
        )}

        {puedeAjustes && (
          <View style={styles.section}>
            <View style={styles.persoHeaderRow}>
              <View style={styles.persoHeaderTitleBlock}>
                <MaterialIcons name="request-quote" size={18} color="#0369a1" />
                <Text style={[styles.sectionTitle, { flexShrink: 1 }]} numberOfLines={1}>
                  Facturación de mantenimiento
                </Text>
                {!loadingFacturacion && (
                  <View
                    style={[
                      styles.statusBadge,
                      ajustesFacturacion.enabled ? styles.statusBadgeOn : styles.statusBadgeOff,
                    ]}
                  >
                    <View
                      style={[
                        styles.statusDot,
                        ajustesFacturacion.enabled ? styles.statusDotOn : styles.statusDotOff,
                      ]}
                    />
                    <Text
                      style={[
                        styles.statusText,
                        ajustesFacturacion.enabled ? styles.statusTextOn : styles.statusTextOff,
                      ]}
                    >
                      {ajustesFacturacion.enabled ? 'Automática activa' : 'Desactivada'}
                    </Text>
                  </View>
                )}
              </View>
              {!loadingFacturacion && !facturacionSoloLectura && (
                <TouchableOpacity
                  style={[styles.persoSaveHeaderBtn, guardandoFacturacion && styles.persoSaveHeaderBtnDisabled]}
                  onPress={guardarFacturacionMantenimiento}
                  disabled={guardandoFacturacion}
                  activeOpacity={0.75}
                  accessibilityLabel="Guardar configuración de facturación de mantenimiento"
                >
                  {guardandoFacturacion ? (
                    <ActivityIndicator size="small" color="#047857" />
                  ) : (
                    <>
                      <MaterialIcons name="save" size={14} color="#047857" />
                      <Text style={styles.persoSaveHeaderBtnText}>Guardar</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.sectionDesc}>
              Factura mensual de las reparaciones ya valoradas: la sociedad emisora factura a las
              sociedades propietarias de cada local. Las facturas se crean en estado borrador.
            </Text>

            {loadingFacturacion ? (
              <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
            ) : (
              <>
                {facturacionSoloLectura && (
                  <View style={styles.facLecturaBox}>
                    <MaterialIcons name="lock-outline" size={14} color="#0369a1" />
                    <Text style={styles.facLecturaText}>
                      Solo lectura: puedes consultar la configuración, pero para cambiarla necesitas
                      permiso para facturar mantenimiento.
                    </Text>
                  </View>
                )}

                <View style={[styles.card, styles.facCardAncha]}>
                  <View style={styles.cfgRowBetween}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cfgLabel}>Generación automática</Text>
                      <Text style={styles.cfgHint}>
                        Emite las facturas del mes en el día y la hora configurados.
                      </Text>
                    </View>
                    {facturacionSoloLectura ? (
                      <Text style={styles.facValorLectura}>
                        {ajustesFacturacion.enabled ? 'Activada' : 'Desactivada'}
                      </Text>
                    ) : (
                      <Switch
                        value={facEnabled}
                        onValueChange={setFacEnabled}
                        trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                        thumbColor={facEnabled ? '#0ea5e9' : '#94a3b8'}
                        style={Platform.OS === 'web' ? { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] } : undefined}
                      />
                    )}
                  </View>

                  {!ajustesFacturacion.enabled && (
                    <View style={styles.facAvisoBox}>
                      <MaterialIcons name="pause-circle-outline" size={14} color="#b45309" />
                      <Text style={styles.facAvisoText}>
                        {facturacionSoloLectura
                          ? 'La generación automática está desactivada: no se emitirá ninguna factura de mantenimiento.'
                          : 'La generación automática está desactivada: no se emitirá ninguna factura hasta que la actives y guardes.'}
                      </Text>
                    </View>
                  )}
                  {facEnabled !== ajustesFacturacion.enabled && (
                    <Text style={styles.facPendienteText}>
                      {facEnabled
                        ? 'Activación pendiente de guardar.'
                        : 'Desactivación pendiente de guardar.'}
                    </Text>
                  )}
                </View>

                <View style={[styles.cardsGrid, styles.facGrid]}>
                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="business" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Sociedad emisora</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Empresa del grupo que emite las facturas de mantenimiento.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {facturacionSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>
                        {loadingEmpresasFacturacion ? '…' : nombreSociedadFacturacion || '—'}
                      </Text>
                    ) : (
                      <SelectorDesplegable
                        style={styles.facCampo}
                        icono="business"
                        placeholder="Selecciona la sociedad"
                        opciones={opcionesEmpresaFacturacion}
                        valorId={facEmpresa}
                        onSeleccionar={setFacEmpresa}
                        tituloLista="Maestro de empresas"
                        iconoLista="business"
                        loading={loadingEmpresasFacturacion}
                        buscador
                        buscadorPlaceholder="Buscar empresa…"
                        vacioTexto="No se pudo cargar el maestro de empresas."
                      />
                    )}
                    {empresaFacturacionDesconocida && (
                      <Text style={styles.facAvisoInline}>
                        La sociedad guardada ({facEmpresa}) ya no está en el maestro de empresas.
                      </Text>
                    )}
                  </View>

                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="receipt-long" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Serie de facturación</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Serie de venta con la que se numeran las facturas generadas.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {facturacionSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>{facSerie || '—'}</Text>
                    ) : (
                      <SelectorDesplegable
                        style={styles.facCampo}
                        icono="tag"
                        placeholder="Selecciona la serie"
                        opciones={opcionesSerieFacturacion}
                        valorId={facSerie}
                        onSeleccionar={setFacSerie}
                        tituloLista="Series de venta activas"
                        iconoLista="receipt-long"
                        loading={loadingSeriesFacturacion}
                        vacioTexto="No hay series de venta activas. Créala en Facturación › Series."
                      />
                    )}
                    {serieFacturacionDesconocida && (
                      <Text style={styles.facAvisoInline}>
                        La serie guardada ({facSerie}) no está entre las series de venta activas.
                      </Text>
                    )}
                  </View>

                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="event" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Día de generación</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Día del mes en que se facturan las reparaciones del mes anterior.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {facturacionSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>
                        {`Día ${facDia || String(DIA_GENERACION_DEFECTO)} del mes`}
                      </Text>
                    ) : (
                      <View style={styles.persoPctRowCard}>
                        <TextInput
                          style={styles.persoPctInputCard}
                          value={facDia}
                          onChangeText={setFacDia}
                          placeholder={String(DIA_GENERACION_DEFECTO)}
                          placeholderTextColor="#94a3b8"
                          keyboardType="number-pad"
                          maxLength={2}
                        />
                        <Text style={styles.persoPctSuffix}>del mes</Text>
                      </View>
                    )}
                  </View>

                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="schedule" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Hora de generación</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Hora a la que se lanza el proceso, en formato HH:MM.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {facturacionSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>
                        {`${facHora || HORA_DEFECTO} h`}
                      </Text>
                    ) : (
                      <View style={styles.persoPctRowCard}>
                        <TextInput
                          style={styles.persoPctInputCard}
                          value={facHora}
                          onChangeText={setFacHora}
                          placeholder={HORA_DEFECTO}
                          placeholderTextColor="#94a3b8"
                          keyboardType="numbers-and-punctuation"
                          maxLength={5}
                        />
                        <Text style={styles.persoPctSuffix}>h</Text>
                      </View>
                    )}
                  </View>

                  <View style={[styles.card, styles.facCardAncha]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="description" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Condiciones de pago</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Texto que se volcará en cada factura generada. Opcional.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {facturacionSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facValorLecturaLargo, styles.facCampo]}>
                        {facCondiciones.trim() || 'Sin condiciones de pago'}
                      </Text>
                    ) : (
                      <TextInput
                        style={[styles.persoPctInputCard, styles.facTextarea]}
                        value={facCondiciones}
                        onChangeText={setFacCondiciones}
                        placeholder="Ej.: Pago por transferencia a 30 días desde la fecha de factura."
                        placeholderTextColor="#94a3b8"
                        multiline
                        numberOfLines={3}
                        textAlignVertical="top"
                      />
                    )}
                  </View>

                  {errorFacturacion || errorCargaFacturacion ? (
                    <View style={[styles.errorBox, { width: '100%' }]}>
                      <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                      <Text style={styles.errorText}>{errorFacturacion ?? errorCargaFacturacion}</Text>
                    </View>
                  ) : null}
                </View>
              </>
            )}
          </View>
        )}

        {puedeAjustes && (
          <View style={styles.section}>
            <View style={styles.persoHeaderRow}>
              <View style={styles.persoHeaderTitleBlock}>
                <MaterialIcons name="local-shipping" size={18} color="#0369a1" />
                <Text style={[styles.sectionTitle, { flexShrink: 1 }]} numberOfLines={1}>
                  Facturación de ventas internas
                </Text>
                {!loadingCompras && (
                  <View
                    style={[
                      styles.statusBadge,
                      ajustesCompras.enabled ? styles.statusBadgeOn : styles.statusBadgeOff,
                    ]}
                  >
                    <View
                      style={[
                        styles.statusDot,
                        ajustesCompras.enabled ? styles.statusDotOn : styles.statusDotOff,
                      ]}
                    />
                    <Text
                      style={[
                        styles.statusText,
                        ajustesCompras.enabled ? styles.statusTextOn : styles.statusTextOff,
                      ]}
                    >
                      {ajustesCompras.enabled ? 'Automática activa' : 'Desactivada'}
                    </Text>
                  </View>
                )}
              </View>
              {!loadingCompras && !comprasSoloLectura && (
                <TouchableOpacity
                  style={[styles.persoSaveHeaderBtn, guardandoCompras && styles.persoSaveHeaderBtnDisabled]}
                  onPress={guardarFacturacionCompras}
                  disabled={guardandoCompras}
                  activeOpacity={0.75}
                  accessibilityLabel="Guardar configuración de facturación de ventas internas"
                >
                  {guardandoCompras ? (
                    <ActivityIndicator size="small" color="#047857" />
                  ) : (
                    <>
                      <MaterialIcons name="save" size={14} color="#047857" />
                      <Text style={styles.persoSaveHeaderBtnText}>Guardar</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.sectionDesc}>
              Factura mensual de los pedidos servidos desde un almacén a los locales y de los abonos
              de rappel: la sociedad que sirve factura a la sociedad que recibe. Las facturas se
              crean en estado borrador.
            </Text>

            {loadingCompras ? (
              <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
            ) : (
              <>
                {comprasSoloLectura && (
                  <View style={styles.facLecturaBox}>
                    <MaterialIcons name="lock-outline" size={14} color="#0369a1" />
                    <Text style={styles.facLecturaText}>
                      Solo lectura: puedes consultar la configuración, pero para cambiarla necesitas
                      permiso para facturar las ventas internas de compras.
                    </Text>
                  </View>
                )}

                <View style={[styles.card, styles.facCardAncha]}>
                  <View style={styles.cfgRowBetween}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cfgLabel}>Generación automática</Text>
                      <Text style={styles.cfgHint}>
                        Emite las facturas del mes en el día y la hora configurados.
                      </Text>
                    </View>
                    {comprasSoloLectura ? (
                      <Text style={styles.facValorLectura}>
                        {ajustesCompras.enabled ? 'Activada' : 'Desactivada'}
                      </Text>
                    ) : (
                      <Switch
                        value={comEnabled}
                        onValueChange={setComEnabled}
                        trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                        thumbColor={comEnabled ? '#0ea5e9' : '#94a3b8'}
                        style={Platform.OS === 'web' ? { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] } : undefined}
                      />
                    )}
                  </View>

                  {!ajustesCompras.enabled && (
                    <View style={styles.facAvisoBox}>
                      <MaterialIcons name="pause-circle-outline" size={14} color="#b45309" />
                      <Text style={styles.facAvisoText}>
                        {comprasSoloLectura
                          ? 'La generación automática está desactivada: no se emitirá ninguna factura de ventas internas.'
                          : 'La generación automática está desactivada: no se emitirá ninguna factura hasta que la actives y guardes.'}
                      </Text>
                    </View>
                  )}
                  {comEnabled !== ajustesCompras.enabled && (
                    <Text style={styles.facPendienteText}>
                      {comEnabled
                        ? 'Activación pendiente de guardar.'
                        : 'Desactivación pendiente de guardar.'}
                    </Text>
                  )}
                  {ultimoPeriodoCompras !== '' && (
                    <View style={styles.cardMetaRow}>
                      <MaterialIcons name="event-available" size={13} color="#64748b" />
                      <Text style={styles.cardMetaText}>
                        {`Último mes ya facturado: ${labelPeriodo(ultimoPeriodoCompras)}`}
                      </Text>
                    </View>
                  )}
                </View>

                <View style={[styles.cardsGrid, styles.facGrid]}>
                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="warehouse" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Sociedad del Almacén General</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Empresa que emite las facturas de lo servido desde el Almacén General.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {comprasSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>
                        {loadingEmpresasFacturacion ? '…' : nombreSociedadAlmacen || 'Sin configurar'}
                      </Text>
                    ) : (
                      <SelectorDesplegable
                        style={styles.facCampo}
                        icono="business"
                        placeholder="Selecciona la sociedad"
                        opciones={opcionesEmpresaFacturacion}
                        valorId={comEmpresaAlmacen}
                        onSeleccionar={setComEmpresaAlmacen}
                        tituloLista="Maestro de empresas"
                        iconoLista="business"
                        loading={loadingEmpresasFacturacion}
                        buscador
                        buscadorPlaceholder="Buscar empresa…"
                        vacioTexto="No se pudo cargar el maestro de empresas."
                      />
                    )}
                    {empresaAlmacenDesconocida && (
                      <Text style={styles.facAvisoInline}>
                        La sociedad guardada ({comEmpresaAlmacen}) ya no está en el maestro de
                        empresas. Vuelve a elegirla para que el Almacén General tenga emisor.
                      </Text>
                    )}
                    {comEmpresaAlmacen === '' && (
                      <Text style={styles.facAvisoInline}>
                        Sin sociedad configurada no se puede facturar lo servido desde el Almacén
                        General.
                      </Text>
                    )}
                    <Text style={styles.cfgHint}>
                      Los almacenes de local usan la sociedad de su propio local; el Almacén General
                      no es de ningún local, así que su sociedad se configura aquí.
                    </Text>
                  </View>

                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="receipt-long" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Serie de ventas internas</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Serie de venta con la que se numeran las facturas de mercancía servida.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {comprasSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>{comSerieVentas || '—'}</Text>
                    ) : (
                      <SelectorDesplegable
                        style={styles.facCampo}
                        icono="tag"
                        placeholder="Selecciona la serie"
                        opciones={opcionesSerieFacturacion}
                        valorId={comSerieVentas}
                        onSeleccionar={setComSerieVentas}
                        tituloLista="Series de venta activas"
                        iconoLista="receipt-long"
                        loading={loadingSeriesFacturacion}
                        vacioTexto="No hay series de venta activas. Créala en Facturación › Series."
                      />
                    )}
                    {serieVentasDesconocida && (
                      <Text style={styles.facAvisoInline}>
                        La serie guardada ({comSerieVentas}) no está entre las series de venta activas.
                      </Text>
                    )}
                  </View>

                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="savings" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Serie de abonos de rappel</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Serie con la que se numeran los abonos de rappel del periodo.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {comprasSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>{comSerieRappel || '—'}</Text>
                    ) : (
                      <SelectorDesplegable
                        style={styles.facCampo}
                        icono="tag"
                        placeholder="Selecciona la serie"
                        opciones={opcionesSerieFacturacion}
                        valorId={comSerieRappel}
                        onSeleccionar={setComSerieRappel}
                        tituloLista="Series de venta activas"
                        iconoLista="receipt-long"
                        loading={loadingSeriesFacturacion}
                        vacioTexto="No hay series de venta activas. Créala en Facturación › Series."
                      />
                    )}
                    {serieRappelDesconocida && (
                      <Text style={styles.facAvisoInline}>
                        La serie guardada ({comSerieRappel}) no está entre las series de venta activas.
                      </Text>
                    )}
                  </View>

                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="event" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Día de generación</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Día del mes en que se facturan los pedidos del mes anterior.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {comprasSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>
                        {`Día ${comDia || String(DIA_GENERACION_DEFECTO)} del mes`}
                      </Text>
                    ) : (
                      <View style={styles.persoPctRowCard}>
                        <TextInput
                          style={styles.persoPctInputCard}
                          value={comDia}
                          onChangeText={setComDia}
                          placeholder={String(DIA_GENERACION_DEFECTO)}
                          placeholderTextColor="#94a3b8"
                          keyboardType="number-pad"
                          maxLength={2}
                        />
                        <Text style={styles.persoPctSuffix}>del mes</Text>
                      </View>
                    )}
                  </View>

                  <View style={[styles.card, gridCardStyle]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="schedule" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Hora de generación</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Hora a la que se lanza el proceso, en formato HH:MM.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {comprasSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facCampo]}>
                        {`${comHora || HORA_DEFECTO} h`}
                      </Text>
                    ) : (
                      <View style={styles.persoPctRowCard}>
                        <TextInput
                          style={styles.persoPctInputCard}
                          value={comHora}
                          onChangeText={setComHora}
                          placeholder={HORA_DEFECTO}
                          placeholderTextColor="#94a3b8"
                          keyboardType="numbers-and-punctuation"
                          maxLength={5}
                        />
                        <Text style={styles.persoPctSuffix}>h</Text>
                      </View>
                    )}
                  </View>

                  <View style={[styles.card, styles.facCardAncha]}>
                    <View style={styles.cardTop}>
                      <View style={[styles.cardIconWrap, styles.cardIconDefault]}>
                        <MaterialIcons name="description" size={20} color="#0369a1" />
                      </View>
                      <View style={styles.cardInfo}>
                        <Text style={styles.cardTitle} numberOfLines={1}>Condiciones de pago</Text>
                        <Text style={styles.cardDesc} numberOfLines={2}>
                          Texto que se volcará en cada factura generada. Opcional.
                        </Text>
                      </View>
                      <View style={{ width: 22 }} />
                    </View>
                    {comprasSoloLectura ? (
                      <Text style={[styles.facValorLectura, styles.facValorLecturaLargo, styles.facCampo]}>
                        {comCondiciones.trim() || 'Sin condiciones de pago'}
                      </Text>
                    ) : (
                      <TextInput
                        style={[styles.persoPctInputCard, styles.facTextarea]}
                        value={comCondiciones}
                        onChangeText={setComCondiciones}
                        placeholder="Ej.: Pago por transferencia a 30 días desde la fecha de factura."
                        placeholderTextColor="#94a3b8"
                        multiline
                        numberOfLines={3}
                        textAlignVertical="top"
                      />
                    )}
                  </View>

                  {errorCompras || errorCargaCompras ? (
                    <View style={[styles.errorBox, { width: '100%' }]}>
                      <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                      <Text style={styles.errorText}>{errorCompras ?? errorCargaCompras}</Text>
                    </View>
                  ) : null}
                </View>
              </>
            )}
          </View>
        )}

        {hasPermiso('ajustes.ver') && <EnlacesPlanningPanel />}

        {hasPermiso('ajustes.ver') && (
          <View style={styles.section}>
            <View style={styles.persoHeaderRow}>
              <View style={styles.persoHeaderTitleBlock}>
                <MaterialIcons name="mark-email-read" size={18} color="#0369a1" />
                <Text style={styles.sectionTitle}>Informe diario por email</Text>
              </View>
              {!infLoading && (
                <TouchableOpacity
                  style={[styles.persoSaveHeaderBtn, infSaving && styles.persoSaveHeaderBtnDisabled]}
                  onPress={guardarInforme}
                  disabled={infSaving}
                  activeOpacity={0.75}
                  accessibilityLabel="Guardar configuración del informe"
                >
                  {infSaving ? (
                    <ActivityIndicator size="small" color="#047857" />
                  ) : (
                    <>
                      <MaterialIcons name="save" size={14} color="#047857" />
                      <Text style={styles.persoSaveHeaderBtnText}>Guardar</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.sectionDesc}>
              Envío automático del informe de jornadas del día anterior (facturación, comparativa,
              cumplimiento, invitaciones/descuentos y top por usuario) a los roles seleccionados,
              con un PDF por destinatario según sus locales asignados.
            </Text>

            {infLoading ? (
              <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
            ) : (
              <View style={[styles.card, { width: '100%', maxWidth: '100%' as any }]}>
                {/* Activación */}
                <View style={styles.cfgRowBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cfgLabel}>Envío automático</Text>
                    <Text style={styles.cfgHint}>Ejecutar en los días y horas configurados</Text>
                  </View>
                  <Switch
                    value={infEnabled}
                    onValueChange={setInfEnabled}
                    trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                    thumbColor={infEnabled ? '#0ea5e9' : '#94a3b8'}
                    style={Platform.OS === 'web' ? { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] } : undefined}
                  />
                </View>

                {/* Días */}
                <View style={styles.cfgSection}>
                  <Text style={styles.cfgLabel}>Días de envío</Text>
                  <View style={styles.daysRow}>
                    {DAY_KEYS.map((dk) => {
                      const active = infDays.includes(dk);
                      return (
                        <TouchableOpacity
                          key={dk}
                          style={[styles.dayChip, active && styles.dayChipActive]}
                          onPress={() => toggleInfDay(dk)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                            {DAY_LABELS[dk]}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                {/* Horas */}
                <View style={styles.cfgSection}>
                  <Text style={styles.cfgLabel}>Horas de envío</Text>
                  {infTimes.length > 0 && (
                    <View style={styles.timesList}>
                      {infTimes.map((t) => (
                        <View key={t} style={styles.timeChip}>
                          <MaterialIcons name="access-time" size={13} color="#0369a1" />
                          <Text style={styles.timeChipText}>{t}</Text>
                          <TouchableOpacity
                            onPress={() => removeInfTime(t)}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            style={styles.timeChipRemove}
                          >
                            <MaterialIcons name="close" size={13} color="#94a3b8" />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                  <View style={styles.addTimeRow}>
                    <TextInput
                      style={styles.addTimeInput}
                      value={infNewTime}
                      onChangeText={(v) => { setInfNewTime(v); setInfTimeError(null); }}
                      placeholder="HH:MM"
                      placeholderTextColor="#94a3b8"
                      maxLength={5}
                      keyboardType="numbers-and-punctuation"
                      onSubmitEditing={addInfTime}
                      {...(Platform.OS === 'web' ? {
                        onKeyPress: (e: any) => { if (e.nativeEvent?.key === 'Enter') addInfTime(); },
                      } : {})}
                    />
                    <TouchableOpacity style={styles.addTimeBtn} onPress={addInfTime} activeOpacity={0.7}>
                      <MaterialIcons name="add" size={16} color="#fff" />
                      <Text style={styles.addTimeBtnText}>Añadir</Text>
                    </TouchableOpacity>
                  </View>
                  {infTimeError && <Text style={styles.cfgError}>{infTimeError}</Text>}
                </View>

                {/* Roles destinatarios */}
                <View style={styles.cfgSection}>
                  <Text style={styles.cfgLabel}>Roles que reciben el informe</Text>
                  <Text style={styles.cfgHint}>Solo usuarios con locales asignados recibirán el correo</Text>
                  <View style={styles.daysRow}>
                    {ROLES_INFORME.map((rol) => {
                      const active = infRoles.includes(rol);
                      return (
                        <TouchableOpacity
                          key={rol}
                          style={[styles.rolChip, active && styles.rolChipActive]}
                          onPress={() => toggleInfRol(rol)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.rolChipText, active && styles.rolChipTextActive]}>{rol}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                {/* Top límite */}
                <View style={styles.cfgSection}>
                  <Text style={styles.cfgLabel}>Top de usuarios a incluir</Text>
                  <View style={styles.persoPctRowCard}>
                    <TextInput
                      style={styles.persoPctInputCard}
                      value={infTopLimit}
                      onChangeText={setInfTopLimit}
                      placeholder="10"
                      placeholderTextColor="#94a3b8"
                      keyboardType="number-pad"
                      maxLength={2}
                    />
                  </View>
                </View>

                {/* Estado */}
                <View style={styles.infStatusRow}>
                  <View style={styles.cardMetaRow}>
                    <MaterialIcons name="group" size={13} color="#64748b" />
                    <Text style={styles.cardMetaText}>
                      {infDestCount != null ? `${infDestCount} destinatario(s)` : '—'}
                    </Text>
                  </View>
                  <View style={styles.cardMetaRow}>
                    <MaterialIcons name="schedule" size={13} color="#94a3b8" />
                    <Text style={styles.cardMetaText}>Último: {formatFechaHora(infLastRun)}</Text>
                  </View>
                </View>

                {infResult && !infError && (
                  <View style={styles.resultBox}>
                    <MaterialIcons name="check-circle" size={12} color="#059669" />
                    <Text style={styles.resultText} numberOfLines={2}>{infResult}</Text>
                  </View>
                )}
                {infError && (
                  <View style={styles.errorBox}>
                    <MaterialIcons name="error-outline" size={12} color="#dc2626" />
                    <Text style={styles.errorText} numberOfLines={2}>{infError}</Text>
                  </View>
                )}

                {/* Acciones: forzar envío + descargar */}
                <View style={styles.infActionsRow}>
                  <TouchableOpacity
                    style={[styles.syncBtn, styles.infActionBtn, infForcing && styles.syncBtnDisabled]}
                    onPress={forzarEnvioInforme}
                    disabled={infForcing || infDownloading}
                    activeOpacity={0.7}
                  >
                    {infForcing ? (
                      <>
                        <ActivityIndicator size="small" color="#fff" />
                        <Text style={styles.syncBtnText}>Enviando…</Text>
                      </>
                    ) : (
                      <>
                        <MaterialIcons name="send" size={15} color="#fff" />
                        <Text style={styles.syncBtnText}>Forzar envío ahora</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.infDownloadBtn, infDownloading && styles.syncBtnDisabled]}
                    onPress={descargarInforme}
                    disabled={infForcing || infDownloading}
                    activeOpacity={0.7}
                  >
                    {infDownloading ? (
                      <>
                        <ActivityIndicator size="small" color="#0369a1" />
                        <Text style={styles.infDownloadBtnText}>Generando…</Text>
                      </>
                    ) : (
                      <>
                        <MaterialIcons name="download" size={15} color="#0369a1" />
                        <Text style={styles.infDownloadBtnText}>Descargar informe</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* ─── Modal de configuración ─── */}
      <Modal visible={!!configModalId} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setConfigModalId(null)}>
          <Pressable style={[styles.modalBox, { maxWidth: Math.min(winWidth - 32, 440) }]} onPress={() => {}}>
            {/* Header modal */}
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                {configItem && <MaterialIcons name={configItem.icon} size={20} color="#0369a1" />}
                <Text style={styles.modalTitle} numberOfLines={1}>
                  {configItem?.label ?? 'Configuración'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setConfigModalId(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={20} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
              {/* Activación */}
              <View style={styles.cfgSection}>
                <View style={styles.cfgRowBetween}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cfgLabel}>Sincronización automática</Text>
                    <Text style={styles.cfgHint}>Ejecutar en los días y horas configurados</Text>
                  </View>
                  <Switch
                    value={cfgEnabled}
                    onValueChange={setCfgEnabled}
                    trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                    thumbColor={cfgEnabled ? '#0ea5e9' : '#94a3b8'}
                    style={Platform.OS === 'web' ? { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] } : undefined}
                  />
                </View>
              </View>

              {/* Días de ejecución */}
              <View style={[styles.cfgSection, !cfgEnabled && styles.cfgDisabled]}>
                <Text style={styles.cfgLabel}>Días de ejecución</Text>
                <View style={styles.daysRow}>
                  {DAY_KEYS.map((dk) => {
                    const active = cfgDays.includes(dk);
                    return (
                      <TouchableOpacity
                        key={dk}
                        style={[styles.dayChip, active && styles.dayChipActive]}
                        onPress={() => cfgEnabled && toggleDay(dk)}
                        activeOpacity={cfgEnabled ? 0.7 : 1}
                      >
                        <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                          {DAY_LABELS[dk]}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Horas de ejecución */}
              <View style={[styles.cfgSection, !cfgEnabled && styles.cfgDisabled]}>
                <Text style={styles.cfgLabel}>Horas de ejecución</Text>
                <Text style={styles.cfgHint}>La sincronización se ejecutará a cada hora programada</Text>

                {cfgTimes.length > 0 && (
                  <View style={styles.timesList}>
                    {cfgTimes.map((t) => (
                      <View key={t} style={styles.timeChip}>
                        <MaterialIcons name="access-time" size={13} color="#0369a1" />
                        <Text style={styles.timeChipText}>{t}</Text>
                        <TouchableOpacity
                          onPress={() => cfgEnabled && removeTime(t)}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          style={styles.timeChipRemove}
                        >
                          <MaterialIcons name="close" size={13} color="#94a3b8" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}

                <View style={styles.addTimeRow}>
                  <TextInput
                    style={styles.addTimeInput}
                    value={cfgNewTime}
                    onChangeText={(v) => {
                      setCfgNewTime(v);
                      setCfgTimeError(null);
                    }}
                    placeholder="HH:MM"
                    placeholderTextColor="#94a3b8"
                    maxLength={5}
                    keyboardType="numbers-and-punctuation"
                    editable={cfgEnabled}
                    onSubmitEditing={addTime}
                    {...(Platform.OS === 'web' ? {
                      onKeyPress: (e: any) => { if (e.nativeEvent?.key === 'Enter') addTime(); },
                    } : {})}
                  />
                  <TouchableOpacity
                    style={[styles.addTimeBtn, !cfgEnabled && { opacity: 0.5 }]}
                    onPress={addTime}
                    disabled={!cfgEnabled}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name="add" size={16} color="#fff" />
                    <Text style={styles.addTimeBtnText}>Añadir</Text>
                  </TouchableOpacity>
                </View>
                {cfgTimeError && <Text style={styles.cfgError}>{cfgTimeError}</Text>}
              </View>
            </ScrollView>

            {/* Footer modal */}
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setConfigModalId(null)}>
                <Text style={styles.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSaveBtn} onPress={guardarConfig} disabled={cfgSaving} activeOpacity={0.7}>
                {cfgSaving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalSaveText}>Guardar</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  sectionDesc: { fontSize: 12, color: '#64748b', marginBottom: 16 },
  emptyText: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', paddingVertical: 20 },

  /* Grid responsive */
  cardsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 10,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  cardIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconDefault: { backgroundColor: '#e0f2fe' },
  cardIconOk: { backgroundColor: '#d1fae5' },
  cardIconError: { backgroundColor: '#fee2e2' },
  cardInfo: { flex: 1, gap: 2 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  cardDesc: { fontSize: 10, color: '#64748b', lineHeight: 14 },
  cardConfigBtn: { padding: 2 },

  /* Estado badge */
  cardStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeOn: { backgroundColor: '#ecfdf5' },
  statusBadgeOff: { backgroundColor: '#f1f5f9' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusDotOn: { backgroundColor: '#10b981' },
  statusDotOff: { backgroundColor: '#94a3b8' },
  statusText: { fontSize: 10, fontWeight: '600' },
  statusTextOn: { color: '#059669' },
  statusTextOff: { color: '#64748b' },

  cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cardMetaText: { fontSize: 10, color: '#94a3b8' },

  /* Schedule preview */
  scheduleRow: { gap: 4 },
  daysPreview: { flexDirection: 'row', gap: 3 },
  dayChipSmall: {
    width: 20,
    height: 20,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
  },
  dayChipSmallActive: { backgroundColor: '#dbeafe' },
  dayChipSmallText: { fontSize: 9, fontWeight: '600', color: '#94a3b8' },
  dayChipSmallTextActive: { color: '#1d4ed8' },
  timesPreview: { fontSize: 10, color: '#64748b', fontWeight: '500' },

  /* Selector de rango (ventas por producto) — escala de chips del card */
  daySelRow: { flexDirection: 'row', gap: 4 },
  daySelChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: '#f1f5f9',
  },
  daySelChipActive: { backgroundColor: '#dbeafe' },
  daySelText: { fontSize: 10, fontWeight: '600', color: '#64748b' },
  daySelTextActive: { color: '#1d4ed8' },

  /* Result / Error */
  resultBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#f0fdf4',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  resultText: { fontSize: 10, color: '#065f46', flex: 1 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontSize: 10, color: '#991b1b', flex: 1 },

  /* Sync button */
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  syncBtnDisabled: { opacity: 0.6 },
  syncBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },

  /* ─── Modal ─── */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },

  /* Config sections */
  cfgSection: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  cfgDisabled: { opacity: 0.45 },
  cfgRowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cfgLabel: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  cfgHint: { fontSize: 11, color: '#64748b', marginTop: 1 },
  cfgError: { fontSize: 11, color: '#dc2626', marginTop: 2 },

  /* Days selector */
  daysRow: { flexDirection: 'row', gap: 6 },
  dayChip: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
  },
  dayChipActive: {
    backgroundColor: '#dbeafe',
    borderColor: '#3b82f6',
  },
  dayChipText: { fontSize: 13, fontWeight: '700', color: '#94a3b8' },
  dayChipTextActive: { color: '#1d4ed8' },

  /* Roles del informe diario */
  rolChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
  },
  rolChipActive: { backgroundColor: '#dbeafe', borderColor: '#3b82f6' },
  rolChipText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  rolChipTextActive: { color: '#1d4ed8' },
  infStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  infActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  infActionBtn: { flex: 1, minWidth: 150, marginTop: 0 },
  infDownloadBtn: {
    flex: 1,
    minWidth: 150,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#e0f2fe',
    borderWidth: 1.5,
    borderColor: '#7dd3fc',
  },
  infDownloadBtnText: { fontSize: 13, fontWeight: '700', color: '#0369a1' },

  /* Times list */
  timesList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  timeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#e0f2fe',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timeChipText: { fontSize: 13, fontWeight: '600', color: '#0369a1' },
  timeChipRemove: { marginLeft: 2 },

  /* Add time */
  addTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  addTimeInput: {
    flex: 1,
    height: 36,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#f8fafc',
  },
  addTimeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addTimeBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },

  /* Modal footer */
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  modalCancelText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  modalSaveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    minWidth: 80,
    alignItems: 'center',
  },
  modalSaveText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  persoHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4,
  },
  persoHeaderTitleBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  persoSaveHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#d1fae5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  persoSaveHeaderBtnDisabled: { opacity: 0.65 },
  persoSaveHeaderBtnText: { fontSize: 12, fontWeight: '600', color: '#047857' },

  persoCardThumb: {
    width: '100%',
    height: 100,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginTop: 4,
  },
  persoCardThumbPlaceholder: {
    width: '100%',
    height: 100,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 4,
  },
  persoImagePlaceholderText: { fontSize: 10, color: '#94a3b8' },
  persoCardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  persoMiniBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#e0f2fe',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  persoMiniBtnText: { fontSize: 11, fontWeight: '600', color: '#0369a1' },
  persoMiniBtnDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  persoMiniBtnTextDanger: { fontSize: 11, fontWeight: '600', color: '#dc2626' },
  persoPctRowCard: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  persoPctInputCard: {
    flex: 1,
    minWidth: 0,
    height: 40,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
    backgroundColor: '#fff',
  },
  persoPctSuffix: { fontSize: 15, fontWeight: '600', color: '#64748b' },

  /* Facturación de mantenimiento */
  facCardAncha: { width: '100%', maxWidth: '100%' },
  facGrid: { marginTop: 12 },
  facCampo: { marginTop: 6 },
  facTextarea: { height: 76, paddingVertical: 8, fontWeight: '400', marginTop: 6 },
  facAvisoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#fffbeb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fde68a',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  facAvisoText: { fontSize: 11, color: '#92400e', flex: 1, lineHeight: 15 },
  facAvisoInline: { fontSize: 10, color: '#b45309', marginTop: 4 },
  facPendienteText: { fontSize: 10, color: '#0369a1', fontWeight: '600' },
  facLecturaBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#f0f9ff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bae6fd',
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 12,
  },
  facLecturaText: { fontSize: 11, color: '#0369a1', flex: 1, lineHeight: 15 },
  facValorLectura: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  facValorLecturaLargo: { fontWeight: '400', color: '#334155', lineHeight: 18 },
});
