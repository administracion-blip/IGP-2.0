import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  PanResponder,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

const PAYMENT_KEYS = ['InvoicePayments', 'TicketPayments', 'DeliveryNotePayments', 'SalesOrderPayments'];
const DEFAULT_COL_WIDTH = 100;
const REFETCH_INTERVAL_MS = 15_000; // GET a DynamoDB cada 15 s (barato, tabla actualizada)
const SYNC_INTERVAL_MS = 60_000;   // POST sync Agora → DynamoDB cada 1 min (trae registros nuevos)

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Convierte YYYY-MM-DD a DD/MM/YYYY (europeo). */
function dateToDDMMYYYY(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Parsea DD/MM/YYYY o D/M/YYYY a YYYY-MM-DD; devuelve '' si no es válido. */
function parseDDMMYYYY(s: string): string {
  const t = s.trim().replace(/\s/g, '');
  const parts = t.split(/[/.-]/);
  if (parts.length !== 3) return '';
  const d = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const y = parseInt(parts[2], 10);
  if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(y)) return '';
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return '';
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/** Genera los días a mostrar en un mes (incluye celdas vacías al inicio). */
function getCalendarDays(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startWeekday = first.getDay();
  const daysInMonth = last.getDate();
  const out: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) out.push(null);
  for (let d = 1; d <= daysInMonth; d++) out.push(d);
  return out;
}

function getBusinessDay(item: CloseOut): string {
  const v = item.BusinessDay ?? item.businessDay;
  if (v != null && String(v).trim()) return String(v).trim();
  const sk = item.SK ?? item.sk;
  if (typeof sk === 'string' && sk.includes('#')) return sk.split('#')[0];
  return '';
}

function getMesFromBusinessDay(item: CloseOut): string {
  const bd = getBusinessDay(item);
  if (!bd || !/^\d{4}-\d{2}-\d{2}$/.test(bd)) return '—';
  const d = new Date(bd + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return MESES[d.getMonth()] ?? '—';
}

function getAnioFromBusinessDay(item: CloseOut): string {
  const bd = getBusinessDay(item);
  if (!bd || !/^\d{4}-\d{2}-\d{2}$/.test(bd)) return '—';
  const d = new Date(bd + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return String(d.getFullYear());
}

function getDiaSemanaFromBusinessDay(item: CloseOut): string {
  const bd = getBusinessDay(item);
  if (!bd || !/^\d{4}-\d{2}-\d{2}$/.test(bd)) return '—';
  const d = new Date(bd + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return DIAS_SEMANA[d.getDay()] ?? '—';
}

const MIN_COL_WIDTH = 50;
const MAX_COL_WIDTH = 400;
const PAGE_SIZE = 50;

const KNOWN_PAYMENT_ORDER = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];
const BASE_COLUMNAS_BEFORE_PAYMENT = ['BusinessDay', 'PK', 'Local', 'Number', 'TotalFacturado'];
const BASE_COLUMNAS_AFTER_PAYMENT = ['Mes', 'Año', 'DiaSemana', 'OpenDate', 'CloseDate', 'SK'];
const FIXED_NON_PAYMENT_COLUMNAS = [...BASE_COLUMNAS_BEFORE_PAYMENT, ...BASE_COLUMNAS_AFTER_PAYMENT]; // incluye 'Local'

function getUniquePaymentMethods(items: CloseOut[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    for (const key of PAYMENT_KEYS) {
      const arr = item[key as keyof CloseOut];
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        const name = (p?.MethodName ?? (p as { methodName?: string }).methodName ?? '').toString().trim() || 'Sin nombre';
        set.add(name);
      }
    }
  }
  const knownFirst = KNOWN_PAYMENT_ORDER.filter((m) => set.has(m));
  const others = Array.from(set).filter((m) => !KNOWN_PAYMENT_ORDER.includes(m)).sort();
  return [...knownFirst, ...others];
}

const TOTALES_CHIP_COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#e9d5ff', '#ccfbf1', '#fce7f3', '#fed7aa', '#ddd6fe'];

type CloseOut = Record<string, unknown>;

function getAmounts(item: CloseOut): Record<string, unknown> | undefined {
  const a = item.Amounts ?? item.amounts;
  if (a != null && typeof a === 'object') return a as Record<string, unknown>;
  return undefined;
}

function getValorFromAmounts(amounts: Record<string, unknown> | undefined, key: string): string {
  if (!amounts) return '—';
  const v = amounts[key] ?? amounts[key.toLowerCase()] ?? amounts[key.toUpperCase()];
  return v != null && v !== '' ? String(v) : '—';
}

function getAmountForMethod(item: CloseOut, methodName: string): string {
  let total = 0;
  for (const key of PAYMENT_KEYS) {
    const arr = item[key as keyof CloseOut];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const name = (p?.MethodName ?? (p as { methodName?: string }).methodName ?? '').toString().trim() || 'Sin nombre';
      if (name === methodName) total += Number(p?.Amount ?? (p as { amount?: number }).amount ?? 0) || 0;
    }
  }
  return total ? total.toFixed(2) : '—';
}

