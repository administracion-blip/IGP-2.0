import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Pressable,
  PanResponder,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import * as XLSX from 'xlsx-js-style';
import { exportRevisionFormasPagoPdf } from './pdfRevisionFormasPago';
import { apiFetch } from '../../utils/api';

const PAGE_SIZE = 100;
const DEFAULT_COL_WIDTH = 90;
const MIN_COL_WIDTH = 50;
const MAX_COL_WIDTH = 220;

type Payment = {
  MethodId: number | null;
  MethodName: string;
  Amount: number;
  PaidAmount?: number;
  ChangeAmount?: number;
  Tip?: number;
  IsPrepayment?: boolean;
  ExtraInformation?: string;
  Date?: string;
};

type Row = {
  WorkplaceId: string;
  WorkplaceName: string | null;
  PosId: number | string | null;
  PosName: string | null;
  BusinessDay: string;
  DocumentType: string;
  TicketNumber: string;
  InvoiceNumber: string;
  DateTime: string;
  GrossAmount: number;
  Payments: Payment[];
};

const KNOWN_PAYMENT_ORDER = ['Efectivo', 'Tarjeta', 'Pendiente de cobro', 'Prepago Transferencia', 'AgoraPay'];
const PAYMENT_ALIASES: Record<string, string> = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  card: 'Tarjeta',
  'pendiente de cobro': 'Pendiente de cobro',
  pending: 'Pendiente de cobro',
  'prepago transferencia': 'Prepago Transferencia',
  transferencia: 'Prepago Transferencia',
  agorapay: 'AgoraPay',
};

function normalizePaymentName(name: string): string {
  const k = String(name ?? '').trim().toLowerCase();
  if (!k) return 'Sin nombre';
  return PAYMENT_ALIASES[k] ?? KNOWN_PAYMENT_ORDER.find((m) => m.toLowerCase() === k) ?? name;
}

