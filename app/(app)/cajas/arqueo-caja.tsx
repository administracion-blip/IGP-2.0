import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { useAuth } from '../../contexts/AuthContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

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

function BankLogoBadge({ bancoId, width = 88, height = 28 }: { bancoId: string; width?: number; height?: number }) {
  const b = BANCOS_ARQUEO.find((x) => x.id === bancoId);
  const [failed, setFailed] = useState(false);
  if (!b) {
    return <View style={{ width, height }} />;
  }
  if (failed || !b.logoUrl) {
    return (
      <View
        style={{
          width,
          height,
          backgroundColor: b.color,
          borderRadius: 6,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 6,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }} numberOfLines={1}>
          {b.label}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: b.logoUrl }}
      style={{ width, height: height * 0.9 }}
      resizeMode="contain"
      onError={() => setFailed(true)}
    />
  );
}

const LABELS = [
  { key: 'efectivo', teoricoKey: 'Efectivo', label: 'Efectivo', realField: 'efectivoReal' as const },
  { key: 'tarjeta', teoricoKey: 'Tarjeta', label: 'Tarjeta', realField: 'tarjetaReal' as const },
  { key: 'pendiente', teoricoKey: 'Pendiente de cobro', label: 'Pendiente de cobro', realField: 'pendienteCobroReal' as const },
  { key: 'prepago', teoricoKey: 'Prepago Transferencia', label: 'Prepago transferencia', realField: 'prepagoTransferenciaReal' as const },
  { key: 'agora', teoricoKey: 'AgoraPay', label: 'AgoraPay', realField: 'agoraPayReal' as const },
] as const;

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