function getValorCelda(item: CloseOut, col: string, agoraCodeToNombre?: Record<string, string>): string {
  if (col === 'Local' && agoraCodeToNombre) {
    const pk = String(item.PK ?? item.pk ?? '').trim();
    return agoraCodeToNombre[pk] ?? '—';
  }
  if (col === 'TotalFacturado') {
    return formatMoneda(getValorFromAmounts(getAmounts(item), 'GrossAmount'));
  }
  if (!FIXED_NON_PAYMENT_COLUMNAS.includes(col)) {
    return formatMoneda(getAmountForMethod(item, col));
  }
  if (col === 'Mes') return getMesFromBusinessDay(item);
  if (col === 'Año') return getAnioFromBusinessDay(item);
  if (col === 'DiaSemana') return getDiaSemanaFromBusinessDay(item);
  const v = item[col] ?? (item as Record<string, unknown>)[col.toLowerCase()];
  return v != null && v !== '' ? String(v) : '—';
}

function getHeaderLabel(col: string): string {
  return col === 'PK' ? 'AgoraID' : col === 'Local' ? 'Local' : col === 'TotalFacturado' ? 'Total facturado' : col === 'BusinessDay' ? 'Business Day' : col === 'DiaSemana' ? 'Día' : col;
}

function parseNum(s: string): number {
  if (!s || s === '—') return 0;
  const n = parseFloat(String(s).replace(',', '.').replace(/\s/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

/** Formato moneda europeo: 1.234,56 €. Si no es número, devuelve "—". */
function formatMoneda(value: string | number): string {
  if (value === '' || value === '—' || value == null) return '—';
  const n = typeof value === 'number' ? value : parseNum(String(value));
  if (n === 0) return '—';
  const parts = n.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

const CHAR_WIDTH_ESTIMATE = 6;
const CELL_PADDING_X = 12;

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

export default function CierresTeoricosScreen() {
  const router = useRouter();
  const [closeouts, setCloseouts] = useState<CloseOut[]>([]);
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [modalSyncVisible, setModalSyncVisible] = useState(false);
  const [businessDaySync, setBusinessDaySync] = useState('');
  const [businessDaySyncTo, setBusinessDaySyncTo] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [modalFiltrosVisible, setModalFiltrosVisible] = useState(false);
  const [filterLocals, setFilterLocals] = useState<string[]>([]);
  const [filterBusinessDayFrom, setFilterBusinessDayFrom] = useState('');
  const [filterBusinessDayTo, setFilterBusinessDayTo] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [displayDateFrom, setDisplayDateFrom] = useState('');
  const [displayDateTo, setDisplayDateTo] = useState('');
  const [calendarFor, setCalendarFor] = useState<'from' | 'to' | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [anoDropdownOpen, setAnoDropdownOpen] = useState(false);
  const [mesDropdownOpen, setMesDropdownOpen] = useState(false);
  const resizeStartWidth = useRef(0);
  const resizeCol = useRef<string | null>(null);

  const refetchCloseouts = useCallback((silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    fetch(`${API_URL}/api/agora/closeouts`)
      .then((res) => res.json())
      .then((data: { closeouts?: CloseOut[]; error?: string }) => {
        if (data.error) {
          if (!silent) setError(data.error);
          setCloseouts([]);
        } else {
          setCloseouts(Array.isArray(data.closeouts) ? data.closeouts : []);
        }
      })
      .catch((e) => {
        if (!silent) setError(e.message || 'Error de conexión');
        setCloseouts([]);
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, []);

  useEffect(() => {
    refetchCloseouts();
  }, [refetchCloseouts]);

  // Sincronizar el día actual en segundo plano al abrir la pantalla (así se ven cierres sin pulsar "Sincronizar")
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    fetch(`${API_URL}/api/agora/closeouts/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessDay: today }),
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean }) => {
        if (data.ok) refetchCloseouts(true);
      })
      .catch(() => {});
  }, [refetchCloseouts]);

  // GET frecuente: refrescar tabla desde DynamoDB cada 15 s (barato)
  useEffect(() => {
    const id = setInterval(() => refetchCloseouts(true), REFETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refetchCloseouts]);

  // Sync periódico: cada minuto traer de Agora el día actual y grabar en DynamoDB, luego refetch
  useEffect(() => {
    const runSync = () => {
      const today = new Date().toISOString().slice(0, 10);
      fetch(`${API_URL}/api/agora/closeouts/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessDay: today }),
      })
        .then((res) => res.json())
        .then((data: { ok?: boolean }) => {
          if (data.ok) refetchCloseouts(true);
        })
        .catch(() => {});
    };
    const id = setInterval(runSync, SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refetchCloseouts]);

  useEffect(() => {
    fetch(`${API_URL}/api/locales`)
      .then((res) => res.json())
      .then((data: { locales?: LocalItem[] }) => {
        setLocales(data.locales || []);
      })
      .catch(() => setLocales([]));
  }, []);

  const agoraCodeToNombreMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) map[code] = nombre || '—';
    }
    return map;
  }, [locales]);

  const paymentColumnas = useMemo(() => getUniquePaymentMethods(closeouts), [closeouts]);
  const columnas = useMemo(
    () => [...BASE_COLUMNAS_BEFORE_PAYMENT, ...paymentColumnas, ...BASE_COLUMNAS_AFTER_PAYMENT],
    [paymentColumnas]
  );

  const localesUnicos = useMemo(() => {
    const set = new Set<string>();
    closeouts.forEach((item) => {
      const pk = item.PK ?? item.pk;
      if (pk != null && String(pk).trim()) set.add(String(pk).trim());
    });
    return Array.from(set).sort();
  }, [closeouts]);

  const anosUnicos = useMemo(() => {
    const set = new Set<string>();
    closeouts.forEach((item) => {
      const bd = getBusinessDay(item);
      if (bd.length >= 4) set.add(bd.slice(0, 4));
    });
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [closeouts]);

  useEffect(() => {
    if (modalFiltrosVisible) {
      setDisplayDateFrom(dateToDDMMYYYY(filterBusinessDayFrom));
      setDisplayDateTo(dateToDDMMYYYY(filterBusinessDayTo));
    }
  }, [modalFiltrosVisible, filterBusinessDayFrom, filterBusinessDayTo]);

  const closeoutsFiltrados = useMemo(() => {
    let list = closeouts;
    if (filterLocals.length > 0) {
      const set = new Set(filterLocals);
      list = list.filter((item) => set.has(String(item.PK ?? item.pk ?? '').trim()));
    }
    if (filterYear) {
      list = list.filter((item) => getBusinessDay(item).slice(0, 4) === filterYear);
    }
    if (filterMonth) {
      list = list.filter((item) => getBusinessDay(item).slice(5, 7) === filterMonth);
    }
    if (filterBusinessDayFrom.trim() && /^\d{4}-\d{2}-\d{2}$/.test(filterBusinessDayFrom.trim())) {
      const from = filterBusinessDayFrom.trim();
      list = list.filter((item) => getBusinessDay(item).localeCompare(from) >= 0);
    }
    if (filterBusinessDayTo.trim() && /^\d{4}-\d{2}-\d{2}$/.test(filterBusinessDayTo.trim())) {
      const to = filterBusinessDayTo.trim();
      list = list.filter((item) => getBusinessDay(item).localeCompare(to) <= 0);
    }
    const q = filtroBusqueda.trim().toLowerCase();
    if (q) {
      list = list.filter((item) =>
        columnas.some((col) => {
          const val = getValorCelda(item, col, agoraCodeToNombreMap);
          return val !== '—' && val.toLowerCase().includes(q);
        })
      );
    }
    return list.sort((a, b) => getBusinessDay(b).localeCompare(getBusinessDay(a)));
  }, [closeouts, filtroBusqueda, filterLocals, filterYear, filterMonth, filterBusinessDayFrom, filterBusinessDayTo, columnas, agoraCodeToNombreMap]);

  const textoFiltrosActivos = useMemo(() => {
    const partes: string[] = [];
    if (filterLocals.length > 0) {
      partes.push(`Local: ${filterLocals.length === 1 ? filterLocals[0] : filterLocals.join(', ')}`);
    }
    if (filterYear) partes.push(`Año: ${filterYear}`);
    if (filterMonth) partes.push(`Mes: ${MESES[parseInt(filterMonth, 10) - 1] ?? filterMonth}`);
    if (filterBusinessDayFrom.trim() && /^\d{4}-\d{2}-\d{2}$/.test(filterBusinessDayFrom.trim())) {
      partes.push(`Desde: ${dateToDDMMYYYY(filterBusinessDayFrom)}`);
    }
    if (filterBusinessDayTo.trim() && /^\d{4}-\d{2}-\d{2}$/.test(filterBusinessDayTo.trim())) {
      partes.push(`Hasta: ${dateToDDMMYYYY(filterBusinessDayTo)}`);
    }
    return partes.length > 0 ? partes.join(' · ') : 'Sin filtros aplicados';
  }, [filterLocals, filterYear, filterMonth, filterBusinessDayFrom, filterBusinessDayTo]);

  const totalesFiltrados = useMemo(() => {
    let totalFacturado = 0;
    const formasPago: Record<string, number> = {};
    paymentColumnas.forEach((col) => { formasPago[col] = 0; });
    for (const item of closeoutsFiltrados) {
      totalFacturado += parseNum(getValorFromAmounts(getAmounts(item), 'GrossAmount'));
      paymentColumnas.forEach((col) => {
        formasPago[col] += parseNum(getAmountForMethod(item, col));
      });
    }
    return { totalFacturado, formasPago };
  }, [closeoutsFiltrados, paymentColumnas]);

  const totalPages = Math.max(1, Math.ceil(closeoutsFiltrados.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const closeoutsPaginated = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return closeoutsFiltrados.slice(start, start + PAGE_SIZE);
  }, [closeoutsFiltrados, safePage]);

  const contentBasedWidths = useMemo(() => {
    const out: Record<string, number> = {};
    for (const col of columnas) {
      const headerLen = getHeaderLabel(col).length;
      let maxLen = headerLen;
      for (const item of closeoutsPaginated) {
        const val = getValorCelda(item, col, agoraCodeToNombreMap);
        if (val.length > maxLen) maxLen = val.length;
      }
      const w = CELL_PADDING_X + maxLen * CHAR_WIDTH_ESTIMATE;
      out[col] = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, w));
    }
    return out;
  }, [closeoutsPaginated, columnas, agoraCodeToNombreMap]);

  const getColWidth = useCallback((col: string): number => {
    if (colWidths[col] != null) return colWidths[col];
    return contentBasedWidths[col] ?? DEFAULT_COL_WIDTH;
  }, [colWidths, contentBasedWidths]);

  const tableMinWidth = useMemo(
    () => columnas.reduce((sum, col) => sum + (colWidths[col] ?? contentBasedWidths[col] ?? DEFAULT_COL_WIDTH), 0),
    [colWidths, contentBasedWidths, columnas]
  );

  const createResizePanResponder = useCallback((col: string) => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        resizeCol.current = col;
        resizeStartWidth.current = colWidths[col] ?? contentBasedWidths[col] ?? DEFAULT_COL_WIDTH;
      },
      onPanResponderMove: (_, gestureState) => {
        if (resizeCol.current === null) return;
        const w = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, resizeStartWidth.current + gestureState.dx));
        setColWidths((prev) => ({ ...prev, [resizeCol.current!]: w }));
      },
      onPanResponderRelease: () => {
        resizeCol.current = null;
      },
    });
  }, [colWidths, contentBasedWidths]);

  const resizePanResponders = useMemo(
    () => Object.fromEntries(columnas.map((col) => [col, createResizePanResponder(col)])),
    [createResizePanResponder, columnas]
  );

  useEffect(() => {
    setCurrentPage((p) => (p > totalPages ? totalPages : p));
  }, [totalPages]);

  const abrirModalSync = () => {
    setModalSyncVisible(true);
    setSyncMessage(null);
    setSyncError(null);
    const today = new Date().toISOString().slice(0, 10);
    setBusinessDaySync(today);
  };

  const cerrarModalSync = () => {
    setModalSyncVisible(false);
    setSyncMessage(null);
    setSyncError(null);
    setSyncProgress(null);
  };

  /** Devuelve fechas YYYY-MM-DD entre desde y hasta (inclusive). */
  const getDaysInRange = useCallback((desde: string, hasta: string): string[] => {
    const d = new Date(desde + 'T12:00:00');
    const h = new Date(hasta + 'T12:00:00');
    if (d.getTime() > h.getTime()) return [];
    const out: string[] = [];
    const cur = new Date(d);
    while (cur.getTime() <= h.getTime()) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, []);

  const ejecutarSync = async () => {
    const day = businessDaySync.trim();
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      setSyncError('Introduce al menos la fecha inicial (YYYY-MM-DD)');
      return;
    }
    const dayTo = businessDaySyncTo.trim();
    const isRange = dayTo && /^\d{4}-\d{2}-\d{2}$/.test(dayTo);
    const days = isRange ? getDaysInRange(day, dayTo) : [day];
    if (days.length === 0) {
      setSyncError('La fecha "Hasta" debe ser igual o posterior a "Desde".');
      return;
    }
    if (days.length > 365) {
      setSyncError('El rango no puede superar 365 días.');
      return;
    }
    setSyncError(null);
    setSyncMessage(null);
    setSyncing(true);
    let totalFetched = 0;
    let totalUpserted = 0;
    try {
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        setSyncProgress(days.length > 1 ? `Sincronizando ${d} (${i + 1}/${days.length})…` : null);
        const res = await fetch(`${API_URL}/api/agora/closeouts/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessDay: d }),
        });
        const data = await res.json();
        if (!res.ok) {
          setSyncError(data.error || `Error al sincronizar ${d}`);
          return;
        }
        totalFetched += data.fetched ?? 0;
        totalUpserted += data.upserted ?? 0;
      }
      setSyncProgress(null);
      setSyncMessage(
        days.length > 1
          ? `${days.length} días sincronizados. Total: ${totalFetched} obtenidos, ${totalUpserted} guardados.`
          : `Sincronizados: ${totalFetched} obtenidos, ${totalUpserted} guardados.`
      );
      refetchCloseouts(true);
    } catch (e) {
      setSyncProgress(null);
      setSyncError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setSyncing(false);
    }
  };

  if (loading && closeouts.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando cierres teóricos…</Text>
      </View>
    );
  }

  if (error && closeouts.length === 0) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color="#f87171" />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetchCloseouts()}>
          <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          <Text style={styles.retryBtnText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Cierres teóricos</Text>
      </View>

      <View style={styles.toolbarRow}>
        <TouchableOpacity
          style={styles.syncBtn}
          onPress={abrirModalSync}
          accessibilityLabel="Sincronizar cierres desde Ágora"
        >
          <MaterialIcons name="sync" size={20} color="#0ea5e9" />
          <Text style={styles.syncBtnText}>Sincronizar cierres</Text>
        </TouchableOpacity>
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
        <TouchableOpacity
          style={styles.syncBtn}
          onPress={() => setModalFiltrosVisible(true)}
          accessibilityLabel="Filtros"
        >
          <MaterialIcons name="filter-list" size={20} color="#0ea5e9" />
          <Text style={styles.syncBtnText}>Filtros</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.filtrosActivosLine}>{textoFiltrosActivos}</Text>

      {closeoutsFiltrados.length > 0 ? (
        <View style={styles.totalesRow}>
          <View style={[styles.totalesChip, styles.totalesChipTotal]}>
            <Text style={styles.totalesChipTotalLabel}>Total facturado</Text>
            <Text style={styles.totalesChipTotalValue}>{formatMoneda(totalesFiltrados.totalFacturado)}</Text>
          </View>
          {paymentColumnas.map((col, idx) => (
            <View key={col} style={[styles.totalesChip, { backgroundColor: TOTALES_CHIP_COLORS[idx % TOTALES_CHIP_COLORS.length] }]}>
              <Text style={styles.totalesChipLabel}>{col}</Text>
              <Text style={styles.totalesChipValue}>{formatMoneda(totalesFiltrados.formasPago[col] ?? 0)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={styles.subtitle}>
        {closeoutsFiltrados.length === 0
          ? '0 cierres'
          : `${closeoutsFiltrados.length} cierre${closeoutsFiltrados.length !== 1 ? 's' : ''}`}
        {closeoutsFiltrados.length > 0 && (
          <Text style={styles.subtitlePage}> · Página {safePage} de {totalPages}</Text>
        )}
      </Text>

      <View style={styles.tableWrap}>
        <ScrollView horizontal style={styles.scroll} contentContainerStyle={[styles.scrollContent, { minWidth: tableMinWidth }]} showsHorizontalScrollIndicator>
          <View style={[styles.table, { minWidth: tableMinWidth }]}>
            <View style={styles.rowHeader}>
              {columnas.map((col, colIdx) => {
                const isMonedaCol = col === 'TotalFacturado' || paymentColumnas.includes(col);
                return (
                <View
                  key={col}
                  style={[
                    styles.cellHeader,
                    { width: getColWidth(col) },
                    colIdx === columnas.length - 1 && styles.cellLast,
                    isMonedaCol && styles.cellHeaderRight,
                  ]}
                >
                  <Text style={[styles.cellHeaderText, col === 'TotalFacturado' && styles.cellHeaderTextBold, isMonedaCol && styles.cellHeaderTextRight]} numberOfLines={1} ellipsizeMode="tail">
                    {getHeaderLabel(col)}
                  </Text>
                  {colIdx < columnas.length - 1 ? (
                    <View
                      style={styles.resizeHandle}
                      {...(resizePanResponders[col]?.panHandlers ?? {})}
                    />
                  ) : null}
                </View>
              );})}
            </View>
            {closeoutsFiltrados.length === 0 ? (
              <View style={[styles.row, styles.rowEmpty, { minWidth: tableMinWidth }]}>
                <View style={[styles.cellEmpty, { width: tableMinWidth }]}>
                  <Text style={styles.cellEmptyText}>
                    {closeouts.length === 0
                      ? 'No hay cierres. Usa "Sincronizar cierres" para importar desde Ágora.'
                      : 'Ningún resultado con el filtro'}
                  </Text>
                </View>
              </View>
            ) : (
              closeoutsPaginated.map((item, idx) => (
                <View key={`${item.PK}-${item.SK}-${idx}`} style={styles.row}>
                  {columnas.map((col, colIdx) => {
                    const isMonedaCol = col === 'TotalFacturado' || paymentColumnas.includes(col);
                    return (
                    <View
                      key={col}
                      style={[
                        styles.cell,
                        { width: getColWidth(col) },
                        colIdx === columnas.length - 1 && styles.cellLast,
                        isMonedaCol && styles.cellRight,
                      ]}
                    >
                      <Text style={[styles.cellText, col === 'TotalFacturado' && styles.cellTextBold, isMonedaCol && styles.cellTextRight]} numberOfLines={1} ellipsizeMode="tail">
                        {getValorCelda(item, col, agoraCodeToNombreMap)}
                      </Text>
                    </View>
                  );})}
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </View>

      {closeoutsFiltrados.length > PAGE_SIZE ? (
        <View style={styles.paginationRow}>
          <TouchableOpacity
            style={[styles.pageBtn, safePage <= 1 && styles.pageBtnDisabled]}
            onPress={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
          >
            <MaterialIcons name="chevron-left" size={20} color={safePage <= 1 ? '#94a3b8' : '#334155'} />
            <Text style={[styles.pageBtnText, safePage <= 1 && styles.pageBtnTextDisabled]}>Anterior</Text>
          </TouchableOpacity>
          <Text style={styles.pageInfo}>
            {(safePage - 1) * PAGE_SIZE + 1}-{Math.min(safePage * PAGE_SIZE, closeoutsFiltrados.length)} de {closeoutsFiltrados.length}
          </Text>
          <TouchableOpacity
            style={[styles.pageBtn, safePage >= totalPages && styles.pageBtnDisabled]}
            onPress={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
          >
            <Text style={[styles.pageBtnText, safePage >= totalPages && styles.pageBtnTextDisabled]}>Siguiente</Text>
            <MaterialIcons name="chevron-right" size={20} color={safePage >= totalPages ? '#94a3b8' : '#334155'} />
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal visible={modalFiltrosVisible} transparent animationType="fade" onRequestClose={() => { setModalFiltrosVisible(false); setLocalDropdownOpen(false); }}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Filtros</Text>
                <TouchableOpacity
                  onPress={() => {
                    setModalFiltrosVisible(false);
                    setLocalDropdownOpen(false);
                  }}
                  style={styles.modalClose}
                >
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalBody}>
                <Text style={styles.formLabel}>Local (selección múltiple)</Text>
                <TouchableOpacity
                  style={styles.dropdownTrigger}
                  onPress={() => setLocalDropdownOpen((v) => !v)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.dropdownTriggerText} numberOfLines={1}>
                    {filterLocals.length === 0
                      ? 'Todos los locales'
                      : filterLocals.length === 1
                        ? filterLocals[0]
                        : `${filterLocals.length} locales seleccionados`}
                  </Text>
                  <MaterialIcons name={localDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
                </TouchableOpacity>
                {localDropdownOpen ? (
                  <View style={styles.dropdownList}>
                    <ScrollView style={styles.filterLocalsScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                      {localesUnicos.map((pk) => {
                        const selected = filterLocals.includes(pk);
                        return (
                          <TouchableOpacity
                            key={pk}
                            style={[styles.filterLocalItem, selected && styles.filterLocalItemSelected]}
                            onPress={() => setFilterLocals((prev) => (selected ? prev.filter((x) => x !== pk) : [...prev, pk]))}
                          >
                            <MaterialIcons name={selected ? 'check-box' : 'check-box-outline-blank'} size={20} color={selected ? '#0ea5e9' : '#94a3b8'} />
                            <Text style={styles.filterLocalText}>{pk}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                ) : null}
                <Text style={styles.formLabel}>Filtrar por año</Text>
                <TouchableOpacity style={styles.dropdownTrigger} onPress={() => setAnoDropdownOpen((v) => !v)} activeOpacity={0.7}>
                  <Text style={styles.dropdownTriggerText}>{filterYear || 'Todos los años'}</Text>
                  <MaterialIcons name={anoDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
                </TouchableOpacity>
                {anoDropdownOpen ? (
                  <View style={styles.dropdownList}>
                    <ScrollView style={styles.filterLocalsScroll} nestedScrollEnabled>
                      <TouchableOpacity style={styles.filterLocalItem} onPress={() => { setFilterYear(''); setAnoDropdownOpen(false); }}>
                        <Text style={styles.filterLocalText}>Todos los años</Text>
                      </TouchableOpacity>
                      {anosUnicos.map((y) => (
                        <TouchableOpacity key={y} style={[styles.filterLocalItem, filterYear === y && styles.filterLocalItemSelected]} onPress={() => { setFilterYear(y); setAnoDropdownOpen(false); }}>
                          <Text style={styles.filterLocalText}>{y}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                ) : null}
                <Text style={styles.formLabel}>Filtrar por mes</Text>
                <TouchableOpacity style={styles.dropdownTrigger} onPress={() => setMesDropdownOpen((v) => !v)} activeOpacity={0.7}>
                  <Text style={styles.dropdownTriggerText}>
                    {filterMonth ? MESES[parseInt(filterMonth, 10) - 1] : 'Todos los meses'}
                  </Text>
                  <MaterialIcons name={mesDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color="#64748b" />
                </TouchableOpacity>
                {mesDropdownOpen ? (
                  <View style={styles.dropdownList}>
                    <ScrollView style={styles.filterLocalsScroll} nestedScrollEnabled>
                      <TouchableOpacity style={[styles.filterLocalItem, !filterMonth && styles.filterLocalItemSelected]} onPress={() => { setFilterMonth(''); setMesDropdownOpen(false); }}>
                        <Text style={styles.filterLocalText}>Todos los meses</Text>
                      </TouchableOpacity>
                      {MESES.map((nombre, i) => {
                        const val = String(i + 1).padStart(2, '0');
                        const sel = filterMonth === val;
                        return (
                          <TouchableOpacity key={val} style={[styles.filterLocalItem, sel && styles.filterLocalItemSelected]} onPress={() => { setFilterMonth(val); setMesDropdownOpen(false); }}>
                            <Text style={styles.filterLocalText}>{nombre}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
                ) : null}
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Desde (DD/MM/YYYY)</Text>
                  <View style={styles.dateInputRow}>
                    <TextInput
                      style={styles.formInputFlex}
                      value={displayDateFrom}
                      onChangeText={(t) => {
                        setDisplayDateFrom(t);
                        const parsed = parseDDMMYYYY(t);
                        if (parsed) setFilterBusinessDayFrom(parsed);
                      }}
                      placeholder="dd/mm/aaaa"
                      placeholderTextColor="#94a3b8"
                    />
                    <TouchableOpacity style={styles.calendarBtn} onPress={() => { setCalendarFor('from'); setCalendarMonth(filterBusinessDayFrom ? new Date(filterBusinessDayFrom + 'T12:00:00') : new Date()); }}>
                      <MaterialIcons name="calendar-today" size={22} color="#0ea5e9" />
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Hasta (DD/MM/YYYY)</Text>
                  <View style={styles.dateInputRow}>
                    <TextInput
                      style={styles.formInputFlex}
                      value={displayDateTo}
                      onChangeText={(t) => {
                        setDisplayDateTo(t);
                        const parsed = parseDDMMYYYY(t);
                        if (parsed) setFilterBusinessDayTo(parsed);
                      }}
                      placeholder="dd/mm/aaaa"
                      placeholderTextColor="#94a3b8"
                    />
                    <TouchableOpacity style={styles.calendarBtn} onPress={() => { setCalendarFor('to'); setCalendarMonth(filterBusinessDayTo ? new Date(filterBusinessDayTo + 'T12:00:00') : new Date()); }}>
                      <MaterialIcons name="calendar-today" size={22} color="#0ea5e9" />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={[styles.modalFooterBtn, styles.modalFooterBtnSecondary]}
                  onPress={() => {
                    setFilterLocals([]);
                    setFilterBusinessDayFrom('');
                    setFilterBusinessDayTo('');
                    setFilterYear('');
                    setFilterMonth('');
                    setDisplayDateFrom('');
                    setDisplayDateTo('');
                    setCurrentPage(1);
                    setLocalDropdownOpen(false);
                    setAnoDropdownOpen(false);
                    setMesDropdownOpen(false);
                    setCalendarFor(null);
                    setModalFiltrosVisible(false);
                  }}
                >
                  <Text style={styles.modalFooterBtnTextSecondary}>Limpiar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalFooterBtn}
                  onPress={() => {
                    const from = parseDDMMYYYY(displayDateFrom);
                    const to = parseDDMMYYYY(displayDateTo);
                    if (from) setFilterBusinessDayFrom(from);
                    if (to) setFilterBusinessDayTo(to);
                    setCurrentPage(1);
                    setLocalDropdownOpen(false);
                    setAnoDropdownOpen(false);
                    setMesDropdownOpen(false);
                    setModalFiltrosVisible(false);
                  }}
                >
                  <Text style={styles.modalFooterBtnText}>Aplicar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={calendarFor !== null} transparent animationType="fade" onRequestClose={() => setCalendarFor(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setCalendarFor(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.calendarModalWrap}>
            <View style={styles.calendarCard}>
              <View style={styles.calendarHeader}>
                <TouchableOpacity onPress={() => setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>
                  <MaterialIcons name="chevron-left" size={28} color="#334155" />
                </TouchableOpacity>
                <Text style={styles.calendarTitle}>{MESES[calendarMonth.getMonth()]} {calendarMonth.getFullYear()}</Text>
                <TouchableOpacity onPress={() => setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>
                  <MaterialIcons name="chevron-right" size={28} color="#334155" />
                </TouchableOpacity>
              </View>
              <View style={styles.calendarWeekdays}>
                {['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'].map((d) => (
                  <Text key={d} style={styles.calendarWeekday}>{d}</Text>
                ))}
              </View>
              <View style={styles.calendarGrid}>
                {getCalendarDays(calendarMonth.getFullYear(), calendarMonth.getMonth()).map((day, i) => {
                  if (day === null) return <View key={`e-${i}`} style={styles.calendarDay} />;
                  const iso = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  return (
                    <TouchableOpacity
                      key={iso}
                      style={styles.calendarDay}
                      onPress={() => {
                        if (calendarFor === 'from') {
                          setFilterBusinessDayFrom(iso);
                          setDisplayDateFrom(dateToDDMMYYYY(iso));
                        } else {
                          setFilterBusinessDayTo(iso);
                          setDisplayDateTo(dateToDDMMYYYY(iso));
                        }
                        setCalendarFor(null);
                      }}
                    >
                      <Text style={styles.calendarDayText}>{day}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal visible={modalSyncVisible} transparent animationType="fade" onRequestClose={cerrarModalSync}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalContentWrap}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Sincronizar cierres (Ágora)</Text>
                <TouchableOpacity onPress={cerrarModalSync} style={styles.modalClose}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={styles.modalBody}>
                <Text style={styles.modalHelp}>
                  Introduce la fecha (o rango) a sincronizar. Se obtendrán los cierres de sistema desde Ágora y se guardarán en la base de datos. Para traer muchos días, indica "Desde" y "Hasta".
                </Text>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Desde (YYYY-MM-DD)</Text>
                  <TextInput
                    style={styles.formInput}
                    value={businessDaySync}
                    onChangeText={setBusinessDaySync}
                    placeholder="2025-01-01"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Hasta (opcional, YYYY-MM-DD)</Text>
                  <TextInput
                    style={styles.formInput}
                    value={businessDaySyncTo}
                    onChangeText={setBusinessDaySyncTo}
                    placeholder="2026-02-03"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                {syncProgress ? <Text style={styles.modalProgress}>{syncProgress}</Text> : null}
                {syncError ? <Text style={styles.modalError}>{syncError}</Text> : null}
                {syncMessage ? <Text style={styles.modalSuccess}>{syncMessage}</Text> : null}
              </View>
              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={styles.modalFooterBtn}
                  onPress={ejecutarSync}
                  disabled={syncing}
                  accessibilityLabel="Sincronizar"
                >
                  {syncing ? (
                    <ActivityIndicator size="small" color="#0ea5e9" />
                  ) : (
                    <>
                      <MaterialIcons name="sync" size={18} color="#0ea5e9" />
                      <Text style={styles.modalFooterBtnText}>Sincronizar</Text>
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
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    padding: 8,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  retryBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
  },
  syncBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 280,
    height: 32,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },
  filtrosActivosLine: {
    fontSize: 10,
    color: '#94a3b8',
    marginBottom: 6,
    paddingHorizontal: 2,
  },
  totalesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    gap: 8,
    marginBottom: 8,
  },
  totalesChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  totalesChipTotal: { backgroundColor: '#1e3a5f', borderColor: '#1e40af' },
  totalesChipLabel: { fontSize: 9, fontWeight: '600', color: '#475569', marginBottom: 2, textTransform: 'uppercase', textAlign: 'center' },
  totalesChipValue: { fontSize: 11, fontWeight: '700', color: '#0f172a', textAlign: 'center' },
  totalesChipTotalLabel: { fontSize: 9, fontWeight: '600', color: '#93c5fd', marginBottom: 2, textTransform: 'uppercase', textAlign: 'center' },
  totalesChipTotalValue: { fontSize: 11, fontWeight: '700', color: '#bfdbfe', textAlign: 'center' },
  subtitle: { fontSize: 12, color: '#64748b', marginBottom: 8 },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    marginBottom: 4,
  },
  dropdownTriggerText: { flex: 1, fontSize: 11, color: '#334155' },
  dropdownList: { marginBottom: 8, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' },
  subtitlePage: { fontSize: 11, color: '#94a3b8' },
  paginationRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 12, marginBottom: 8 },
  pageBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, backgroundColor: '#f8fafc' },
  pageBtnDisabled: { opacity: 0.6 },
  pageBtnText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  pageBtnTextDisabled: { color: '#94a3b8' },
  pageInfo: { fontSize: 12, color: '#64748b' },
  tableWrap: {
    flex: 1,
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#f8fafc',
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20, flexGrow: 1 },
  table: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    alignSelf: 'flex-start',
  },
  rowHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: '#cbd5e1', position: 'relative' },
  resizeHandle: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 10,
    backgroundColor: 'rgba(0,0,0,0.04)',
    cursor: 'col-resize' as 'pointer',
  },
  cellHeaderText: { fontSize: 10, fontWeight: '600', color: '#334155' },
  cellHeaderTextBold: { fontWeight: '700' },
  cellHeaderTextRight: { textAlign: 'right' },
  cellHeaderRight: { alignItems: 'flex-end' },
  cellLast: { borderRightWidth: 0 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#fff' },
  rowEmpty: {},
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  cellRight: { alignItems: 'flex-end' },
  cellText: { fontSize: 10, color: '#475569' },
  cellTextBold: { fontWeight: '700' },
  cellTextRight: { textAlign: 'right', alignSelf: 'stretch' },
  cellEmpty: { paddingVertical: 28, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  cellEmptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  modalContentWrap: { width: '100%', maxWidth: 420, padding: 24, alignItems: 'center' },
  modalCard: { width: '100%', backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12, overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { paddingHorizontal: 20, paddingVertical: 16 },
  modalHelp: { fontSize: 12, color: '#475569', marginBottom: 12, lineHeight: 18 },
  formGroup: { marginBottom: 8 },
  formLabel: { fontSize: 9, fontWeight: '500', color: '#475569', marginBottom: 2 },
  formInput: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: '#334155' },
  filterLocalsScroll: { maxHeight: 200 },
  filterLocalItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 4 },
  filterLocalItemSelected: { backgroundColor: '#f0f9ff', borderRadius: 6 },
  filterLocalText: { fontSize: 11, color: '#334155' },
  dateInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  formInputFlex: { flex: 1, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: '#334155' },
  calendarBtn: { padding: 8, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 },
  calendarModalWrap: { width: '100%', maxWidth: 340, padding: 24, alignItems: 'center' },
  calendarCard: { width: '100%', backgroundColor: '#fff', borderRadius: 16, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 12 },
  calendarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  calendarTitle: { fontSize: 16, fontWeight: '600', color: '#334155' },
  calendarWeekdays: { flexDirection: 'row', marginBottom: 4 },
  calendarWeekday: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: '#64748b' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarDay: { width: '14.28%', aspectRatio: 1, justifyContent: 'center', alignItems: 'center', padding: 2 },
  calendarDayText: { fontSize: 14, color: '#334155' },
  modalProgress: { fontSize: 11, color: '#64748b', marginTop: 8 },
  modalError: { fontSize: 11, color: '#f87171', marginTop: 8 },
  modalSuccess: { fontSize: 11, color: '#22c55e', marginTop: 8 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  modalFooterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  modalFooterBtnText: { fontSize: 12, color: '#0ea5e9', fontWeight: '500' },
  modalFooterBtnSecondary: { backgroundColor: 'transparent' },
  modalFooterBtnTextSecondary: { fontSize: 12, color: '#64748b', fontWeight: '500' },
});
