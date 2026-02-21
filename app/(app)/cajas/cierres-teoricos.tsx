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
  Pressable,
  PanResponder,
  Platform,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';
const REFETCH_INTERVAL_MS = 15_000;
const PAGE_SIZE = 100;
const DEFAULT_COL_WIDTH = 72;
const MIN_COL_WIDTH = 50;
const MAX_COL_WIDTH = 180;


/** Parsea respuesta como JSON de forma segura. Evita "Unexpected token '<'" cuando el servidor devuelve HTML. */
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

const PAYMENT_KEYS = ['InvoicePayments', 'TicketPayments', 'DeliveryNotePayments', 'SalesOrderPayments'];

/** Celda con tooltip al pasar el ratón (solo web). Muestra el texto completo en etiqueta amarillo pastel. */
function CellWithTooltip({
  fullText,
  cellStyle,
  textStyle,
}: {
  fullText: string;
  cellStyle: object;
  textStyle: object;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const isWeb = Platform.OS === 'web';
  return (
    <View
      style={[styles.cell, cellStyle]}
      {...(isWeb && {
        onMouseEnter: () => setShowTooltip(true),
        onMouseLeave: () => setShowTooltip(false),
      } as object)}
    >
      <Text style={textStyle} numberOfLines={1}>
        {fullText}
      </Text>
      {isWeb && showTooltip && String(fullText).trim() !== '' && (
        <View style={styles.cellTooltip} pointerEvents="none">
          <Text style={styles.cellTooltipText} numberOfLines={10}>
            {fullText}
          </Text>
        </View>
      )}
    </View>
  );
}
const KNOWN_PAYMENT_ORDER = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];
const PAYMENT_ALIASES: Record<string, string> = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', card: 'Tarjeta',
  'pendiente de cobro': 'Pendiente de cobro', pending: 'Pendiente de cobro',
  'prepago transferencia': 'Prepago Transferencia', transferencia: 'Prepago Transferencia',
  agorapay: 'AgoraPay',
};
type CloseOut = Record<string, unknown>;

function normalizePaymentName(name: string): string {
  const k = name.trim().toLowerCase();
  return PAYMENT_ALIASES[k] ?? KNOWN_PAYMENT_ORDER.find((m) => m.toLowerCase() === k) ?? name;
}

/** Parsea dd/mm/yyyy o yyyy-mm-dd y devuelve yyyy-mm-dd para comparación con Business Day. */
function formatBusinessDayLabel(iso: string): string {
  if (!iso || typeof iso !== 'string') return '—';
  const parts = iso.trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

const DIA_SEMANA_3 = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function getDiaSemana3(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return DIA_SEMANA_3[date.getDay()] ?? '—';
}

function formatSyncSeconds(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m} min ${s} s` : `${m} min`;
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

function getBusinessDay(item: CloseOut): string {
  const v = item.BusinessDay ?? item.businessDay;
  if (v != null && String(v).trim()) return String(v).trim();
  const sk = item.SK ?? item.sk;
  if (typeof sk === 'string' && sk.includes('#')) return sk.split('#')[0];
  return '';
}

function getAmounts(item: CloseOut): Record<string, unknown> | undefined {
  const a = item.Amounts ?? item.amounts;
  if (a != null && typeof a === 'object') return a as Record<string, unknown>;
  return undefined;
}

function getInvoicePaymentsTotal(item: CloseOut): number {
  const ventas = (item as Record<string, unknown>).Ventas;
  if (ventas != null && (typeof ventas === 'number' || (typeof ventas === 'string' && ventas.trim() !== ''))) {
    const n = typeof ventas === 'number' ? ventas : parseFloat(String(ventas).replace(',', '.'));
    if (!Number.isNaN(n)) return n;
  }
  const arr = item.InvoicePayments ?? item.invoicePayments;
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, p) => s + (Number(p?.Amount ?? (p as { amount?: number }).amount ?? 0) || 0), 0);
}

function getAmountForMethod(item: CloseOut, methodName: string): number {
  const colCanonical = normalizePaymentName(methodName);
  const directKey = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'].find((k) => normalizePaymentName(k) === colCanonical);
  if (directKey) {
    const val = (item as Record<string, unknown>)[directKey];
    if (val != null && (typeof val === 'number' || (typeof val === 'string' && val !== ''))) {
      const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
      if (!Number.isNaN(n)) return n;
    }
  }
  let total = 0;
  for (const key of PAYMENT_KEYS) {
    const arr = item[key as keyof CloseOut];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const raw = (p?.MethodName ?? (p as { methodName?: string }).methodName ?? '').toString().trim() || 'Sin nombre';
      const name = raw !== 'Sin nombre' ? normalizePaymentName(raw) : raw;
      if (name === colCanonical) total += Number(p?.Amount ?? (p as { amount?: number }).amount ?? 0) || 0;
    }
  }
  return total;
}

function getUniquePaymentMethods(items: CloseOut[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    for (const key of PAYMENT_KEYS) {
      const arr = item[key as keyof CloseOut];
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        const raw = (p?.MethodName ?? (p as { methodName?: string }).methodName ?? '').toString().trim() || 'Sin nombre';
        const name = raw !== 'Sin nombre' ? normalizePaymentName(raw) : raw;
        set.add(name);
      }
    }
  }
  const knownFirst = KNOWN_PAYMENT_ORDER.filter((m) => set.has(m));
  const others = Array.from(set).filter((m) => !KNOWN_PAYMENT_ORDER.includes(m)).sort();
  return [...knownFirst, ...others];
}

function formatMoneda(value: string | number): string {
  if (value === '' || value === '—' || value == null) return '—';
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.').replace(/\s/g, ''));
  if (Number.isNaN(n) || n === 0) return '—';
  const parts = n.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]} €`;
}

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