function parseDateToYYYYMMDD(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const date = new Date(y, mo - 1, d);
      if (date.getDate() === d && date.getMonth() === mo - 1 && date.getFullYear() === y) {
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/** dd/mm/yyyy a partir de un Date (hora local). */
function dateToDmy(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * Fecha de negocio por defecto: hasta las 09:30 se asume que aún se arquea el día anterior
 * (cierres de madrugada); desde las 09:31, el día natural es hoy.
 */
function defaultBusinessDayDmy(): string {
  const now = new Date();
  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  const cutoff = 9 * 60 + 30; // 09:30
  if (minutesOfDay <= cutoff) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return dateToDmy(y);
  }
  return dateToDmy(now);
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

type CompareResponse = {
  teorico: Record<string, number>;
  real: {
    efectivoReal: number;
    tarjetaReal: number;
    pendienteCobroReal: number;
    prepagoTransferenciaReal: number;
    agoraPayReal: number;
  };
  diff: Record<string, number>;
  /** Suma de diferencias (coincide con descuadreTotal guardado en Dynamo al guardar). */
  descuadreTotal?: number;
  closeoutsCount: number;
  error?: string;
  realGuardado?: {
    tarjetaLineas?: TarjetaLineaPersisted[];
  };
};

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
  const { hasPermiso, user } = useAuth();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [saleCenters, setSaleCenters] = useState<{ Id?: number; Nombre?: string; Local?: string; Activo?: boolean }[]>([]);

  const [businessDayDmy, setBusinessDayDmy] = useState(() => defaultBusinessDayDmy());
  const [formLocal, setFormLocal] = useState('');
  const [formPosId, setFormPosId] = useState('');
  const [formPosName, setFormPosName] = useState('');

  const [efectivoReal, setEfectivoReal] = useState('');
  const [tarjetaReal, setTarjetaReal] = useState('');
  const [tarjetaLineas, setTarjetaLineas] = useState<TarjetaLinea[]>([]);
  const [ocrLineId, setOcrLineId] = useState<string | null>(null);
  const [pendienteReal, setPendienteReal] = useState('');
  const [prepagoReal, setPrepagoReal] = useState('');

  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [loadingCompare, setLoadingCompare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const [localModalOpen, setLocalModalOpen] = useState(false);
  const [posModalOpen, setPosModalOpen] = useState(false);
  const [conteoEfectivoOpen, setConteoEfectivoOpen] = useState(false);
  const [conteoCantidades, setConteoCantidades] = useState<string[]>(() => EFECTIVO_DENOMINACIONES.map(() => ''));
  const [syncingCloseouts, setSyncingCloseouts] = useState(false);
  const [tarjetaBoletasModalOpen, setTarjetaBoletasModalOpen] = useState(false);
  /** En el modal, fila con detalle desplegado (campos OCR; la foto se ve en miniatura o al ampliar). */
  const [tarjetaLineaExpandidaId, setTarjetaLineaExpandidaId] = useState<string | null>(null);
  /** Vista previa a pantalla completa al pulsar la miniatura. */
  const [tarjetaLightboxUri, setTarjetaLightboxUri] = useState<string | null>(null);
  const [tarjetaBancoPickerLineId, setTarjetaBancoPickerLineId] = useState<string | null>(null);

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const tarjetaCamposDosColumnas = windowWidth >= 480;
  /** Altura máxima del scroll del modal (~mitad de pantalla, acotada). */
  const tarjetaModalScrollMaxH = useMemo(
    () => Math.min(560, Math.max(180, windowHeight * 0.42)),
    [windowHeight],
  );

  const businessDayIso = useMemo(() => parseDateToYYYYMMDD(businessDayDmy), [businessDayDmy]);

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
    fetch(`${API_URL}/api/locales`)
      .then((r) => safeJson<{ locales?: LocalItem[] }>(r))
      .then((d) => setLocales(d.locales || []))
      .catch(() => setLocales([]));
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/api/agora/sale-centers`)
      .then((r) => safeJson<{ saleCenters?: typeof saleCenters }>(r))
      .then((d) => setSaleCenters(d.saleCenters || []))
      .catch(() => setSaleCenters([]));
  }, []);

  useEffect(() => {
    if (formLocal && formPosId && !saleCentersPorLocal.some((sc) => String(sc.Id) === formPosId)) {
      setFormPosId('');
      setFormPosName('');
    }
  }, [formLocal, saleCentersPorLocal, formPosId]);

  const totalTarjetaImporte = useMemo(() => {
    if (tarjetaLineas.length > 0) {
      let s = 0;
      for (const l of tarjetaLineas) s += parseEuroInput(l.importe);
      return Math.round(s * 100) / 100;
    }
    return parseEuroInput(tarjetaReal);
  }, [tarjetaLineas, tarjetaReal]);

  useEffect(() => {
    if (tarjetaLineas.length === 0) return;
    const s = tarjetaLineas.reduce((acc, l) => acc + parseEuroInput(l.importe), 0);
    const rounded = Math.round(s * 100) / 100;
    setTarjetaReal(rounded.toFixed(2).replace('.', ','));
  }, [tarjetaLineas]);

  const diffsEnVivo = useMemo(() => {
    if (!compare) return null;
    const t = compare.teorico;
    return {
      Efectivo: parseEuroInput(efectivoReal) - (t.Efectivo ?? 0),
      Tarjeta: totalTarjetaImporte - (t.Tarjeta ?? 0),
      'Pendiente de cobro': parseEuroInput(pendienteReal) - (t['Pendiente de cobro'] ?? 0),
      'Prepago Transferencia': parseEuroInput(prepagoReal) - (t['Prepago Transferencia'] ?? 0),
      AgoraPay: 0,
    };
  }, [compare, efectivoReal, totalTarjetaImporte, pendienteReal, prepagoReal]);

  const descuadreEnVivo = useMemo(() => {
    if (!diffsEnVivo) return null;
    let s = 0;
    for (const row of LABELS) s += diffsEnVivo[row.teoricoKey] ?? 0;
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
    fetch(`${API_URL}/api/cajas/arqueos-reales/compare?${q}`)
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
                const rurl = await fetch(
                  `${API_URL}/api/cajas/arqueos-reales/ticket-image-url?key=${encodeURIComponent(l.imagenKey)}`,
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
        setEfectivoReal(String(r.efectivoReal ?? ''));
        setTarjetaReal(String(r.tarjetaReal ?? ''));
        setPendienteReal(String(r.pendienteCobroReal ?? ''));
        setPrepagoReal(String(r.prepagoTransferenciaReal ?? ''));
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
      const res = await fetch(`${API_URL}/api/agora/closeouts/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  const guardar = async () => {
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
      const body = {
        PK: formLocal.trim(),
        BusinessDay: businessDayIso,
        PosId: formPosId,
        PosName: formPosName,
        WorkplaceName: agoraCodeToNombre[formLocal.trim()] ?? formLocal,
        efectivoReal: efectivoReal.replace(',', '.'),
        tarjetaReal: tarjetaReal.replace(',', '.'),
        tarjetaLineas: tarjetaLineas.map((l) => ({
          id: l.id,
          banco: l.banco,
          importe: l.importe,
          numeroComercio: l.numeroComercio,
          fechaHora: l.fechaHora,
          imagenKey: l.imagenKey,
          ocrCompletado: Boolean(l.ocrCompletado),
        })),
        pendienteCobroReal: pendienteReal.replace(',', '.'),
        prepagoTransferenciaReal: prepagoReal.replace(',', '.'),
        agoraPayReal: compare ? String(compare.teorico.AgoraPay ?? 0) : '0',
        usuarioId: user?.id_usuario,
        usuarioNombre: user?.Nombre,
      };
      const res = await fetch(`${API_URL}/api/cajas/arqueos-reales`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await safeJson<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data.error) throw new Error(data.error || 'Error al guardar');
      setSaveOk(true);
      fetchCompare();
      setTimeout(() => setSaveOk(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const openTarjetaBoletasModal = useCallback(() => {
    setTarjetaBoletasModalOpen(true);
  }, []);

  const addTarjetaLinea = useCallback(() => {
    const nl = newTarjetaLinea();
    setTarjetaLineas((prev) => {
      if (prev.length >= 20) return prev;
      return [...prev, nl];
    });
    setTarjetaLineaExpandidaId(null);
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

  const pickImageTarjetaLinea = useCallback(async (lineId: string, source: 'library' | 'camera') => {
    const uri = await obtenerUriImagen(source);
    if (!uri) return;
    setTarjetaLineas((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? { ...l, localUri: uri, previewUrl: undefined, ocrCompletado: false, imagenKey: '' }
          : l,
      ),
    );
  }, []);

  const escanearTarjetaLinea = useCallback(
    async (line: TarjetaLinea) => {
      if (!businessDayIso || !formLocal.trim()) {
        setError('Indica fecha y local antes de escanear.');
        return;
      }
      const uri = line.localUri || line.previewUrl;
      if (!uri) {
        setError('Añade una imagen antes de escanear.');
        return;
      }
      setOcrLineId(line.id);
      setError(null);
      try {
        const form = new FormData();
        form.append('workplaceId', formLocal.trim());
        form.append('businessDay', businessDayIso);
        form.append('lineId', line.id);
        await appendImagenOcrTarjeta(form, uri);
        const resp = await fetch(`${API_URL}/api/cajas/arqueos-reales/ocr-ticket`, { method: 'POST', body: form });
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
            l.id === line.id
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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al escanear');
      } finally {
        setOcrLineId(null);
      }
    },
    [businessDayIso, formLocal],
  );

  const setters: Record<string, React.Dispatch<React.SetStateAction<string>>> = {
    efectivoReal: setEfectivoReal,
    tarjetaReal: setTarjetaReal,
    pendienteCobroReal: setPendienteReal,
    prepagoTransferenciaReal: setPrepagoReal,
  };

  const values: Record<string, string> = {
    efectivoReal,
    tarjetaReal,
    pendienteCobroReal: pendienteReal,
    prepagoTransferenciaReal: prepagoReal,
  };

  if (!hasPermiso('cierres.ver')) {
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

        <View style={styles.filtrosRow}>
          <View style={styles.filtrosColFecha}>
            <Text style={styles.labelFiltros}>Fecha negocio</Text>
            <InputFecha
              value={businessDayDmy}
              onChange={setBusinessDayDmy}
              format="dmy"
              placeholder="dd/mm/aaaa"
              style={styles.inputFechaCompact}
            />
          </View>
          <View style={styles.filtrosColSelect}>
            <Text style={styles.labelFiltros}>Local</Text>
            <TouchableOpacity
              style={styles.selectBtn}
              onPress={() => {
                setPosModalOpen(false);
                setLocalModalOpen(true);
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.selectText} numberOfLines={2}>
                {formLocal
                  ? `${agoraCodeToNombre[formLocal] || '—'} · id ${formLocal}`
                  : 'Seleccionar…'}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>
          <View style={styles.filtrosColSelect}>
            <Text style={styles.labelFiltros}>TPV</Text>
            <TouchableOpacity
              style={[styles.selectBtn, !formLocal && styles.selectDisabled]}
              onPress={() => {
                if (!formLocal) return;
                setLocalModalOpen(false);
                setPosModalOpen(true);
              }}
              disabled={!formLocal}
              activeOpacity={0.7}
            >
              <Text style={styles.selectText} numberOfLines={2}>
                {formPosId
                  ? `${formPosName || 'TPV'} · id ${formPosId}`
                  : 'Seleccionar…'}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={22} color="#64748b" />
            </TouchableOpacity>
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

        <Modal visible={localModalOpen} transparent animationType="fade" onRequestClose={() => setLocalModalOpen(false)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setLocalModalOpen(false)}>
            <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>Local</Text>
              <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {locales.map((loc) => {
                  const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                  if (!code) return null;
                  const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
                  return (
                    <TouchableOpacity
                      key={code}
                      style={[styles.modalRow, formLocal === code && styles.modalRowActive]}
                      onPress={() => {
                        setFormLocal(code);
                        setLocalModalOpen(false);
                      }}
                    >
                      <Text style={styles.modalRowLine} numberOfLines={2}>
                        <Text style={styles.modalRowName}>{nombre || '—'}</Text>
                        <Text style={styles.modalRowId}> · id {code}</Text>
                      </Text>
                      {formLocal === code ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity style={styles.modalClose} onPress={() => setLocalModalOpen(false)}>
                <Text style={styles.modalCloseText}>Cerrar</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal visible={posModalOpen} transparent animationType="fade" onRequestClose={() => setPosModalOpen(false)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setPosModalOpen(false)}>
            <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>TPV</Text>
              <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {saleCentersPorLocal.map((sc) => {
                  const id = sc.Id != null ? String(sc.Id) : '';
                  if (!id) return null;
                  const nom = String(sc.Nombre ?? '').trim() || `TPV ${id}`;
                  return (
                    <TouchableOpacity
                      key={id}
                      style={[styles.modalRow, formPosId === id && styles.modalRowActive]}
                      onPress={() => {
                        setFormPosId(id);
                        setFormPosName(nom);
                        setPosModalOpen(false);
                      }}
                    >
                      <Text style={styles.modalRowLine} numberOfLines={2}>
                        <Text style={styles.modalRowName}>{nom}</Text>
                        <Text style={styles.modalRowId}> · id {id}</Text>
                      </Text>
                      {formPosId === id ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity style={styles.modalClose} onPress={() => setPosModalOpen(false)}>
                <Text style={styles.modalCloseText}>Cerrar</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>

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
                Total = suma de importes. Con imagen: OCR obligatorio una vez (botón verde al completar). Pulsa la miniatura para ampliar foto.
              </Text>
              <ScrollView
                style={[styles.tarjetaModalScroll, { maxHeight: tarjetaModalScrollMaxH }]}
                contentContainerStyle={styles.tarjetaModalScrollContent}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                {tarjetaLineas.length === 0 ? (
                  <Text style={styles.tarjetaModalEmpty}>No hay líneas. Pulsa «Añadir boleta» abajo.</Text>
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
                            onPress={() => pickImageTarjetaLinea(line.id, 'camera')}
                            accessibilityLabel="Cámara"
                          >
                            <MaterialIcons name="photo-camera" size={20} color="#0369a1" />
                          </TouchableOpacity>
                        ) : null}
                        <TouchableOpacity
                          style={styles.tarjetaIconOnly}
                          onPress={() => pickImageTarjetaLinea(line.id, 'library')}
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
                              onPress={() => pickImageTarjetaLinea(line.id, 'library')}
                            >
                              <MaterialIcons name="add-a-photo" size={18} color="#0369a1" />
                              <Text style={styles.tarjetaSinFotoText}>Añadir imagen (galería)</Text>
                            </TouchableOpacity>
                          ) : null}
                          {tarjetaCamposDosColumnas ? (
                            <>
                              <View style={styles.tarjetaDetailRow2}>
                                <TouchableOpacity
                                  style={[styles.tarjetaLineaInputCompact, styles.tarjetaBancoSelect, styles.tarjetaLineaFieldGrow]}
                                  onPress={() => setTarjetaBancoPickerLineId(line.id)}
                                  activeOpacity={0.75}
                                >
                                  {line.banco ? (
                                    <View style={styles.tarjetaBancoSelectInner}>
                                      <BankLogoBadge bancoId={line.banco} width={84} height={26} />
                                      <MaterialIcons name="arrow-drop-down" size={20} color="#64748b" />
                                    </View>
                                  ) : (
                                    <Text style={styles.tarjetaBancoSelectPlaceholder}>Seleccionar banco</Text>
                                  )}
                                </TouchableOpacity>
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
                              <TouchableOpacity
                                style={[styles.tarjetaLineaInputCompact, styles.tarjetaBancoSelect]}
                                onPress={() => setTarjetaBancoPickerLineId(line.id)}
                                activeOpacity={0.75}
                              >
                                {line.banco ? (
                                  <View style={styles.tarjetaBancoSelectInner}>
                                    <BankLogoBadge bancoId={line.banco} width={88} height={26} />
                                    <MaterialIcons name="arrow-drop-down" size={20} color="#64748b" />
                                  </View>
                                ) : (
                                  <Text style={styles.tarjetaBancoSelectPlaceholder}>Seleccionar banco</Text>
                                )}
                              </TouchableOpacity>
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

        <Modal
          visible={tarjetaBancoPickerLineId != null}
          transparent
          animationType="fade"
          onRequestClose={() => setTarjetaBancoPickerLineId(null)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setTarjetaBancoPickerLineId(null)}>
            <Pressable style={[styles.modalSheet, styles.bankPickerSheet]} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.bankPickerTitle}>Seleccionar banco</Text>
              <ScrollView style={styles.bankPickerList} keyboardShouldPersistTaps="handled">
                {BANCOS_ARQUEO.map((b) => {
                  const sel = tarjetaLineas.find((l) => l.id === tarjetaBancoPickerLineId)?.banco === b.id;
                  return (
                    <TouchableOpacity
                      key={b.id}
                      style={[styles.bankPickerRow, sel && styles.bankPickerRowActive]}
                      onPress={() => {
                        const id = tarjetaBancoPickerLineId;
                        if (id) updateTarjetaLinea(id, { banco: b.id });
                        setTarjetaBancoPickerLineId(null);
                      }}
                      activeOpacity={0.75}
                    >
                      <BankLogoBadge bancoId={b.id} width={104} height={30} />
                      <Text style={styles.bankPickerLabel}>{b.label}</Text>
                      {sel ? <MaterialIcons name="check" size={22} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity style={styles.bankPickerCerrar} onPress={() => setTarjetaBancoPickerLineId(null)}>
                <Text style={styles.bankPickerCerrarText}>Cancelar</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
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
            {LABELS.map((row) => {
              const t = compare.teorico[row.teoricoKey] ?? 0;
              const diff = diffsEnVivo ? diffsEnVivo[row.teoricoKey] ?? 0 : 0;
              const v = values[row.realField];

              if (row.key === 'tarjeta') {
                return (
                  <View key={row.key} style={styles.rowCompare}>
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
                              onChangeText={setters[row.realField]}
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
                <View key={row.key} style={styles.rowCompare}>
                  <Text style={styles.rowLabel}>{row.label}</Text>
                  <View style={styles.rowCols}>
                    <View style={styles.colTeo}>
                      <Text style={styles.colHdr}>Teórico</Text>
                      <Text style={styles.colVal}>{formatMoneda(t)}</Text>
                    </View>
                    <View style={styles.colReal}>
                      <Text style={styles.colHdr}>Real</Text>
                      {row.key === 'efectivo' ? (
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
                            onChangeText={setters[row.realField]}
                            keyboardType="decimal-pad"
                            placeholder="0,00"
                            placeholderTextColor="#94a3b8"
                          />
                        </View>
                      ) : row.key === 'agora' ? (
                        <View style={styles.agoraRealSync}>
                          <Text style={styles.agoraRealSyncText}>{formatMoneda(t)}</Text>
                          <MaterialIcons name="sync" size={16} color="#64748b" />
                        </View>
                      ) : (
                        <TextInput
                          style={styles.inputNum}
                          value={v}
                          onChangeText={setters[row.realField]}
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
                </View>
              );
            })}
          </View>
        ) : (
          !loadingCompare &&
          formLocal &&
          formPosId &&
          businessDayIso && (
            <Text style={styles.hint}>Sin datos de comparativa. Revisa fecha y permisos de API.</Text>
          )
        )}

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDis]}
          onPress={guardar}
          disabled={saving || !businessDayIso || !formLocal || !formPosId}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <MaterialIcons name="save" size={20} color="#fff" />
              <Text style={styles.saveBtnText}>Guardar arqueo real</Text>
            </>
          )}
        </TouchableOpacity>
        {saveOk ? <Text style={styles.okText}>Guardado correctamente.</Text> : null}

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
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 18,
  },
  /** Fecha: crece un poco en pantallas anchas, sin ocupar todo el ancho. */
  filtrosColFecha: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 132,
    maxWidth: 200,
  },
  /** Local / TPV: solo el ancho necesario (hasta un máximo). */
  filtrosColSelect: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 140,
    maxWidth: 288,
    alignSelf: 'flex-start',
  },
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
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: '#fff',
    minHeight: 40,
  },
  selectDisabled: { opacity: 0.5 },
  selectText: { flexShrink: 1, fontSize: 13, color: '#334155', marginRight: 4, minWidth: 0 },
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
  modalList: { maxHeight: 360 },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    marginBottom: 4,
  },
  modalRowActive: { backgroundColor: '#f0f9ff', borderColor: '#bae6fd' },
  modalRowLine: { flex: 1, flexWrap: 'wrap' as const },
  modalRowName: { fontSize: 14, color: '#334155', fontWeight: '500' },
  modalRowId: { fontSize: 14, color: '#64748b' },
  modalClose: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  modalCloseText: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
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
  tarjetaBancoSelect: {
    justifyContent: 'center',
    minHeight: 40,
  },
  tarjetaBancoSelectInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
  },
  tarjetaBancoSelectPlaceholder: {
    fontSize: 13,
    color: '#94a3b8',
  },
  bankPickerSheet: {
    maxWidth: 400,
    maxHeight: '85%',
    paddingBottom: 12,
    ...(Platform.OS === 'web' ? { zIndex: 10001 } as object : {}),
  },
  bankPickerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 12,
  },
  bankPickerList: { maxHeight: 320 },
  bankPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 8,
    backgroundColor: '#fff',
  },
  bankPickerRowActive: {
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  bankPickerLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
  },
  bankPickerCerrar: { alignSelf: 'center', paddingVertical: 8, marginTop: 4 },
  bankPickerCerrarText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
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
  okText: { fontSize: 13, color: '#059669', marginTop: 10, textAlign: 'center' },
  errorText: { padding: 16, color: '#b91c1c' },
});
