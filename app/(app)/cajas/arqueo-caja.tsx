import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
  Image,
  useWindowDimensions,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useAuth } from '../../contexts/AuthContext';
import { puedeVerArqueoCaja } from '../../lib/permisosModulos';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';

/** Bancos permitidos en boletas (valor guardado = id). Logos vía Wikimedia; si falla la carga, se usa badge de color. */
const BANCOS_ARQUEO = [
  {
    id: 'BBVA',
    label: 'BBVA',
    color: '#004481',
    logoUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/BBVA_logo.svg/256px-BBVA_logo.svg.png',
  },
  {
    id: 'CAIXABANK',
    label: 'CaixaBank',
    color: '#007EAE',
    logoUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Logo_CaixaBank.svg/256px-Logo_CaixaBank.svg.png',
  },
  {
    id: 'SANTANDER',
    label: 'Santander',
    color: '#EC0000',
    logoUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Banco_Santander_Logotipo.svg/256px-Banco_Santander_Logotipo.svg.png',
  },
  {
    id: 'SABADELL',
    label: 'Sabadell',
    color: '#006D2C',
    logoUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Banco_Sabadell_logo.svg/256px-Banco_Sabadell_logo.svg.png',
  },
] as const;

type BancoArqueoId = (typeof BANCOS_ARQUEO)[number]['id'];

const BANCOS_ARQUEO_IDS: BancoArqueoId[] = BANCOS_ARQUEO.map((b) => b.id);

function normalizarBancoIdDesdeOcr(texto: string): BancoArqueoId | '' {
  const u = String(texto || '').toUpperCase();
  if (u.includes('BBVA')) return 'BBVA';
  if (u.includes('CAIXA')) return 'CAIXABANK';
  if (u.includes('SANTANDER')) return 'SANTANDER';
  if (u.includes('SABADELL')) return 'SABADELL';
  return '';
}

function etiquetaBanco(id: string): string {
  return BANCOS_ARQUEO.find((b) => b.id === id)?.label ?? '—';
}

/** Grupos con UI propia; el resto se renderiza con input numérico genérico. */
const GRUPO_EFECTIVO = 'Efectivo';
const GRUPO_TARJETA = 'Tarjeta';
const GRUPO_PREPAGO = 'Prepago Transferencia';

/** Billetes y monedas en euros (cantidad entera × valor). */
const EFECTIVO_DENOMINACIONES: { value: number; label: string }[] = [
  { value: 500, label: '500 €' },
  { value: 200, label: '200 €' },
  { value: 100, label: '100 €' },
  { value: 50, label: '50 €' },
  { value: 20, label: '20 €' },
  { value: 10, label: '10 €' },
  { value: 5, label: '5 €' },
  { value: 2, label: '2 €' },
  { value: 1, label: '1 €' },
  { value: 0.5, label: '0,50 €' },
  { value: 0.2, label: '0,20 €' },
  { value: 0.1, label: '0,10 €' },
  { value: 0.05, label: '0,05 €' },
  { value: 0.02, label: '0,02 €' },
  { value: 0.01, label: '0,01 €' },
];

const EFECTIVO_BILLETES = EFECTIVO_DENOMINACIONES.slice(0, 7);
const EFECTIVO_MONEDAS = EFECTIVO_DENOMINACIONES.slice(7);
const IDX_BILLETE_BASE = 0;
const IDX_MONEDA_BASE = 7;

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