export default function CierresTeoricosScreen() {
  const router = useRouter();
  const [closeouts, setCloseouts] = useState<CloseOut[]>([]);
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [saleCenters, setSaleCenters] = useState<{ Id?: number; Nombre?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusquedaInput, setFiltroBusquedaInput] = useState('');
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncTotalDays, setSyncTotalDays] = useState(0);
  const [syncCurrentDay, setSyncCurrentDay] = useState(0);
  const [syncElapsedSeconds, setSyncElapsedSeconds] = useState(0);
  const [syncEstimatedRemainingSeconds, setSyncEstimatedRemainingSeconds] = useState<number | null>(null);
  const syncStartTimeRef = useRef<number | null>(null);
  const syncElapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [syncFechaDesde, setSyncFechaDesde] = useState(() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  });
  const [syncFechaHasta, setSyncFechaHasta] = useState(() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  });
  const [filtroFechaDesde, setFiltroFechaDesde] = useState('');
  const [filtroFechaHasta, setFiltroFechaHasta] = useState('');
  const [filtroLocal, setFiltroLocal] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    Local: Math.round(DEFAULT_COL_WIDTH * 1.2),
    PosName: Math.round(DEFAULT_COL_WIDTH * 1.44),
    DiaSemana: 48,
  });
  const [soloConFacturacion, setSoloConFacturacion] = useState(true);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingItem, setEditingItem] = useState<CloseOut | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingItem, setDeletingItem] = useState<CloseOut | null>(null);
  const [saving, setSaving] = useState(false);
  const [formBusinessDay, setFormBusinessDay] = useState('');
  const [formLocal, setFormLocal] = useState('');
  const [formPosId, setFormPosId] = useState('');
  const [formPosName, setFormPosName] = useState('');
  const [formNumber, setFormNumber] = useState('1');
  const [formPayments, setFormPayments] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formLocalDropdownOpen, setFormLocalDropdownOpen] = useState(false);
  const [formPosDropdownOpen, setFormPosDropdownOpen] = useState(false);

  const formPaymentMethods = useMemo(() => {
    const known = [...KNOWN_PAYMENT_ORDER];
    const fromForm = Object.keys(formPayments).filter((k) => !known.includes(k)).sort();
    return [...known, ...fromForm];
  }, [formPayments]);

  const formTotalGross = useMemo(() => {
    return formPaymentMethods.reduce((sum, method) => {
      const v = formPayments[method];
      const n = v ? parseFloat(String(v).replace(',', '.')) : 0;
      return sum + (Number.isNaN(n) ? 0 : n);
    }, 0);
  }, [formPayments, formPaymentMethods]);

  const refetchCloseouts = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    fetch(`${API_URL}/api/agora/closeouts`)
      .then((res) => safeJson<{ closeouts?: CloseOut[]; error?: string }>(res))
      .then((data) => {
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
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  const syncRangoFechas = useCallback(async (desde: string, hasta: string) => {
    setSyncing(true);
    setSyncProgress(0);
    setSyncElapsedSeconds(0);
    setSyncEstimatedRemainingSeconds(null);
    syncStartTimeRef.current = Date.now();

    const days: string[] = [];
    let d = new Date(desde + 'T12:00:00');
    const end = new Date(hasta + 'T12:00:00');
    while (d <= end) {
      days.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    const totalDays = days.length;
    setSyncTotalDays(totalDays);
    setSyncCurrentDay(0);

    syncElapsedIntervalRef.current = setInterval(() => {
      setSyncElapsedSeconds((prev) => prev + 1);
    }, 1000);

    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      try {
        const res = await fetch(`${API_URL}/api/agora/closeouts/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessDay: day }),
        });
        await safeJson<{ ok?: boolean }>(res);
      } catch {
        // seguir con el siguiente día
      }
      const completed = i + 1;
      setSyncCurrentDay(completed);
      setSyncProgress(Math.round((completed / totalDays) * 100));
      if (completed > 0 && completed < totalDays) {
        const elapsed = (Date.now() - (syncStartTimeRef.current ?? Date.now())) / 1000;
        const avgPerDay = elapsed / completed;
        const remaining = Math.ceil(avgPerDay * (totalDays - completed));
        setSyncEstimatedRemainingSeconds(remaining);
      }
    }

    if (syncElapsedIntervalRef.current) {
      clearInterval(syncElapsedIntervalRef.current);
      syncElapsedIntervalRef.current = null;
    }
    setSyncing(false);
    setSyncProgress(100);
    setSyncEstimatedRemainingSeconds(0);
    setShowSyncModal(false);
    refetchCloseouts(true);
  }, [refetchCloseouts]);

  useEffect(() => {
    return () => {
      if (syncElapsedIntervalRef.current) {
        clearInterval(syncElapsedIntervalRef.current);
        syncElapsedIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => { refetchCloseouts(); }, [refetchCloseouts]);

  useEffect(() => {
    const id = setInterval(() => refetchCloseouts(true), REFETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refetchCloseouts]);

  useEffect(() => {
    fetch(`${API_URL}/api/locales`)
      .then((res) => safeJson<{ locales?: LocalItem[] }>(res))
      .then((data) => setLocales(data.locales || []))
      .catch(() => setLocales([]));
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/api/agora/sale-centers`)
      .then((res) => safeJson<{ saleCenters?: { Id?: number; Nombre?: string }[] }>(res))
      .then((data) => setSaleCenters(data.saleCenters || []))
      .catch(() => setSaleCenters([]));
  }, []);

  const DEBOUNCE_MS = 250;
  useEffect(() => {
    const t = setTimeout(() => setFiltroBusqueda(filtroBusquedaInput), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filtroBusquedaInput]);

  const agoraCodeToNombre = useMemo(() => {
    const map: Record<string, string> = {};
    for (const loc of locales) {
      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
      if (code) map[code] = nombre || '—';
    }
    return map;
  }, [locales]);

  const posIdToNombre = useMemo(() => {
    const map: Record<string, string> = {};
    for (const sc of saleCenters) {
      if (sc.Id != null) map[String(sc.Id)] = String(sc.Nombre ?? '').trim() || '—';
    }
    return map;
  }, [saleCenters]);

  const paymentCols = useMemo(() => getUniquePaymentMethods(closeouts), [closeouts]);
  const columnas = useMemo(() => {
    const base = ['BusinessDay', 'DiaSemana', 'Local', 'PosName', 'InvoicePayments'];
    const orderedPayments = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'].filter((m) => paymentCols.includes(m));
    const otherPayments = paymentCols.filter((m) => !orderedPayments.includes(m));
    const dates = ['OpenDate', 'CloseDate', 'updatedAt'];
    const rest = ['GrossAmount', 'NetAmount', 'VatAmount', 'SurchargeAmount', 'PK', 'SK', 'Number', 'WorkplaceId', 'PosId', 'Documents', 'TicketPayments', 'DeliveryNotePayments', 'SalesOrderPayments', 'createdAt', 'source'];
    return [...base, ...orderedPayments, ...otherPayments, ...dates, ...rest];
  }, [paymentCols]);

  const closeoutsFiltrados = useMemo(() => {
    let list = closeouts;
    if (filtroLocal) {
      list = list.filter((i) => (i.PK ?? i.pk) === filtroLocal);
    }
    const desde = parseDateToYYYYMMDD(filtroFechaDesde);
    const hasta = parseDateToYYYYMMDD(filtroFechaHasta);
    if (desde) {
      list = list.filter((i) => {
        const bd = getBusinessDay(i);
        return bd >= desde;
      });
    }
    if (hasta) {
      list = list.filter((i) => {
        const bd = getBusinessDay(i);
        return bd <= hasta;
      });
    }
    const q = filtroBusqueda.trim().toLowerCase();
    if (q) {
      list = list.filter((item) => {
        const pk = String(item.PK ?? item.pk ?? '').trim();
        const bd = getBusinessDay(item);
        const pos = item.PosName ?? item.posName ?? item.PosId ?? item.posId ?? '';
        const num = item.Number ?? item.number ?? '';
        const gross = getAmounts(item)?.GrossAmount ?? getAmounts(item)?.grossAmount ?? '';
        const local = agoraCodeToNombre[pk] ?? '';
        const searchStr = `${pk} ${bd} ${pos} ${num} ${gross} ${local}`.toLowerCase();
        return searchStr.includes(q);
      });
    }
    if (soloConFacturacion) {
      list = list.filter((item) => getInvoicePaymentsTotal(item) > 0);
    }
    list = [...list].sort((a, b) => {
      const bdA = getBusinessDay(a);
      const bdB = getBusinessDay(b);
      const cmpBd = bdB.localeCompare(bdA);
      if (cmpBd !== 0) return cmpBd;
      const localA = agoraCodeToNombre[String(a.PK ?? a.pk ?? '')] ?? String(a.PK ?? a.pk ?? '');
      const localB = agoraCodeToNombre[String(b.PK ?? b.pk ?? '')] ?? String(b.PK ?? b.pk ?? '');
      return localA.localeCompare(localB);
    });
    return list;
  }, [closeouts, filtroBusqueda, filtroLocal, filtroFechaDesde, filtroFechaHasta, soloConFacturacion, agoraCodeToNombre]);

  const { paginatedList, totalPages, totalCount, effectivePage } = useMemo(() => {
    const total = closeoutsFiltrados.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.max(1, Math.min(currentPage, pages));
    const start = (page - 1) * PAGE_SIZE;
    const paginatedList = closeoutsFiltrados.slice(start, start + PAGE_SIZE);
    return { paginatedList, totalPages: pages, totalCount: total, effectivePage: page };
  }, [closeoutsFiltrados, currentPage]);

  const selectedItem = useMemo(() => {
    if (!selectedRowKey || !paginatedList) return null;
    return paginatedList.find((item, idx) => `${item.PK ?? ''}-${item.SK ?? ''}-${idx}` === selectedRowKey) ?? null;
  }, [selectedRowKey, paginatedList]);

  const openAddModal = useCallback(() => {
    const d = new Date();
    setFormBusinessDay(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
    setFormLocal('');
    setFormPosId('');
    setFormPosName('');
    setFormNumber('1');
    const init: Record<string, string> = {};
    for (const m of KNOWN_PAYMENT_ORDER) init[m] = '';
    setFormPayments(init);
    setFormError(null);
    setEditingItem(null);
    setFormLocalDropdownOpen(false);
    setFormPosDropdownOpen(false);
    setShowFormModal(true);
  }, []);

  const openEditModal = useCallback(() => {
    const item = selectedItem;
    if (!item) return;
    const bd = getBusinessDay(item);
    const [y, m, d] = bd ? bd.split('-') : ['', '', ''];
    setFormBusinessDay(bd ? `${d}/${m}/${y}` : '');
    setFormLocal(String(item.PK ?? item.pk ?? ''));
    setFormPosId(String(item.PosId ?? item.posId ?? ''));
    setFormPosName(String(item.PosName ?? item.posName ?? ''));
    setFormNumber(String(item.Number ?? item.number ?? '1'));
    const arr = item.InvoicePayments ?? item.invoicePayments;
    const payments: Record<string, string> = {};
    for (const m of KNOWN_PAYMENT_ORDER) payments[m] = '';
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const name = normalizePaymentName(String(p?.MethodName ?? (p as { methodName?: string }).methodName ?? '').trim() || 'Sin nombre');
        const amt = Number(p?.Amount ?? (p as { amount?: number }).amount ?? 0) || 0;
        if (name && name !== 'Sin nombre') {
          const prev = parseFloat(payments[name] || '0') || 0;
          payments[name] = String(prev + amt);
        }
      }
    }
    setFormPayments(payments);
    setFormError(null);
    setEditingItem(item);
    setFormLocalDropdownOpen(false);
    setFormPosDropdownOpen(false);
    setShowFormModal(true);
  }, [selectedItem]);

  const openDeleteModal = useCallback(() => {
    if (selectedItem) {
      setDeletingItem(selectedItem);
      setFormError(null);
      setShowDeleteModal(true);
    }
  }, [selectedItem]);

  const handleSaveForm = useCallback(async () => {
    const bd = parseDateToYYYYMMDD(formBusinessDay);
    const pk = formLocal.trim();
    if (!bd || !pk) {
      setFormError('Fecha y local obligatorios');
      return;
    }
    const invoicePayments = formPaymentMethods
      .map((method) => {
        const v = formPayments[method];
        const n = v ? parseFloat(String(v).replace(',', '.')) : 0;
        return { MethodName: method, Amount: Number.isNaN(n) ? 0 : n };
      })
      .filter((p) => p.Amount > 0);
    const grossNum = invoicePayments.reduce((s, p) => s + p.Amount, 0);
    setSaving(true);
    setFormError(null);
    try {
      if (editingItem) {
        const res = await fetch(`${API_URL}/api/agora/closeouts`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            PK: editingItem.PK ?? editingItem.pk,
            SK: editingItem.SK ?? editingItem.sk,
            BusinessDay: bd,
            WorkplaceName: agoraCodeToNombre[pk] ?? pk,
            PosId: formPosId.trim() || null,
            PosName: formPosName.trim() || null,
            Number: formNumber.trim() || '1',
            InvoicePayments: invoicePayments,
            Amounts: { GrossAmount: grossNum, NetAmount: null, VatAmount: null, SurchargeAmount: null },
          }),
        });
        const data = await safeJson<{ ok?: boolean; error?: string }>(res);
        if (data.error) throw new Error(data.error);
      } else {
        const res = await fetch(`${API_URL}/api/agora/closeouts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            PK: pk,
            BusinessDay: bd,
            PosId: formPosId.trim() || null,
            PosName: formPosName.trim() || null,
            Number: formNumber.trim() || '1',
            WorkplaceName: agoraCodeToNombre[pk] ?? pk,
            InvoicePayments: invoicePayments,
            GrossAmount: grossNum,
          }),
        });
        const data = await safeJson<{ ok?: boolean; error?: string }>(res);
        if (data.error) throw new Error(data.error);
      }
      setShowFormModal(false);
      refetchCloseouts(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }, [formBusinessDay, formLocal, formPosId, formPosName, formNumber, formPayments, formPaymentMethods, editingItem, agoraCodeToNombre, refetchCloseouts]);

  const handleDelete = useCallback(async () => {
    const item = deletingItem;
    if (!item) return;
    const pk = String(item.PK ?? item.pk ?? '').trim();
    const sk = String(item.SK ?? item.sk ?? '').trim();
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(`${API_URL}/api/agora/closeouts?PK=${encodeURIComponent(pk)}&SK=${encodeURIComponent(sk)}`, { method: 'DELETE' });
      const data = await safeJson<{ ok?: boolean; error?: string }>(res);
      if (data.error) throw new Error(data.error);
      setShowDeleteModal(false);
      setDeletingItem(null);
      setSelectedRowKey(null);
      refetchCloseouts(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Error al eliminar');
    } finally {
      setSaving(false);
    }
  }, [deletingItem, refetchCloseouts]);

  const totalFacturado = useMemo(() => {
    return closeoutsFiltrados.reduce((sum, item) => {
      const arr = item.InvoicePayments ?? item.invoicePayments;
      if (!Array.isArray(arr)) return sum;
      const rowTotal = arr.reduce((s, p) => s + (Number(p?.Amount ?? (p as { amount?: number }).amount ?? 0) || 0), 0);
      return sum + rowTotal;
    }, 0);
  }, [closeoutsFiltrados]);

  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(1);
  }, [currentPage, totalPages]);

  const getValorCelda = useCallback((item: CloseOut, col: string): string => {
    if (col === 'DiaSemana') {
      return getDiaSemana3(getBusinessDay(item));
    }
    if (col === 'Local') {
      const pk = String(item.PK ?? item.pk ?? '').trim();
      return agoraCodeToNombre[pk] ?? '—';
    }
    if (paymentCols.includes(col)) {
      const amt = getAmountForMethod(item, col);
      return formatMoneda(amt);
    }
    if (col === 'GrossAmount') {
      const ventas = (item as Record<string, unknown>).Ventas;
      if (ventas != null && (typeof ventas === 'number' || (typeof ventas === 'string' && String(ventas).trim() !== ''))) {
        const n = typeof ventas === 'number' ? ventas : parseFloat(String(ventas).replace(',', '.'));
        if (!Number.isNaN(n)) return formatMoneda(n);
      }
      const amounts = getAmounts(item);
      const v = amounts?.GrossAmount ?? amounts?.grossAmount;
      return formatMoneda(v != null ? String(v) : '—');
    }
    if (['NetAmount', 'VatAmount', 'SurchargeAmount'].includes(col)) {
      const amounts = getAmounts(item);
      const v = amounts?.[col] ?? amounts?.[col.charAt(0).toLowerCase() + col.slice(1)];
      return formatMoneda(v != null ? String(v) : '—');
    }
    if (col === 'Documents') {
      const arr = item.Documents ?? item.documents;
      return Array.isArray(arr) ? String(arr.length) : '—';
    }
    if (col === 'InvoicePayments') {
      const total = getInvoicePaymentsTotal(item);
      return formatMoneda(total);
    }
    if (['TicketPayments', 'DeliveryNotePayments', 'SalesOrderPayments'].includes(col)) {
      const arr = item[col as keyof CloseOut] ?? (item as Record<string, unknown>)[col.charAt(0).toLowerCase() + col.slice(1)];
      if (!Array.isArray(arr)) return '—';
      const total = arr.reduce((s, p) => s + (Number(p?.Amount ?? (p as { amount?: number }).amount ?? 0) || 0), 0);
      return formatMoneda(total);
    }
    if (col === 'PosName') {
      const posName = item.PosName ?? item.posName;
      const posId = item.PosId ?? item.posId;
      const nombreFromMap = posId != null ? posIdToNombre[String(posId)] : undefined;
      return (posName ?? nombreFromMap ?? posId ?? '—').toString();
    }
    const v = item[col as keyof CloseOut] ?? (item as Record<string, unknown>)[col.charAt(0).toLowerCase() + col.slice(1)];
    if (v == null || v === '') return '—';
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 50) + (JSON.stringify(v).length > 50 ? '…' : '');
    return String(v);
  }, [agoraCodeToNombre, posIdToNombre, paymentCols]);

  const getHeaderLabel = (col: string): string => {
    const labels: Record<string, string> = {
      PK: 'WorkplaceId', Local: 'Local', SK: 'SK', BusinessDay: 'Business Day', DiaSemana: 'Día', Number: 'Nº',
      WorkplaceId: 'Workplace', PosId: 'TPV Id', PosName: 'TPV',
      OpenDate: 'Apertura', CloseDate: 'Cierre',
      GrossAmount: 'Bruto', NetAmount: 'Neto', VatAmount: 'IVA', SurchargeAmount: 'Recargo',
      Documents: 'Docs', InvoicePayments: 'Total facturado', TicketPayments: 'Tickets', DeliveryNotePayments: 'Albaranes', SalesOrderPayments: 'Pedidos',
      createdAt: 'Creado', updatedAt: 'Actualizado', source: 'Origen',
    };
    return labels[col] ?? col;
  };

  const isMonedaCol = (col: string) =>
    ['GrossAmount', 'NetAmount', 'VatAmount', 'SurchargeAmount'].includes(col) || paymentCols.includes(col) ||
    ['InvoicePayments', 'TicketPayments', 'DeliveryNotePayments', 'SalesOrderPayments'].includes(col);

  const getColWidth = useCallback((col: string) => Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, columnWidths[col] ?? DEFAULT_COL_WIDTH)), [columnWidths]);

  const resizeRef = useRef<{ col: string; startW: number; startX: number } | null>(null);
  const columnWidthsRef = useRef(columnWidths);
  columnWidthsRef.current = columnWidths;

  const startResize = useCallback((col: string, clientX: number) => {
    resizeRef.current = { col, startW: columnWidthsRef.current[col] ?? DEFAULT_COL_WIDTH, startX: clientX };
  }, []);

  const onResizeMove = useCallback((clientX: number) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = clientX - r.startX;
    const newW = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, r.startW + dx));
    setColumnWidths((prev) => ({ ...prev, [r.col]: newW }));
    r.startW = newW;
    r.startX = clientX;
  }, []);

  const stopResize = useCallback(() => { resizeRef.current = null; }, []);

  const handleWebResizeStart = useCallback((col: string) => (e: { nativeEvent: { clientX: number } }) => {
    startResize(col, e.nativeEvent.clientX);
    const onMove = (ev: MouseEvent) => onResizeMove(ev.clientX);
    const onUp = () => { stopResize(); (globalThis as typeof window).removeEventListener('mousemove', onMove); (globalThis as typeof window).removeEventListener('mouseup', onUp); };
    (globalThis as typeof window).addEventListener('mousemove', onMove);
    (globalThis as typeof window).addEventListener('mouseup', onUp);
  }, [startResize, onResizeMove, stopResize]);

  const resizeHandlers = useMemo(() => {
    const map: Record<string, ReturnType<typeof PanResponder.create>> = {};
    for (const col of columnas) {
      map[col] = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (_, g) => {
          startResize(col, g.moveX);
        },
        onPanResponderMove: (_, g) => {
          onResizeMove(g.moveX);
        },
        onPanResponderRelease: stopResize,
      });
    }
    return map;
  }, [columnas, startResize, onResizeMove, stopResize]);

  if (loading && closeouts.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Cierres de ventas teóricas</Text>
        </View>
        <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.loadingText}>Cargando cierres…</Text>
        </View>
      </View>
    );
  }

  if (error && closeouts.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Cierres de ventas teóricas</Text>
        </View>
        <View style={styles.errorWrap}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetchCloseouts()}>
          <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
          <Text style={styles.retryBtnText}>Reintentar</Text>
        </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Cierres de ventas teóricas</Text>
      </View>

      <View style={styles.toolbarRow}>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusquedaInput}
            onChangeText={setFiltroBusquedaInput}
            placeholder="Buscar por local, TPV, fecha…"
            placeholderTextColor="#94a3b8"
          />
        </View>
        <TouchableOpacity
          style={[styles.toolbarBtn, syncing && styles.toolbarBtnDisabled]}
          onPress={() => setShowSyncModal(true)}
          disabled={syncing}
        >
          <MaterialIcons name="sync" size={16} color="#0ea5e9" />
          <Text style={styles.toolbarBtnText}>Sincronizar</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolbarBtn, showFilterPanel && styles.toolbarBtnActive]}
          onPress={() => setShowFilterPanel((v) => !v)}
        >
          <MaterialIcons name="filter-list" size={16} color={showFilterPanel ? '#fff' : '#64748b'} />
          <Text style={[styles.toolbarBtnText, showFilterPanel && styles.toolbarBtnTextActive]}>Filtro</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolbarBtnAdd} onPress={openAddModal}>
          <MaterialIcons name="add" size={16} color="#fff" />
          <Text style={styles.toolbarBtnAddText}>Añadir</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolbarBtn, !selectedItem && styles.toolbarBtnDisabled]}
          onPress={openEditModal}
          disabled={!selectedItem}
        >
          <MaterialIcons name="edit" size={16} color={selectedItem ? '#0ea5e9' : '#94a3b8'} />
          <Text style={[styles.toolbarBtnText, !selectedItem && styles.toolbarBtnTextDisabled]}>Editar</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toolbarBtn, !selectedItem && styles.toolbarBtnDisabled]}
          onPress={openDeleteModal}
          disabled={!selectedItem}
        >
          <MaterialIcons name="delete" size={16} color={selectedItem ? '#dc2626' : '#94a3b8'} />
          <Text style={[styles.toolbarBtnText, !selectedItem && styles.toolbarBtnTextDisabled]}>Borrar</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.totalFacturadoBox}>
        <Text style={styles.totalFacturadoLabel}>Total facturado</Text>
        <Text style={styles.totalFacturadoValue}>{formatMoneda(totalFacturado)}</Text>
      </View>

      <View style={styles.soloFacturacionBox}>
        <View style={styles.soloFacturacionSwitchWrap}>
          <Switch
            value={soloConFacturacion}
            onValueChange={setSoloConFacturacion}
            trackColor={{ false: '#e2e8f0', true: '#86efac' }}
            thumbColor={soloConFacturacion ? '#22c55e' : '#94a3b8'}
          />
          </View>
        <Text style={styles.soloFacturacionLabel}>Mostrar solo registros con facturación</Text>
            </View>

      {showFilterPanel && (
        <View style={styles.filterPanel}>
          <View style={styles.filterRow}>
            <View style={styles.filterField}>
              <Text style={styles.filterLabel}>Desde</Text>
              <TextInput
                style={styles.filterInput}
                value={filtroFechaDesde}
                onChangeText={setFiltroFechaDesde}
                placeholder="dd/mm/yyyy"
                placeholderTextColor="#94a3b8"
              />
                </View>
            <View style={styles.filterField}>
              <Text style={styles.filterLabel}>Hasta</Text>
              <TextInput
                style={styles.filterInput}
                value={filtroFechaHasta}
                onChangeText={setFiltroFechaHasta}
                placeholder="dd/mm/yyyy"
                placeholderTextColor="#94a3b8"
              />
            </View>
            <View style={styles.filterFieldLocal}>
              <Text style={styles.filterLabel}>Local</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterLocalesWrap} contentContainerStyle={styles.filterLocalesContent}>
                <TouchableOpacity
                  style={[styles.filterChip, !filtroLocal && styles.filterChipActive]}
                  onPress={() => setFiltroLocal('')}
                >
                  <Text style={[styles.filterChipText, !filtroLocal && styles.filterChipTextActive]}>Todos</Text>
                </TouchableOpacity>
                {locales.map((loc) => {
                  const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                  const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim() || code || '—';
                  const sel = code !== '' && filtroLocal === code;
                    return (
                    <TouchableOpacity
                      key={code || nombre}
                      style={[styles.filterChip, sel && styles.filterChipActive]}
                      onPress={() => setFiltroLocal(sel ? '' : code)}
                    >
                      <Text style={[styles.filterChipText, sel && styles.filterChipTextActive]} numberOfLines={1}>
                        {nombre}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
                    </View>
            <TouchableOpacity style={styles.filterClearBtn} onPress={() => { setFiltroFechaDesde(''); setFiltroFechaHasta(''); setFiltroLocal(''); }}>
              <MaterialIcons name="clear" size={14} color="#64748b" />
              <Text style={styles.filterClearText}>Limpiar</Text>
            </TouchableOpacity>
                </View>
        </View>
      )}

      <Modal visible={showSyncModal} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => !syncing && setShowSyncModal(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Sincronizar cierres</Text>
            <Text style={styles.modalSubtitle}>Actualiza los datos desde Ágora entre las fechas seleccionadas</Text>
            <Text style={styles.filterLabel}>Fecha desde</Text>
            <TextInput
              style={styles.filterInput}
              value={syncFechaDesde}
              onChangeText={setSyncFechaDesde}
              placeholder="dd/mm/yyyy"
              placeholderTextColor="#94a3b8"
              editable={!syncing}
            />
            <Text style={styles.filterLabel}>Fecha hasta</Text>
            <TextInput
              style={styles.filterInput}
              value={syncFechaHasta}
              onChangeText={setSyncFechaHasta}
              placeholder="dd/mm/yyyy"
              placeholderTextColor="#94a3b8"
              editable={!syncing}
            />
            {syncing && (
              <View style={styles.syncProgressWrap}>
                <View style={styles.syncProgressBarBg}>
                  <View style={[styles.syncProgressBarFill, { width: `${syncProgress}%` }]} />
          </View>
                <View style={styles.syncProgressInfo}>
                  <Text style={styles.syncProgressText}>
                    {syncCurrentDay} / {syncTotalDays} días ({syncProgress}%)
                  </Text>
                  <Text style={styles.syncProgressTimer}>
                    {syncEstimatedRemainingSeconds != null && syncEstimatedRemainingSeconds > 0
                      ? `Tiempo restante: ~${formatSyncSeconds(syncEstimatedRemainingSeconds)}`
                      : `Tiempo transcurrido: ${formatSyncSeconds(syncElapsedSeconds)}`}
                  </Text>
      </View>
              </View>
            )}
            <View style={styles.modalActions}>
          <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnCancel]}
                onPress={() => !syncing && setShowSyncModal(false)}
                disabled={syncing}
              >
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
          </TouchableOpacity>
          <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary, syncing && styles.toolbarBtnDisabled]}
                  onPress={() => {
                  const desde = parseDateToYYYYMMDD(syncFechaDesde);
                  const hasta = parseDateToYYYYMMDD(syncFechaHasta);
                  if (desde && hasta && desde <= hasta) {
                    syncRangoFechas(desde, hasta);
                  }
                }}
                disabled={syncing}
              >
                {syncing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <MaterialIcons name="sync" size={18} color="#fff" />
                    <Text style={[styles.modalBtnPrimaryText, { marginLeft: 6 }]}>Sincronizar</Text>
                  </View>
                )}
                </TouchableOpacity>
              </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showFormModal} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => !saving && setShowFormModal(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <ScrollView style={styles.formModalScroll} showsVerticalScrollIndicator>
            <Text style={styles.modalTitle}>{editingItem ? 'Editar cierre' : 'Añadir cierre'}</Text>
            {formError ? <Text style={styles.formError}>{formError}</Text> : null}
            <Text style={styles.filterLabel}>Fecha (dd/mm/yyyy)</Text>
            <TextInput
              style={styles.filterInput}
              value={formBusinessDay}
              onChangeText={setFormBusinessDay}
              placeholder="dd/mm/yyyy"
              placeholderTextColor="#94a3b8"
              editable={!saving}
            />
            <Text style={styles.filterLabel}>Local</Text>
            <View style={styles.formDropdownWrap}>
                <TouchableOpacity
                style={styles.formDropdownTrigger}
                onPress={() => !editingItem && setFormLocalDropdownOpen((v) => !v)}
                disabled={!!editingItem}
              >
                <Text style={[styles.formDropdownText, !formLocal && styles.formDropdownPlaceholder]} numberOfLines={1}>
                  {formLocal ? (agoraCodeToNombre[formLocal] ?? formLocal) : 'Selecciona un local'}
                  </Text>
                <MaterialIcons name={formLocalDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
                </TouchableOpacity>
              {formLocalDropdownOpen && (
                <View style={styles.formDropdownList}>
                  <ScrollView style={styles.formDropdownScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {locales.filter((loc) => String(loc.agoraCode ?? loc.AgoraCode ?? '').trim()).map((loc) => {
                      const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                      const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim() || code || '—';
                      const sel = code && formLocal === code;
                        return (
                          <TouchableOpacity
                          key={code || nombre}
                          style={[styles.formDropdownOption, sel && styles.formDropdownOptionSelected]}
                          onPress={() => { setFormLocal(code); setFormLocalDropdownOpen(false); }}
                        >
                          <Text style={[styles.formDropdownOptionText, sel && styles.formDropdownOptionTextSelected]} numberOfLines={1}>{nombre}</Text>
                          {sel ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
              )}
                  </View>
            <Text style={styles.filterLabel}>TPV</Text>
            <View style={styles.formDropdownWrap}>
              <TouchableOpacity
                style={styles.formDropdownTrigger}
                onPress={() => setFormPosDropdownOpen((v) => !v)}
                disabled={!!editingItem}
              >
                <Text style={[styles.formDropdownText, !formPosId && !formPosName && styles.formDropdownPlaceholder]} numberOfLines={1}>
                  {formPosId ? `${formPosName || saleCenters.find((s) => String(s.Id) === formPosId)?.Nombre || formPosId} (${formPosId})` : 'Selecciona un TPV'}
                  </Text>
                <MaterialIcons name={formPosDropdownOpen ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
                </TouchableOpacity>
              {formPosDropdownOpen && (
                <View style={styles.formDropdownList}>
                  <ScrollView style={styles.formDropdownScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    <TouchableOpacity
                      style={[styles.formDropdownOption, !formPosId && !formPosName && styles.formDropdownOptionSelected]}
                      onPress={() => { setFormPosId(''); setFormPosName(''); setFormPosDropdownOpen(false); }}
                    >
                      <Text style={styles.formDropdownOptionText}>Ninguno</Text>
                      {!formPosId && !formPosName ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                      </TouchableOpacity>
                    {saleCenters.map((sc) => {
                      const id = sc.Id != null ? String(sc.Id) : '';
                      const nombre = String(sc.Nombre ?? '').trim() || id || '—';
                        return (
                        <TouchableOpacity
                          key={id || nombre}
                          style={[styles.formDropdownOption, (formPosId === id) && styles.formDropdownOptionSelected]}
                          onPress={() => { setFormPosId(id); setFormPosName(nombre); setFormPosDropdownOpen(false); }}
                        >
                          <Text style={[styles.formDropdownOptionText, (formPosId === id) && styles.formDropdownOptionTextSelected]} numberOfLines={1}>{nombre} ({id})</Text>
                          {formPosId === id ? <MaterialIcons name="check" size={18} color="#0ea5e9" /> : null}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>
              )}
                  </View>
            <Text style={styles.filterLabel}>Número</Text>
            <TextInput style={styles.filterInput} value={formNumber} onChangeText={setFormNumber} placeholder="1" placeholderTextColor="#94a3b8" editable={!saving && !editingItem} />
            <Text style={styles.filterLabel}>Formas de pago (€)</Text>
            {formPaymentMethods.map((method) => (
              <View key={method} style={styles.formPaymentRow}>
                <Text style={styles.formPaymentLabel}>{method}</Text>
                    <TextInput
                  style={styles.formPaymentInput}
                  value={formPayments[method] ?? ''}
                  onChangeText={(t) => setFormPayments((p) => ({ ...p, [method]: t }))}
                  placeholder="0"
                      placeholderTextColor="#94a3b8"
                  keyboardType="decimal-pad"
                  editable={!saving}
                    />
                  </View>
            ))}
            <View style={styles.formTotalRow}>
              <Text style={styles.formTotalLabel}>Total facturado</Text>
              <Text style={styles.formTotalValue}>{formatMoneda(formTotalGross)}</Text>
                </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => !saving && setShowFormModal(false)} disabled={saving}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
                </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnPrimary, saving && styles.toolbarBtnDisabled]} onPress={handleSaveForm} disabled={saving}>
                {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.modalBtnPrimaryText}>Guardar</Text>}
                </TouchableOpacity>
              </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showDeleteModal} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => !saving && setShowDeleteModal(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Eliminar cierre</Text>
            <Text style={styles.modalSubtitle}>
              ¿Eliminar el registro de {deletingItem ? (agoraCodeToNombre[String(deletingItem.PK ?? deletingItem.pk ?? '')] ?? deletingItem.PK) : ''} del {deletingItem ? formatBusinessDayLabel(getBusinessDay(deletingItem)) : ''}?
            </Text>
            {formError ? <Text style={styles.formError}>{formError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnCancel]} onPress={() => !saving && (setShowDeleteModal(false), setDeletingItem(null))} disabled={saving}>
                <Text style={styles.modalBtnCancelText}>Cancelar</Text>
                </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnDanger, saving && styles.toolbarBtnDisabled]} onPress={handleDelete} disabled={saving}>
                {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.modalBtnPrimaryText}>Eliminar</Text>}
                </TouchableOpacity>
              </View>
          </Pressable>
        </Pressable>
      </Modal>

      <View style={styles.infoRow}>
        <Text style={styles.infoLine}>
          {totalCount === 0
            ? 'No hay cierres. Se sincronizan automáticamente cada 2 min desde Ágora.'
            : `${totalCount} cierre${totalCount !== 1 ? 's' : ''} (ordenado por Business Day, más reciente primero; luego por local)`}
        </Text>
        {totalCount > PAGE_SIZE && (
          <View style={styles.pagination}>
                    <TouchableOpacity
              style={[styles.pageBtn, effectivePage <= 1 && styles.pageBtnDisabled]}
              onPress={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={effectivePage <= 1}
            >
              <MaterialIcons name="chevron-left" size={20} color={effectivePage <= 1 ? '#94a3b8' : '#334155'} />
              <Text style={[styles.pageBtnText, effectivePage <= 1 && styles.pageBtnTextDisabled]}>Anterior</Text>
                    </TouchableOpacity>
            <Text style={styles.pageInfo}>
              Página {effectivePage} de {totalPages}
            </Text>
            <TouchableOpacity
              style={[styles.pageBtn, effectivePage >= totalPages && styles.pageBtnDisabled]}
              onPress={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={effectivePage >= totalPages}
            >
              <Text style={[styles.pageBtnText, effectivePage >= totalPages && styles.pageBtnTextDisabled]}>Siguiente</Text>
              <MaterialIcons name="chevron-right" size={20} color={effectivePage >= totalPages ? '#94a3b8' : '#334155'} />
            </TouchableOpacity>
              </View>
        )}
            </View>

      <ScrollView horizontal style={styles.tableScroll} showsHorizontalScrollIndicator>
        <View style={styles.tableWrapper}>
          <View style={styles.headerRowTable}>
            {columnas.map((col) => (
              <View key={col} style={[styles.cellHeader, isMonedaCol(col) && styles.cellRight, { width: getColWidth(col) }]}>
                <Text style={styles.cellHeaderText} numberOfLines={1}>
                  {getHeaderLabel(col)}
                </Text>
                <View
                  style={[styles.resizeHandle, Platform.OS === 'web' && (styles.resizeHandleWeb as object)]}
                  {...(Platform.OS === 'web' ? { onMouseDown: handleWebResizeStart(col) } : (resizeHandlers[col]?.panHandlers || {}))}
                >
                  <View style={styles.resizeLine} />
                </View>
                </View>
            ))}
              </View>
          <ScrollView style={styles.tableInner} showsVerticalScrollIndicator>
            <View style={styles.table}>
              {paginatedList.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>
                    {closeouts.length === 0 ? 'No hay cierres. Sincronizando…' : 'Ningún resultado con el filtro'}
                  </Text>
                </View>
              ) : (
                paginatedList.map((item, idx) => {
                  const rowKey = `${item.PK ?? ''}-${item.SK ?? ''}-${idx}`;
                  const isSelected = selectedRowKey === rowKey;
                  return (
                    <Pressable
                      key={rowKey}
                      style={[styles.dataRow, isSelected && styles.dataRowSelected]}
                      onPress={() => setSelectedRowKey(isSelected ? null : rowKey)}
                    >
                      {columnas.map((col) => {
                        const valor = getValorCelda(item, col);
                        return (
                          <CellWithTooltip
                            key={col}
                            fullText={String(valor ?? '')}
                            cellStyle={[isMonedaCol(col) && styles.cellRight, { width: getColWidth(col) }]}
                            textStyle={[styles.cellText, col === 'InvoicePayments' && styles.cellBold]}
                          />
                        );
                      })}
                    </Pressable>
                  );
                })
              )}
              </View>
          </ScrollView>
            </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 17, fontWeight: '600', color: '#1e293b', letterSpacing: -0.3 },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 8, paddingHorizontal: 10 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 13, color: '#334155' },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f8fafc', borderRadius: 6, borderWidth: 1, borderColor: '#e2e8f0' },
  toolbarBtnDisabled: { opacity: 0.6 },
  toolbarBtnActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  toolbarBtnText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  toolbarBtnTextActive: { color: '#fff' },
  toolbarBtnTextDisabled: { color: '#94a3b8' },
  toolbarBtnAdd: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#22c55e', borderRadius: 6 },
  toolbarBtnAddText: { fontSize: 11, color: '#fff', fontWeight: '600' },
  formError: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  formLocalesWrap: { maxHeight: 36, marginBottom: 8 },
  formLocalesContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  formDropdownWrap: { marginBottom: 8 },
  formDropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  formDropdownText: { fontSize: 10, color: '#334155', flex: 1 },
  formDropdownPlaceholder: { color: '#94a3b8', fontSize: 10 },
  formDropdownList: { marginTop: 4, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff', maxHeight: 180 },
  formDropdownScroll: { maxHeight: 180 },
  formDropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  formDropdownOptionSelected: { backgroundColor: '#f0f9ff' },
  formDropdownOptionText: { fontSize: 10, color: '#334155', flex: 1 },
  formDropdownOptionTextSelected: { color: '#0ea5e9', fontWeight: '500' },
  formPaymentRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  formPaymentLabel: { fontSize: 12, color: '#475569', minWidth: 140 },
  formPaymentInput: { flex: 1, backgroundColor: '#fff', borderRadius: 4, paddingVertical: 4, paddingHorizontal: 8, fontSize: 12, color: '#334155', borderWidth: StyleSheet.hairlineWidth, borderColor: '#e2e8f0' },
  formTotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  formTotalLabel: { fontSize: 13, fontWeight: '600', color: '#334155' },
  formTotalValue: { fontSize: 14, fontWeight: '700', color: '#047857' },
  formModalScroll: { maxHeight: 360 },
  modalBtnDanger: { backgroundColor: '#dc2626' },
  totalFacturadoBox: { backgroundColor: '#d1fae5', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  soloFacturacionBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, paddingHorizontal: 0, marginBottom: 10 },
  soloFacturacionLabel: { fontSize: 11, color: '#94a3b8', fontWeight: '400' },
  soloFacturacionSwitchWrap: { transform: [{ scale: 0.65 }] },
  totalFacturadoLabel: { fontSize: 14, fontWeight: '600', color: '#065f46' },
  totalFacturadoValue: { fontSize: 15, fontWeight: '700', color: '#047857' },
  filterPanel: {
    backgroundColor: '#fafbfc',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    ...(Platform.OS === 'web' && { boxShadow: '0 1px 2px rgba(0,0,0,0.04)' } as object),
  },
  filterRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: 10 },
  filterField: { minWidth: 82, flex: 0 },
  filterFieldLocal: { flex: 1, minWidth: 120 },
  filterLabel: { fontSize: 10, fontWeight: '600', color: '#6b7280', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3 },
  filterInput: { backgroundColor: '#fff', borderRadius: 4, paddingVertical: 2, paddingHorizontal: 6, fontSize: 10, color: '#334155', borderWidth: StyleSheet.hairlineWidth, borderColor: '#e5e7eb', minHeight: 24 },
  filterLocalesWrap: { maxHeight: 26 },
  filterLocalesContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  filterChip: { paddingVertical: 2, paddingHorizontal: 6, backgroundColor: '#f3f4f6', borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: '#e5e7eb' },
  filterChipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  filterChipText: { fontSize: 10, color: '#6b7280', fontWeight: '500' },
  filterChipTextActive: { color: '#fff' },
  filterClearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 5, paddingHorizontal: 8, marginLeft: 4 },
  filterClearText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { backgroundColor: '#fff', borderRadius: 12, padding: 20, width: '100%', maxWidth: 360 },
  modalTitle: { fontSize: 17, fontWeight: '600', color: '#334155', marginBottom: 4 },
  modalSubtitle: { fontSize: 12, color: '#64748b', marginBottom: 16 },
  syncProgressWrap: { marginTop: 16, marginBottom: 4 },
  syncProgressBarBg: { height: 8, backgroundColor: '#e2e8f0', borderRadius: 4, overflow: 'hidden' },
  syncProgressBarFill: { height: '100%', backgroundColor: '#0ea5e9', borderRadius: 4 },
  syncProgressInfo: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, flexWrap: 'wrap', gap: 4 },
  syncProgressText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  syncProgressTimer: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 16, justifyContent: 'flex-end' },
  modalBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  modalBtnCancel: { backgroundColor: '#f1f5f9' },
  modalBtnCancelText: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  modalBtnPrimary: { backgroundColor: '#0ea5e9' },
  modalBtnPrimaryText: { fontSize: 13, color: '#fff', fontWeight: '600', marginLeft: 6 },
  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 },
  infoLine: { fontSize: 11, color: '#64748b', flex: 1 },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pageBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f8fafc', borderRadius: 8 },
  pageBtnDisabled: { opacity: 0.5 },
  pageBtnText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  pageBtnTextDisabled: { color: '#94a3b8' },
  pageInfo: { fontSize: 12, color: '#64748b', fontWeight: '500' },
  tableScroll: { flex: 1, backgroundColor: '#fff' },
  tableWrapper: { flex: 1, flexDirection: 'column' },
  tableInner: { flex: 1, backgroundColor: '#fff' },
  table: { paddingBottom: 24, backgroundColor: '#fff' },
  headerRowTable: { flexDirection: 'row', backgroundColor: '#f8fafc', borderBottomWidth: 1, borderColor: '#e2e8f0' },
  dataRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#f1f5f9' },
  dataRowSelected: { backgroundColor: '#dbeafe' },
  cellHeader: { paddingHorizontal: 6, paddingVertical: 6, paddingRight: 18, justifyContent: 'center', position: 'relative' },
  cell: { paddingHorizontal: 6, paddingVertical: 5, justifyContent: 'center', position: 'relative' },
  cellTooltip: {
    position: 'absolute',
    left: 0,
    bottom: '100%',
    marginBottom: 2,
    backgroundColor: '#fef9c3', 
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    maxWidth: 280,
    zIndex: 1000,
    opacity: 1,
    ...(Platform.OS === 'web' && { boxShadow: '0 1px 3px rgba(0,0,0,0.08)' } as object),
  },
  cellTooltipText: { fontSize: 10, color: '#713f12', lineHeight: 14 },
  cellRight: { alignItems: 'flex-end' },
  cellHeaderText: { fontSize: 10, fontWeight: '600', color: '#475569', letterSpacing: 0.2 },
  cellText: { fontSize: 10, color: '#334155', letterSpacing: 0.1 },
  cellBold: { fontWeight: '700' },
  resizeHandle: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 16, justifyContent: 'center', alignItems: 'flex-end' },
  resizeHandleWeb: { cursor: 'col-resize' } as Record<string, unknown>,
  resizeLine: { width: StyleSheet.hairlineWidth, height: '70%', backgroundColor: '#f1f5f9', borderRadius: 0 },
  emptyRow: { padding: 24, alignItems: 'center' },
  emptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 13, color: '#64748b' },
  errorWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  errorText: { fontSize: 13, color: '#dc2626', textAlign: 'center' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10 },
  retryBtnText: { fontSize: 13, color: '#0ea5e9', fontWeight: '500' },
});
