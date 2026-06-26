/**
 * Control de Excepciones (Cajas)
 * Revisa invitaciones, descuentos manuales y anulaciones registrados en Ágora
 * para un rango de fechas y locales seleccionados.
 *
 * Fuente: GET /api/agora/invoices/exceptions (cacheado 2 min en backend).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Pressable,
  Platform,
  Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as XLSX from 'xlsx-js-style';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { InputFecha } from '../../components/InputFecha';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';
import { generarPdfExcepciones, generarPdfExcepcionesAgrupado, generarPdfResumenLocales, pdfExcepcionesFileSlug } from './pdfControlExcepciones';
import { formatMotivoLabel, getMotivoBadgeStyle } from './motivoBadges';
import { filterExcepcionesConsumo, isConsumoCustomer } from './excepcionesConsumo';

const PAGE_SIZE = 100;
const PAGE_SIZE_GRUPOS = 50;
const DEFAULT_COL_WIDTH = 90;
const STORAGE_KEY_AGRUPAR = 'excepciones.agrupar.v1';
const STORAGE_KEY_EXPANDIDOS = 'excepciones.expandidos.v1';

const GROUP_COLS = ['Usuario', 'Invitaciones', 'Promociones', 'Descuentos', 'Anulaciones', 'Consumo', 'Total'] as const;
const GROUP_COL_WIDTH: Record<(typeof GROUP_COLS)[number], number> = {
  Usuario: 220,
  Invitaciones: 220,
  Promociones: 200,
  Descuentos: 180,
  Anulaciones: 180,
  Consumo: 180,
  Total: 110,
};

type ExceptionType = 'invitacion' | 'promocion' | 'descuento' | 'anulacion' | 'consumo';

type ExceptionRow = {
  Type: ExceptionType;
  WorkplaceId: string;
  WorkplaceName: string | null;
  PosId: number | string | null;
  PosName: string | null;
  BusinessDay: string;
  DateTime: string;
  DocumentType: string;
  TicketNumber: string;
  InvoiceNumber: string;
  UserId: number | string | null;
  UserName: string | null;
  Amount: number;
  Quantity: number | null;
  ProductName: string | null;
  Reason: string | null;
  DiscountRate: number | null;
  OriginalInvoiceId: number | string | null;
  CustomerId?: number | string | null;
  CustomerName?: string | null;
};

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

const TYPE_LABEL: Record<ExceptionType, string> = {
  invitacion: 'Invitación',
  promocion: 'Promoción',
  descuento: 'Descuento manual',
  anulacion: 'Anulación',
  consumo: 'Consumo',
};

const TYPE_COLOR: Record<ExceptionType, { bg: string; text: string; border: string }> = {
  invitacion: { bg: '#ecfdf5', text: '#065f46', border: '#a7f3d0' },
  promocion: { bg: '#ede9fe', text: '#5b21b6', border: '#c4b5fd' },
  descuento: { bg: '#fef3c7', text: '#92400e', border: '#fde68a' },
  anulacion: { bg: '#fee2e2', text: '#991b1b', border: '#fecaca' },
  consumo: { bg: '#ecfeff', text: '#0e7490', border: '#a5f3fc' },
};

function formatMoneda(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '—';
  const parts = value.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

function parseDateToYYYYMMDD(input: string): string | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const date = new Date(y, mo - 1, d);
    if (date.getDate() === d && date.getMonth() === mo - 1 && date.getFullYear() === y) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function todayDmy(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatBusinessDayLabel(iso: string): string {
  if (!iso || typeof iso !== 'string') return '—';
  const parts = iso.trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatHora(iso: string): string {
  if (!iso) return '—';
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const m2 = String(iso).match(/(\d{2}):(\d{2})(:\d{2})?/);
  if (m2) return `${m2[1]}:${m2[2]}`;
  return '—';
}

async function safeJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}: ${res.statusText || 'Servidor no disponible'}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(res.ok ? 'Respuesta no válida del servidor' : `Error ${res.status}: ${res.statusText || 'Servidor no disponible'}`);
  }
}

const COLUMNAS = [
  'Type', 'BusinessDay', 'Hora', 'Local', 'PosName', 'DocumentType',
  'TicketNumber', 'UserName', 'ProductName', 'Quantity', 'Amount', 'Customer', 'Reason',
] as const;

const COL_LABELS: Record<string, string> = {
  Type: 'Tipo',
  BusinessDay: 'Fecha',
  Hora: 'Hora',
  Local: 'Local',
  PosName: 'POS',
  DocumentType: 'Doc',
  TicketNumber: 'Nº',
  UserName: 'Usuario',
  ProductName: 'Producto',
  Quantity: 'Cant.',
  Amount: 'Importe',
  Customer: 'Cliente',
  Reason: 'Motivo',
};

const COL_DEFAULT_WIDTH: Record<string, number> = {
  Type: 110,
  BusinessDay: 78,
  Hora: 56,
  Local: 130,
  PosName: 90,
  DocumentType: 70,
  TicketNumber: 84,
  UserName: 130,
  ProductName: 180,
  Quantity: 60,
  Amount: 92,
  Customer: 120,
  Reason: 160,
};

export default function ControlExcepcionesScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const puedeExportar = hasPermiso('excepciones.exportar');

  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fechaDesdeInput, setFechaDesdeInput] = useState<string>(todayDmy());
  const [fechaHastaInput, setFechaHastaInput] = useState<string>(todayDmy());
  const [consultedFrom, setConsultedFrom] = useState<string>('');
  const [consultedTo, setConsultedTo] = useState<string>('');
  const [filtroBusquedaInput, setFiltroBusquedaInput] = useState('');
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filtroTipo, setFiltroTipo] = useState<Set<ExceptionType>>(new Set());
  const [filtroLocales, setFiltroLocales] = useState<string[]>([]);
  const [localesOpen, setLocalesOpen] = useState(false);
  const [appliedLocales, setAppliedLocales] = useState<string[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [locales, setLocales] = useState<LocalItem[]>([]);

  // --- Filtro por usuario (multi-select con buscador) ---
  const [filtroUsuarios, setFiltroUsuarios] = useState<Set<string>>(new Set());
  const [usuariosOpen, setUsuariosOpen] = useState(false);
  const [usuariosSearch, setUsuariosSearch] = useState('');

  // --- Ordenación de tabla por cabecera ---
  type SortDir = 'asc' | 'desc';
  const [sortBy, setSortBy] = useState<{ col: (typeof COLUMNAS)[number]; dir: SortDir } | null>(null);

  // --- Menú Descarga + descarga masiva por local ---
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [showMassDownload, setShowMassDownload] = useState(false);
  const [massSelectedLocals, setMassSelectedLocals] = useState<Set<string>>(new Set());
  const [massDownloading, setMassDownloading] = useState(false);
  const [massProgress, setMassProgress] = useState({ current: 0, total: 0, localName: '' });

  // --- Filtro cliente CONSUMO (Id 1) — excluido por defecto ---
  const [incluirConsumo, setIncluirConsumo] = useState(true);

  // --- Agrupación por usuario (toggle + expand/collapse + persistencia) ---
  const [agrupar, setAgrupar] = useState(true);
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set());
  const [currentPageGrupos, setCurrentPageGrupos] = useState(1);
  const prefsHydrated = useRef(false);

  // Hidratar preferencias desde AsyncStorage al montar
  useEffect(() => {
    (async () => {
      try {
        const [ag, exp] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY_AGRUPAR),
          AsyncStorage.getItem(STORAGE_KEY_EXPANDIDOS),
        ]);
        if (ag === '0') setAgrupar(false);
        if (exp) {
          try {
            const arr = JSON.parse(exp);
            if (Array.isArray(arr)) setExpandidos(new Set(arr.map(String)));
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      prefsHydrated.current = true;
    })();
  }, []);

  // Guardar preferencias
  useEffect(() => {
    if (!prefsHydrated.current) return;
    AsyncStorage.setItem(STORAGE_KEY_AGRUPAR, agrupar ? '1' : '0').catch(() => { /* ignore */ });
  }, [agrupar]);
  useEffect(() => {
    if (!prefsHydrated.current) return;
    AsyncStorage.setItem(STORAGE_KEY_EXPANDIDOS, JSON.stringify(Array.from(expandidos))).catch(() => { /* ignore */ });
  }, [expandidos]);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((res) => safeJson<{ locales?: LocalItem[] }>(res))
      .then((data) => setLocales(data.locales || []))
      .catch(() => setLocales([]));
  }, []);

  const agoraCodeToNombre = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) map[code] = nombre || '—';
    }
    return map;
  }, [locales]);

  const localesOrdenados = useMemo(() => {
    return [...locales].sort((a, b) => {
      const na = String(a.nombre ?? a.Nombre ?? a.agoraCode ?? a.AgoraCode ?? '').trim();
      const nb = String(b.nombre ?? b.Nombre ?? b.agoraCode ?? b.AgoraCode ?? '').trim();
      return na.localeCompare(nb, 'es', { sensitivity: 'base' });
    });
  }, [locales]);

  useEffect(() => {
    const t = setTimeout(() => setFiltroBusqueda(filtroBusquedaInput), 250);
    return () => clearTimeout(t);
  }, [filtroBusquedaInput]);

  const consultar = useCallback(async (opts: {
    desde: string;
    hasta: string;
    locales: string[];
    refresh?: boolean;
  }) => {
    const isoFrom = parseDateToYYYYMMDD(opts.desde);
    const isoTo = parseDateToYYYYMMDD(opts.hasta);
    if (!isoFrom || !isoTo) {
      setError('Fechas no válidas (dd/mm/yyyy)');
      return;
    }
    if (isoFrom > isoTo) {
      setError('La fecha "Desde" debe ser anterior o igual a "Hasta"');
      return;
    }
    const MAX_DAYS = opts.locales.length === 1 ? 365 : 31;
    const msDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.round(
      (new Date(isoTo + 'T12:00:00').getTime() - new Date(isoFrom + 'T12:00:00').getTime()) / msDay,
    ) + 1;
    if (diffDays > MAX_DAYS) {
      const msg = opts.locales.length === 1
        ? `Rango máximo permitido: ${MAX_DAYS} días`
        : `Rango máximo permitido: ${MAX_DAYS} días con ${opts.locales.length === 0 ? 'todos los locales' : `${opts.locales.length} locales`}. Selecciona 1 solo local para ampliar hasta 365 días.`;
      setError(msg);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('dateFrom', isoFrom);
      params.set('dateTo', isoTo);
      for (const wp of opts.locales) {
        if (wp) params.append('workplaceIds', wp);
      }
      if (opts.refresh) params.set('refresh', '1');

      const res = await apiFetch(
        `/api/agora/invoices/exceptions?${params.toString()}`,
        { timeoutMs: 120_000 },
      );
      const data = await safeJson<{
        rows?: ExceptionRow[];
        error?: string;
        cachedAt?: string;
        fromCache?: boolean;
      }>(res);
      if (data.error) throw new Error(data.error);
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setConsultedFrom(isoFrom);
      setConsultedTo(isoTo);
      setAppliedLocales([...opts.locales]);
      setCachedAt(data.cachedAt ?? null);
      setFromCache(Boolean(data.fromCache));
      setCurrentPage(1);
    } catch (e) {
      const msg =
        e instanceof Error && /abort/i.test(e.message)
          ? 'La consulta tardó demasiado. Reduce el rango de fechas o el número de locales seleccionados.'
          : e instanceof Error ? e.message : 'Error de conexión';
      setError(msg);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const didAutoConsult = useRef(false);
  useEffect(() => {
    if (didAutoConsult.current) return;
    didAutoConsult.current = true;
    consultar({ desde: fechaDesdeInput, hasta: fechaHastaInput, locales: [] });
  }, [consultar, fechaDesdeInput, fechaHastaInput]);

  const getValorCelda = useCallback((r: ExceptionRow, col: string): string => {
    switch (col) {
      case 'Type': return TYPE_LABEL[r.Type] ?? r.Type;
      case 'BusinessDay': return formatBusinessDayLabel(r.BusinessDay);
      case 'Hora': return formatHora(r.DateTime);
      case 'Local': {
        const cod = String(r.WorkplaceId ?? '').trim();
        return agoraCodeToNombre[cod] ?? r.WorkplaceName ?? cod ?? '—';
      }
      case 'PosName': return r.PosName ?? (r.PosId != null ? String(r.PosId) : '—');
      case 'DocumentType': return r.DocumentType ?? '—';
      case 'TicketNumber': return r.TicketNumber || r.InvoiceNumber || '—';
      case 'UserName': return r.UserName ?? (r.UserId != null ? `#${r.UserId}` : '—');
      case 'ProductName': return r.ProductName ?? '—';
      case 'Quantity': return r.Quantity != null ? String(r.Quantity) : '—';
      case 'Amount': {
        const n = Number(r.Amount) || 0;
        if (n === 0 && r.Type === 'invitacion') return '0,00 €';
        return formatMoneda(n);
      }
      case 'Customer': {
        if (isConsumoCustomer(r.CustomerId, r.CustomerName)) return 'CONSUMO';
        return r.CustomerName ?? (r.CustomerId != null ? `#${r.CustomerId}` : '—');
      }
      case 'Reason': {
        const base = formatMotivoLabel(r.Reason, r.DiscountRate);
        return isConsumoCustomer(r.CustomerId, r.CustomerName) ? `${base} · CONSUMO` : base;
      }
      default: return '';
    }
  }, [agoraCodeToNombre]);

  const rowsVisibles = useMemo(
    () => filterExcepcionesConsumo(rows, incluirConsumo),
    [rows, incluirConsumo],
  );

  // --- Usuarios únicos (a partir de los datos cargados) ---
  const usuariosUnicos = useMemo(() => {
    const map = new Map<string, string>(); // key = id o nombre, value = nombre visible
    for (const r of rowsVisibles) {
      const id = r.UserId != null ? String(r.UserId) : (r.UserName ?? '').trim();
      if (!id) continue;
      const nombre = r.UserName ?? (r.UserId != null ? `#${r.UserId}` : id);
      if (!map.has(id)) map.set(id, nombre);
    }
    return Array.from(map.entries())
      .sort(([, a], [, b]) => a.localeCompare(b, 'es'));
  }, [rowsVisibles]);

  const usuariosUnicosFiltrados = useMemo(() => {
    const q = usuariosSearch.trim().toLowerCase();
    if (!q) return usuariosUnicos;
    return usuariosUnicos.filter(([, nombre]) => nombre.toLowerCase().includes(q));
  }, [usuariosUnicos, usuariosSearch]);

  // --- Filtrado cliente ---
  const filteredRows = useMemo(() => {
    let list = rowsVisibles;
    if (filtroTipo.size > 0) {
      list = list.filter((r) => filtroTipo.has(r.Type));
    }
    if (filtroUsuarios.size > 0) {
      list = list.filter((r) => {
        const id = r.UserId != null ? String(r.UserId) : (r.UserName ?? '').trim();
        return filtroUsuarios.has(id);
      });
    }
    const q = filtroBusqueda.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        [r.UserName, r.ProductName, r.TicketNumber, r.InvoiceNumber, r.Reason, r.WorkplaceName, r.PosName]
          .map((v) => String(v ?? '').toLowerCase())
          .some((v) => v.includes(q)),
      );
    }
    return list;
  }, [rowsVisibles, filtroTipo, filtroUsuarios, filtroBusqueda]);

  // --- Ordenación ---
  const sortedRows = useMemo(() => {
    if (!sortBy) return filteredRows;
    const { col, dir } = sortBy;
    const factor = dir === 'asc' ? 1 : -1;
    const numericCols = new Set(['Amount', 'Quantity']);
    const arr = [...filteredRows];
    arr.sort((a, b) => {
      if (numericCols.has(col)) {
        const va = Number((a as Record<string, unknown>)[col]) || 0;
        const vb = Number((b as Record<string, unknown>)[col]) || 0;
        return (va - vb) * factor;
      }
      if (col === 'BusinessDay') {
        return String(a.BusinessDay ?? '').localeCompare(String(b.BusinessDay ?? '')) * factor;
      }
      if (col === 'Hora') {
        return String(a.DateTime ?? '').localeCompare(String(b.DateTime ?? '')) * factor;
      }
      const sa = getValorCelda(a, col);
      const sb = getValorCelda(b, col);
      return String(sa).localeCompare(String(sb), 'es', { numeric: true }) * factor;
    });
    return arr;
  }, [filteredRows, sortBy, getValorCelda]);

  // --- Agrupación por usuario ---
  type GrupoUsuario = {
    userKey: string;
    userName: string;
    invitacion: { count: number; quantity: number; amount: number };
    promocion: { count: number; quantity: number; amount: number };
    descuento: { count: number; quantity: number; amount: number };
    anulacion: { count: number; quantity: number; amount: number };
    consumo: { count: number; quantity: number; amount: number };
    totalCount: number;
    totalAmount: number;
    rows: ExceptionRow[];
  };

  const grupos = useMemo<GrupoUsuario[]>(() => {
    const map = new Map<string, GrupoUsuario>();
    for (const r of sortedRows) {
      const id = r.UserId != null ? String(r.UserId) : (r.UserName ?? '').trim();
      const key = id || '__sin_usuario__';
      let g = map.get(key);
      if (!g) {
        g = {
          userKey: key,
          userName: r.UserName ?? (r.UserId != null ? `#${r.UserId}` : 'Sin usuario'),
          invitacion: { count: 0, quantity: 0, amount: 0 },
          promocion: { count: 0, quantity: 0, amount: 0 },
          descuento: { count: 0, quantity: 0, amount: 0 },
          anulacion: { count: 0, quantity: 0, amount: 0 },
          consumo: { count: 0, quantity: 0, amount: 0 },
          totalCount: 0,
          totalAmount: 0,
          rows: [],
        };
        map.set(key, g);
      }
      const bucket = g[r.Type];
      if (bucket) {
        bucket.count += 1;
        bucket.quantity += Number(r.Quantity) || 0;
        bucket.amount += Number(r.Amount) || 0;
      }
      g.totalCount += 1;
      g.totalAmount += Number(r.Amount) || 0;
      g.rows.push(r);
    }
    return Array.from(map.values()).sort((a, b) => a.userName.localeCompare(b.userName, 'es'));
  }, [sortedRows]);

  // Paginación por grupos (modo agrupado)
  const totalPagesGrupos = Math.max(1, Math.ceil(grupos.length / PAGE_SIZE_GRUPOS));
  const effectivePageGrupos = Math.min(Math.max(1, currentPageGrupos), totalPagesGrupos);
  const paginatedGrupos = useMemo(() => {
    const start = (effectivePageGrupos - 1) * PAGE_SIZE_GRUPOS;
    return grupos.slice(start, start + PAGE_SIZE_GRUPOS);
  }, [grupos, effectivePageGrupos]);

  // --- KPIs ---
  const kpis = useMemo(() => {
    const out = {
      invitacion: { count: 0, total: 0 },
      promocion: { count: 0, total: 0 },
      descuento: { count: 0, total: 0 },
      anulacion: { count: 0, total: 0 },
      consumo: { count: 0, total: 0 },
    };
    for (const r of filteredRows) {
      const t = r.Type;
      if (!out[t]) continue;
      out[t].count += 1;
      out[t].total += Number(r.Amount) || 0;
    }
    return out;
  }, [filteredRows]);

  const totalesTabla = useMemo(() => {
    let quantity = 0;
    let amount = 0;
    for (const r of sortedRows) {
      quantity += Number(r.Quantity) || 0;
      amount += Number(r.Amount) || 0;
    }
    return { quantity, amount };
  }, [sortedRows]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const effectivePage = Math.min(Math.max(1, currentPage), totalPages);
  const paginatedList = useMemo(() => {
    const start = (effectivePage - 1) * PAGE_SIZE;
    return sortedRows.slice(start, start + PAGE_SIZE);
  }, [sortedRows, effectivePage]);

  const isMonedaCol = (col: string) => col === 'Amount' || col === 'Quantity';

  const renderSumRowTable = (
    totales: { quantity: number; amount: number },
    variant: 'main' | 'child' = 'main',
  ) => (
    <View style={[styles.sumRowTable, variant === 'child' && styles.sumRowTableChild]}>
      {COLUMNAS.map((col) => {
        const w = COL_DEFAULT_WIDTH[col] ?? DEFAULT_COL_WIDTH;
        if (col === 'ProductName') {
          return (
            <View key={col} style={[styles.cell, styles.sumCell, { width: w }]}>
              <Text style={styles.sumLabelText} numberOfLines={1}>Total</Text>
            </View>
          );
        }
        if (col === 'Quantity') {
          return (
            <View key={col} style={[styles.cell, styles.cellRight, styles.sumCell, { width: w }]}>
              <Text style={styles.sumCellText} numberOfLines={1}>
                {totales.quantity !== 0 ? String(totales.quantity) : '—'}
              </Text>
            </View>
          );
        }
        if (col === 'Amount') {
          const amt = totales.amount;
          const amtLabel = !Number.isFinite(amt) || amt === 0
            ? '0,00 €'
            : formatMoneda(amt);
          return (
            <View key={col} style={[styles.cell, styles.cellRight, styles.sumCell, { width: w }]}>
              <Text style={styles.sumCellText} numberOfLines={1}>
                {amtLabel}
              </Text>
            </View>
          );
        }
        return <View key={col} style={{ width: w }} />;
      })}
    </View>
  );

  const renderReasonCell = (r: ExceptionRow, w: number) => {
    const colors = getMotivoBadgeStyle(r.Reason);
    const base = formatMotivoLabel(r.Reason, r.DiscountRate);
    const esConsumo = isConsumoCustomer(r.CustomerId, r.CustomerName);
    const label = esConsumo ? `${base} · CONSUMO` : base;
    return (
      <View style={[styles.cell, { width: w }]}>
        <View style={[styles.motivoBadge, { backgroundColor: colors.bg, borderColor: colors.border }]}>
          <Text style={[styles.motivoBadgeText, { color: colors.text }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      </View>
    );
  };

  const renderCustomerCell = (r: ExceptionRow, w: number) => {
    const esConsumo = isConsumoCustomer(r.CustomerId, r.CustomerName);
    if (esConsumo) {
      return (
        <View style={[styles.cell, { width: w }]}>
          <View style={styles.consumoBadge}>
            <Text style={styles.consumoBadgeText} numberOfLines={1}>CONSUMO</Text>
          </View>
        </View>
      );
    }
    const nombre = r.CustomerName ?? (r.CustomerId != null ? `#${r.CustomerId}` : null);
    return (
      <View style={[styles.cell, { width: w }]}>
        <Text style={styles.cellText} numberOfLines={1}>
          {nombre ?? '—'}
        </Text>
      </View>
    );
  };

  const toggleTipo = (t: ExceptionType) => {
    setFiltroTipo((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
    setCurrentPage(1);
  };

  const toggleLocal = (code: string) => {
    setFiltroLocales((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  };

  const onConsultar = () => consultar({
    desde: fechaDesdeInput,
    hasta: fechaHastaInput,
    locales: filtroLocales,
  });
  const onRecargar = () => consultar({
    desde: fechaDesdeInput,
    hasta: fechaHastaInput,
    locales: filtroLocales,
    refresh: true,
  });

  const toggleUsuario = (id: string) => {
    setFiltroUsuarios((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setCurrentPage(1);
  };

  const seleccionarTodosUsuarios = () => {
    setFiltroUsuarios(new Set());
    setCurrentPage(1);
  };

  const onSort = (col: (typeof COLUMNAS)[number]) => {
    setSortBy((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' };
      if (prev.dir === 'asc') return { col, dir: 'desc' };
      return null; // tercer click: quita ordenación
    });
    setCurrentPage(1);
  };

  const toggleGrupo = (userKey: string) => {
    setExpandidos((prev) => {
      const next = new Set(prev);
      if (next.has(userKey)) next.delete(userKey); else next.add(userKey);
      return next;
    });
  };

  // --- Descarga masiva por local ---
  const handleOpenMassDownload = () => {
    setDownloadMenuOpen(false);
    setMassSelectedLocals(new Set());
    setMassProgress({ current: 0, total: 0, localName: '' });
    setShowMassDownload(true);
  };

  const toggleMassLocal = (code: string) => {
    setMassSelectedLocals((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const toggleMassAll = () => {
    setMassSelectedLocals((prev) => {
      const allCodes = locales
        .map((l) => String(l.agoraCode ?? l.AgoraCode ?? '').trim())
        .filter(Boolean);
      return prev.size === allCodes.length ? new Set() : new Set(allCodes);
    });
  };

  const localesConDatos = useMemo(() => {
    // Locales con al menos 1 fila en sortedRows (después de filtros aplicados)
    const set = new Set<string>();
    for (const r of sortedRows) {
      const code = String(r.WorkplaceId ?? '').trim();
      if (code) set.add(code);
    }
    return set;
  }, [sortedRows]);

  async function descargarPdf(filas: typeof sortedRows, titulo: string, slug: string) {
    if (filas.length === 0) return;
    const doc = agrupar
      ? await generarPdfExcepcionesAgrupado(filas, titulo, consultedFrom, consultedTo, { incluirConsumo })
      : await generarPdfExcepciones(filas, titulo, consultedFrom, consultedTo, { incluirConsumo });
    const fname = `excepciones${agrupar ? '_agrupado' : ''}_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`;
    if (Platform.OS === 'web') {
      doc.save(fname);
    } else {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1] || '';
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      await FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 });
      await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname });
    }
  }

  const exportarPdfConsolidado = async () => {
    setDownloadMenuOpen(false);
    if (!puedeExportar || sortedRows.length === 0) return;
    const titulo = appliedLocales.length === 0
      ? 'Todos los locales'
      : appliedLocales.length === 1
        ? (agoraCodeToNombre[appliedLocales[0]] ?? appliedLocales[0])
        : `${appliedLocales.length} locales`;
    await descargarPdf(sortedRows, titulo, pdfExcepcionesFileSlug(titulo));
  };

  const exportarPdfResumen = async () => {
    setDownloadMenuOpen(false);
    if (!puedeExportar || rowsVisibles.length === 0) return;
    const titulo = appliedLocales.length === 0
      ? 'Todos los locales'
      : appliedLocales.length === 1
        ? (agoraCodeToNombre[appliedLocales[0]] ?? appliedLocales[0])
        : `${appliedLocales.length} locales`;
    const slug = pdfExcepcionesFileSlug(titulo);
    const doc = await generarPdfResumenLocales(
      rowsVisibles,
      titulo,
      consultedFrom,
      consultedTo,
      { incluirConsumo, nombrePorLocal: agoraCodeToNombre },
    );
    const fname = `excepciones_resumen_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`;
    if (Platform.OS === 'web') {
      doc.save(fname);
    } else {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1] || '';
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      await FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 });
      await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname });
    }
  };

  const handleMassDownload = async () => {
    if (massSelectedLocals.size === 0) return;
    setMassDownloading(true);
    const seleccion = locales.filter((l) => {
      const code = String(l.agoraCode ?? l.AgoraCode ?? '').trim();
      return massSelectedLocals.has(code);
    });
    setMassProgress({ current: 0, total: seleccion.length, localName: '' });

    for (let i = 0; i < seleccion.length; i++) {
      const loc = seleccion[i];
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? code);
      setMassProgress({ current: i, total: seleccion.length, localName: nombre });
      try {
        // Si el rango/locales aplicado ya incluye este local, filtramos desde memoria.
        // Si no, consultamos al backend con el rango actual.
        let filas = sortedRows.filter((r) => String(r.WorkplaceId ?? '').trim() === code);
        if (filas.length === 0 && (appliedLocales.length === 0 || !appliedLocales.includes(code))) {
          const params = new URLSearchParams();
          params.set('dateFrom', consultedFrom);
          params.set('dateTo', consultedTo);
          params.append('workplaceIds', code);
          const res = await apiFetch(
            `/api/agora/invoices/exceptions?${params.toString()}`,
            { timeoutMs: 120_000 },
          );
          const data = await safeJson<{ rows?: ExceptionRow[] }>(res);
          filas = filterExcepcionesConsumo(
            Array.isArray(data.rows) ? data.rows : [],
            incluirConsumo,
          );
        }
        if (filas.length === 0) continue;
        await descargarPdf(filas, nombre, pdfExcepcionesFileSlug(nombre));
        if (Platform.OS === 'web') {
          await new Promise((r) => setTimeout(r, 350));
        }
      } catch { /* continuar con el siguiente local */ }
    }
    setMassProgress((p) => ({ ...p, current: seleccion.length, localName: '' }));
    setMassDownloading(false);
    setShowMassDownload(false);
  };

  const exportarExcel = () => {
    setDownloadMenuOpen(false);
    if (!puedeExportar || sortedRows.length === 0) return;

    const HEADERS = [
      'Tipo', 'Fecha', 'Hora', 'Local', 'POS', 'Documento', 'Nº',
      'Usuario', 'Producto', 'Cantidad', 'Importe (€)', 'Cliente', 'Motivo', '% Descuento',
    ];

    const filaParaR = (r: typeof sortedRows[number]) => {
      const esConsumo = isConsumoCustomer(r.CustomerId, r.CustomerName);
      const cliente = esConsumo
        ? 'CONSUMO'
        : (r.CustomerName ?? (r.CustomerId != null ? `#${r.CustomerId}` : ''));
      const motivoBase = r.Reason ?? '';
      const motivo = esConsumo && motivoBase ? `${motivoBase} · CONSUMO` : motivoBase;
      return {
        Tipo: TYPE_LABEL[r.Type] ?? r.Type,
        Fecha: formatBusinessDayLabel(r.BusinessDay),
        Hora: formatHora(r.DateTime),
        Local: (() => {
          const cod = String(r.WorkplaceId ?? '').trim();
          return agoraCodeToNombre[cod] ?? r.WorkplaceName ?? cod ?? '';
        })(),
        POS: r.PosName ?? (r.PosId != null ? String(r.PosId) : ''),
        Documento: r.DocumentType ?? '',
        'Nº': r.TicketNumber || r.InvoiceNumber || '',
        Usuario: r.UserName ?? (r.UserId != null ? `#${r.UserId}` : ''),
        Producto: r.ProductName ?? '',
        Cantidad: r.Quantity ?? '',
        'Importe (€)': Number(r.Amount) || 0,
        Cliente: cliente,
        Motivo: motivo,
        '% Descuento': r.DiscountRate ?? '',
      };
    };

    type Fila = ReturnType<typeof filaParaR>;
    const headerStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '0EA5E9' } },
      alignment: { horizontal: 'center' as const, vertical: 'center' as const },
    };
    const subtotalStyle = {
      font: { bold: true, color: { rgb: '0F172A' } },
      fill: { fgColor: { rgb: 'E0F2FE' } },
      alignment: { horizontal: 'left' as const },
    };
    const totalStyle = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '0369A1' } },
      alignment: { horizontal: 'left' as const },
    };

    const empty: Fila = {
      Tipo: '', Fecha: '', Hora: '', Local: '', POS: '', Documento: '', 'Nº': '',
      Usuario: '', Producto: '', Cantidad: '', 'Importe (€)': 0, Cliente: '', Motivo: '', '% Descuento': '',
    } as Fila;

    let dataRows: Fila[];
    let styledRows: number[] = []; // 0-based filas (sin contar la cabecera) que llevan estilo subtotal
    let totalRowIdx: number | null = null;

    if (agrupar) {
      dataRows = [];
      for (const g of grupos) {
        // Fila resumen
        const resumen: Fila = {
          ...empty,
          Tipo: `USUARIO: ${g.userName}`,
          Fecha: `${g.totalCount} reg`,
          Local: `Inv: ${g.invitacion.count} (${g.invitacion.quantity} ud · ${formatMoneda(g.invitacion.amount)})`,
          POS: `Promo: ${g.promocion.count} · ${formatMoneda(g.promocion.amount)}`,
          Documento: `Desc: ${g.descuento.count} · ${formatMoneda(g.descuento.amount)}`,
          'Nº': `Anul: ${g.anulacion.count} · ${formatMoneda(g.anulacion.amount)}`,
          Usuario: g.userName,
          Producto: `Cons: ${g.consumo.count} · ${formatMoneda(g.consumo.amount)}`,
          'Importe (€)': g.totalAmount,
          Motivo: `Total: ${formatMoneda(g.totalAmount)}`,
        };
        styledRows.push(dataRows.length); // 0-based body
        dataRows.push(resumen);
        for (const r of g.rows) dataRows.push(filaParaR(r));
      }
      // Total global
      const totalGlobal = sortedRows.reduce((acc, r) => acc + (Number(r.Amount) || 0), 0);
      totalRowIdx = dataRows.length;
      dataRows.push({
        ...empty,
        Tipo: 'TOTAL',
        Fecha: `${grupos.length} usuarios · ${sortedRows.length} reg`,
        'Importe (€)': totalGlobal,
      });
    } else {
      dataRows = sortedRows.map(filaParaR);
    }

    const ws = XLSX.utils.json_to_sheet(dataRows, { header: HEADERS });
    const range = XLSX.utils.decode_range(ws['!ref'] as string);

    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) (ws[addr] as { s?: unknown }).s = headerStyle;
    }
    if (agrupar) {
      for (const i of styledRows) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r: i + 1, c });
          if (ws[addr]) (ws[addr] as { s?: unknown }).s = subtotalStyle;
        }
      }
      if (totalRowIdx != null) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r: totalRowIdx + 1, c });
          if (ws[addr]) (ws[addr] as { s?: unknown }).s = totalStyle;
        }
      }
    }

    ws['!cols'] = [
      { wch: 14 }, { wch: 12 }, { wch: 8 }, { wch: 22 }, { wch: 14 },
      { wch: 10 }, { wch: 12 }, { wch: 22 }, { wch: 28 }, { wch: 10 },
      { wch: 14 }, { wch: 18 }, { wch: 28 }, { wch: 10 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, agrupar ? 'Excepciones (agrupado)' : 'Excepciones');
    const fn = `control-excepciones${agrupar ? '-agrupado' : ''}-${consultedFrom || 'sin-fecha'}-${consultedTo || ''}.xlsx`;
    XLSX.writeFile(wb, fn);
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.replace('/cajas')}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Control de Excepciones</Text>
        <Text style={styles.subtitle}>· Invitaciones, descuentos y anulaciones</Text>
      </View>

      <View style={[styles.queryBlock, (localesOpen || usuariosOpen) && styles.queryBlockElevated]}>
        <Text style={styles.queryBlockTitle}>Consulta</Text>
        <View style={[styles.queryRow, styles.queryRowFilters]}>
          <View style={styles.dateWrap}>
            <Text style={styles.dateLabel}>Desde</Text>
            <InputFecha
              value={fechaDesdeInput}
              onChange={setFechaDesdeInput}
              format="dmy"
              placeholder="dd/mm/yyyy"
              style={styles.dateInput}
              editable={!loading}
            />
          </View>
          <View style={styles.dateWrap}>
            <Text style={styles.dateLabel}>Hasta</Text>
            <InputFecha
              value={fechaHastaInput}
              onChange={setFechaHastaInput}
              format="dmy"
              placeholder="dd/mm/yyyy"
              style={styles.dateInput}
              editable={!loading}
            />
          </View>

          <View style={styles.dateWrap}>
            <Text style={styles.dateLabel}>Locales</Text>
            <View style={[styles.builderDropdownWrap, localesOpen && styles.builderDropdownWrapOpen]}>
              <TouchableOpacity
                style={styles.builderDropdownTrigger}
                onPress={() => {
                  setUsuariosOpen(false);
                  setLocalesOpen((v) => !v);
                }}
                disabled={loading}
              >
                <Text style={styles.builderDropdownText} numberOfLines={1}>
                  {filtroLocales.length === 0
                    ? 'Todos'
                    : filtroLocales.length === 1
                      ? (agoraCodeToNombre[filtroLocales[0]] ?? filtroLocales[0])
                      : `${filtroLocales.length} locales`}
                </Text>
                <MaterialIcons name={localesOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
              </TouchableOpacity>
              {localesOpen && (
                <>
                  <Pressable style={styles.ddOverlay} onPress={() => setLocalesOpen(false)} />
                  <View style={styles.builderDropdownList}>
                    <TouchableOpacity
                      style={[styles.builderDropdownOption, styles.builderDropdownOptionCompact, filtroLocales.length === 0 && styles.builderDropdownOptionSelected]}
                      onPress={() => setFiltroLocales([])}
                    >
                      <Text style={[styles.builderDropdownOptionText, styles.builderDropdownOptionTextCompact, filtroLocales.length === 0 && styles.builderDropdownOptionTextSelected]}>
                        Todos
                      </Text>
                      {filtroLocales.length === 0 ? <MaterialIcons name="check" size={14} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                    <View style={styles.ddDivider} />
                    <ScrollView style={styles.builderDropdownScrollCompact} nestedScrollEnabled>
                      {localesOrdenados.map((loc) => {
                        const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                        if (!code) return null;
                        const nombre = String(loc.nombre ?? loc.Nombre ?? code).trim();
                        const selected = filtroLocales.includes(code);
                        return (
                          <TouchableOpacity
                            key={code}
                            style={[styles.builderDropdownOption, styles.builderDropdownOptionCompact, styles.builderDropdownOptionWithCheck, selected && styles.builderDropdownOptionSelected]}
                            onPress={() => toggleLocal(code)}
                          >
                            <View style={styles.ddCheckboxCompact}>
                              {selected ? <MaterialIcons name="check-box" size={14} color="#0ea5e9" /> : <MaterialIcons name="check-box-outline-blank" size={14} color="#cbd5e1" />}
                            </View>
                            <Text style={[styles.builderDropdownOptionText, styles.builderDropdownOptionTextCompact, selected && styles.builderDropdownOptionTextSelected]} numberOfLines={1}>
                              {nombre}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                </>
              )}
            </View>
          </View>

          <View style={styles.dateWrap}>
            <Text style={styles.dateLabel}>Usuario</Text>
            <View style={[styles.builderDropdownWrap, usuariosOpen && styles.builderDropdownWrapOpen]}>
              <TouchableOpacity
                style={[styles.builderDropdownTrigger, { minWidth: 220 }]}
                onPress={() => {
                  setLocalesOpen(false);
                  setUsuariosOpen((v) => !v);
                }}
                disabled={loading || usuariosUnicos.length === 0}
              >
                <Text style={styles.builderDropdownText} numberOfLines={1}>
                  {filtroUsuarios.size === 0
                    ? 'Todos'
                    : filtroUsuarios.size === 1
                      ? (usuariosUnicos.find(([id]) => filtroUsuarios.has(id))?.[1] ?? '1 usuario')
                      : `${filtroUsuarios.size} usuarios`}
                </Text>
                <MaterialIcons name={usuariosOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
              </TouchableOpacity>
              {usuariosOpen && (
                <>
                  <Pressable style={styles.ddOverlay} onPress={() => setUsuariosOpen(false)} />
                  <View style={[styles.builderDropdownList, { minWidth: 280 }]}>
                    <View style={styles.ddSearchWrap}>
                      <MaterialIcons name="search" size={13} color="#94a3b8" />
                      <TextInput
                        style={[styles.ddSearchInput, styles.ddSearchInputCompact]}
                        placeholder="Buscar usuario…"
                        value={usuariosSearch}
                        onChangeText={setUsuariosSearch}
                        placeholderTextColor="#94a3b8"
                        autoFocus
                      />
                      {usuariosSearch.length > 0 && (
                        <TouchableOpacity onPress={() => setUsuariosSearch('')}>
                          <MaterialIcons name="close" size={13} color="#94a3b8" />
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={styles.ddDivider} />
                    <TouchableOpacity
                      style={[styles.builderDropdownOption, styles.builderDropdownOptionCompact, filtroUsuarios.size === 0 && styles.builderDropdownOptionSelected]}
                      onPress={seleccionarTodosUsuarios}
                    >
                      <Text style={[styles.builderDropdownOptionText, styles.builderDropdownOptionTextCompact, filtroUsuarios.size === 0 && styles.builderDropdownOptionTextSelected]}>
                        Todos
                      </Text>
                      {filtroUsuarios.size === 0 ? <MaterialIcons name="check" size={14} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                    <View style={styles.ddDivider} />
                    <ScrollView style={styles.builderDropdownScrollCompact} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {usuariosUnicosFiltrados.length === 0 ? (
                        <View style={styles.ddEmptyWrap}>
                          <Text style={styles.ddEmptyText}>
                            {usuariosUnicos.length === 0 ? 'No hay usuarios en el resultado' : 'Sin coincidencias'}
                          </Text>
                        </View>
                      ) : (
                        usuariosUnicosFiltrados.map(([id, nombre]) => {
                          const selected = filtroUsuarios.has(id);
                          return (
                            <TouchableOpacity
                              key={id}
                              style={[styles.builderDropdownOption, styles.builderDropdownOptionCompact, styles.builderDropdownOptionWithCheck, selected && styles.builderDropdownOptionSelected]}
                              onPress={() => toggleUsuario(id)}
                            >
                              <View style={styles.ddCheckboxCompact}>
                                {selected ? <MaterialIcons name="check-box" size={14} color="#0ea5e9" /> : <MaterialIcons name="check-box-outline-blank" size={14} color="#cbd5e1" />}
                              </View>
                              <Text style={[styles.builderDropdownOptionText, styles.builderDropdownOptionTextCompact, selected && styles.builderDropdownOptionTextSelected]} numberOfLines={1}>
                                {nombre}
                              </Text>
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </ScrollView>
                  </View>
                </>
              )}
            </View>
          </View>
          {filtroUsuarios.size > 0 && (
            <TouchableOpacity
              style={styles.toolbarBtn}
              onPress={seleccionarTodosUsuarios}
            >
              <MaterialIcons name="filter-alt-off" size={14} color="#64748b" />
              <Text style={styles.toolbarBtnText}>Quitar filtro usuarios</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Segunda fila del bloque de consulta: botones */}
        <View style={[styles.queryRow, styles.queryRowActions, { marginTop: 8 }]}>
          <TouchableOpacity
            style={[styles.toolbarBtnPrimary, loading && styles.toolbarBtnDisabled]}
            onPress={onConsultar}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="search" size={16} color="#fff" />
            )}
            <Text style={styles.toolbarBtnPrimaryText}>Consultar</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.toolbarBtn, loading && styles.toolbarBtnDisabled]}
            onPress={onRecargar}
            disabled={loading}
          >
            <MaterialIcons name="refresh" size={16} color="#64748b" />
            <Text style={styles.toolbarBtnText}>Recargar</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.toolbarBtn, agrupar && styles.toolbarBtnActive, loading && styles.toolbarBtnDisabled]}
            onPress={() => { setAgrupar((v) => !v); setCurrentPage(1); setCurrentPageGrupos(1); }}
            disabled={loading}
          >
            <MaterialIcons name="group-work" size={16} color={agrupar ? '#0369a1' : '#64748b'} />
            <Text style={[styles.toolbarBtnText, agrupar && styles.toolbarBtnTextActive]}>
              {agrupar ? 'Agrupado' : 'Agrupar'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.consumoCheckRow, loading && styles.toolbarBtnDisabled]}
            onPress={() => {
              setIncluirConsumo((v) => !v);
              setCurrentPage(1);
              setCurrentPageGrupos(1);
            }}
            disabled={loading}
          >
            <MaterialIcons
              name={incluirConsumo ? 'check-box' : 'check-box-outline-blank'}
              size={18}
              color={incluirConsumo ? '#0ea5e9' : '#94a3b8'}
            />
            <Text style={[styles.consumoCheckText, incluirConsumo && styles.consumoCheckTextActive]}>
              Incluir consumo
            </Text>
          </TouchableOpacity>

          {puedeExportar && (
            <TouchableOpacity
              style={[styles.toolbarBtn, (rowsVisibles.length === 0 || loading) && styles.toolbarBtnDisabled]}
              onPress={() => setDownloadMenuOpen(true)}
              disabled={rowsVisibles.length === 0 || loading}
            >
              <MaterialIcons name="file-download" size={16} color="#64748b" />
              <Text style={styles.toolbarBtnText}>Descarga</Text>
              <MaterialIcons name="expand-more" size={14} color="#64748b" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* KPIs */}
      <View style={styles.contentBelow}>
      <View style={styles.kpisRow}>
        {(['invitacion', 'promocion', 'descuento', 'anulacion', 'consumo'] as ExceptionType[]).map((t) => {
          const k = kpis[t];
          const color = TYPE_COLOR[t];
          const active = filtroTipo.has(t);
          return (
            <TouchableOpacity
              key={t}
              onPress={() => toggleTipo(t)}
              activeOpacity={0.85}
              style={[
                styles.kpiCard,
                { backgroundColor: color.bg, borderColor: color.border },
                active && styles.kpiCardActive,
              ]}
            >
              <Text style={[styles.kpiLabel, { color: color.text }]}>{TYPE_LABEL[t]}</Text>
              <Text style={[styles.kpiValue, { color: color.text }]}>{formatMoneda(k.total)}</Text>
              <Text style={[styles.kpiCount, { color: color.text }]}>{k.count} {k.count === 1 ? 'registro' : 'registros'}</Text>
            </TouchableOpacity>
          );
        })}
        {filtroTipo.size > 0 && (
          <TouchableOpacity style={styles.kpiClearBtn} onPress={() => { setFiltroTipo(new Set()); setCurrentPage(1); }}>
            <MaterialIcons name="filter-alt-off" size={14} color="#64748b" />
            <Text style={styles.kpiClearText}>Quitar filtro</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Búsqueda + paginación */}
      <View style={styles.toolbarRow}>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={16} color="#94a3b8" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Buscar usuario, producto, ticket…"
            value={filtroBusquedaInput}
            onChangeText={setFiltroBusquedaInput}
            placeholderTextColor="#94a3b8"
          />
        </View>
        {appliedLocales.length > 0 && (
          <View style={styles.cacheBadge}>
            <MaterialIcons name="place" size={12} color="#0369a1" />
            <Text style={styles.cacheBadgeText}>
              {appliedLocales.length === 1
                ? (agoraCodeToNombre[appliedLocales[0]] ?? appliedLocales[0])
                : `${appliedLocales.length} locales`}
            </Text>
          </View>
        )}
        {cachedAt && (
          <View style={styles.cacheBadge}>
            <MaterialIcons name={fromCache ? 'cached' : 'cloud-done'} size={12} color={fromCache ? '#92400e' : '#0369a1'} />
            <Text style={[styles.cacheBadgeText, fromCache && styles.cacheBadgeTextCached]}>
              {fromCache ? 'Caché' : 'Actualizado'}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.infoRow}>
        <Text style={styles.infoLine}>
          {consultedFrom && consultedTo
            ? `${formatBusinessDayLabel(consultedFrom)}${consultedFrom !== consultedTo ? ` → ${formatBusinessDayLabel(consultedTo)}` : ''} · `
            : ''}
          {agrupar
            ? `${grupos.length} ${grupos.length === 1 ? 'usuario' : 'usuarios'} · ${sortedRows.length} ${sortedRows.length === 1 ? 'excepción' : 'excepciones'}`
            : `${sortedRows.length} ${sortedRows.length === 1 ? 'excepción' : 'excepciones'}`
          }
          {rowsVisibles.length !== sortedRows.length ? ` (de ${rowsVisibles.length})` : ''}
          {!incluirConsumo && rows.length !== rowsVisibles.length
            ? ` · consumo excluido (${rows.length - rowsVisibles.length})`
            : ''}
          {sortBy && ` · orden: ${COL_LABELS[sortBy.col] ?? sortBy.col} ${sortBy.dir === 'asc' ? '↑' : '↓'}`}
        </Text>
        {agrupar
          ? (grupos.length > PAGE_SIZE_GRUPOS && (
            <View style={styles.pagination}>
              <TouchableOpacity
                style={[styles.pageBtn, effectivePageGrupos <= 1 && styles.pageBtnDisabled]}
                onPress={() => setCurrentPageGrupos((p) => Math.max(1, p - 1))}
                disabled={effectivePageGrupos <= 1}
              >
                <MaterialIcons name="chevron-left" size={20} color={effectivePageGrupos <= 1 ? '#94a3b8' : '#334155'} />
                <Text style={[styles.pageBtnText, effectivePageGrupos <= 1 && styles.pageBtnTextDisabled]}>Anterior</Text>
              </TouchableOpacity>
              <Text style={styles.pageInfo}>Página {effectivePageGrupos} de {totalPagesGrupos}</Text>
              <TouchableOpacity
                style={[styles.pageBtn, effectivePageGrupos >= totalPagesGrupos && styles.pageBtnDisabled]}
                onPress={() => setCurrentPageGrupos((p) => Math.min(totalPagesGrupos, p + 1))}
                disabled={effectivePageGrupos >= totalPagesGrupos}
              >
                <Text style={[styles.pageBtnText, effectivePageGrupos >= totalPagesGrupos && styles.pageBtnTextDisabled]}>Siguiente</Text>
                <MaterialIcons name="chevron-right" size={20} color={effectivePageGrupos >= totalPagesGrupos ? '#94a3b8' : '#334155'} />
              </TouchableOpacity>
            </View>
          ))
          : (sortedRows.length > PAGE_SIZE && (
            <View style={styles.pagination}>
              <TouchableOpacity
                style={[styles.pageBtn, effectivePage <= 1 && styles.pageBtnDisabled]}
                onPress={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={effectivePage <= 1}
              >
                <MaterialIcons name="chevron-left" size={20} color={effectivePage <= 1 ? '#94a3b8' : '#334155'} />
                <Text style={[styles.pageBtnText, effectivePage <= 1 && styles.pageBtnTextDisabled]}>Anterior</Text>
              </TouchableOpacity>
              <Text style={styles.pageInfo}>Página {effectivePage} de {totalPages}</Text>
              <TouchableOpacity
                style={[styles.pageBtn, effectivePage >= totalPages && styles.pageBtnDisabled]}
                onPress={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={effectivePage >= totalPages}
              >
                <Text style={[styles.pageBtnText, effectivePage >= totalPages && styles.pageBtnTextDisabled]}>Siguiente</Text>
                <MaterialIcons name="chevron-right" size={20} color={effectivePage >= totalPages ? '#94a3b8' : '#334155'} />
              </TouchableOpacity>
            </View>
          ))
        }
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={onConsultar}>
            <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : loading && rows.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Consultando Ágora…</Text>
        </View>
      ) : (
        <ScrollView horizontal style={styles.tableScroll} showsHorizontalScrollIndicator>
          <View style={styles.tableWrapper}>
            {agrupar ? (
              <View style={styles.headerRowTable}>
                {GROUP_COLS.map((col) => (
                  <View
                    key={col}
                    style={[
                      styles.cellHeader,
                      col === 'Total' && styles.cellRight,
                      { width: GROUP_COL_WIDTH[col] },
                    ]}
                  >
                    <Text style={styles.cellHeaderText} numberOfLines={1}>{col}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <>
                {sortedRows.length > 0 && renderSumRowTable(totalesTabla)}
                <View style={styles.headerRowTable}>
                {COLUMNAS.map((col) => {
                  const active = sortBy?.col === col;
                  return (
                    <TouchableOpacity
                      key={col}
                      style={[
                        styles.cellHeader,
                        isMonedaCol(col) && styles.cellRight,
                        active && styles.cellHeaderActive,
                        { width: COL_DEFAULT_WIDTH[col] ?? DEFAULT_COL_WIDTH },
                      ]}
                      onPress={() => onSort(col)}
                      activeOpacity={0.6}
                    >
                      <Text
                        style={[styles.cellHeaderText, active && styles.cellHeaderTextActive]}
                        numberOfLines={1}
                      >
                        {COL_LABELS[col] ?? col}
                      </Text>
                      {active && (
                        <MaterialIcons
                          name={sortBy?.dir === 'asc' ? 'arrow-upward' : 'arrow-downward'}
                          size={12}
                          color="#0ea5e9"
                        />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
              </>
            )}
            <ScrollView style={styles.tableInner} showsVerticalScrollIndicator>
              <View style={styles.table}>
                {agrupar ? (
                  paginatedGrupos.length === 0 ? (
                    <View style={styles.emptyRow}>
                      <Text style={styles.emptyText}>
                        {rows.length === 0
                          ? (consultedFrom ? 'Sin excepciones en el rango consultado' : 'Consulta un rango para ver las excepciones')
                          : 'Ningún resultado con el filtro actual'}
                      </Text>
                    </View>
                  ) : (
                    paginatedGrupos.map((g) => {
                      const isOpen = expandidos.has(g.userKey);
                      return (
                        <Fragment key={g.userKey}>
                          <TouchableOpacity
                            style={styles.groupRow}
                            onPress={() => toggleGrupo(g.userKey)}
                            activeOpacity={0.6}
                          >
                            <View style={[styles.cell, { width: GROUP_COL_WIDTH.Usuario, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
                              <View style={styles.expandBtn}>
                                <MaterialIcons
                                  name={isOpen ? 'remove' : 'add'}
                                  size={14}
                                  color="#0ea5e9"
                                />
                              </View>
                              <Text style={styles.groupUserText} numberOfLines={1}>{g.userName}</Text>
                              <Text style={styles.groupCountChip}>{g.totalCount}</Text>
                            </View>
                            <View style={[styles.cell, { width: GROUP_COL_WIDTH.Invitaciones }]}>
                              <Text style={[styles.groupBadgeText, { color: TYPE_COLOR.invitacion.text }]} numberOfLines={1}>
                                {g.invitacion.count > 0
                                  ? `${g.invitacion.count} reg · ${g.invitacion.quantity} ud · ${formatMoneda(g.invitacion.amount)}`
                                  : '—'}
                              </Text>
                            </View>
                            <View style={[styles.cell, { width: GROUP_COL_WIDTH.Promociones }]}>
                              <Text style={[styles.groupBadgeText, { color: TYPE_COLOR.promocion.text }]} numberOfLines={1}>
                                {g.promocion.count > 0
                                  ? `${g.promocion.count} reg · ${formatMoneda(g.promocion.amount)}`
                                  : '—'}
                              </Text>
                            </View>
                            <View style={[styles.cell, { width: GROUP_COL_WIDTH.Descuentos }]}>
                              <Text style={[styles.groupBadgeText, { color: TYPE_COLOR.descuento.text }]} numberOfLines={1}>
                                {g.descuento.count > 0
                                  ? `${g.descuento.count} reg · ${formatMoneda(g.descuento.amount)}`
                                  : '—'}
                              </Text>
                            </View>
                            <View style={[styles.cell, { width: GROUP_COL_WIDTH.Anulaciones }]}>
                              <Text style={[styles.groupBadgeText, { color: TYPE_COLOR.anulacion.text }]} numberOfLines={1}>
                                {g.anulacion.count > 0
                                  ? `${g.anulacion.count} reg · ${formatMoneda(g.anulacion.amount)}`
                                  : '—'}
                              </Text>
                            </View>
                            <View style={[styles.cell, { width: GROUP_COL_WIDTH.Consumo }]}>
                              <Text style={[styles.groupBadgeText, { color: TYPE_COLOR.consumo.text }]} numberOfLines={1}>
                                {g.consumo.count > 0
                                  ? `${g.consumo.count} reg · ${formatMoneda(g.consumo.amount)}`
                                  : '—'}
                              </Text>
                            </View>
                            <View style={[styles.cell, styles.cellRight, { width: GROUP_COL_WIDTH.Total }]}>
                              <Text
                                style={[
                                  styles.groupTotalText,
                                  g.totalAmount < 0 && styles.cellNegative,
                                ]}
                                numberOfLines={1}
                              >
                                {formatMoneda(g.totalAmount)}
                              </Text>
                            </View>
                          </TouchableOpacity>

                          {isOpen && (
                            <>
                              {renderSumRowTable(
                                g.rows.reduce(
                                  (acc, r) => ({
                                    quantity: acc.quantity + (Number(r.Quantity) || 0),
                                    amount: acc.amount + (Number(r.Amount) || 0),
                                  }),
                                  { quantity: 0, amount: 0 },
                                ),
                                'child',
                              )}
                              <View style={styles.childHeaderRow}>
                                {COLUMNAS.map((col) => (
                                  <View
                                    key={col}
                                    style={[
                                      styles.childHeaderCell,
                                      isMonedaCol(col) && styles.cellRight,
                                      { width: COL_DEFAULT_WIDTH[col] ?? DEFAULT_COL_WIDTH },
                                    ]}
                                  >
                                    <Text style={styles.childHeaderText} numberOfLines={1}>
                                      {COL_LABELS[col] ?? col}
                                    </Text>
                                  </View>
                                ))}
                              </View>
                              {g.rows.map((r, idx) => (
                                <View
                                  key={`${g.userKey}-${r.WorkplaceId}-${r.PosId ?? ''}-${r.InvoiceNumber}-${r.TicketNumber}-${r.Type}-${idx}`}
                                  style={[styles.dataRow, styles.childRow]}
                                >
                                  {COLUMNAS.map((col) => {
                                    const w = COL_DEFAULT_WIDTH[col] ?? DEFAULT_COL_WIDTH;
                                    if (col === 'Type') {
                                      const c = TYPE_COLOR[r.Type] ?? TYPE_COLOR.descuento;
                                      return (
                                        <View key={col} style={[styles.cell, { width: w }]}>
                                          <View style={[styles.typeBadge, { backgroundColor: c.bg, borderColor: c.border }]}>
                                            <Text style={[styles.typeBadgeText, { color: c.text }]} numberOfLines={1}>
                                              {TYPE_LABEL[r.Type] ?? r.Type}
                                            </Text>
                                          </View>
                                        </View>
                                      );
                                    }
                                    if (col === 'Reason') {
                                      return <View key={col}>{renderReasonCell(r, w)}</View>;
                                    }
                                    if (col === 'Customer') {
                                      return <View key={col}>{renderCustomerCell(r, w)}</View>;
                                    }
                                    const valor = getValorCelda(r, col);
                                    return (
                                      <View key={col} style={[styles.cell, isMonedaCol(col) && styles.cellRight, { width: w }]}>
                                        <Text
                                          style={[
                                            styles.cellText,
                                            col === 'Amount' && styles.cellBold,
                                            r.Type === 'anulacion' && col === 'Amount' && styles.cellNegative,
                                          ]}
                                          numberOfLines={1}
                                        >
                                          {valor}
                                        </Text>
                                      </View>
                                    );
                                  })}
                                </View>
                              ))}
                            </>
                          )}
                        </Fragment>
                      );
                    })
                  )
                ) : (
                  paginatedList.length === 0 ? (
                    <View style={styles.emptyRow}>
                      <Text style={styles.emptyText}>
                        {rows.length === 0
                          ? (consultedFrom ? 'Sin excepciones en el rango consultado' : 'Consulta un rango para ver las excepciones')
                          : 'Ningún resultado con el filtro actual'}
                      </Text>
                    </View>
                  ) : (
                    paginatedList.map((r, idx) => (
                      <View
                        key={`${r.WorkplaceId}-${r.PosId ?? ''}-${r.InvoiceNumber}-${r.TicketNumber}-${r.Type}-${idx}`}
                        style={styles.dataRow}
                      >
                        {COLUMNAS.map((col) => {
                          const w = COL_DEFAULT_WIDTH[col] ?? DEFAULT_COL_WIDTH;
                          if (col === 'Type') {
                            const c = TYPE_COLOR[r.Type] ?? TYPE_COLOR.descuento;
                            return (
                              <View key={col} style={[styles.cell, { width: w }]}>
                                <View style={[styles.typeBadge, { backgroundColor: c.bg, borderColor: c.border }]}>
                                  <Text style={[styles.typeBadgeText, { color: c.text }]} numberOfLines={1}>
                                    {TYPE_LABEL[r.Type] ?? r.Type}
                                  </Text>
                                </View>
                              </View>
                            );
                          }
                          if (col === 'Reason') {
                            return <View key={col}>{renderReasonCell(r, w)}</View>;
                          }
                          if (col === 'Customer') {
                            return <View key={col}>{renderCustomerCell(r, w)}</View>;
                          }
                          const valor = getValorCelda(r, col);
                          return (
                            <View key={col} style={[styles.cell, isMonedaCol(col) && styles.cellRight, { width: w }]}>
                              <Text
                                style={[
                                  styles.cellText,
                                  col === 'Amount' && styles.cellBold,
                                  r.Type === 'anulacion' && col === 'Amount' && styles.cellNegative,
                                ]}
                                numberOfLines={1}
                              >
                                {valor}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    ))
                  )
                )}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      )}
      </View>

      {/* Menú Descarga */}
      <Modal visible={downloadMenuOpen} transparent animationType="fade" onRequestClose={() => setDownloadMenuOpen(false)}>
        <Pressable style={styles.shareOverlay} onPress={() => setDownloadMenuOpen(false)}>
          <Pressable onPress={() => { /* swallow */ }} style={styles.shareMenuOuter}>
            <View style={styles.shareMenu}>
              <Text style={styles.shareMenuTitle}>Formato de descarga</Text>
              <ScrollView style={styles.shareMenuScroll} bounces={false} keyboardShouldPersistTaps="handled">
                <TouchableOpacity style={styles.shareMenuItem} onPress={exportarExcel}>
                  <MaterialIcons name="table-chart" size={18} color="#16a34a" />
                  <Text style={styles.shareMenuText}>Excel (.xlsx)</Text>
                </TouchableOpacity>
                <View style={styles.shareMenuDivider} />
                <TouchableOpacity style={styles.shareMenuItem} onPress={exportarPdfResumen}>
                  <MaterialIcons name="assessment" size={18} color="#0369a1" />
                  <Text style={styles.shareMenuText}>PDF resumen por local + Top 10</Text>
                </TouchableOpacity>
                <View style={styles.shareMenuDivider} />
                <TouchableOpacity style={styles.shareMenuItem} onPress={exportarPdfConsolidado}>
                  <MaterialIcons name="picture-as-pdf" size={18} color="#dc2626" />
                  <Text style={styles.shareMenuText}>PDF (consolidado)</Text>
                </TouchableOpacity>
                <View style={styles.shareMenuDivider} />
                <TouchableOpacity style={styles.shareMenuItem} onPress={handleOpenMassDownload}>
                  <MaterialIcons name="download-for-offline" size={18} color="#7c3aed" />
                  <Text style={styles.shareMenuText}>Descarga masiva (PDF por local)</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Modal descarga masiva por local */}
      <Modal visible={showMassDownload} transparent animationType="fade" onRequestClose={() => !massDownloading && setShowMassDownload(false)}>
        <Pressable style={styles.shareOverlay} onPress={() => !massDownloading && setShowMassDownload(false)}>
          <Pressable onPress={() => { /* swallow */ }} style={styles.massModal}>
            <Text style={styles.massTitle}>Descarga masiva de PDF</Text>
            <Text style={styles.massSubtitle}>
              Periodo: {formatBusinessDayLabel(consultedFrom)} → {formatBusinessDayLabel(consultedTo)}
            </Text>
            <View style={styles.massSelectAllRow}>
              <TouchableOpacity
                style={styles.massCheckRow}
                onPress={toggleMassAll}
                disabled={massDownloading}
              >
                <MaterialIcons
                  name={massSelectedLocals.size === locales.filter((l) => String(l.agoraCode ?? l.AgoraCode ?? '').trim()).length ? 'check-box' : 'check-box-outline-blank'}
                  size={20}
                  color={massSelectedLocals.size > 0 ? '#0ea5e9' : '#94a3b8'}
                />
                <Text style={styles.massSelectAllText}>Seleccionar todos</Text>
              </TouchableOpacity>
              <Text style={styles.massCountText}>
                {massSelectedLocals.size} de {locales.filter((l) => String(l.agoraCode ?? l.AgoraCode ?? '').trim()).length}
              </Text>
            </View>
            <ScrollView style={styles.massListScroll} nestedScrollEnabled>
              {localesOrdenados.map((loc) => {
                const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                if (!code) return null;
                const nombre = String(loc.nombre ?? loc.Nombre ?? code);
                const checked = massSelectedLocals.has(code);
                const tieneDatos = localesConDatos.has(code);
                return (
                  <TouchableOpacity
                    key={code}
                    style={styles.massCheckRow}
                    onPress={() => toggleMassLocal(code)}
                    disabled={massDownloading}
                  >
                    <MaterialIcons
                      name={checked ? 'check-box' : 'check-box-outline-blank'}
                      size={20}
                      color={checked ? '#0ea5e9' : '#cbd5e1'}
                    />
                    <Text style={[styles.massLocalName, checked && styles.massLocalNameSelected]}>
                      {nombre}
                      {!tieneDatos && <Text style={styles.massLocalHint}>  (consultará Ágora)</Text>}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {massDownloading && (
              <View style={styles.massProgressWrap}>
                <View style={styles.massProgressBarBg}>
                  <View style={[styles.massProgressBarFill, { width: `${massProgress.total > 0 ? Math.round((massProgress.current / massProgress.total) * 100) : 0}%` }]} />
                </View>
                <Text style={styles.massProgressText}>
                  {massProgress.current} / {massProgress.total}{massProgress.localName ? ` — ${massProgress.localName}` : ''}
                </Text>
              </View>
            )}
            <View style={styles.massActions}>
              <TouchableOpacity
                style={styles.massCancelBtn}
                onPress={() => !massDownloading && setShowMassDownload(false)}
                disabled={massDownloading}
              >
                <Text style={styles.massCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.massDownloadBtn, (massSelectedLocals.size === 0 || massDownloading) && styles.massDownloadBtnDisabled]}
                onPress={handleMassDownload}
                disabled={massSelectedLocals.size === 0 || massDownloading}
              >
                {massDownloading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <MaterialIcons name="download" size={16} color="#fff" />
                    <Text style={styles.massDownloadText}>
                      Descargar {massSelectedLocals.size > 0 ? `(${massSelectedLocals.size})` : ''}
                    </Text>
                  </>
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
  container: {
    flex: 1,
    padding: 10,
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' ? { overflow: 'visible' as const } : {}),
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 17, fontWeight: '600', color: '#1e293b', letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: '#64748b', fontWeight: '500' },

  queryBlock: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    position: 'relative',
    zIndex: 200,
    ...(Platform.OS === 'web' ? { overflow: 'visible' as const } : {}),
  },
  queryBlockElevated: {
    zIndex: 1000,
    ...(Platform.OS === 'web' ? { isolation: 'isolate' as const } : {}),
  },
  queryBlockTitle: { fontSize: 10, fontWeight: '700', color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  queryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', position: 'relative' },
  /** Fila con los dropdowns (Locales / Usuario): debe pintar por ENCIMA de la fila de botones. */
  queryRowFilters: { zIndex: 20 },
  /** Fila de botones de acción: por DEBAJO de los desplegables. */
  queryRowActions: { zIndex: 10 },

  contentBelow: {
    flex: 1,
    position: 'relative',
    zIndex: 1,
  },

  dateWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dateLabel: { fontSize: 11, color: '#64748b', fontWeight: '600' },
  dateInput: { backgroundColor: '#fff', borderRadius: 6, paddingVertical: 4, paddingHorizontal: 6, fontSize: 12, color: '#334155', borderWidth: StyleSheet.hairlineWidth, borderColor: '#cbd5e1', minHeight: 30, minWidth: 120 },

  builderDropdownWrap: { position: 'relative', zIndex: 210 },
  builderDropdownWrapOpen: { zIndex: 1010 },
  builderDropdownTrigger: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#fff', borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1', paddingVertical: 6, paddingHorizontal: 10, minWidth: 150, minHeight: 32 },
  builderDropdownText: { fontSize: 12, color: '#334155', fontWeight: '500', flex: 1 },
  ddOverlay: {
    position: 'fixed' as 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1005,
  },
  builderDropdownList: {
    position: 'absolute', top: '100%', left: 0, marginTop: 4,
    backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0',
    minWidth: 240, zIndex: 1010,
    elevation: 12,
    ...(Platform.OS === 'web' && { boxShadow: '0 8px 24px rgba(0,0,0,0.15)' } as object),
  },
  builderDropdownScroll: { maxHeight: 240 },
  builderDropdownScrollCompact: { maxHeight: 220 },
  builderDropdownOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 10, gap: 8 },
  builderDropdownOptionCompact: { paddingVertical: 4, paddingHorizontal: 8, gap: 6, minHeight: 26 },
  builderDropdownOptionWithCheck: { justifyContent: 'flex-start' },
  builderDropdownOptionSelected: { backgroundColor: '#f0f9ff' },
  builderDropdownOptionText: { fontSize: 12, color: '#334155' },
  builderDropdownOptionTextCompact: { fontSize: 11, lineHeight: 14 },
  builderDropdownOptionTextSelected: { color: '#0369a1', fontWeight: '600' },
  ddCheckbox: { width: 18, alignItems: 'center' },
  ddCheckboxCompact: { width: 16, alignItems: 'center', justifyContent: 'center' },
  ddDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#e2e8f0' },
  ddSearchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 5, paddingHorizontal: 8,
    backgroundColor: '#f8fafc',
  },
  ddSearchInput: {
    flex: 1,
    fontSize: 12,
    color: '#334155',
    paddingVertical: 2,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
  },
  ddSearchInputCompact: { fontSize: 11, paddingVertical: 1 },
  ddEmptyWrap: { paddingVertical: 6, paddingHorizontal: 8 },
  ddEmptyText: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic' },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' },
  searchWrap: { flex: 1, minWidth: 200, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 8, paddingHorizontal: 10 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 13, color: '#334155', ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}) },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f8fafc', borderRadius: 6, borderWidth: 1, borderColor: '#e2e8f0' },
  toolbarBtnPrimary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#0ea5e9', borderRadius: 6 },
  toolbarBtnPrimaryText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  toolbarBtnDisabled: { opacity: 0.6 },
  toolbarBtnText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  toolbarBtnActive: { backgroundColor: '#e0f2fe', borderColor: '#bae6fd' },
  toolbarBtnTextActive: { color: '#0369a1', fontWeight: '700' },
  consumoCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  consumoCheckText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  consumoCheckTextActive: { color: '#0369a1', fontWeight: '600' },
  consumoBadge: {
    alignSelf: 'flex-start',
    paddingVertical: 1,
    paddingHorizontal: 6,
    backgroundColor: '#f0f9ff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  consumoBadgeText: {
    fontSize: 9.5,
    color: '#0369a1',
    fontWeight: '400',
    letterSpacing: 0.3,
  },

  kpisRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 },
  kpiCard: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, minWidth: 140 },
  kpiCardActive: { borderWidth: 2, ...(Platform.OS === 'web' && { boxShadow: '0 0 0 2px rgba(14,165,233,0.4)' } as object) },
  kpiLabel: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, lineHeight: 12 },
  kpiValue: { fontSize: 15, fontWeight: '700', marginTop: 2, lineHeight: 17 },
  kpiCount: { fontSize: 9, fontWeight: '500', marginTop: 1, lineHeight: 11 },
  kpiClearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8 },
  kpiClearText: { fontSize: 11, color: '#64748b', fontWeight: '500' },

  cacheBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#f0f9ff', borderRadius: 10, borderWidth: 1, borderColor: '#bae6fd' },
  cacheBadgeText: { fontSize: 10, color: '#0369a1', fontWeight: '600' },
  cacheBadgeTextCached: { color: '#92400e' },

  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 },
  infoLine: { fontSize: 11, color: '#64748b', flex: 1 },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pageBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f8fafc', borderRadius: 8 },
  pageBtnDisabled: { opacity: 0.5 },
  pageBtnText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  pageBtnTextDisabled: { color: '#94a3b8' },
  pageInfo: { fontSize: 12, color: '#64748b', fontWeight: '500' },

  tableScroll: { flex: 1, backgroundColor: '#fff', zIndex: 1 },
  tableWrapper: { flex: 1, flexDirection: 'column' },
  tableInner: { flex: 1, backgroundColor: '#fff' },
  table: { paddingBottom: 24, backgroundColor: '#fff' },
  headerRowTable: { flexDirection: 'row', backgroundColor: '#f8fafc', borderBottomWidth: 1, borderColor: '#e2e8f0' },
  sumRowTable: {
    flexDirection: 'row',
    backgroundColor: '#eff6ff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#dbeafe',
  },
  sumRowTableChild: {
    backgroundColor: '#f0f9ff',
    borderLeftWidth: 3,
    borderLeftColor: '#bae6fd',
  },
  sumCell: { paddingVertical: 3 },
  sumLabelText: { fontSize: 9, fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 },
  sumCellText: { fontSize: 10, fontWeight: '700', color: '#0369a1' },
  dataRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#f1f5f9' },
  cellHeader: {
    paddingHorizontal: 6, paddingVertical: 6,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' as unknown as 'default' } : {}),
  },
  cellHeaderActive: { backgroundColor: '#e0f2fe' },
  cellHeaderTextActive: { color: '#0369a1', fontWeight: '700' },
  cell: { paddingHorizontal: 6, paddingVertical: 5, justifyContent: 'center' },
  cellRight: { alignItems: 'flex-end' },
  cellHeaderText: { fontSize: 10, fontWeight: '600', color: '#475569', letterSpacing: 0.2 },
  cellText: { fontSize: 10, color: '#334155', letterSpacing: 0.1 },
  cellBold: { fontWeight: '700' },
  cellNegative: { color: '#b91c1c' },
  typeBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6, borderWidth: 1, alignSelf: 'flex-start' },
  typeBadgeText: { fontSize: 9, fontWeight: '600', lineHeight: 11 },
  motivoBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6, borderWidth: 1, alignSelf: 'flex-start', maxWidth: '100%' },
  motivoBadgeText: { fontSize: 9, fontWeight: '600', lineHeight: 11 },

  // Agrupación
  groupRow: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderColor: '#cbd5e1',
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' as unknown as 'default' } : {}),
  },
  expandBtn: {
    width: 18, height: 18,
    borderRadius: 4,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupUserText: { fontSize: 11, fontWeight: '700', color: '#0f172a', flex: 1 },
  groupCountChip: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0369a1',
    backgroundColor: '#e0f2fe',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },
  groupBadgeText: { fontSize: 10, fontWeight: '600' },
  groupTotalText: { fontSize: 11, fontWeight: '700', color: '#0f172a' },
  childHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#e2e8f0',
  },
  childHeaderCell: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  childHeaderText: { fontSize: 9, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3 },
  childRow: {
    backgroundColor: '#fcfdff',
    borderLeftWidth: 3,
    borderLeftColor: '#bae6fd',
  },

  emptyRow: { padding: 24, alignItems: 'center' },
  emptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 13, color: '#64748b' },
  errorWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  errorText: { fontSize: 13, color: '#dc2626', textAlign: 'center' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10 },
  retryBtnText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },

  // Menú Descarga
  shareOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  shareMenuOuter: {
    maxWidth: '92%',
    maxHeight: '85%',
  },
  shareMenu: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 8,
    minWidth: 300,
    maxHeight: '100%',
    ...(Platform.OS === 'web' && { boxShadow: '0 10px 30px rgba(0,0,0,0.2)' } as object),
  },
  shareMenuScroll: {
    maxHeight: 320,
  },
  shareMenuTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    paddingHorizontal: 14,
    paddingVertical: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  shareMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  shareMenuText: { fontSize: 13, color: '#334155', fontWeight: '500' },
  shareMenuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#e2e8f0', marginHorizontal: 14 },

  // Modal descarga masiva
  massModal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    width: 420,
    maxWidth: '90%',
    maxHeight: '80%',
    ...(Platform.OS === 'web' && { boxShadow: '0 10px 30px rgba(0,0,0,0.2)' } as object),
  },
  massTitle: { fontSize: 16, fontWeight: '700', color: '#1e293b', marginBottom: 4 },
  massSubtitle: { fontSize: 12, color: '#64748b', marginBottom: 12 },
  massSelectAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#e2e8f0',
    marginBottom: 6,
  },
  massCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
  },
  massSelectAllText: { fontSize: 12, color: '#334155', fontWeight: '600' },
  massCountText: { fontSize: 11, color: '#64748b' },
  massListScroll: { maxHeight: 260 },
  massLocalName: { fontSize: 13, color: '#334155' },
  massLocalNameSelected: { color: '#0369a1', fontWeight: '600' },
  massLocalHint: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic' },
  massProgressWrap: { marginTop: 12, gap: 6 },
  massProgressBarBg: {
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  massProgressBarFill: {
    height: '100%',
    backgroundColor: '#0ea5e9',
  },
  massProgressText: { fontSize: 11, color: '#64748b' },
  massActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  massCancelBtn: { paddingVertical: 8, paddingHorizontal: 14 },
  massCancelText: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  massDownloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: '#0ea5e9',
    borderRadius: 6,
  },
  massDownloadBtnDisabled: { opacity: 0.5 },
  massDownloadText: { fontSize: 13, color: '#fff', fontWeight: '600' },
});