async function safeJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}`);
  }
}

function formatMoneda(n: number): string {
  if (Number.isNaN(n)) return '—';
  const parts = n.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function parseEuroInput(s: string): number {
  const n = parseFloat(String(s).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Método de pago a mostrar/arquear (viene del maestro Igp_FormasPago vía backend). */
type MetodoArqueo = {
  grupo: string;
  label: string;
  arquear: boolean;
  orden: number;
  /** Real automático calculado por el backend (no editable). P. ej. prepago = Σ transferencias. */
  auto?: boolean;
  autoImporte?: number;
  /** Importe de retiradas de caja que se suma al efectivo para el descuadre. */
  ajusteRetiradas?: number;
};

type CompareResponse = {
  /** Métodos dinámicos a mostrar. Si falta, se usa fallback de los 5 históricos. */
  metodos?: MetodoArqueo[];
  teorico: Record<string, number>;
  /** Real guardado por grupo de forma de pago. */
  real: Record<string, number>;
  diff: Record<string, number>;
  /** Suma de diferencias (coincide con descuadreTotal guardado en Dynamo al guardar). */
  descuadreTotal?: number;
  /** Estado del arqueo guardado del TPV: null si no hay arqueo guardado. */
  estado?: 'borrador' | 'cerrado' | null;
  /** Totales de movimientos de caja del TPV: retiradas (efectivo) y transferencias (prepago). */
  movimientos?: { retiradas: number; transferencias: number };
  closeoutsCount: number;
  error?: string;
  realGuardado?: {
    tarjetaLineas?: TarjetaLineaPersisted[];
    /** Desglose de efectivo por denominación: { "50": 2, "0.5": 10 }. */
    efectivoConteo?: Record<string, number>;
  };
};

type JornadaTpv = {
  posId: string;
  posName: string;
  estado: 'borrador' | 'cerrado';
  descuadreTotal?: number;
  cerradoEn?: string | null;
};

type JornadaResponse = {
  workplaceId: string;
  businessDay: string;
  arqueos: JornadaTpv[];
  jornada?: { estado?: string; descuadreTotal?: number; cerradoPor?: string | null; cerradoEn?: string | null } | null;
  estado: 'abierta' | 'cerrada';
  puedeCerrar: boolean;
  pendientes: string[];
  error?: string;
};

/** Fallback si el backend no devuelve `metodos` (tabla aún sin sincronizar). */
const METODOS_FALLBACK: MetodoArqueo[] = [
  { grupo: 'Efectivo', label: 'Efectivo', arquear: true, orden: 1 },
  { grupo: 'Tarjeta', label: 'Tarjeta', arquear: true, orden: 2 },
  { grupo: 'Pendiente de cobro', label: 'Pendiente de cobro', arquear: true, orden: 3 },
  { grupo: 'Prepago Transferencia', label: 'Prepago Transferencia', arquear: true, orden: 4 },
  { grupo: 'AgoraPay', label: 'AgoraPay', arquear: true, orden: 5 },
];

/** Línea de boleta tarjeta guardada en Dynamo (sin URIs locales). */
type TarjetaLineaPersisted = {
  id?: string;
  banco?: string;
  importe?: string;
  numeroComercio?: string;
  fechaHora?: string;
  imagenKey?: string;
  ocrCompletado?: boolean;
};

type TarjetaLinea = TarjetaLineaPersisted & {
  id: string;
  localUri?: string;
  previewUrl?: string;
};

function newTarjetaLinea(): TarjetaLinea {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    banco: '',
    importe: '',
    numeroComercio: '',
    fechaHora: '',
    imagenKey: '',
    ocrCompletado: false,
  };
}

function normalizeTarjetaLineaFromApi(raw: unknown): TarjetaLinea {
  const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bancoRaw = String(x.banco ?? '');
  const banco =
    BANCOS_ARQUEO_IDS.includes(bancoRaw as BancoArqueoId) ? (bancoRaw as BancoArqueoId) : '';
  return {
    id: String(x.id ?? `line-${Date.now()}`),
    banco,
    importe: String(x.importe ?? ''),
    numeroComercio: String(x.numeroComercio ?? x.numero_comercio ?? ''),
    fechaHora: String(x.fechaHora ?? x.fecha_hora ?? ''),
    imagenKey: String(x.imagenKey ?? x.imagen_key ?? ''),
    ocrCompletado: Boolean(x.ocrCompletado ?? x.ocr_completado),
  };
}

async function appendImagenOcrTarjeta(form: FormData, uri: string) {
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    const blob = await res.blob();
    form.append('imagen', blob, 'ticket.jpg');
  } else {
    form.append('imagen', { uri, name: 'ticket.jpg', type: 'image/jpeg' } as unknown as Blob);
  }
}

async function obtenerUriImagen(source: 'library' | 'camera'): Promise<string | null> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
    const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (res.canceled || !res.assets?.[0]?.uri) return null;
    return res.assets[0].uri;
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.85,
  });
  if (res.canceled || !res.assets?.[0]?.uri) return null;
  return res.assets[0].uri;
}

export default function ArqueoCajaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ workplaceId?: string; posId?: string; posName?: string; businessDay?: string }>();
  const { hasPermiso, user } = useAuth();
  const { shouldStackToolbar } = useBreakpoint();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [saleCenters, setSaleCenters] = useState<{ Id?: number; Nombre?: string; Local?: string; Activo?: boolean }[]>([]);

  const [businessDayIso, setBusinessDayIso] = useState(
    () => (typeof params.businessDay === 'string' && params.businessDay) || fechaJornadaNegocioIso(),
  );
  const [formLocal, setFormLocal] = useState(typeof params.workplaceId === 'string' ? params.workplaceId : '');
  const [formPosId, setFormPosId] = useState(typeof params.posId === 'string' ? params.posId : '');
  const [formPosName, setFormPosName] = useState(typeof params.posName === 'string' ? params.posName : '');

  const [efectivoReal, setEfectivoReal] = useState('');
  const [tarjetaReal, setTarjetaReal] = useState('');
  const [tarjetaLineas, setTarjetaLineas] = useState<TarjetaLinea[]>([]);
  const [ocrLineId, setOcrLineId] = useState<string | null>(null);
  /** Real introducido para grupos distintos de Efectivo/Tarjeta (clave = grupo). */
  const [otrosReal, setOtrosReal] = useState<Record<string, string>>({});

  const setOtroReal = useCallback((grupo: string, val: string) => {
    setOtrosReal((prev) => ({ ...prev, [grupo]: val }));
  }, []);

  const [compare, setCompare] = useState<CompareResponse | null>(null);

  const metodos = useMemo<MetodoArqueo[]>(() => {
    const list = compare?.metodos && compare.metodos.length > 0 ? compare.metodos : METODOS_FALLBACK;
    return [...list].sort((a, b) => (a.orden - b.orden) || a.grupo.localeCompare(b.grupo));
  }, [compare]);

  const [loadingCompare, setLoadingCompare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // Jornada del local: estado de los arqueos por TPV y cierre consolidado.
  const [jornada, setJornada] = useState<JornadaResponse | null>(null);
  const [jornadaBusy, setJornadaBusy] = useState(false);
  const primerFoco = useRef(true);

  const [conteoEfectivoOpen, setConteoEfectivoOpen] = useState(false);
  const [conteoCantidades, setConteoCantidades] = useState<string[]>(() => EFECTIVO_DENOMINACIONES.map(() => ''));
  const [syncingCloseouts, setSyncingCloseouts] = useState(false);
  const [tarjetaBoletasModalOpen, setTarjetaBoletasModalOpen] = useState(false);
  /** En el modal, fila con detalle desplegado (campos OCR; la foto se ve en miniatura o al ampliar). */
  const [tarjetaLineaExpandidaId, setTarjetaLineaExpandidaId] = useState<string | null>(null);
  /** Vista previa a pantalla completa al pulsar la miniatura. */
  const [tarjetaLightboxUri, setTarjetaLightboxUri] = useState<string | null>(null);

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const tarjetaCamposDosColumnas = windowWidth >= 480;
  /** Altura máxima del scroll del modal (~mitad de pantalla, acotada). */
  const tarjetaModalScrollMaxH = useMemo(
    () => Math.min(560, Math.max(180, windowHeight * 0.42)),
    [windowHeight],
  );


  const agoraCodeToNombre = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) map[code] = nombre || '—';
    }
    return map;
  }, [locales]);

  const saleCentersPorLocal = useMemo(() => {
    if (!formLocal.trim()) return saleCenters.filter((sc) => sc.Activo !== false);
    const localName = String(agoraCodeToNombre[formLocal.trim()] ?? '').trim();
    return saleCenters.filter((sc) => {
      if (sc.Activo === false) return false;
      return String(sc.Local ?? '').trim() === localName;
    });
  }, [saleCenters, formLocal, agoraCodeToNombre]);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => safeJson<{ locales?: LocalItem[] }>(r))
      .then((d) => setLocales(d.locales || []))
      .catch(() => setLocales([]));
  }, []);

  useEffect(() => {
    apiFetch('/api/agora/sale-centers')
      .then((r) => safeJson<{ saleCenters?: typeof saleCenters }>(r))
      .then((d) => setSaleCenters(d.saleCenters || []))
      .catch(() => setSaleCenters([]));
  }, []);

  useEffect(() => {
    if (formLocal && formPosId && saleCentersPorLocal.length > 0 && !saleCentersPorLocal.some((sc) => String(sc.Id) === formPosId)) {
      setFormPosId('');
      setFormPosName('');
    }
  }, [formLocal, saleCentersPorLocal, formPosId]);

  const totalTarjetaImporte = useMemo(() => {
    if (tarjetaLineas.length > 0) {
      let s = 0;
      for (const l of tarjetaLineas) s += parseEuroInput(l.importe ?? '');
      return Math.round(s * 100) / 100;
    }
    return parseEuroInput(tarjetaReal);
  }, [tarjetaLineas, tarjetaReal]);

  useEffect(() => {
    if (tarjetaLineas.length === 0) return;
    const s = tarjetaLineas.reduce((acc, l) => acc + parseEuroInput(l.importe ?? ''), 0);
    const rounded = Math.round(s * 100) / 100;
    setTarjetaReal(rounded.toFixed(2).replace('.', ','));
  }, [tarjetaLineas]);

  /** Retiradas de efectivo y transferencias de prepago (movimientos de caja). */
  const movRetiradas = compare?.movimientos?.retiradas ?? 0;
  const movTransferencias = compare?.movimientos?.transferencias ?? 0;

  /**
   * Importe real introducido para un grupo (según su UI).
   * `metodo.auto` (prepago) usa el importe automático del backend; el efectivo
   * suma las retiradas (dinero que salió del cajón pero es recaudación real).
   */
  const realDeGrupo = useCallback(
    (grupo: string, metodo?: MetodoArqueo): number => {
      if (metodo?.auto) return compare?.real?.[grupo] ?? metodo.autoImporte ?? 0;
      if (grupo === GRUPO_EFECTIVO) return parseEuroInput(efectivoReal) + movRetiradas;
      if (grupo === GRUPO_TARJETA) return totalTarjetaImporte;
      return parseEuroInput(otrosReal[grupo] ?? '');
    },
    [efectivoReal, totalTarjetaImporte, otrosReal, compare, movRetiradas],
  );

  const diffsEnVivo = useMemo(() => {
    if (!compare) return null;
    const t = compare.teorico;
    const out: Record<string, number> = {};
    for (const m of metodos) {
      const teo = t[m.grupo] ?? 0;
      // Si el método no se arquea, su real = teórico (diferencia 0).
      out[m.grupo] = m.arquear ? realDeGrupo(m.grupo, m) - teo : 0;
    }
    return out;
  }, [compare, metodos, realDeGrupo]);

  const descuadreEnVivo = useMemo(() => {
    if (!diffsEnVivo) return null;
    let s = 0;
    for (const v of Object.values(diffsEnVivo)) s += v;
    return Math.round(s * 100) / 100;
  }, [diffsEnVivo]);

  const totalConteoEfectivo = useMemo(() => {
    let s = 0;
    conteoCantidades.forEach((raw, i) => {
      const q = parseInt(String(raw).replace(/\D/g, ''), 10);
      if (!Number.isFinite(q) || q < 0) return;
      s += q * EFECTIVO_DENOMINACIONES[i].value;
    });
    return Math.round(s * 100) / 100;
  }, [conteoCantidades]);

  const limpiarConteoEfectivo = useCallback(() => {
    setConteoCantidades(EFECTIVO_DENOMINACIONES.map(() => ''));
  }, []);

  const aplicarConteoEfectivo = useCallback(() => {
    const t = totalConteoEfectivo;
    setEfectivoReal(t.toFixed(2).replace('.', ','));
    setConteoEfectivoOpen(false);
  }, [totalConteoEfectivo]);

  const fetchCompare = useCallback(() => {
    if (!businessDayIso || !formLocal.trim() || !formPosId) {
      setCompare(null);
      return;
    }
    setLoadingCompare(true);
    setError(null);
    const q = new URLSearchParams({
      workplaceId: formLocal.trim(),
      businessDay: businessDayIso,
      posId: formPosId,
    });
    apiFetch(`/api/cajas/arqueos-reales/compare?${q}`)
      .then((r) => safeJson<CompareResponse & { error?: string }>(r))
      .then((data) => {
        if ((data as { error?: string }).error) {
          setError((data as { error: string }).error);
          setCompare(null);
          return;
        }
        setCompare(data);
        const r = data.real;
        const rg = (data as CompareResponse).realGuardado;
        const incoming = Array.isArray(rg?.tarjetaLineas) ? rg.tarjetaLineas : [];
        if (incoming.length > 0) {
          const normalized = incoming.map(normalizeTarjetaLineaFromApi);
          setTarjetaLineas(normalized);
          Promise.all(
            normalized.map(async (l) => {
              if (!l.imagenKey || l.localUri) return l;
              try {
                const rurl = await apiFetch(
                  `/api/cajas/arqueos-reales/ticket-image-url?key=${encodeURIComponent(l.imagenKey)}`,
                );
                const d = await safeJson<{ url?: string }>(rurl);
                return { ...l, previewUrl: d.url };
              } catch {
                return l;
              }
            }),
          ).then((lines) => setTarjetaLineas(lines));
        } else {
          setTarjetaLineas([]);
        }
        // Recupera el desglose de efectivo guardado (si lo hay) para precargar el conteo.
        const conteo = (rg?.efectivoConteo && typeof rg.efectivoConteo === 'object' ? rg.efectivoConteo : {}) as Record<string, number>;
        setConteoCantidades(
          EFECTIVO_DENOMINACIONES.map((d) => {
            const q = Number(conteo[String(d.value)]);
            return Number.isFinite(q) && q > 0 ? String(q) : '';
          }),
        );
        const realMap = (r && typeof r === 'object' ? r : {}) as Record<string, number>;
        const hayReal = Object.keys(realMap).length > 0;
        setEfectivoReal(hayReal && realMap[GRUPO_EFECTIVO] != null ? String(realMap[GRUPO_EFECTIVO]) : '');
        setTarjetaReal(hayReal && realMap[GRUPO_TARJETA] != null ? String(realMap[GRUPO_TARJETA]) : '');
        const otros: Record<string, string> = {};
        for (const [grupo, val] of Object.entries(realMap)) {
          if (grupo === GRUPO_EFECTIVO || grupo === GRUPO_TARJETA) continue;
          otros[grupo] = val != null ? String(val) : '';
        }
        setOtrosReal(otros);
      })
      .catch((e) => {
        setError(e.message || 'Error al cargar comparativa');
        setCompare(null);
      })
      .finally(() => setLoadingCompare(false));
  }, [businessDayIso, formLocal, formPosId]);

  /** Misma acción que en Cierres teóricos: trae cierres de Ágora y los guarda en Dynamo para poder comparar. */
  const sincronizarCierresTeoricos = useCallback(async () => {
    if (!businessDayIso || !formLocal.trim()) {
      setError('Indica fecha de negocio y local para sincronizar.');
      return;
    }
    setSyncingCloseouts(true);
    setError(null);
    try {
      const res = await apiFetch('/api/agora/closeouts/sync', {
        method: 'POST',
        body: JSON.stringify({
          businessDay: businessDayIso,
          workplaces: formLocal.trim(),
        }),
      });
      const data = await safeJson<{ ok?: boolean; error?: string; upserted?: number }>(res);
      if (!res.ok || (data as { error?: string }).error) {
        throw new Error((data as { error?: string }).error || 'Error al sincronizar cierres');
      }
      fetchCompare();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al sincronizar cierres teóricos');
    } finally {
      setSyncingCloseouts(false);
    }
  }, [businessDayIso, formLocal, fetchCompare]);

  useEffect(() => {
    const t = setTimeout(fetchCompare, 300);
    return () => clearTimeout(t);
  }, [fetchCompare]);

  const guardar = async (opts?: { cerrar?: boolean }) => {
    if (!businessDayIso || !formLocal.trim() || !formPosId) {
      setError('Indica fecha, local y TPV');
      return;
    }
    for (const l of tarjetaLineas) {
      const tieneImagen = !!(l.localUri || l.previewUrl || l.imagenKey);
      if (!tieneImagen) continue;
      if (!l.ocrCompletado) {
        setError('En cada boleta con imagen debes ejecutar OCR al menos una vez.');
        return;
      }
      if (!l.banco || !BANCOS_ARQUEO_IDS.includes(l.banco as BancoArqueoId)) {
        setError('Selecciona el banco en cada boleta con imagen.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    setSaveOk(false);
    try {
      // Mapa dinámico real por grupo: solo los métodos que se arquean.
      const realPorMetodo: Record<string, string> = {};
      for (const m of metodos) {
        if (!m.arquear || m.auto) continue; // prepago es automático: lo calcula el backend
        let val = '';
        if (m.grupo === GRUPO_EFECTIVO) val = efectivoReal;
        else if (m.grupo === GRUPO_TARJETA) val = tarjetaReal;
        else val = otrosReal[m.grupo] ?? '';
        realPorMetodo[m.grupo] = String(val).replace(',', '.');
      }
      const body = {
        PK: formLocal.trim(),
        BusinessDay: businessDayIso,
        PosId: formPosId,
        PosName: formPosName,
        WorkplaceName: agoraCodeToNombre[formLocal.trim()] ?? formLocal,
        realPorMetodo,
        // Desglose de billetes/monedas para que quien reabra el arqueo lo vea y pueda editarlo.
        efectivoConteo: Object.fromEntries(
          conteoCantidades
            .map((raw, i) => [String(EFECTIVO_DENOMINACIONES[i].value), parseInt(String(raw).replace(/\D/g, ''), 10) || 0] as const)
            .filter(([, q]) => q > 0),
        ),
        tarjetaLineas: tarjetaLineas.map((l) => ({
          id: l.id,
          banco: l.banco,
          importe: l.importe,
          numeroComercio: l.numeroComercio,
          fechaHora: l.fechaHora,
          imagenKey: l.imagenKey,
          ocrCompletado: Boolean(l.ocrCompletado),
        })),
        usuarioId: user?.id_usuario,
        usuarioNombre: user?.Nombre,
      };
      const res = await apiFetch('/api/cajas/arqueos-reales', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const data = await safeJson<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data.error) throw new Error(data.error || 'Error al guardar');
      // Cierre encadenado: tras guardar los importes, marca el arqueo como cerrado.
      if (opts?.cerrar) {
        const resEstado = await apiFetch('/api/cajas/arqueos-reales/estado', {
          method: 'POST',
          body: JSON.stringify({
            workplaceId: formLocal.trim(),
            businessDay: businessDayIso,
            posId: formPosId,
            estado: 'cerrado',
            usuarioId: user?.id_usuario,
            usuarioNombre: user?.Nombre,
          }),
        });
        const dataEstado = await safeJson<{ ok?: boolean; error?: string }>(resEstado);
        if (!resEstado.ok || dataEstado.error) throw new Error(dataEstado.error || 'Guardado, pero no se pudo cerrar el arqueo');
      }
      setSaveOk(true);
      fetchCompare();
      fetchJornada();
      setTimeout(() => setSaveOk(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const fetchJornada = useCallback(() => {
    if (!businessDayIso || !formLocal.trim()) {
      setJornada(null);
      return;
    }
    const q = new URLSearchParams({ workplaceId: formLocal.trim(), businessDay: businessDayIso });
    apiFetch(`/api/cajas/jornada?${q}`)
      .then((r) => safeJson<JornadaResponse>(r))
      .then((d) => {
        if ((d as { error?: string }).error) { setJornada(null); return; }
        setJornada(d);
      })
      .catch(() => setJornada(null));
  }, [businessDayIso, formLocal]);

  useEffect(() => {
    const t = setTimeout(fetchJornada, 350);
    return () => clearTimeout(t);
  }, [fetchJornada]);

  useFocusEffect(
    useCallback(() => {
      if (primerFoco.current) {
        primerFoco.current = false;
        return;
      }
      fetchCompare();
      fetchJornada();
    }, [fetchCompare, fetchJornada]),
  );

  /** Cierra o reabre el arqueo del TPV seleccionado. */
  const cambiarEstadoArqueo = useCallback(
    async (estado: 'cerrado' | 'borrador') => {
      if (!businessDayIso || !formLocal.trim() || !formPosId) return;
      setJornadaBusy(true);
      setError(null);
      try {
        const res = await apiFetch('/api/cajas/arqueos-reales/estado', {
          method: 'POST',
          body: JSON.stringify({
            workplaceId: formLocal.trim(),
            businessDay: businessDayIso,
            posId: formPosId,
            estado,
            usuarioId: user?.id_usuario,
            usuarioNombre: user?.Nombre,
          }),
        });
        const data = await safeJson<{ ok?: boolean; error?: string }>(res);
        if (!res.ok || data.error) throw new Error(data.error || 'Error al cambiar el estado');
        fetchCompare();
        fetchJornada();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al cambiar el estado del arqueo');
      } finally {
        setJornadaBusy(false);
      }
    },
    [businessDayIso, formLocal, formPosId, user, fetchCompare, fetchJornada],
  );

  /** Cierra o reabre la jornada del local (consolidado). */
  const cambiarEstadoJornada = useCallback(
    async (accion: 'cerrar' | 'reabrir') => {
      if (!businessDayIso || !formLocal.trim()) return;
      setJornadaBusy(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/cajas/jornada/${accion}`, {
          method: 'POST',
          body: JSON.stringify({
            workplaceId: formLocal.trim(),
            businessDay: businessDayIso,
            workplaceName: agoraCodeToNombre[formLocal.trim()] ?? formLocal,
            usuarioId: user?.id_usuario,
            usuarioNombre: user?.Nombre,
          }),
        });
        const data = await safeJson<{ ok?: boolean; error?: string }>(res);
        if (!res.ok || data.error) throw new Error(data.error || 'Error al actualizar la jornada');
        fetchCompare();
        fetchJornada();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al actualizar la jornada del local');
      } finally {
        setJornadaBusy(false);
      }
    },
    [businessDayIso, formLocal, agoraCodeToNombre, user, fetchCompare, fetchJornada],
  );

  const openTarjetaBoletasModal = useCallback(() => {
    setTarjetaBoletasModalOpen(true);
  }, []);

  const removeTarjetaLinea = useCallback((id: string) => {
    setTarjetaLineas((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const quitarLineasTarjeta = useCallback(() => {
    setTarjetaLineas([]);
  }, []);

  const updateTarjetaLinea = useCallback((id: string, patch: Partial<TarjetaLinea>) => {
    setTarjetaLineas((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  /** Lanza el OCR sobre una imagen ya disponible. Devuelve true si el OCR rellenó los campos clave. */
  const ejecutarOcrBoleta = useCallback(
    async (lineId: string, uri: string): Promise<boolean> => {
      if (!businessDayIso || !formLocal.trim()) {
        setError('Indica fecha y local antes de escanear.');
        return false;
      }
      setOcrLineId(lineId);
      setError(null);
      try {
        const form = new FormData();
        form.append('workplaceId', formLocal.trim());
        form.append('businessDay', businessDayIso);
        form.append('lineId', lineId);
        await appendImagenOcrTarjeta(form, uri);
        const resp = await apiFetch('/api/cajas/arqueos-reales/ocr-ticket', { method: 'POST', body: form });
        const data = await safeJson<{
          ok?: boolean;
          error?: string;
          banco?: string;
          importe?: string;
          numeroComercio?: string;
          fechaHora?: string;
          imagenKey?: string;
          imagenUrl?: string;
        }>(resp);
        if (!resp.ok || data.error) throw new Error(data.error || 'Error al escanear');
        const bancoOcr = normalizarBancoIdDesdeOcr(data.banco ?? '');
        setTarjetaLineas((prev) =>
          prev.map((l) =>
            l.id === lineId
              ? {
                  ...l,
                  banco: bancoOcr || l.banco,
                  importe: data.importe ?? l.importe,
                  numeroComercio: data.numeroComercio ?? l.numeroComercio,
                  fechaHora: data.fechaHora ?? l.fechaHora,
                  imagenKey: data.imagenKey ?? l.imagenKey,
                  previewUrl: data.imagenUrl ?? l.previewUrl,
                  ocrCompletado: true,
                }
              : l,
          ),
        );
        // El OCR es orientativo: si falta banco, importe o nº de comercio, hay que revisar a mano.
        return Boolean(bancoOcr && data.importe && data.numeroComercio);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al escanear');
        return false;
      } finally {
        setOcrLineId(null);
      }
    },
    [businessDayIso, formLocal],
  );

  /**
   * Flujo principal de captura de boleta: abre cámara (móvil/tablet) o galería (web),
   * y al obtener la foto lanza el OCR automáticamente. Si se cancela, el OCR falla o
   * deja campos sin rellenar, despliega la fila para edición manual.
   */
  const capturarEscanearBoleta = useCallback(
    async (lineId: string, source: 'library' | 'camera') => {
      const uri = await obtenerUriImagen(source);
      if (!uri) {
        // Cancelado: dejar la fila lista para introducir los datos a mano.
        setTarjetaLineaExpandidaId(lineId);
        return;
      }
      setTarjetaLineas((prev) =>
        prev.map((l) =>
          l.id === lineId
            ? { ...l, localUri: uri, previewUrl: undefined, ocrCompletado: false, imagenKey: '' }
            : l,
        ),
      );
      const ok = await ejecutarOcrBoleta(lineId, uri);
      // Si el OCR no completó todos los campos clave, abrir el detalle para revisar/corregir.
      if (!ok) setTarjetaLineaExpandidaId(lineId);
    },
    [ejecutarOcrBoleta],
  );

  /** Reintento manual del OCR sobre una imagen ya añadida. */
  const escanearTarjetaLinea = useCallback(
    async (line: TarjetaLinea) => {
      const uri = line.localUri || line.previewUrl;
      if (!uri) {
        setError('Añade una imagen antes de escanear.');
        return;
      }
      await ejecutarOcrBoleta(line.id, uri);
    },
    [ejecutarOcrBoleta],
  );

  const addTarjetaLinea = useCallback(() => {
    const nl = newTarjetaLinea();
    let added = false;
    setTarjetaLineas((prev) => {
      if (prev.length >= 20) return prev;
      added = true;
      return [...prev, nl];
    });
    if (!added) return;
    // Sin fecha/local no se puede escanear: añadimos la boleta lista para introducir datos a mano.
    if (!businessDayIso || !formLocal.trim()) {
      setTarjetaLineaExpandidaId(nl.id);
      return;
    }
    setTarjetaLineaExpandidaId(null);
    // Primero la cámara (móvil/tablet) o galería (web); el OCR se lanza automáticamente.
    const source: 'library' | 'camera' = Platform.OS === 'web' ? 'library' : 'camera';
    capturarEscanearBoleta(nl.id, source);
  }, [businessDayIso, formLocal, capturarEscanearBoleta]);

  if (!puedeVerArqueoCaja(hasPermiso)) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={64}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Arqueo de caja</Text>
        </View>

        <Text style={styles.lead}>
          Introduce los importes reales para contrastarlos con el cierre teórico (Ágora) del mismo día, local y TPV.
        </Text>

        <View style={[styles.filtrosRow, shouldStackToolbar && styles.filtrosRowStack]}>
          <View style={[styles.filtrosColFecha, !shouldStackToolbar && styles.filtrosColInline]}>
            <Text style={styles.labelFiltros}>Fecha negocio</Text>
            <InputFecha
              valueIso={businessDayIso}
              onChangeIso={setBusinessDayIso}
              placeholder="dd/mm/aaaa"
              style={styles.inputFechaCompact}
            />
          </View>
          <View style={[styles.filtrosColSelect, !shouldStackToolbar && styles.filtrosColInlineFlex]}>
            <Text style={styles.labelFiltros}>Local</Text>
            <SelectorDesplegable
              style={!shouldStackToolbar ? styles.selectorInline : undefined}
              icono="store"
              iconoLista="store"
              tituloLista="Local"
              placeholder="Seleccionar…"
              buscador
              buscadorPlaceholder="Buscar local…"
              valorId={formLocal}
              opciones={locales
                .map((loc) => {
                  const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                  const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
                  return { code, nombre };
                })
                .filter((l) => l.code)
                .map((l) => ({
                  id: l.code,
                  titulo: l.nombre || '—',
                  subtitulo: `id ${l.code}`,
                  icono: 'store' as const,
                }))}
              onSeleccionar={(code) => setFormLocal(code)}
            />
          </View>
          <View style={[styles.filtrosColSelect, !shouldStackToolbar && styles.filtrosColInlineFlex]}>
            <Text style={styles.labelFiltros}>TPV</Text>
            <SelectorDesplegable
              style={!shouldStackToolbar ? styles.selectorInline : undefined}
              icono="point-of-sale"
              iconoLista="point-of-sale"
              tituloLista="TPV"
              placeholder="Seleccionar…"
              disabled={!formLocal}
              vacioTexto="No hay TPVs activos para este local."
              valorId={formPosId}
              opciones={saleCentersPorLocal.map((sc) => {
                const id = sc.Id != null ? String(sc.Id) : '';
                const nom = String(sc.Nombre ?? '').trim() || `TPV ${id}`;
                return { id, titulo: nom, subtitulo: `id ${id}`, icono: 'point-of-sale' as const };
              })}
              onSeleccionar={(id) => {
                const sc = saleCentersPorLocal.find((s) => String(s.Id) === id);
                setFormPosId(id);
                setFormPosName(String(sc?.Nombre ?? '').trim() || `TPV ${id}`);
              }}
            />
          </View>
        </View>

        <View style={styles.syncRow}>
          <TouchableOpacity
            style={[
              styles.syncBtn,
              (!businessDayIso || !formLocal.trim() || syncingCloseouts) && styles.syncBtnDisabled,
            ]}
            onPress={sincronizarCierresTeoricos}
            disabled={!businessDayIso || !formLocal.trim() || syncingCloseouts}
            activeOpacity={0.7}
          >
            {syncingCloseouts ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="sync" size={18} color="#0ea5e9" />
            )}
            <Text
              style={[
                styles.syncBtnText,
                (!businessDayIso || !formLocal.trim()) && styles.syncBtnTextDisabled,
              ]}
            >
              Sincronizar cierres teóricos
            </Text>
          </TouchableOpacity>
          <Text style={styles.syncHint}>
            Descarga de Ágora el cierre del día para este local, guarda en la tabla de cierres teóricos y actualiza la comparativa (elige también el TPV para ver el teórico por TPV).
          </Text>
        </View>

        <Modal visible={conteoEfectivoOpen} transparent animationType="fade" onRequestClose={() => setConteoEfectivoOpen(false)}>
          <Pressable style={styles.modalBackdropConteo} onPress={() => setConteoEfectivoOpen(false)}>
            <Pressable style={[styles.modalSheet, styles.modalSheetConteo]} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>Conteo de efectivo</Text>
              <Text style={styles.conteoIntro}>
                Indica cuántas piezas de cada denominación. El total se aplicará al campo «Efectivo real».
              </Text>
              <ScrollView
                style={styles.conteoScroll}
                contentContainerStyle={styles.conteoScrollContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                <View style={styles.conteoTwoCols}>
                  <View style={styles.conteoCol}>
                    <View style={[styles.conteoColHeader, styles.conteoColHeaderBilletes]}>
                      <View style={styles.conteoColIconCircle}>
                        <MaterialIcons name="receipt-long" size={22} color="#0f766e" />
                      </View>
                      <Text style={styles.conteoColTitle}>Billetes</Text>
                    </View>
                    {EFECTIVO_BILLETES.map((den, i) => {
                      const idx = IDX_BILLETE_BASE + i;
                      const raw = conteoCantidades[idx] ?? '';
                      const qty = parseInt(raw, 10);
                      const q = Number.isFinite(qty) && qty > 0 ? qty : 0;
                      const sub = Math.round(q * den.value * 100) / 100;
                      return (
                        <View key={den.label} style={styles.conteoRow}>
                          <MaterialIcons name="note" size={14} color="#94a3b8" style={styles.conteoRowMiniIcon} />
                          <Text style={styles.conteoDenomLabel} numberOfLines={1}>
                            {den.label}
                          </Text>
                          <View style={styles.conteoQtySubGroup}>
                            <TextInput
                              style={styles.conteoQtyInput}
                              value={raw}
                              onChangeText={(text) => {
                                const digits = text.replace(/[^\d]/g, '');
                                setConteoCantidades((prev) => {
                                  const next = [...prev];
                                  next[idx] = digits;
                                  return next;
                                });
                              }}
                              keyboardType="number-pad"
                              placeholder="0"
                              placeholderTextColor="#94a3b8"
                            />
                            <Text style={styles.conteoSub} numberOfLines={1}>
                              {q > 0 ? formatMoneda(sub) : '—'}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                  <View style={styles.conteoCol}>
                    <View style={[styles.conteoColHeader, styles.conteoColHeaderMonedas]}>
                      <View style={[styles.conteoColIconCircle, styles.conteoColIconCircleMonedas]}>
                        <MaterialIcons name="toll" size={22} color="#b45309" />
                      </View>
                      <Text style={styles.conteoColTitle}>Monedas</Text>
                    </View>
                    {EFECTIVO_MONEDAS.map((den, i) => {
                      const idx = IDX_MONEDA_BASE + i;
                      const raw = conteoCantidades[idx] ?? '';
                      const qty = parseInt(raw, 10);
                      const q = Number.isFinite(qty) && qty > 0 ? qty : 0;
                      const sub = Math.round(q * den.value * 100) / 100;
                      return (
                        <View key={den.label} style={styles.conteoRow}>
                          <MaterialIcons name="lens" size={14} color="#d97706" style={styles.conteoRowMiniIcon} />
                          <Text style={styles.conteoDenomLabel} numberOfLines={1}>
                            {den.label}
                          </Text>
                          <View style={styles.conteoQtySubGroup}>
                            <TextInput
                              style={styles.conteoQtyInput}
                              value={raw}
                              onChangeText={(text) => {
                                const digits = text.replace(/[^\d]/g, '');
                                setConteoCantidades((prev) => {
                                  const next = [...prev];
                                  next[idx] = digits;
                                  return next;
                                });
                              }}
                              keyboardType="number-pad"
                              placeholder="0"
                              placeholderTextColor="#94a3b8"
                            />
                            <Text style={styles.conteoSub} numberOfLines={1}>
                              {q > 0 ? formatMoneda(sub) : '—'}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              </ScrollView>
              <View style={styles.conteoTotalBar}>
                <Text style={styles.conteoTotalLabel}>Total</Text>
                <Text style={styles.conteoTotalVal}>{formatMoneda(totalConteoEfectivo)}</Text>
              </View>
              <View style={styles.conteoActions}>
                <TouchableOpacity style={styles.conteoBtnSecondary} onPress={limpiarConteoEfectivo}>
                  <Text style={styles.conteoBtnSecondaryText}>Poner a cero</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.conteoBtnSecondary} onPress={() => setConteoEfectivoOpen(false)}>
                  <Text style={styles.conteoBtnSecondaryText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.conteoBtnPrimary} onPress={aplicarConteoEfectivo}>
                  <Text style={styles.conteoBtnPrimaryText}>Aplicar</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={tarjetaBoletasModalOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setTarjetaBoletasModalOpen(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setTarjetaBoletasModalOpen(false)}>
            <Pressable style={[styles.modalSheet, styles.tarjetaModalSheet]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.tarjetaModalHeader}>
                <Text style={styles.tarjetaModalTitle}>Boletas tarjeta</Text>
                <TouchableOpacity
                  onPress={() => setTarjetaBoletasModalOpen(false)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <MaterialIcons name="close" size={24} color="#64748b" />
                </TouchableOpacity>
              </View>
              <Text style={styles.tarjetaModalLead}>
                Al añadir una boleta se abre la cámara y se escanea automáticamente (OCR). Revisa los datos y corrígelos a mano si hace falta. Pulsa la miniatura para ampliar la foto.
              </Text>
              <ScrollView
                style={[styles.tarjetaModalScroll, { maxHeight: tarjetaModalScrollMaxH }]}
                contentContainerStyle={styles.tarjetaModalScrollContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                {tarjetaLineas.length === 0 ? (
                  <Text style={styles.tarjetaModalEmpty}>No hay boletas. Pulsa «Añadir boleta» abajo para abrir la cámara y escanear.</Text>
                ) : null}
                {tarjetaLineas.map((line, idx) => {
                  const imgUri = line.localUri || line.previewUrl;
                  const expanded = tarjetaLineaExpandidaId === line.id;
                  return (
                    <View key={line.id} style={styles.tarjetaModalLineCard}>
                      <View style={styles.tarjetaTableRow}>
                        {imgUri ? (
                          <TouchableOpacity
                            onPress={() => setTarjetaLightboxUri(imgUri)}
                            activeOpacity={0.85}
                            accessibilityLabel="Ver foto ampliada"
                          >
                            <Image source={{ uri: imgUri }} style={styles.tarjetaThumb} resizeMode="cover" />
                          </TouchableOpacity>
                        ) : (
                          <View style={styles.tarjetaThumbPlaceholder}>
                            <MaterialIcons name="image" size={22} color="#cbd5e1" />
                          </View>
                        )}
                        <View style={styles.tarjetaTableRowMain}>
                          <Text style={styles.tarjetaTableBoleta}>Boleta {idx + 1}</Text>
                          <TextInput
                            style={styles.tarjetaTableImporte}
                            value={line.importe}
                            onChangeText={(text) => updateTarjetaLinea(line.id, { importe: text })}
                            keyboardType="decimal-pad"
                            placeholder="Importe"
                            placeholderTextColor="#94a3b8"
                          />
                          <Text style={styles.tarjetaTableBancoHint} numberOfLines={1}>
                            {line.banco ? etiquetaBanco(line.banco) : 'Sin banco'}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.tarjetaExpandBtn}
                          onPress={() => setTarjetaLineaExpandidaId(expanded ? null : line.id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <MaterialIcons name={expanded ? 'expand-less' : 'expand-more'} size={24} color="#64748b" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.tarjetaRowDeleteBtn}
                          onPress={() => {
                            removeTarjetaLinea(line.id);
                            if (tarjetaLineaExpandidaId === line.id) setTarjetaLineaExpandidaId(null);
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <MaterialIcons name="delete-outline" size={22} color="#b91c1c" />
                        </TouchableOpacity>
                      </View>
                      <View style={styles.tarjetaTableIconRow}>
                        {Platform.OS !== 'web' ? (
                          <TouchableOpacity
                            style={styles.tarjetaIconOnly}
                            onPress={() => capturarEscanearBoleta(line.id, 'camera')}
                            accessibilityLabel="Cámara"
                          >
                            <MaterialIcons name="photo-camera" size={20} color="#0369a1" />
                          </TouchableOpacity>
                        ) : null}
                        <TouchableOpacity
                          style={styles.tarjetaIconOnly}
                          onPress={() => capturarEscanearBoleta(line.id, 'library')}
                          accessibilityLabel="Galería"
                        >
                          <MaterialIcons name="photo-library" size={20} color="#0369a1" />
                        </TouchableOpacity>
                        {imgUri ? (
                          <TouchableOpacity
                            style={[
                              styles.tarjetaIconOnly,
                              line.ocrCompletado && styles.tarjetaIconOnlyOcrOk,
                              ocrLineId === line.id && styles.tarjetaLineaBtnDis,
                            ]}
                            onPress={() => escanearTarjetaLinea(line)}
                            disabled={ocrLineId === line.id}
                            accessibilityLabel={line.ocrCompletado ? 'OCR completado' : 'Escanear OCR'}
                          >
                            {ocrLineId === line.id ? (
                              <ActivityIndicator size="small" color={line.ocrCompletado ? '#15803d' : '#0369a1'} />
                            ) : (
                              <MaterialIcons
                                name="document-scanner"
                                size={20}
                                color={line.ocrCompletado ? '#15803d' : '#0369a1'}
                              />
                            )}
                          </TouchableOpacity>
                        ) : null}
                      </View>
                      {expanded ? (
                        <View style={styles.tarjetaModalDetail}>
                          {!imgUri ? (
                            <TouchableOpacity
                              style={styles.tarjetaSinFotoRow}
                              onPress={() => capturarEscanearBoleta(line.id, 'library')}
                            >
                              <MaterialIcons name="add-a-photo" size={18} color="#0369a1" />
                              <Text style={styles.tarjetaSinFotoText}>Añadir imagen (galería)</Text>
                            </TouchableOpacity>
                          ) : null}
                          {tarjetaCamposDosColumnas ? (
                            <>
                              <View style={styles.tarjetaDetailRow2}>
                                <SelectorDesplegable
                                  style={styles.tarjetaLineaFieldGrow}
                                  icono="account-balance"
                                  iconoLista="account-balance"
                                  tituloLista="Seleccionar banco"
                                  placeholder="Seleccionar banco"
                                  valorId={line.banco}
                                  opciones={BANCOS_ARQUEO.map((b) => ({ id: b.id, titulo: b.label, icono: 'account-balance' as const }))}
                                  onSeleccionar={(id) => updateTarjetaLinea(line.id, { banco: id })}
                                />
                                <TextInput
                                  style={[styles.tarjetaLineaInputCompact, styles.tarjetaLineaFieldGrow]}
                                  value={line.numeroComercio}
                                  onChangeText={(text) => updateTarjetaLinea(line.id, { numeroComercio: text })}
                                  placeholder="Nº comercio"
                                  placeholderTextColor="#94a3b8"
                                />
                              </View>
                              <TextInput
                                style={styles.tarjetaLineaInputCompact}
                                value={line.fechaHora}
                                onChangeText={(text) => updateTarjetaLinea(line.id, { fechaHora: text })}
                                placeholder="Fecha y hora"
                                placeholderTextColor="#94a3b8"
                              />
                            </>
                          ) : (
                            <>
                              <SelectorDesplegable
                                icono="account-balance"
                                iconoLista="account-balance"
                                tituloLista="Seleccionar banco"
                                placeholder="Seleccionar banco"
                                valorId={line.banco}
                                opciones={BANCOS_ARQUEO.map((b) => ({ id: b.id, titulo: b.label, icono: 'account-balance' as const }))}
                                onSeleccionar={(id) => updateTarjetaLinea(line.id, { banco: id })}
                              />
                              <TextInput
                                style={styles.tarjetaLineaInputCompact}
                                value={line.numeroComercio}
                                onChangeText={(text) => updateTarjetaLinea(line.id, { numeroComercio: text })}
                                placeholder="Nº comercio / afiliación"
                                placeholderTextColor="#94a3b8"
                              />
                              <TextInput
                                style={styles.tarjetaLineaInputCompact}
                                value={line.fechaHora}
                                onChangeText={(text) => updateTarjetaLinea(line.id, { fechaHora: text })}
                                placeholder="Fecha y hora"
                                placeholderTextColor="#94a3b8"
                              />
                            </>
                          )}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.tarjetaModalFooter}>
                <TouchableOpacity
                  style={[styles.tarjetaModalFooterBtn, tarjetaLineas.length >= 20 && styles.tarjetaModalFooterBtnDis]}
                  onPress={addTarjetaLinea}
                  disabled={tarjetaLineas.length >= 20}
                >
                  <MaterialIcons name="add-circle-outline" size={20} color="#0369a1" />
                  <Text style={styles.tarjetaModalFooterBtnText}>Añadir boleta</Text>
                </TouchableOpacity>
                {tarjetaLineas.length > 0 ? (
                  <TouchableOpacity style={styles.tarjetaModalFooterLink} onPress={quitarLineasTarjeta}>
                    <Text style={styles.tarjetaModalFooterLinkText}>Usar solo un importe (sin líneas)</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.tarjetaModalCerrar} onPress={() => setTarjetaBoletasModalOpen(false)}>
                  <Text style={styles.tarjetaModalCerrarText}>Cerrar</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={tarjetaLightboxUri != null}
          transparent
          animationType="fade"
          onRequestClose={() => setTarjetaLightboxUri(null)}
        >
          <View style={styles.tarjetaLightboxWrap}>
            <TouchableOpacity
              style={styles.tarjetaLightboxClose}
              onPress={() => setTarjetaLightboxUri(null)}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            >
              <MaterialIcons name="close" size={28} color="#f8fafc" />
            </TouchableOpacity>
            <Pressable style={styles.tarjetaLightboxInner} onPress={() => setTarjetaLightboxUri(null)}>
              {tarjetaLightboxUri ? (
                <Image source={{ uri: tarjetaLightboxUri }} style={styles.tarjetaLightboxImg} resizeMode="contain" />
              ) : null}
            </Pressable>
          </View>
        </Modal>

        {loadingCompare && formLocal && formPosId && businessDayIso ? (
          <ActivityIndicator style={{ marginVertical: 12 }} color="#0ea5e9" />
        ) : null}

        {error ? (
          <View style={styles.errBox}>
            <MaterialIcons name="error-outline" size={18} color="#dc2626" />
            <Text style={styles.errText}>{error}</Text>
          </View>
        ) : null}

        {compare && businessDayIso && formPosId ? (
          <View style={styles.card}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>Teórico vs real</Text>
              {descuadreEnVivo != null ? (
                <View style={styles.descuadreBox}>
                  <Text style={styles.descuadreLabel}>Descuadre</Text>
                  <Text
                    style={[
                      styles.descuadreVal,
                      Math.abs(descuadreEnVivo) < 0.01 ? styles.diffOk : styles.diffBad,
                    ]}
                  >
                    {formatMoneda(descuadreEnVivo)}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.cardMeta}>
              Cierres teóricos encontrados: {compare.closeoutsCount}
            </Text>
            {metodos.map((row) => {
              const t = compare.teorico[row.grupo] ?? 0;
              const diff = diffsEnVivo ? diffsEnVivo[row.grupo] ?? 0 : 0;
              const esEfectivo = row.grupo === GRUPO_EFECTIVO;
              const esTarjeta = row.grupo === GRUPO_TARJETA;
              const v = esEfectivo
                ? efectivoReal
                : esTarjeta
                  ? tarjetaReal
                  : (otrosReal[row.grupo] ?? '');

              if (esTarjeta) {
                return (
                  <View key={row.grupo} style={styles.rowCompare}>
                    <Text style={styles.rowLabel}>{row.label}</Text>
                    <View style={styles.rowCols}>
                      <View style={styles.colTeo}>
                        <Text style={styles.colHdr}>Teórico</Text>
                        <Text style={styles.colVal}>{formatMoneda(t)}</Text>
                      </View>
                      <View style={styles.colReal}>
                        <Text style={styles.colHdr}>Real</Text>
                        {tarjetaLineas.length > 0 ? (
                          <View style={styles.tarjetaRealSumRow}>
                            <TouchableOpacity
                              style={styles.tarjetaModalOpenBtn}
                              onPress={openTarjetaBoletasModal}
                              accessibilityLabel={`Gestionar boletas, ${tarjetaLineas.length} líneas`}
                            >
                              <MaterialIcons name="receipt-long" size={18} color="#0ea5e9" />
                              <Text style={styles.tarjetaModalOpenBtnText}>Boletas ({tarjetaLineas.length})</Text>
                            </TouchableOpacity>
                            <TextInput
                              style={[styles.inputNum, styles.inputNumEfectivo]}
                              value={formatMoneda(totalTarjetaImporte).replace(' €', '')}
                              editable={false}
                              placeholder="0,00"
                              placeholderTextColor="#94a3b8"
                            />
                          </View>
                        ) : (
                          <View style={styles.efectivoRealRow}>
                            <TouchableOpacity
                              style={styles.conteoEfectivoBtn}
                              onPress={openTarjetaBoletasModal}
                              accessibilityLabel="Abrir boletas por líneas"
                            >
                              <MaterialIcons name="receipt-long" size={18} color="#0ea5e9" />
                            </TouchableOpacity>
                            <TextInput
                              style={[styles.inputNum, styles.inputNumEfectivo]}
                              value={v}
                              onChangeText={setTarjetaReal}
                              keyboardType="decimal-pad"
                              placeholder="0,00"
                              placeholderTextColor="#94a3b8"
                            />
                          </View>
                        )}
                      </View>
                      <View style={styles.colDiff}>
                        <Text style={styles.colHdr}>Dif.</Text>
                        <Text style={[styles.colVal, Math.abs(diff) < 0.01 ? styles.diffOk : styles.diffBad]}>
                          {formatMoneda(diff)}
                        </Text>
                      </View>
                    </View>
                    {tarjetaLineas.length > 0 ? (
                      <TouchableOpacity onPress={openTarjetaBoletasModal} style={styles.tarjetaHintUnderRow}>
                        <Text style={styles.tarjetaHintUnderRowText}>Editar boletas y fotos en el panel</Text>
                        <MaterialIcons name="open-in-new" size={14} color="#0ea5e9" />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              }

              return (
                <View key={row.grupo} style={styles.rowCompare}>
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <View style={styles.rowCols}>
                    <View style={styles.colTeo}>
                      <Text style={styles.colHdr}>Teórico</Text>
                      <Text style={styles.colVal}>{formatMoneda(t)}</Text>
                    </View>
                    <View style={styles.colReal}>
                      <Text style={styles.colHdr}>Real</Text>
                      {!row.arquear ? (
                        <View style={styles.agoraRealSync}>
                          <Text style={styles.agoraRealSyncText}>{formatMoneda(t)}</Text>
                          <MaterialIcons name="sync" size={16} color="#64748b" />
                        </View>
                      ) : row.auto ? (
                        <View style={styles.agoraRealSync}>
                          <Text style={styles.agoraRealSyncText}>{formatMoneda(realDeGrupo(row.grupo, row))}</Text>
                          <MaterialIcons name="swap-horiz" size={16} color="#0369a1" />
                        </View>
                      ) : esEfectivo ? (
                        <View style={styles.efectivoRealRow}>
                          <TouchableOpacity
                            style={styles.conteoEfectivoBtn}
                            onPress={() => setConteoEfectivoOpen(true)}
                            accessibilityLabel="Contar billetes y monedas"
                          >
                            <MaterialIcons name="calculate" size={18} color="#0ea5e9" />
                          </TouchableOpacity>
                          <TextInput
                            style={[styles.inputNum, styles.inputNumEfectivo]}
                            value={v}
                            onChangeText={setEfectivoReal}
                            keyboardType="decimal-pad"
                            placeholder="0,00"
                            placeholderTextColor="#94a3b8"
                          />
                        </View>
                      ) : (
                        <TextInput
                          style={styles.inputNum}
                          value={v}
                          onChangeText={(text) => setOtroReal(row.grupo, text)}
                          keyboardType="decimal-pad"
                          placeholder="0,00"
                          placeholderTextColor="#94a3b8"
                        />
                      )}
                    </View>
                    <View style={styles.colDiff}>
                      <Text style={styles.colHdr}>Dif.</Text>
                      <Text style={[styles.colVal, Math.abs(diff) < 0.01 ? styles.diffOk : styles.diffBad]}>
                        {formatMoneda(diff)}
                      </Text>
                    </View>
                  </View>
                  {esEfectivo && movRetiradas > 0 ? (
                    <Text style={styles.movNota}>
                      Incluye {formatMoneda(movRetiradas)} de retiradas de caja.
                    </Text>
                  ) : null}
                  {row.auto ? (
                    <Text style={styles.movNota}>
                      Automático: suma de transferencias registradas en movimientos de caja.
                    </Text>
                  ) : null}
                </View>
              );
            })}
            <TouchableOpacity
              style={styles.movLinkBtn}
              onPress={() =>
                router.push({
                  pathname: '/cajas/movimientos-caja',
                  params: {
                    workplaceId: formLocal.trim(),
                    posId: formPosId,
                    posName: formPosName,
                    businessDay: businessDayIso,
                  },
                })
              }
              activeOpacity={0.8}
            >
              <MaterialIcons name="swap-horiz" size={18} color="#0369a1" />
              <Text style={styles.movLinkBtnText}>Movimientos de caja (retiradas y transferencias)</Text>
              <MaterialIcons name="chevron-right" size={18} color="#0369a1" />
            </TouchableOpacity>

            <View style={styles.tpvEstadoRow}>
              <View style={styles.tpvEstadoLeft}>
                <Text style={styles.tpvEstadoLabel}>Estado del TPV</Text>
                {compare.estado ? (
                  <View style={[styles.estadoChip, compare.estado === 'cerrado' ? styles.estadoChipCerrado : styles.estadoChipBorrador]}>
                    <MaterialIcons
                      name={compare.estado === 'cerrado' ? 'lock' : 'edit'}
                      size={13}
                      color={compare.estado === 'cerrado' ? '#15803d' : '#b45309'}
                    />
                    <Text style={[styles.estadoChipText, compare.estado === 'cerrado' ? styles.estadoChipTextCerrado : styles.estadoChipTextBorrador]}>
                      {compare.estado === 'cerrado' ? 'Cerrado' : 'Borrador'}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.tpvEstadoHint}>Sin guardar</Text>
                )}
              </View>
            </View>
          </View>
        ) : (
          !loadingCompare &&
          formLocal &&
          formPosId &&
          businessDayIso && (
            <Text style={styles.hint}>Sin datos de comparativa. Revisa fecha y permisos de API.</Text>
          )
        )}

        {compare?.estado === 'cerrado' ? (
          <TouchableOpacity
            style={[styles.saveBtn, styles.reabrirBtn, (jornadaBusy || jornada?.estado === 'cerrada') && styles.saveBtnDis]}
            onPress={() => cambiarEstadoArqueo('borrador')}
            disabled={jornadaBusy || jornada?.estado === 'cerrada'}
          >
            {jornadaBusy ? (
              <ActivityIndicator color="#b45309" />
            ) : (
              <>
                <MaterialIcons name="lock-open" size={20} color="#b45309" />
                <Text style={styles.reabrirBtnText}>Reabrir arqueo para editar</Text>
              </>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.saveBtn, saving && styles.saveBtnDis]}
            onPress={() => guardar({ cerrar: true })}
            disabled={saving || !businessDayIso || !formLocal || !formPosId}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <MaterialIcons name="lock" size={20} color="#fff" />
                <Text style={styles.saveBtnText}>Guardar y cerrar arqueo</Text>
              </>
            )}
          </TouchableOpacity>
        )}
        {compare?.estado === 'cerrado' && jornada?.estado === 'cerrada' ? (
          <Text style={styles.hintCentro}>Reabre primero la jornada del local para poder editar este arqueo.</Text>
        ) : null}
        {saveOk ? <Text style={styles.okText}>Guardado correctamente.</Text> : null}

        {formLocal && businessDayIso && jornada ? (
          <View style={styles.jornadaCard}>
            <View style={styles.jornadaHeader}>
              <View style={styles.jornadaHeaderLeft}>
                <MaterialIcons name="storefront" size={18} color="#334155" />
                <Text style={styles.jornadaTitle}>Jornada del local</Text>
              </View>
              <View style={[styles.estadoChip, jornada.estado === 'cerrada' ? styles.estadoChipCerrado : styles.estadoChipBorrador]}>
                <MaterialIcons
                  name={jornada.estado === 'cerrada' ? 'lock' : 'lock-open'}
                  size={13}
                  color={jornada.estado === 'cerrada' ? '#15803d' : '#b45309'}
                />
                <Text style={[styles.estadoChipText, jornada.estado === 'cerrada' ? styles.estadoChipTextCerrado : styles.estadoChipTextBorrador]}>
                  {jornada.estado === 'cerrada' ? 'Cerrada' : 'Abierta'}
                </Text>
              </View>
            </View>

            {jornada.arqueos.length === 0 ? (
              <Text style={styles.jornadaEmpty}>Aún no hay arqueos guardados en esta jornada.</Text>
            ) : (
              jornada.arqueos.map((a) => (
                <View key={a.posId} style={styles.jornadaTpvRow}>
                  <MaterialIcons
                    name={a.estado === 'cerrado' ? 'check-circle' : 'radio-button-unchecked'}
                    size={16}
                    color={a.estado === 'cerrado' ? '#16a34a' : '#cbd5e1'}
                  />
                  <Text style={styles.jornadaTpvName} numberOfLines={1}>{a.posName || `TPV ${a.posId}`}</Text>
                  <Text
                    style={[
                      styles.jornadaTpvDesc,
                      Math.abs(Number(a.descuadreTotal) || 0) < 0.01 ? styles.diffOk : styles.diffBad,
                    ]}
                  >
                    {formatMoneda(Number(a.descuadreTotal) || 0)}
                  </Text>
                  <Text style={[styles.jornadaTpvEstado, a.estado === 'cerrado' ? styles.estadoChipTextCerrado : styles.estadoChipTextBorrador]}>
                    {a.estado === 'cerrado' ? 'Cerrado' : 'Borrador'}
                  </Text>
                </View>
              ))
            )}

            {jornada.estado === 'cerrada' ? (
              <>
                <View style={styles.jornadaTotalRow}>
                  <Text style={styles.jornadaTotalLabel}>Descuadre consolidado</Text>
                  <Text
                    style={[
                      styles.jornadaTotalVal,
                      Math.abs(Number(jornada.jornada?.descuadreTotal) || 0) < 0.01 ? styles.diffOk : styles.diffBad,
                    ]}
                  >
                    {formatMoneda(Number(jornada.jornada?.descuadreTotal) || 0)}
                  </Text>
                </View>
                {jornada.jornada?.cerradoPor ? (
                  <Text style={styles.jornadaMeta}>Cerrada por {jornada.jornada.cerradoPor}</Text>
                ) : null}
                <TouchableOpacity
                  style={[styles.estadoBtn, styles.estadoBtnReabrir, styles.jornadaActionBtn]}
                  onPress={() => cambiarEstadoJornada('reabrir')}
                  disabled={jornadaBusy}
                >
                  {jornadaBusy ? <ActivityIndicator size="small" color="#b45309" /> : <MaterialIcons name="lock-open" size={16} color="#b45309" />}
                  <Text style={styles.estadoBtnReabrirText}>Reabrir jornada</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {!jornada.puedeCerrar && jornada.pendientes.length > 0 ? (
                  <Text style={styles.jornadaWarn}>
                    Hay {jornada.pendientes.length} arqueo(s) en borrador. Ciérralos todos para poder cerrar la jornada.
                  </Text>
                ) : null}
                <TouchableOpacity
                  style={[styles.estadoBtn, styles.estadoBtnCerrar, styles.jornadaActionBtn, (!jornada.puedeCerrar || jornadaBusy) && styles.saveBtnDis]}
                  onPress={() => cambiarEstadoJornada('cerrar')}
                  disabled={!jornada.puedeCerrar || jornadaBusy}
                >
                  {jornadaBusy ? <ActivityIndicator size="small" color="#fff" /> : <MaterialIcons name="lock" size={16} color="#fff" />}
                  <Text style={styles.estadoBtnCerrarText}>Cerrar jornada del local</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : null}

        <View style={{ height: 32 }} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: {
    padding: 16,
    paddingBottom: 40,
    alignItems: 'center',
  },
  /** Formulario no a ancho completo en pantallas anchas */
  formMax: {
    width: '100%',
    maxWidth: 560,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  lead: { fontSize: 13, color: '#64748b', marginBottom: 16, lineHeight: 20 },
  filtrosRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 18,
    width: '100%',
  },
  /** En móvil/tablet apilado: permitir salto de línea entre campos. */
  filtrosRowStack: {
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
  /** Fecha: ancho fijo en toolbar en línea. */
  filtrosColFecha: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 132,
    maxWidth: 200,
  },
  /** Local / TPV en toolbar apilada (móvil). */
  filtrosColSelect: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 140,
    maxWidth: 288,
    alignSelf: 'flex-start',
  },
  /** Columna en fila única: puede encogerse; el texto largo se trunca con ellipsis. */
  filtrosColInline: {
    flexShrink: 0,
    width: 168,
    maxWidth: 168,
  },
  filtrosColInlineFlex: {
    flex: 1,
    minWidth: 0,
    maxWidth: undefined,
    alignSelf: 'stretch',
  },
  selectorInline: { flex: 1, minWidth: 0, width: '100%' },
  syncRow: {
    width: '100%',
    marginBottom: 14,
    gap: 8,
  },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: '#f0f9ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  syncBtnDisabled: { opacity: 0.55 },
  syncBtnText: { fontSize: 14, fontWeight: '600', color: '#0369a1' },
  syncBtnTextDisabled: { color: '#94a3b8' },
  syncHint: { fontSize: 11, color: '#64748b', lineHeight: 16 },
  labelFiltros: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  inputFechaCompact: {
    fontSize: 13,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 40,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    justifyContent: 'center',
    padding: 20,
    ...(Platform.OS === 'web' ? { zIndex: 9999 } as object : {}),
  },
  modalSheet: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#fff',
    borderRadius: 12,
    maxHeight: '80%',
    padding: 16,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 16px 48px rgba(0,0,0,0.2)', zIndex: 10000 } as object
      : { elevation: 12 }),
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 12 },
  errBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    marginTop: 12,
  },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  card: {
    marginTop: 16,
    padding: 14,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardTitleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#334155', flexShrink: 1 },
  descuadreBox: {
    alignItems: 'flex-end',
    paddingVertical: 4,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  descuadreLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  descuadreVal: { fontSize: 15, fontWeight: '700' },
  cardMeta: { fontSize: 11, color: '#94a3b8', marginBottom: 12 },
  rowCompare: { marginBottom: 14, borderBottomWidth: 1, borderBottomColor: '#f1f5f9', paddingBottom: 12 },
  rowLabel: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 6 },
  rowCols: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  colTeo: { flex: 1, minWidth: 90 },
  colReal: { flex: 1, minWidth: 100 },
  colDiff: { width: 88 },
  colHdr: { fontSize: 10, color: '#94a3b8', marginBottom: 2, textTransform: 'uppercase' },
  colVal: { fontSize: 13, fontWeight: '600', color: '#334155' },
  inputNum: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  /** AgoraPay real = teórico (sincronizado), no editable. */
  agoraRealSync: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#f1f5f9',
    minHeight: 38,
  },
  agoraRealSyncText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    flex: 1,
  },
  efectivoRealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  inputNumEfectivo: { flex: 1, minWidth: 0 },
  conteoEfectivoBtn: {
    padding: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    flexShrink: 0,
  },
  tarjetaRealSumRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  tarjetaModalOpenBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    flexShrink: 0,
  },
  tarjetaModalOpenBtnText: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  tarjetaHintUnderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  tarjetaHintUnderRowText: { fontSize: 11, color: '#64748b' },
  tarjetaModalSheet: {
    maxWidth: 560,
    width: '100%',
    maxHeight: '92%',
    padding: 16,
    paddingBottom: 12,
  },
  tarjetaModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  tarjetaModalTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a', flex: 1, marginRight: 8 },
  tarjetaModalLead: { fontSize: 11, color: '#64748b', lineHeight: 16, marginBottom: 8 },
  tarjetaModalScroll: { flexGrow: 0 },
  tarjetaModalScrollContent: { paddingBottom: 6, gap: 8 },
  tarjetaModalEmpty: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', marginBottom: 4 },
  tarjetaModalLineCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 8,
    gap: 6,
  },
  tarjetaTableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  tarjetaThumb: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  tarjetaThumbPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tarjetaTableRowMain: { flex: 1, minWidth: 0 },
  tarjetaTableBoleta: { fontSize: 11, fontWeight: '700', color: '#64748b', marginBottom: 2 },
  tarjetaTableImporte: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 14,
    fontWeight: '600',
    color: '#334155',
    backgroundColor: '#fff',
  },
  tarjetaTableBancoHint: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  tarjetaExpandBtn: { padding: 2, marginTop: 4 },
  tarjetaRowDeleteBtn: { padding: 2, marginTop: 4 },
  tarjetaTableIconRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: 0,
  },
  tarjetaIconOnly: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  tarjetaIconOnlyOcrOk: {
    backgroundColor: '#dcfce7',
    borderColor: '#86efac',
  },
  tarjetaModalDetail: { gap: 6, marginTop: 2, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  tarjetaSinFotoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    marginBottom: 2,
  },
  tarjetaSinFotoText: { fontSize: 12, color: '#0369a1', fontWeight: '600' },
  tarjetaDetailRow2: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  tarjetaLineaFieldGrow: { flex: 1, minWidth: 0 },
  tarjetaLineaInputCompact: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#fff',
  },
  tarjetaLineaBtnDis: { opacity: 0.6 },
  tarjetaLightboxWrap: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.92)',
    justifyContent: 'center',
    padding: 12,
  },
  tarjetaLightboxClose: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 48 : 24,
    right: 16,
    zIndex: 2,
    padding: 8,
  },
  tarjetaLightboxInner: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tarjetaLightboxImg: {
    width: '100%',
    height: '100%',
    maxHeight: 720,
  },
  tarjetaModalFooter: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    gap: 10,
    alignItems: 'stretch',
  },
  tarjetaModalFooterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#f0f9ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  tarjetaModalFooterBtnDis: { opacity: 0.45 },
  tarjetaModalFooterBtnText: { fontSize: 14, fontWeight: '600', color: '#0369a1' },
  tarjetaModalFooterLink: { alignSelf: 'center', paddingVertical: 4 },
  tarjetaModalFooterLinkText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },
  tarjetaModalCerrar: { alignSelf: 'center', paddingVertical: 8 },
  tarjetaModalCerrarText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  /** Más aire respecto a los bordes de pantalla que el backdrop genérico. */
  modalBackdropConteo: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 36,
    ...(Platform.OS === 'web' ? { zIndex: 9999 } as object : {}),
  },
  modalSheetConteo: { maxWidth: 640, paddingHorizontal: 20, paddingVertical: 18 },
  conteoIntro: { fontSize: 12, color: '#64748b', marginBottom: 10, lineHeight: 18 },
  conteoScroll: { maxHeight: 320 },
  /** Aire entre el contenido y la barra de scroll (columna monedas / borde derecho). */
  conteoScrollContent: { paddingRight: 14 },
  /** Cantidad + subtotal juntos, sin hueco flexible entre medias. */
  conteoQtySubGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  conteoTwoCols: {
    flexDirection: 'row',
    gap: 18,
    alignItems: 'flex-start',
  },
  conteoCol: {
    flex: 1,
    minWidth: 0,
  },
  conteoColHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 2,
  },
  conteoColHeaderBilletes: { borderBottomColor: '#5eead4' },
  conteoColHeaderMonedas: { borderBottomColor: '#fcd34d' },
  conteoColIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#f0fdfa',
    justifyContent: 'center',
    alignItems: 'center',
  },
  conteoColIconCircleMonedas: { backgroundColor: '#fffbeb' },
  conteoColTitle: { fontSize: 14, fontWeight: '700', color: '#334155', flex: 1 },
  conteoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 2,
  },
  conteoRowMiniIcon: { width: 14, marginRight: 0 },
  /** Ancho fijo: la cantidad queda pegada al texto, sin hueco flexible en medio. */
  conteoDenomLabel: {
    width: 56,
    flexShrink: 0,
    marginRight: 2,
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  conteoQtyInput: {
    width: 48,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 5,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#fff',
    textAlign: 'center',
  },
  conteoSub: {
    width: 76,
    flexShrink: 0,
    fontSize: 10,
    color: '#64748b',
    textAlign: 'right',
  },
  conteoTotalBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  conteoTotalLabel: { fontSize: 14, fontWeight: '700', color: '#334155' },
  conteoTotalVal: { fontSize: 16, fontWeight: '700', color: '#0ea5e9' },
  conteoActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
    justifyContent: 'flex-end',
  },
  conteoBtnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  conteoBtnSecondaryText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  conteoBtnPrimary: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  conteoBtnPrimaryText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  movNota: { fontSize: 11, color: '#64748b', fontStyle: 'italic', marginTop: 6 },
  tpvEstadoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  tpvEstadoLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  tpvEstadoLabel: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  tpvEstadoHint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  estadoChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1 },
  estadoChipBorrador: { backgroundColor: '#fffbeb', borderColor: '#fcd34d' },
  estadoChipCerrado: { backgroundColor: '#dcfce7', borderColor: '#86efac' },
  estadoChipText: { fontSize: 11, fontWeight: '700' },
  estadoChipTextBorrador: { color: '#b45309' },
  estadoChipTextCerrado: { color: '#15803d' },
  estadoBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  estadoBtnCerrar: { backgroundColor: '#16a34a' },
  estadoBtnCerrarText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  estadoBtnReabrir: { backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fcd34d' },
  estadoBtnReabrirText: { fontSize: 13, fontWeight: '700', color: '#b45309' },
  jornadaCard: {
    marginTop: 16,
    padding: 14,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  jornadaHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  jornadaHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  jornadaTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  jornadaEmpty: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', paddingVertical: 6 },
  jornadaTpvRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  jornadaTpvName: { flex: 1, minWidth: 0, fontSize: 13, color: '#334155', fontWeight: '500' },
  jornadaTpvDesc: { fontSize: 13, fontWeight: '700', width: 90, textAlign: 'right' },
  jornadaTpvEstado: { fontSize: 11, fontWeight: '700', width: 64, textAlign: 'right' },
  jornadaTotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  jornadaTotalLabel: { fontSize: 13, fontWeight: '700', color: '#334155' },
  jornadaTotalVal: { fontSize: 16, fontWeight: '700' },
  jornadaMeta: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
  jornadaWarn: { fontSize: 11, color: '#b45309', fontStyle: 'italic', marginTop: 10 },
  jornadaActionBtn: { justifyContent: 'center', marginTop: 12 },
  movLinkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  movLinkBtnText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#0369a1' },
  diffOk: { color: '#059669' },
  diffBad: { color: '#dc2626' },
  hint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 8 },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 20,
    paddingVertical: 14,
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
  },
  saveBtnDis: { opacity: 0.6 },
  saveBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  reabrirBtn: { backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fcd34d' },
  reabrirBtnText: { fontSize: 15, fontWeight: '700', color: '#b45309' },
  hintCentro: { fontSize: 12, color: '#b45309', marginTop: 8, textAlign: 'center' },
  okText: { fontSize: 13, color: '#059669', marginTop: 10, textAlign: 'center' },
  errorText: { padding: 16, color: '#b91c1c' },
});