function formatMoneda(value: string | number): string {
  if (value === '' || value === '—' || value == null) return '—';
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.').replace(/\s/g, ''));
  if (Number.isNaN(n) || n === 0) return '—';
  const parts = n.toFixed(2).split('.');
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

function formatHora(iso: string): string {
  if (!iso) return '—';
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  if (m) return `${m[1]}:${m[2]}`;
  const m2 = String(iso).match(/(\d{2}):(\d{2})(:\d{2})?/);
  if (m2) return `${m2[1]}:${m2[2]}`;
  return '—';
}

function formatBusinessDayLabel(iso: string): string {
  if (!iso || typeof iso !== 'string') return '—';
  const parts = iso.trim().split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

/** Celda con tooltip al pasar el ratón (solo web). */
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

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };

function getUniquePaymentMethods(rows: Row[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    for (const p of r.Payments ?? []) {
      const n = normalizePaymentName(p.MethodName);
      if (n && n !== 'Sin nombre') set.add(n);
    }
  }
  const known = KNOWN_PAYMENT_ORDER.filter((m) => set.has(m));
  const others = Array.from(set).filter((m) => !KNOWN_PAYMENT_ORDER.includes(m)).sort();
  return [...known, ...others];
}

function getAmountForMethod(row: Row, methodName: string): number {
  const target = normalizePaymentName(methodName);
  let total = 0;
  for (const p of row.Payments ?? []) {
    if (normalizePaymentName(p.MethodName) === target) total += Number(p.Amount) || 0;
  }
  return total;
}

function getTotalPayments(row: Row): number {
  return (row.Payments ?? []).reduce((s, p) => s + (Number(p.Amount) || 0), 0);
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

type OperatorId = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne' | 'between' | 'gt0' | 'eq0';

const OPERATORS: { id: OperatorId; label: string; short: string; hasValue: boolean; hasSecond: boolean }[] = [
  { id: 'gt', label: 'es mayor que', short: '>', hasValue: true, hasSecond: false },
  { id: 'lt', label: 'es menor que', short: '<', hasValue: true, hasSecond: false },
  { id: 'gte', label: 'mayor o igual', short: '≥', hasValue: true, hasSecond: false },
  { id: 'lte', label: 'menor o igual', short: '≤', hasValue: true, hasSecond: false },
  { id: 'eq', label: 'es igual a', short: '=', hasValue: true, hasSecond: false },
  { id: 'ne', label: 'es distinto de', short: '≠', hasValue: true, hasSecond: false },
  { id: 'between', label: 'está entre', short: 'entre', hasValue: true, hasSecond: true },
  { id: 'gt0', label: 'pagó con esta forma (> 0)', short: '> 0', hasValue: false, hasSecond: false },
  { id: 'eq0', label: 'no pagó con esta forma (= 0)', short: '= 0', hasValue: false, hasSecond: false },
];

type PaymentRule = {
  id: string;
  method: string;
  op: OperatorId;
  value: number;
  value2?: number;
};

function describeRule(r: PaymentRule): string {
  const op = OPERATORS.find((o) => o.id === r.op);
  if (!op) return `${r.method}`;
  if (op.hasSecond) return `${r.method} ${op.short} ${formatMoneda(r.value)} – ${formatMoneda(r.value2 ?? 0)}`;
  if (op.hasValue) return `${r.method} ${op.short} ${formatMoneda(r.value)}`;
  return `${r.method} ${op.short}`;
}

export default function RevisionFormasPagoScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fechaDesdeInput, setFechaDesdeInput] = useState<string>(todayDmy());
  const [fechaHastaInput, setFechaHastaInput] = useState<string>(todayDmy());
  const [consultedFrom, setConsultedFrom] = useState<string>('');
  const [consultedTo, setConsultedTo] = useState<string>('');
  const [filtroBusquedaInput, setFiltroBusquedaInput] = useState('');
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filtroTipoDoc, setFiltroTipoDoc] = useState('');
  const [filtroLocales, setFiltroLocales] = useState<string[]>([]);
  const [localesOpen, setLocalesOpen] = useState(false);
  const [reglasPago, setReglasPago] = useState<PaymentRule[]>([]);
  const [combMode, setCombMode] = useState<'AND' | 'OR'>('AND');
  const [builderMetodo, setBuilderMetodo] = useState<string>('');
  const [builderOp, setBuilderOp] = useState<OperatorId>('gt');
  const [builderValor, setBuilderValor] = useState<string>('');
  const [builderValor2, setBuilderValor2] = useState<string>('');
  const [builderMetodoOpen, setBuilderMetodoOpen] = useState(false);
  const [builderOpOpen, setBuilderOpOpen] = useState(false);
  const [appliedDesde, setAppliedDesde] = useState<string>('');
  const [appliedHasta, setAppliedHasta] = useState<string>('');
  const [appliedLocales, setAppliedLocales] = useState<string[]>([]);
  const [appliedReglas, setAppliedReglas] = useState<PaymentRule[]>([]);
  const [appliedCombMode, setAppliedCombMode] = useState<'AND' | 'OR'>('AND');
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    BusinessDay: 80,
    DateTime: 60,
    Local: 130,
    PosName: 90,
    DocumentType: 70,
    TicketNumber: 80,
    InvoiceNumber: 90,
    GrossAmount: 90,
    Total: 90,
  });

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

  const DEBOUNCE_MS = 250;
  useEffect(() => {
    const t = setTimeout(() => setFiltroBusqueda(filtroBusquedaInput), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filtroBusquedaInput]);

  const consultar = useCallback(async (opts: {
    desde: string;
    hasta: string;
    reglas: PaymentRule[];
    combMode: 'AND' | 'OR';
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
      const msg =
        opts.locales.length === 1
          ? `Rango máximo permitido: ${MAX_DAYS} días (incluso con 1 solo local)`
          : `Rango máximo permitido: ${MAX_DAYS} días con ${opts.locales.length === 0 ? 'todos los locales' : `${opts.locales.length} locales`}. Selecciona 1 solo local para ampliar hasta 365 días.`;
      setError(msg);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (isoFrom === isoTo) {
        params.set('businessDay', isoFrom);
      } else {
        params.set('dateFrom', isoFrom);
        params.set('dateTo', isoTo);
      }
      for (const wp of opts.locales) {
        if (wp) params.append('workplaceIds', wp);
      }
      if (opts.reglas.length > 0) {
        const rulesPayload = opts.reglas.map((r) => ({
          method: r.method,
          op: r.op,
          value: r.value,
          ...(r.value2 != null ? { value2: r.value2 } : {}),
        }));
        params.set('rules', JSON.stringify(rulesPayload));
        params.set('combMode', opts.combMode);
      }
      if (opts.refresh) params.set('refresh', '1');

      const res = await apiFetch(`/api/agora/invoices/payments-review?${params.toString()}`);
      const data = await safeJson<{
        rows?: Row[];
        error?: string;
        cachedAt?: string;
        fromCache?: boolean;
      }>(res);
      if (data.error) throw new Error(data.error);
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setConsultedFrom(isoFrom);
      setConsultedTo(isoTo);
      setAppliedDesde(isoFrom);
      setAppliedHasta(isoTo);
      setAppliedLocales([...opts.locales]);
      setAppliedReglas([...opts.reglas]);
      setAppliedCombMode(opts.combMode);
      setCachedAt(data.cachedAt ?? null);
      setFromCache(Boolean(data.fromCache));
      setCurrentPage(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const didAutoConsult = useRef(false);
  useEffect(() => {
    if (didAutoConsult.current) return;
    didAutoConsult.current = true;
    consultar({
      desde: fechaDesdeInput,
      hasta: fechaHastaInput,
      reglas: [],
      combMode: 'AND',
      locales: [],
    });
  }, [consultar, fechaDesdeInput, fechaHastaInput]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const paymentCols = useMemo(() => getUniquePaymentMethods(rows), [rows]);

  const metodosDisponibles = useMemo(() => {
    const canonicalFirst = KNOWN_PAYMENT_ORDER.slice();
    const extras = paymentCols.filter((m) => !canonicalFirst.includes(m));
    return [...canonicalFirst, ...extras];
  }, [paymentCols]);

  const tiposDocUnicos = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.DocumentType) s.add(r.DocumentType);
    return Array.from(s).sort();
  }, [rows]);

  const showBusinessDayCol = consultedFrom !== '' && consultedTo !== '' && consultedFrom !== consultedTo;

  const columnas = useMemo(() => {
    const base = [
      ...(showBusinessDayCol ? ['BusinessDay'] : []),
      'DateTime', 'Local', 'PosName', 'DocumentType', 'TicketNumber', 'InvoiceNumber', 'GrossAmount', 'Total',
    ];
    const ordered = KNOWN_PAYMENT_ORDER.filter((m) => paymentCols.includes(m));
    const others = paymentCols.filter((m) => !ordered.includes(m));
    return [...base, ...ordered, ...others];
  }, [paymentCols, showBusinessDayCol]);

  useEffect(() => {
    if (metodosDisponibles.length === 0) return;
    if (!builderMetodo) {
      setBuilderMetodo(metodosDisponibles[0]);
    }
  }, [metodosDisponibles, builderMetodo]);

  const rowsFiltrados = useMemo(() => {
    let list = rows;
    if (filtroTipoDoc) list = list.filter((r) => r.DocumentType === filtroTipoDoc);
    const q = filtroBusqueda.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const local = agoraCodeToNombre[r.WorkplaceId] ?? r.WorkplaceName ?? r.WorkplaceId ?? '';
        const searchStr = `${r.WorkplaceId} ${local} ${r.PosName ?? ''} ${r.PosId ?? ''} ${r.DocumentType} ${r.TicketNumber} ${r.InvoiceNumber} ${r.GrossAmount} ${r.BusinessDay}`.toLowerCase();
        return searchStr.includes(q);
      });
    }
    return list;
  }, [rows, filtroTipoDoc, filtroBusqueda, agoraCodeToNombre]);

  const currentOperator = useMemo(() => OPERATORS.find((o) => o.id === builderOp), [builderOp]);

  const ruleKey = (r: PaymentRule) => `${r.method}|${r.op}|${r.value}|${r.value2 ?? ''}`;
  const hasPendingRule = useMemo(() => {
    if (!currentOperator) return false;
    if (!builderMetodo) return false;
    if (!currentOperator.hasValue) return false;
    const v = parseFloat(builderValor.replace(',', '.'));
    if (Number.isNaN(v)) return false;
    if (currentOperator.hasSecond) {
      const v2 = parseFloat(builderValor2.replace(',', '.'));
      if (Number.isNaN(v2)) return false;
    }
    return true;
  }, [currentOperator, builderMetodo, builderValor, builderValor2]);

  const hasPendingChanges = useMemo(() => {
    if (hasPendingRule) return true;
    if (!appliedDesde || !appliedHasta) return false;
    const isoFrom = parseDateToYYYYMMDD(fechaDesdeInput) || '';
    const isoTo = parseDateToYYYYMMDD(fechaHastaInput) || '';
    if (isoFrom !== appliedDesde || isoTo !== appliedHasta) return true;
    const currLoc = [...filtroLocales].sort().join(',');
    const apliLoc = [...appliedLocales].sort().join(',');
    if (currLoc !== apliLoc) return true;
    if (reglasPago.length !== appliedReglas.length) return true;
    const a = reglasPago.map(ruleKey).sort().join(';');
    const b = appliedReglas.map(ruleKey).sort().join(';');
    if (a !== b) return true;
    if (reglasPago.length >= 2 && combMode !== appliedCombMode) return true;
    return false;
  }, [
    hasPendingRule,
    fechaDesdeInput, fechaHastaInput, filtroLocales, reglasPago, combMode,
    appliedDesde, appliedHasta, appliedLocales, appliedReglas, appliedCombMode,
  ]);

  const validacionRango = useMemo(() => {
    const isoFrom = parseDateToYYYYMMDD(fechaDesdeInput);
    const isoTo = parseDateToYYYYMMDD(fechaHastaInput);
    const nLocales = filtroLocales.length;
    const maxDias = nLocales === 1 ? 365 : 31;

    if (!isoFrom || !isoTo) {
      return {
        ok: false,
        estado: 'error' as const,
        mensaje: 'Introduce fechas válidas (dd/mm/aaaa)',
        maxDias,
        dias: 0,
      };
    }
    if (isoFrom > isoTo) {
      return {
        ok: false,
        estado: 'error' as const,
        mensaje: '«Desde» debe ser anterior o igual a «Hasta»',
        maxDias,
        dias: 0,
      };
    }
    const dStart = new Date(isoFrom + 'T12:00:00').getTime();
    const dEnd = new Date(isoTo + 'T12:00:00').getTime();
    const dias = Math.round((dEnd - dStart) / 86400000) + 1;

    if (dias > maxDias) {
      const mensaje =
        nLocales === 1
          ? `Rango de ${dias} días excede el máximo permitido (365 días, incluso con 1 solo local)`
          : nLocales === 0
            ? `Rango de ${dias} días no permitido con «Todos los locales» (máx 31). Selecciona 1 local para ampliar hasta 365.`
            : `Rango de ${dias} días no permitido con ${nLocales} locales (máx 31). Selecciona 1 solo local para ampliar hasta 365.`;
      return { ok: false, estado: 'error' as const, mensaje, maxDias, dias };
    }

    if (nLocales === 1 && dias > 31) {
      return {
        ok: true,
        estado: 'ampliado' as const,
        mensaje: `1 local seleccionado · rango ampliado hasta 365 días`,
        maxDias,
        dias,
      };
    }

    return {
      ok: true,
      estado: 'neutral' as const,
      mensaje: 'Máx 31 días con varios locales · hasta 365 días con 1 solo local',
      maxDias,
      dias,
    };
  }, [fechaDesdeInput, fechaHastaInput, filtroLocales]);

  const cachedAgoLabel = useMemo(() => {
    if (!cachedAt) return '';
    const delta = Math.max(0, nowTick - new Date(cachedAt).getTime());
    const secs = Math.floor(delta / 1000);
    if (secs < 5) return 'Datos recién obtenidos';
    if (secs < 60) return `Datos de hace ${secs}s`;
    const mins = Math.floor(secs / 60);
    return `Datos de hace ${mins} min${mins !== 1 ? '' : ''}`;
  }, [cachedAt, nowTick]);

  const { paginatedList, totalPages, totalCount, effectivePage } = useMemo(() => {
    const total = rowsFiltrados.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.max(1, Math.min(currentPage, pages));
    const start = (page - 1) * PAGE_SIZE;
    return {
      paginatedList: rowsFiltrados.slice(start, start + PAGE_SIZE),
      totalPages: pages,
      totalCount: total,
      effectivePage: page,
    };
  }, [rowsFiltrados, currentPage]);

  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(1);
  }, [currentPage, totalPages]);

  const totalFacturado = useMemo(
    () => rowsFiltrados.reduce((s, r) => s + getTotalPayments(r), 0),
    [rowsFiltrados]
  );

  const canAddRule = useMemo(() => {
    if (!builderMetodo) return false;
    if (!currentOperator) return false;
    if (!currentOperator.hasValue) return true;
    const v = parseFloat(builderValor.replace(',', '.'));
    if (Number.isNaN(v)) return false;
    if (currentOperator.hasSecond) {
      const v2 = parseFloat(builderValor2.replace(',', '.'));
      if (Number.isNaN(v2)) return false;
    }
    return true;
  }, [builderMetodo, currentOperator, builderValor, builderValor2]);

  const addRule = useCallback(() => {
    if (!canAddRule || !currentOperator) return;
    const v = currentOperator.hasValue ? parseFloat(builderValor.replace(',', '.')) : 0;
    const v2 = currentOperator.hasSecond ? parseFloat(builderValor2.replace(',', '.')) : undefined;
    const newRule: PaymentRule = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      method: builderMetodo,
      op: builderOp,
      value: v,
      value2: v2,
    };
    setReglasPago((prev) => [...prev, newRule]);
    setBuilderValor('');
    setBuilderValor2('');
    setCurrentPage(1);
  }, [canAddRule, currentOperator, builderValor, builderValor2, builderMetodo, builderOp]);

  const removeRule = useCallback((id: string) => {
    setReglasPago((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const clearRules = useCallback(() => {
    setReglasPago([]);
  }, []);

  const runConsulta = useCallback(
    (refresh = false) => {
      let reglasEfectivas = reglasPago;
      if (canAddRule && currentOperator) {
        const v = currentOperator.hasValue ? parseFloat(builderValor.replace(',', '.')) : 0;
        const v2 = currentOperator.hasSecond ? parseFloat(builderValor2.replace(',', '.')) : undefined;
        const newRule: PaymentRule = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          method: builderMetodo,
          op: builderOp,
          value: v,
          value2: v2,
        };
        reglasEfectivas = [...reglasPago, newRule];
        setReglasPago(reglasEfectivas);
        setBuilderValor('');
        setBuilderValor2('');
      }
      consultar({
        desde: fechaDesdeInput,
        hasta: fechaHastaInput,
        reglas: reglasEfectivas,
        combMode,
        locales: filtroLocales,
        refresh,
      });
    },
    [
      canAddRule, currentOperator, builderValor, builderValor2, builderMetodo, builderOp,
      reglasPago, fechaDesdeInput, fechaHastaInput, combMode, filtroLocales, consultar,
    ],
  );

  const totalesPorMetodo = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of paymentCols) map[m] = 0;
    for (const r of rowsFiltrados) {
      for (const m of paymentCols) map[m] += getAmountForMethod(r, m);
    }
    return map;
  }, [rowsFiltrados, paymentCols]);

  const getHeaderLabel = (col: string): string => {
    const labels: Record<string, string> = {
      BusinessDay: 'Fecha',
      DateTime: 'Hora',
      Local: 'Local',
      PosName: 'TPV',
      DocumentType: 'Tipo',
      TicketNumber: 'Nº Ticket',
      InvoiceNumber: 'Nº Factura',
      GrossAmount: 'Bruto',
      Total: 'Total pagado',
    };
    return labels[col] ?? col;
  };

  const isMonedaCol = (col: string) =>
    col === 'GrossAmount' || col === 'Total' || paymentCols.includes(col);

  const getValorCelda = useCallback(
    (r: Row, col: string): string => {
      if (col === 'BusinessDay') return formatBusinessDayLabel(r.BusinessDay);
      if (col === 'DateTime') return formatHora(r.DateTime);
      if (col === 'Local') return agoraCodeToNombre[r.WorkplaceId] ?? r.WorkplaceName ?? r.WorkplaceId ?? '—';
      if (col === 'PosName') return r.PosName ?? (r.PosId != null ? String(r.PosId) : '—');
      if (col === 'DocumentType') return r.DocumentType || '—';
      if (col === 'TicketNumber') return r.TicketNumber || '—';
      if (col === 'InvoiceNumber') return r.InvoiceNumber || '—';
      if (col === 'GrossAmount') return formatMoneda(r.GrossAmount);
      if (col === 'Total') return formatMoneda(getTotalPayments(r));
      if (paymentCols.includes(col)) return formatMoneda(getAmountForMethod(r, col));
      return '—';
    },
    [agoraCodeToNombre, paymentCols]
  );

  const exportColumnas = useMemo(() => {
    const base = [
      ...(showBusinessDayCol ? ['BusinessDay'] : []),
      'DateTime', 'Local', 'PosName', 'DocumentType', 'TicketNumber', 'InvoiceNumber', 'GrossAmount', 'Total',
    ];
    const ordered = KNOWN_PAYMENT_ORDER.filter((m) => paymentCols.includes(m));
    const others = paymentCols.filter((m) => !ordered.includes(m));
    return [...base, ...ordered, ...others];
  }, [paymentCols, showBusinessDayCol]);

  const handleExportExcel = useCallback(() => {
    setShowDownloadMenu(false);
    const rowsExport = rowsFiltrados.map((r) => {
      const row: Record<string, string> = {};
      for (const col of exportColumnas) {
        row[getHeaderLabel(col)] = getValorCelda(r, col);
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rowsExport);
    const MONEY_W = 16;
    ws['!cols'] = exportColumnas.map((col) => ({
      wch:
        col === 'BusinessDay' ? 12 :
        col === 'DateTime' ? 8 :
        col === 'Local' ? 20 :
        col === 'PosName' ? 14 :
        col === 'DocumentType' ? 10 :
        col === 'TicketNumber' || col === 'InvoiceNumber' ? 14 :
        MONEY_W,
    }));
    const headerStyle = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0EA5E9' } } };
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = headerStyle;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Revisión formas pago');
    const suffix =
      consultedFrom && consultedTo
        ? consultedFrom === consultedTo
          ? consultedFrom
          : `${consultedFrom}_a_${consultedTo}`
        : 'sin_fecha';
    XLSX.writeFile(wb, `revision_formas_pago_${suffix}.xlsx`);
  }, [rowsFiltrados, exportColumnas, getValorCelda, consultedFrom, consultedTo]);

  const handleExportPdf = useCallback(() => {
    setShowDownloadMenu(false);
    if (Platform.OS !== 'web') return;

    const landscape = exportColumnas.length >= 9;
    const rangoTxt =
      consultedFrom && consultedTo
        ? consultedFrom === consultedTo
          ? formatBusinessDayLabel(consultedFrom)
          : `${formatBusinessDayLabel(consultedFrom)} — ${formatBusinessDayLabel(consultedTo)}`
        : '—';
    const localesTxt =
      appliedLocales.length === 0
        ? 'Todos'
        : appliedLocales
            .map((code) => agoraCodeToNombre[code] ?? code)
            .join(', ');
    const reglasTxt =
      appliedReglas.length === 0
        ? 'Sin reglas'
        : appliedReglas.map((r) => describeRule(r)).join(
            appliedReglas.length >= 2 ? (appliedCombMode === 'OR' ? ' O ' : ' Y ') : '',
          );
    const generado = new Date().toLocaleString('es-ES');
    const meta = [
      `Rango: ${rangoTxt}`,
      `Locales: ${localesTxt}`,
      `Reglas: ${reglasTxt}`,
      `Generado: ${generado}  ·  Registros: ${rowsFiltrados.length}`,
    ];

    const headers = exportColumnas.map((col) => getHeaderLabel(col));
    const rows = rowsFiltrados.map((r) => exportColumnas.map((col) => getValorCelda(r, col)));

    const totalsRow = exportColumnas.map((col) => {
      if (col === 'Total') return formatMoneda(totalFacturado);
      if (paymentCols.includes(col)) return formatMoneda(totalesPorMetodo[col] ?? 0);
      return '';
    });
    totalsRow[0] = 'TOTALES';

    const moneyColIndexes: number[] = [];
    exportColumnas.forEach((col, i) => {
      if (col === 'GrossAmount' || col === 'Total' || paymentCols.includes(col)) moneyColIndexes.push(i);
    });

    const suffix =
      consultedFrom && consultedTo
        ? consultedFrom === consultedTo
          ? consultedFrom
          : `${consultedFrom}_a_${consultedTo}`
        : 'sin_fecha';

    exportRevisionFormasPagoPdf({
      headers,
      rows,
      totalsRow,
      moneyColIndexes,
      meta,
      title: 'Revisión formas de pago',
      filename: `revision_formas_pago_${suffix}.pdf`,
      landscape,
    });
  }, [
    exportColumnas, rowsFiltrados, consultedFrom, consultedTo, appliedLocales, appliedReglas, appliedCombMode,
    agoraCodeToNombre, getValorCelda, getHeaderLabel, paymentCols, totalesPorMetodo, totalFacturado,
  ]);

  // Redimensionado de columnas (misma lógica que cierres-teoricos)
  const getColWidth = useCallback(
    (col: string) => Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, columnWidths[col] ?? DEFAULT_COL_WIDTH)),
    [columnWidths]
  );
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
  const handleWebResizeStart = useCallback(
    (col: string) => (e: { nativeEvent: { clientX: number } }) => {
      startResize(col, e.nativeEvent.clientX);
      const onMove = (ev: MouseEvent) => onResizeMove(ev.clientX);
      const onUp = () => {
        stopResize();
        (globalThis as typeof window).removeEventListener('mousemove', onMove);
        (globalThis as typeof window).removeEventListener('mouseup', onUp);
      };
      (globalThis as typeof window).addEventListener('mousemove', onMove);
      (globalThis as typeof window).addEventListener('mouseup', onUp);
    },
    [startResize, onResizeMove, stopResize]
  );
  const resizeHandlers = useMemo(() => {
    const map: Record<string, ReturnType<typeof PanResponder.create>> = {};
    for (const col of columnas) {
      map[col] = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (_, g) => startResize(col, g.moveX),
        onPanResponderMove: (_, g) => onResizeMove(g.moveX),
        onPanResponderRelease: stopResize,
      });
    }
    return map;
  }, [columnas, startResize, onResizeMove, stopResize]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Revisión formas de pago</Text>
        {consultedFrom && consultedTo ? (
          <Text style={styles.subtitle}>
            · {consultedFrom === consultedTo
              ? formatBusinessDayLabel(consultedFrom)
              : `${formatBusinessDayLabel(consultedFrom)} → ${formatBusinessDayLabel(consultedTo)}`}
          </Text>
        ) : null}
      </View>

      <View style={styles.toolbarRow}>
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusquedaInput}
            onChangeText={setFiltroBusquedaInput}
            placeholder="Buscar por local, TPV, Nº ticket, Nº factura…"
            placeholderTextColor="#94a3b8"
          />
        </View>
        <TouchableOpacity
          style={[styles.toolbarBtn, showFilterPanel && styles.toolbarBtnActive]}
          onPress={() => setShowFilterPanel((v) => !v)}
        >
          <MaterialIcons name="filter-list" size={16} color={showFilterPanel ? '#fff' : '#64748b'} />
          <Text style={[styles.toolbarBtnText, showFilterPanel && styles.toolbarBtnTextActive]}>Filtro</Text>
        </TouchableOpacity>
        <View style={styles.downloadWrap}>
          <TouchableOpacity
            style={styles.toolbarBtn}
            onPress={() => setShowDownloadMenu((v) => !v)}
            disabled={rowsFiltrados.length === 0}
          >
            <MaterialIcons name="download" size={16} color={rowsFiltrados.length === 0 ? '#94a3b8' : '#0ea5e9'} />
            <Text style={[styles.toolbarBtnText, rowsFiltrados.length === 0 && styles.toolbarBtnTextDisabled]}>Descargar</Text>
          </TouchableOpacity>
          {showDownloadMenu && (
            <>
              <Pressable style={styles.downloadOverlay} onPress={() => setShowDownloadMenu(false)} />
              <View style={styles.downloadMenu}>
                <TouchableOpacity style={styles.downloadMenuItem} onPress={handleExportExcel}>
                  <MaterialIcons name="table-chart" size={16} color="#16a34a" />
                  <Text style={styles.downloadMenuText}>Excel (.xlsx)</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.downloadMenuItem, Platform.OS !== 'web' && styles.toolbarBtnDisabled]}
                  onPress={handleExportPdf}
                  disabled={Platform.OS !== 'web'}
                >
                  <MaterialIcons name="picture-as-pdf" size={16} color="#dc2626" />
                  <Text style={styles.downloadMenuText}>
                    PDF (.pdf){Platform.OS !== 'web' ? ' · solo web' : ''}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>

      <View style={styles.queryBlock}>
        <Text style={styles.queryBlockTitle}>Consulta</Text>
        <View style={styles.queryRow}>
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
            <Text style={styles.dateLabel}>Local</Text>
            <View style={styles.builderDropdownWrap}>
              <TouchableOpacity
                style={styles.builderDropdownTrigger}
                onPress={() => setLocalesOpen((v) => !v)}
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
                      style={[styles.builderDropdownOption, filtroLocales.length === 0 && styles.builderDropdownOptionSelected]}
                      onPress={() => setFiltroLocales([])}
                    >
                      <Text style={[styles.builderDropdownOptionText, filtroLocales.length === 0 && styles.builderDropdownOptionTextSelected]}>
                        Todos
                      </Text>
                      {filtroLocales.length === 0 ? <MaterialIcons name="check" size={16} color="#0ea5e9" /> : null}
                    </TouchableOpacity>
                    <View style={styles.ddDivider} />
                    <ScrollView style={styles.builderDropdownScroll} nestedScrollEnabled>
                      {locales.map((loc) => {
                        const code = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();
                        const nombre = String(loc.nombre ?? loc.Nombre ?? '').trim() || code || '—';
                        if (!code) return null;
                        const sel = filtroLocales.includes(code);
                        return (
                          <TouchableOpacity
                            key={code}
                            style={[styles.builderDropdownOption, sel && styles.builderDropdownOptionSelected]}
                            onPress={() =>
                              setFiltroLocales((prev) =>
                                prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code],
                              )
                            }
                          >
                            <View style={styles.ddCheckbox}>
                              {sel ? <MaterialIcons name="check-box" size={16} color="#0ea5e9" /> : <MaterialIcons name="check-box-outline-blank" size={16} color="#94a3b8" />}
                            </View>
                            <Text style={[styles.builderDropdownOptionText, sel && styles.builderDropdownOptionTextSelected, { flex: 1 }]} numberOfLines={1}>
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

          <TouchableOpacity
            style={[
              styles.toolbarBtnPrimary,
              hasPendingChanges && styles.toolbarBtnPending,
              (loading || !validacionRango.ok) && styles.toolbarBtnDisabled,
            ]}
            onPress={() => runConsulta(false)}
            disabled={loading || !validacionRango.ok}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <MaterialIcons name={hasPendingChanges ? 'flash-on' : 'search'} size={16} color="#fff" />
                <Text style={styles.toolbarBtnPrimaryText}>
                  {hasPendingChanges ? 'Aplicar' : 'Consultar'}
                </Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.toolbarBtn, (loading || !validacionRango.ok) && styles.toolbarBtnDisabled]}
            onPress={() => runConsulta(true)}
            disabled={loading || !validacionRango.ok}
          >
            <MaterialIcons name="refresh" size={16} color="#64748b" />
            <Text style={styles.toolbarBtnText}>Refrescar</Text>
          </TouchableOpacity>

          {cachedAt ? (
            <View style={styles.cacheBadge}>
              <MaterialIcons name={fromCache ? 'bolt' : 'cloud-done'} size={12} color={fromCache ? '#d97706' : '#0ea5e9'} />
              <Text style={[styles.cacheBadgeText, fromCache && styles.cacheBadgeTextCached]}>
                {cachedAgoLabel}{fromCache ? ' · caché' : ''}
              </Text>
            </View>
          ) : null}
        </View>

        <View
          style={[
            styles.rangoBadge,
            validacionRango.estado === 'ampliado' && styles.rangoBadgeAmpliado,
            validacionRango.estado === 'error' && styles.rangoBadgeError,
          ]}
        >
          <MaterialIcons
            name={
              validacionRango.estado === 'error'
                ? 'warning'
                : validacionRango.estado === 'ampliado'
                  ? 'lock-open'
                  : 'info-outline'
            }
            size={14}
            color={
              validacionRango.estado === 'error'
                ? '#b91c1c'
                : validacionRango.estado === 'ampliado'
                  ? '#047857'
                  : '#475569'
            }
          />
          <Text
            style={[
              styles.rangoBadgeText,
              validacionRango.estado === 'ampliado' && styles.rangoBadgeTextAmpliado,
              validacionRango.estado === 'error' && styles.rangoBadgeTextError,
            ]}
          >
            {validacionRango.mensaje}
          </Text>
        </View>

        <View style={styles.builderRow}>
          <Text style={styles.builderLabel}>Forma de pago</Text>
          <View style={styles.builderDropdownWrap}>
            <TouchableOpacity
              style={styles.builderDropdownTrigger}
              onPress={() => setBuilderMetodoOpen((v) => !v)}
            >
              <Text style={styles.builderDropdownText} numberOfLines={1}>
                {builderMetodo || 'Selecciona'}
              </Text>
              <MaterialIcons name={builderMetodoOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
            </TouchableOpacity>
            {builderMetodoOpen && (
              <>
                <Pressable style={styles.ddOverlay} onPress={() => setBuilderMetodoOpen(false)} />
                <View style={styles.builderDropdownList}>
                  <ScrollView style={styles.builderDropdownScroll} nestedScrollEnabled>
                    {metodosDisponibles.map((m) => {
                      const sel = m === builderMetodo;
                      const presente = paymentCols.includes(m);
                      return (
                        <TouchableOpacity
                          key={m}
                          style={[styles.builderDropdownOption, sel && styles.builderDropdownOptionSelected]}
                          onPress={() => { setBuilderMetodo(m); setBuilderMetodoOpen(false); }}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                            <View style={[styles.methodDot, presente ? styles.methodDotPresent : styles.methodDotAbsent]} />
                            <Text style={[styles.builderDropdownOptionText, sel && styles.builderDropdownOptionTextSelected]}>{m}</Text>
                          </View>
                          {sel ? <MaterialIcons name="check" size={16} color="#0ea5e9" /> : null}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              </>
            )}
          </View>

          <View style={styles.builderDropdownWrap}>
            <TouchableOpacity
              style={styles.builderDropdownTrigger}
              onPress={() => setBuilderOpOpen((v) => !v)}
            >
              <Text style={styles.builderDropdownText} numberOfLines={1}>
                {currentOperator?.label ?? 'Operador'}
              </Text>
              <MaterialIcons name={builderOpOpen ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
            </TouchableOpacity>
            {builderOpOpen && (
              <>
                <Pressable style={styles.ddOverlay} onPress={() => setBuilderOpOpen(false)} />
                <View style={styles.builderDropdownList}>
                  <ScrollView style={styles.builderDropdownScroll} nestedScrollEnabled>
                    {OPERATORS.map((op) => {
                      const sel = op.id === builderOp;
                      return (
                        <TouchableOpacity
                          key={op.id}
                          style={[styles.builderDropdownOption, sel && styles.builderDropdownOptionSelected]}
                          onPress={() => { setBuilderOp(op.id); setBuilderOpOpen(false); }}
                        >
                          <Text style={[styles.builderDropdownOptionText, sel && styles.builderDropdownOptionTextSelected]}>
                            <Text style={styles.builderOpShort}>{op.short}</Text>  {op.label}
                          </Text>
                          {sel ? <MaterialIcons name="check" size={16} color="#0ea5e9" /> : null}
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              </>
            )}
          </View>

          {currentOperator?.hasValue && (
            <View style={styles.builderValueWrap}>
              <TextInput
                style={styles.builderValueInput}
                value={builderValor}
                onChangeText={setBuilderValor}
                placeholder={currentOperator.hasSecond ? 'Min' : 'Valor'}
                placeholderTextColor="#94a3b8"
                keyboardType="decimal-pad"
              />
              <Text style={styles.builderValueSuffix}>€</Text>
            </View>
          )}
          {currentOperator?.hasSecond && (
            <>
              <Text style={styles.builderRangeSep}>y</Text>
              <View style={styles.builderValueWrap}>
                <TextInput
                  style={styles.builderValueInput}
                  value={builderValor2}
                  onChangeText={setBuilderValor2}
                  placeholder="Max"
                  placeholderTextColor="#94a3b8"
                  keyboardType="decimal-pad"
                />
                <Text style={styles.builderValueSuffix}>€</Text>
              </View>
            </>
          )}

          <TouchableOpacity
            style={[styles.builderAddBtn, !canAddRule && styles.toolbarBtnDisabled]}
            onPress={addRule}
            disabled={!canAddRule}
          >
            <MaterialIcons name="add" size={16} color="#fff" />
            <Text style={styles.builderAddBtnText}>Añadir</Text>
          </TouchableOpacity>
        </View>

        {reglasPago.length > 0 && (
          <View style={styles.reglasRow}>
            {reglasPago.length >= 2 && (
              <View style={styles.combSwitchWrap}>
                <Text style={styles.builderLabel}>Combinar</Text>
                <View style={styles.combSwitch}>
                  <TouchableOpacity
                    style={[styles.combSwitchBtn, combMode === 'AND' && styles.combSwitchBtnActive]}
                    onPress={() => setCombMode('AND')}
                  >
                    <Text style={[styles.combSwitchText, combMode === 'AND' && styles.combSwitchTextActive]}>Todas (AND)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.combSwitchBtn, combMode === 'OR' && styles.combSwitchBtnActive]}
                    onPress={() => setCombMode('OR')}
                  >
                    <Text style={[styles.combSwitchText, combMode === 'OR' && styles.combSwitchTextActive]}>Alguna (OR)</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            <View style={styles.reglasChipsWrap}>
              {reglasPago.map((r) => (
                <View key={r.id} style={styles.reglaChip}>
                  <Text style={styles.reglaChipText}>{describeRule(r)}</Text>
                  <TouchableOpacity onPress={() => removeRule(r.id)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} style={styles.reglaChipClose}>
                    <MaterialIcons name="close" size={14} color="#64748b" />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity onPress={clearRules} style={styles.reglasClearBtn}>
                <MaterialIcons name="clear-all" size={14} color="#64748b" />
                <Text style={styles.reglasClearText}>Eliminar todas</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      <View style={styles.totalFacturadoBox}>
        <Text style={styles.totalFacturadoLabel}>Total pagado</Text>
        <Text style={styles.totalFacturadoValue}>{formatMoneda(totalFacturado)}</Text>
      </View>

      {paymentCols.length > 0 && (
        <View style={styles.totalesChipsRow}>
          {paymentCols.map((m) => (
            <View key={m} style={styles.totalChip}>
              <Text style={styles.totalChipLabel}>{m}</Text>
              <Text style={styles.totalChipValue}>{formatMoneda(totalesPorMetodo[m] ?? 0)}</Text>
            </View>
          ))}
        </View>
      )}

      {showFilterPanel && (
        <View style={styles.filterPanel}>
          <View style={styles.filterRow}>
            <TouchableOpacity
              style={styles.filterClearBtn}
              onPress={() => {
                setFiltroTipoDoc('');
                setFiltroBusquedaInput('');
              }}
            >
              <MaterialIcons name="clear" size={14} color="#64748b" />
              <Text style={styles.filterClearText}>Limpiar</Text>
            </TouchableOpacity>
          </View>
          {tiposDocUnicos.length > 1 && (
            <View style={styles.filterRowLocal}>
              <Text style={styles.filterLabel}>Tipo documento</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterLocalesWrap} contentContainerStyle={styles.filterLocalesContent}>
                <TouchableOpacity
                  style={[styles.filterChip, !filtroTipoDoc && styles.filterChipActive]}
                  onPress={() => setFiltroTipoDoc('')}
                >
                  <Text style={[styles.filterChipText, !filtroTipoDoc && styles.filterChipTextActive]}>Todos</Text>
                </TouchableOpacity>
                {tiposDocUnicos.map((t) => {
                  const sel = filtroTipoDoc === t;
                  return (
                    <TouchableOpacity
                      key={t}
                      style={[styles.filterChip, sel && styles.filterChipActive]}
                      onPress={() => setFiltroTipoDoc(sel ? '' : t)}
                    >
                      <Text style={[styles.filterChipText, sel && styles.filterChipTextActive]}>{t}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          )}
        </View>
      )}

      <View style={styles.infoRow}>
        <Text style={styles.infoLine}>
          {loading
            ? 'Consultando Ágora…'
            : error
              ? ''
              : totalCount === 0
                ? consultedFrom && consultedTo
                  ? `Sin registros en ${consultedFrom === consultedTo ? formatBusinessDayLabel(consultedFrom) : `${formatBusinessDayLabel(consultedFrom)} → ${formatBusinessDayLabel(consultedTo)}`}`
                  : 'Selecciona fechas y pulsa Consultar'
                : `${totalCount} registro${totalCount !== 1 ? 's' : ''} (${paymentCols.length} forma${paymentCols.length !== 1 ? 's' : ''} de pago detectada${paymentCols.length !== 1 ? 's' : ''})`}
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
        )}
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => runConsulta(false)}
          >
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
            <View style={styles.headerRowTable}>
              {columnas.map((col) => (
                <View key={col} style={[styles.cellHeader, isMonedaCol(col) && styles.cellRight, { width: getColWidth(col) }]}>
                  <Text style={styles.cellHeaderText} numberOfLines={1}>{getHeaderLabel(col)}</Text>
                  <View
                    style={[styles.resizeHandle, Platform.OS === 'web' && (styles.resizeHandleWeb as object)]}
                    {...(Platform.OS === 'web'
                      ? { onMouseDown: handleWebResizeStart(col) }
                      : (resizeHandlers[col]?.panHandlers || {}))}
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
                      {rows.length === 0
                        ? consultedFrom
                          ? 'Sin datos para el rango consultado'
                          : 'Consulta un rango de fechas para ver la información'
                        : 'Ningún resultado con el filtro'}
                    </Text>
                  </View>
                ) : (
                  paginatedList.map((r, idx) => (
                    <View key={`${r.WorkplaceId}-${r.PosId ?? ''}-${r.InvoiceNumber}-${r.TicketNumber}-${idx}`} style={styles.dataRow}>
                      {columnas.map((col) => {
                        const valor = getValorCelda(r, col);
                        return (
                          <CellWithTooltip
                            key={col}
                            fullText={String(valor ?? '')}
                            cellStyle={[isMonedaCol(col) && styles.cellRight, { width: getColWidth(col) }]}
                            textStyle={[styles.cellText, (col === 'Total' || col === 'GrossAmount') && styles.cellBold]}
                          />
                        );
                      })}
                    </View>
                  ))
                )}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, backgroundColor: '#fff' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 17, fontWeight: '600', color: '#1e293b', letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8, position: 'relative', zIndex: 100, flexWrap: 'wrap' },
  searchWrap: { flex: 1, minWidth: 200, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 8, paddingHorizontal: 10 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 13, color: '#334155' },
  dateWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dateLabel: { fontSize: 11, color: '#64748b', fontWeight: '600' },
  dateInput: { backgroundColor: '#fff', borderRadius: 6, paddingVertical: 4, paddingHorizontal: 6, fontSize: 12, color: '#334155', borderWidth: StyleSheet.hairlineWidth, borderColor: '#cbd5e1', minHeight: 30, minWidth: 120 },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f8fafc', borderRadius: 6, borderWidth: 1, borderColor: '#e2e8f0' },
  toolbarBtnPrimary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#0ea5e9', borderRadius: 6 },
  toolbarBtnPrimaryText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  toolbarBtnPending: { backgroundColor: '#f97316' },
  toolbarBtnDisabled: { opacity: 0.6 },
  toolbarBtnActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  toolbarBtnText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  toolbarBtnTextActive: { color: '#fff' },
  toolbarBtnTextDisabled: { color: '#94a3b8' },
  downloadWrap: { position: 'relative', zIndex: 50 },
  downloadOverlay: { position: 'fixed' as 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 49 },
  downloadMenu: {
    position: 'absolute', top: '100%', right: 0, marginTop: 4,
    backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0',
    minWidth: 150, zIndex: 100,
    ...(Platform.OS === 'web' && { boxShadow: '0 4px 12px rgba(0,0,0,0.12)' } as object),
  },
  downloadMenuItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12 },
  downloadMenuText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  totalFacturadoBox: { backgroundColor: '#d1fae5', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalFacturadoLabel: { fontSize: 14, fontWeight: '600', color: '#065f46' },
  totalFacturadoValue: { fontSize: 15, fontWeight: '700', color: '#047857' },
  totalesChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  totalChip: { backgroundColor: '#f0f9ff', borderWidth: 1, borderColor: '#bae6fd', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  totalChipLabel: { fontSize: 11, color: '#0369a1', fontWeight: '600' },
  totalChipValue: { fontSize: 12, color: '#0c4a6e', fontWeight: '700' },
  filterPanel: {
    backgroundColor: '#fafbfc', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#e5e7eb',
    ...(Platform.OS === 'web' && { boxShadow: '0 1px 2px rgba(0,0,0,0.04)' } as object),
  },
  queryBlock: {
    backgroundColor: '#f8fafc', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 10,
    borderWidth: 1, borderColor: '#e2e8f0',
    position: 'relative', zIndex: 90,
  },
  queryBlockTitle: { fontSize: 10, fontWeight: '700', color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  queryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, position: 'relative', zIndex: 90 },
  builderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', position: 'relative', zIndex: 60 },
  builderLabel: { fontSize: 10, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 },
  builderDropdownWrap: { position: 'relative', zIndex: 70 },
  builderDropdownTrigger: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#fff', borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1',
    paddingVertical: 6, paddingHorizontal: 10, minWidth: 150, minHeight: 32,
  },
  builderDropdownText: { fontSize: 12, color: '#334155', fontWeight: '500', flex: 1 },
  builderOpShort: { fontFamily: (Platform.OS === 'web' ? 'monospace' : undefined), fontWeight: '700', color: '#0ea5e9' },
  ddOverlay: { position: 'fixed' as 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 199 },
  builderDropdownList: {
    position: 'absolute', top: '100%', left: 0, marginTop: 4,
    backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0',
    minWidth: 220, zIndex: 200,
    ...(Platform.OS === 'web' && { boxShadow: '0 4px 12px rgba(0,0,0,0.12)' } as object),
  },
  builderDropdownScroll: { maxHeight: 240 },
  builderDropdownOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 10, gap: 8 },
  ddDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#e2e8f0' },
  methodDot: { width: 6, height: 6, borderRadius: 3 },
  methodDotPresent: { backgroundColor: '#22c55e' },
  methodDotAbsent: { backgroundColor: '#cbd5e1' },
  ddCheckbox: { width: 18, alignItems: 'center' },
  cacheBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: '#f0f9ff', borderRadius: 10, borderWidth: 1, borderColor: '#bae6fd' },
  cacheBadgeText: { fontSize: 10, color: '#0369a1', fontWeight: '600' },
  cacheBadgeTextCached: { color: '#92400e' },
  rangoBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4, paddingHorizontal: 10,
    backgroundColor: '#f8fafc', borderRadius: 6,
    borderWidth: 1, borderColor: '#e2e8f0',
    marginTop: 6,
  },
  rangoBadgeAmpliado: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' },
  rangoBadgeError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  rangoBadgeText: { fontSize: 11, color: '#475569', fontWeight: '500' },
  rangoBadgeTextAmpliado: { color: '#047857', fontWeight: '600' },
  rangoBadgeTextError: { color: '#b91c1c', fontWeight: '600' },
  builderDropdownOptionSelected: { backgroundColor: '#f0f9ff' },
  builderDropdownOptionText: { fontSize: 12, color: '#334155' },
  builderDropdownOptionTextSelected: { color: '#0369a1', fontWeight: '600' },
  builderValueWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1',
    paddingHorizontal: 8, minHeight: 32,
  },
  builderValueInput: { paddingVertical: 6, fontSize: 12, color: '#334155', minWidth: 80, outlineStyle: 'none' as 'none' },
  builderValueSuffix: { fontSize: 11, color: '#64748b', marginLeft: 4, fontWeight: '600' },
  builderRangeSep: { fontSize: 11, color: '#64748b' },
  builderAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 7, paddingHorizontal: 12, backgroundColor: '#0ea5e9', borderRadius: 6 },
  builderAddBtnText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  reglasRow: { marginTop: 10, gap: 6 },
  combSwitchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  combSwitch: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1', overflow: 'hidden' },
  combSwitchBtn: { paddingVertical: 4, paddingHorizontal: 10 },
  combSwitchBtnActive: { backgroundColor: '#0ea5e9' },
  combSwitchText: { fontSize: 11, color: '#64748b', fontWeight: '600' },
  combSwitchTextActive: { color: '#fff' },
  reglasChipsWrap: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  reglaChip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#bfdbfe',
    borderRadius: 14, paddingVertical: 3, paddingHorizontal: 10, gap: 4,
  },
  reglaChipText: { fontSize: 11, color: '#1e40af', fontWeight: '600' },
  reglaChipClose: { marginLeft: 2 },
  reglasClearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8 },
  reglasClearText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  filterRow: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', gap: 10 },
  filterRowLocal: { marginTop: 8, width: '100%' },
  filterLabel: { fontSize: 10, fontWeight: '600', color: '#6b7280', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3 },
  filterLocalesWrap: { maxHeight: 26 },
  filterLocalesContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  filterChip: { paddingVertical: 2, paddingHorizontal: 6, backgroundColor: '#f3f4f6', borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: '#e5e7eb' },
  filterChipActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  filterChipText: { fontSize: 10, color: '#6b7280', fontWeight: '500' },
  filterChipTextActive: { color: '#fff' },
  filterClearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 5, paddingHorizontal: 8 },
  filterClearText: { fontSize: 11, color: '#64748b', fontWeight: '500' },
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
  cellHeader: { paddingHorizontal: 6, paddingVertical: 6, paddingRight: 18, justifyContent: 'center', position: 'relative' },
  cell: { paddingHorizontal: 6, paddingVertical: 5, justifyContent: 'center', position: 'relative' },
  cellTooltip: {
    position: 'absolute', left: 0, bottom: '100%', marginBottom: 2,
    backgroundColor: '#fef9c3', paddingHorizontal: 6, paddingVertical: 4,
    borderRadius: 4, maxWidth: 280, zIndex: 1000,
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
