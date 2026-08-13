/**
 * RRHH — Bonus mensual (MVP).
 * Layout 50/50: resumen (izq) + desglose por empresa (der).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import {
  generarPdfBonusMensual,
  pdfBonusMensualFileSlug,
  type BonusPdfDatos,
} from '../../lib/bonusMensualPdf';
import {
  fechaCorteMediaRealObjetivos,
  mediasPorDiaSemanaDesdeFilas,
  obtenerFilasObjetivos,
  type MediasDiaSemanaFila,
} from '../../lib/objetivosFilasApi';
import { apiFetch } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';
import { formatMoneda } from '../../utils/formatMoneda';
import { MIN_TOUCH } from '../../constants/layout';

const MESES_NOMBRE = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
] as const;

const MESES_OPCIONES = MESES_NOMBRE.map((nombre, i) => ({
  id: String(i + 1),
  titulo: nombre,
}));

type IncentivoDetalle = {
  campanaId?: string;
  campanaNombre?: string;
  destinatario?: string;
  productId?: string;
  productName?: string;
  agoraUserId?: string | null;
  userName?: string;
  unidades?: number;
  incentivoEur?: number;
};

type BonusLocal = {
  localId: string;
  localNombre: string;
  realGross: number;
  objGross: number;
  desvGross: number;
  desvSinIva: number;
  huecoGross?: number;
  incentivosCampana: number;
  baseFondo: number;
  pctFondo: number | null;
  pctEfectivo: number;
  fondo: number;
  /** Incentivos + fondo (lo pagado en conjunto). */
  total?: number;
  incentivosDetalle?: IncentivoDetalle[];
};

type BonusTotales = {
  realGross: number;
  objGross: number;
  desvGross: number;
  desvSinIva: number;
  incentivos: number;
  baseFondo: number;
  fondo: number;
  total?: number;
};

type BonusEmpresa = {
  id_empresa: string;
  nombre: string;
  totales: BonusTotales;
  locales: BonusLocal[];
};

type BonusResponse = {
  mes: string;
  anio?: number;
  hastaFecha: string;
  estado: 'borrador' | 'cerrado' | string;
  pctDefaultGlobal: number;
  empresas: BonusEmpresa[];
  totalesGrupo: BonusTotales;
  avisos?: string[];
  error?: string;
};

function mesAnioPorDefecto(): { anio: string; mes: string } {
  const j = fechaJornadaNegocioIso();
  const [anio, mes] = j.split('-');
  return { anio, mes: String(Number(mes)) };
}

function parsePctInput(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return n;
}

function formatPctDisplay(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return String(n);
}

function empKeyOf(emp: BonusEmpresa): string {
  return emp.id_empresa || emp.nombre;
}

function csvEscape(val: string | number | null | undefined): string {
  const s = val == null ? '' : String(val);
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function totalDeLocal(loc: Pick<BonusLocal, 'incentivosCampana' | 'fondo' | 'total'>): number {
  if (loc.total != null && Number.isFinite(loc.total)) return Number(loc.total);
  return round2((Number(loc.incentivosCampana) || 0) + (Number(loc.fondo) || 0));
}

function totalDeTotales(t: BonusTotales): number {
  if (t.total != null && Number.isFinite(t.total)) return Number(t.total);
  return round2((Number(t.incentivos) || 0) + (Number(t.fondo) || 0));
}

function buildCsv(data: BonusResponse): string {
  const sep = ';';
  const lines: string[] = [];
  lines.push(
    ['tipo', 'empresa', 'local', 'empleado', 'producto', 'uds', 'incentivoEur', 'fondo', 'total'].join(sep),
  );

  for (const emp of data.empresas || []) {
    for (const loc of emp.locales || []) {
      lines.push(
        [
          'fondo_local',
          csvEscape(emp.nombre),
          csvEscape(loc.localNombre),
          '',
          '',
          '',
          '',
          csvEscape(loc.fondo ?? 0),
          csvEscape(totalDeLocal(loc)),
        ].join(sep),
      );
      for (const d of loc.incentivosDetalle || []) {
        const empleado = d.destinatario === 'equipo' ? 'Equipo' : (d.userName || '—');
        lines.push(
          [
            'incentivo',
            csvEscape(emp.nombre),
            csvEscape(loc.localNombre),
            csvEscape(empleado),
            csvEscape(d.productName || d.productId || ''),
            csvEscape(d.unidades ?? 0),
            csvEscape(d.incentivoEur ?? 0),
            '',
            '',
          ].join(sep),
        );
      }
    }
  }

  const tg = data.totalesGrupo;
  if (tg) {
    lines.push(
      [
        'total_grupo',
        'GRUPO',
        '',
        '',
        '',
        '',
        csvEscape(tg.incentivos ?? 0),
        csvEscape(tg.fondo ?? 0),
        csvEscape(totalDeTotales(tg)),
      ].join(sep),
    );
  }

  return `\uFEFF${lines.join('\n')}`;
}

async function descargarCsv(contenido: string, filename: string) {
  if (Platform.OS === 'web') {
    const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const dir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
  if (!dir) throw new Error('No hay directorio para guardar el CSV');
  const fileUri = `${dir}${filename}`;
  await FileSystemLegacy.writeAsStringAsync(fileUri, contenido, {
    encoding: FileSystemLegacy.EncodingType.UTF8,
  });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(fileUri, { mimeType: 'text/csv', dialogTitle: filename });
  }
}

/** Mismo criterio que api/lib/bonus/bonusCalculo: override local (incl. 0) o global. */
function pctEfectivoDraft(pctLocal: number | null, pctGlobal: number): number {
  if (pctLocal != null) return pctLocal;
  return Number(pctGlobal) || 0;
}

function fondoComunDraft(base: number, pct: number): number {
  return round2(Math.max(0, Number(base) || 0) * ((Number(pct) || 0) / 100));
}

function emptyTotales(): BonusTotales {
  return {
    realGross: 0,
    objGross: 0,
    desvGross: 0,
    desvSinIva: 0,
    incentivos: 0,
    baseFondo: 0,
    fondo: 0,
    total: 0,
  };
}

/** Primer y último día del mes YYYY-MM. */
function rangoMesBonus(mesYYYYMM: string): { fechaInicio: string; fechaFin: string } {
  if (!/^\d{4}-\d{2}$/.test(mesYYYYMM)) return { fechaInicio: '', fechaFin: '' };
  const [ys, ms] = mesYYYYMM.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const fechaInicio = `${ys}-${ms}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const fechaFin = `${ys}-${ms}-${String(lastDay).padStart(2, '0')}`;
  return { fechaInicio, fechaFin };
}

/** Ayer en calendario local (YYYY-MM-DD). */
function ayerIsoLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Misma fórmula que Cajas → Objetivos. */
function variacionPctMediasVsComp(
  mediaReal: number,
  mediaComp: number,
): { pct: number; up: boolean } | null {
  if (!(mediaComp > 0) || mediaReal === mediaComp) return null;
  const pct = (mediaReal / mediaComp - 1) * 100;
  return { pct, up: mediaReal > mediaComp };
}

function mediasCacheKey(localId: string, mes: string): string {
  return `${localId}|${mes}`;
}

type MediasLocalState =
  | { status: 'loading' }
  | { status: 'ready'; filas: MediasDiaSemanaFila[] }
  | { status: 'error'; message: string }
  | { status: 'sin_agora' };

function sumTotales(acc: BonusTotales, part: BonusTotales): BonusTotales {
  const incentivos = part.incentivos || 0;
  const fondo = part.fondo || 0;
  const total = part.total != null ? part.total : round2(incentivos + fondo);
  return {
    realGross: round2(acc.realGross + (part.realGross || 0)),
    objGross: round2(acc.objGross + (part.objGross || 0)),
    desvGross: round2(acc.desvGross + (part.desvGross || 0)),
    desvSinIva: round2(acc.desvSinIva + (part.desvSinIva || 0)),
    incentivos: round2(acc.incentivos + incentivos),
    baseFondo: round2(acc.baseFondo + (part.baseFondo || 0)),
    fondo: round2(acc.fondo + fondo),
    total: round2((acc.total || 0) + total),
  };
}

/**
 * Payload PDF:
 * - Mes cerrado: snapshot API sin recalcular (auditoría).
 * - Borrador: % draft de la UI y fondo/total recalculados en cliente.
 */
function buildPdfDatosFromUi(
  data: BonusResponse,
  pctGlobalDraft: string,
  pctLocalDraft: Record<string, string>,
): BonusPdfDatos {
  const cerrado = String(data.estado || '').toLowerCase() === 'cerrado';
  const pctGlobal = cerrado
    ? (data.pctDefaultGlobal ?? 0)
    : (parsePctInput(pctGlobalDraft) ?? data.pctDefaultGlobal ?? 0);

  const empresas = (data.empresas || []).map((emp) => {
    const locales = (emp.locales || []).map((loc) => {
      if (cerrado) {
        const fondo = loc.fondo ?? 0;
        const total = totalDeLocal(loc);
        return {
          localId: loc.localId,
          localNombre: loc.localNombre,
          realGross: loc.realGross,
          objGross: loc.objGross,
          desvGross: loc.desvGross,
          desvSinIva: loc.desvSinIva,
          incentivosCampana: loc.incentivosCampana,
          baseFondo: loc.baseFondo,
          pctEfectivo: loc.pctEfectivo,
          fondo,
          total,
          incentivosDetalle: loc.incentivosDetalle,
        };
      }
      const pctLocal = Object.prototype.hasOwnProperty.call(pctLocalDraft, loc.localId)
        ? parsePctInput(pctLocalDraft[loc.localId] ?? '')
        : loc.pctFondo;
      const pctEff = pctEfectivoDraft(pctLocal, pctGlobal);
      const base = loc.desvSinIva ?? loc.baseFondo;
      const fondo = fondoComunDraft(base, pctEff);
      const total = round2((Number(loc.incentivosCampana) || 0) + fondo);
      return {
        localId: loc.localId,
        localNombre: loc.localNombre,
        realGross: loc.realGross,
        objGross: loc.objGross,
        desvGross: loc.desvGross,
        desvSinIva: loc.desvSinIva,
        incentivosCampana: loc.incentivosCampana,
        baseFondo: base,
        pctEfectivo: pctEff,
        fondo,
        total,
        incentivosDetalle: loc.incentivosDetalle,
      };
    });
    const totales = cerrado
      ? {
          ...emptyTotales(),
          ...(emp.totales || {}),
          total: totalDeTotales(emp.totales || emptyTotales()),
        }
      : locales.reduce(
          (acc, loc) =>
            sumTotales(acc, {
              realGross: loc.realGross,
              objGross: loc.objGross,
              desvGross: loc.desvGross,
              desvSinIva: loc.desvSinIva,
              incentivos: loc.incentivosCampana,
              baseFondo: loc.baseFondo,
              fondo: loc.fondo,
              total: loc.total,
            }),
          emptyTotales(),
        );
    return {
      id_empresa: emp.id_empresa,
      nombre: emp.nombre,
      totales,
      locales,
    };
  });
  const totalesGrupo = cerrado
    ? {
        ...emptyTotales(),
        ...(data.totalesGrupo || {}),
        total: totalDeTotales(data.totalesGrupo || emptyTotales()),
      }
    : empresas.reduce((acc, emp) => sumTotales(acc, emp.totales), emptyTotales());
  return {
    mes: data.mes,
    hastaFecha: data.hastaFecha,
    estado: data.estado,
    pctDefaultGlobal: pctGlobal,
    empresas,
    totalesGrupo,
  };
}

function PctInput({
  value,
  onCommit,
  placeholder,
  disabled,
  compact,
}: {
  value: string;
  onCommit: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);

  return (
    <TextInput
      style={[styles.pctInput, compact && styles.pctInputCompact, disabled && styles.pctInputDisabled]}
      value={text}
      editable={!disabled}
      onChangeText={(t) => setText(t.replace(/[^0-9.,]/g, ''))}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onCommit(text);
      }}
      keyboardType="decimal-pad"
      placeholder={placeholder ?? '%'}
      placeholderTextColor="#94a3b8"
    />
  );
}

function KpiChip({
  label,
  value,
  emphasize,
  badge,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
  /** Destaca "Total" (incentivos + fondo). */
  badge?: boolean;
}) {
  return (
    <View
      style={[
        styles.kpiChip,
        emphasize && styles.kpiChipEmph,
        badge && styles.kpiChipBadge,
      ]}
    >
      <View style={styles.kpiLabelRow}>
        <Text style={[styles.kpiLabel, badge && styles.kpiLabelBadge]}>{label}</Text>
        {badge ? (
          <View style={styles.totalBadge}>
            <Text style={styles.totalBadgeText}>Σ</Text>
          </View>
        ) : null}
      </View>
      <Text
        style={[
          styles.kpiValue,
          emphasize && styles.kpiValueEmph,
          badge && styles.kpiValueBadge,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

export default function BonusRrhhScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { isPhone, shouldStackPanels, shouldStackToolbar } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  /** Web / tablet landscape: 50/50. Móvil o portrait: apilar. */
  const apilarPaneles = shouldStackPanels;

  const puedeVer = hasPermiso('rrhh.bonus.ver');
  const puedeEditar = hasPermiso('rrhh.bonus.editar');

  const def = useMemo(() => mesAnioPorDefecto(), []);
  const [anio, setAnio] = useState(def.anio);
  const [mes, setMes] = useState(def.mes);

  const [data, setData] = useState<BonusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportandoPdf, setExportandoPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accionMsg, setAccionMsg] = useState<string | null>(null);

  const [pctGlobalDraft, setPctGlobalDraft] = useState('');
  const [pctLocalDraft, setPctLocalDraft] = useState<Record<string, string>>({});
  const [empresaActivaKey, setEmpresaActivaKey] = useState<string | null>(null);
  const [localesExpandidos, setLocalesExpandidos] = useState<Record<string, boolean>>({});

  /** id_Locales → agoraCode (null = cargando). */
  const [agoraByLocalId, setAgoraByLocalId] = useState<Record<string, string> | null>(null);
  const [agoraLocalesError, setAgoraLocalesError] = useState(false);
  /** Cache medias: `${localId}|${mes}` → estado. */
  const [mediasPorLocal, setMediasPorLocal] = useState<Record<string, MediasLocalState>>({});
  const mediasCacheRef = useRef<Record<string, MediasLocalState>>({});

  const aniosOpciones = useMemo(() => {
    const y = Number(def.anio) || new Date().getFullYear();
    return [y - 1, y, y + 1].map((n) => ({ id: String(n), titulo: String(n) }));
  }, [def.anio]);

  const cerrado = data?.estado === 'cerrado';
  const editable = puedeEditar && !cerrado && !!data;

  const syncDraftsFromData = useCallback((resp: BonusResponse) => {
    setPctGlobalDraft(formatPctDisplay(resp.pctDefaultGlobal));
    const map: Record<string, string> = {};
    for (const emp of resp.empresas || []) {
      for (const loc of emp.locales || []) {
        map[loc.localId] = formatPctDisplay(loc.pctFondo);
      }
    }
    setPctLocalDraft(map);
    setEmpresaActivaKey((prev) => {
      const keys = (resp.empresas || []).map(empKeyOf);
      if (prev && keys.includes(prev)) return prev;
      return keys[0] ?? null;
    });
  }, []);

  const cargar = useCallback(async () => {
    if (!puedeVer) return;
    setLoading(true);
    setError(null);
    setAccionMsg(null);
    try {
      const res = await apiFetch(`/api/bonus?anio=${encodeURIComponent(anio)}&mes=${encodeURIComponent(mes)}`);
      const json = (await res.json()) as BonusResponse;
      if (!res.ok) throw new Error(json.error || 'No se pudo cargar el bonus');
      setData(json);
      syncDraftsFromData(json);
    } catch (e) {
      setData(null);
      setError((e as Error).message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, [anio, mes, puedeVer, syncDraftsFromData]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelled = false;
    setAgoraLocalesError(false);
    apiFetch('/api/locales')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Locales ${res.status}`);
        return res.json() as Promise<{
          locales?: Array<{ id_Locales?: string; agoraCode?: string; AgoraCode?: string }>;
        }>;
      })
      .then((json) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const l of json.locales || []) {
          const id = String(l.id_Locales ?? '').trim();
          const code = String(l.agoraCode ?? l.AgoraCode ?? '').trim();
          if (id && code) map[id] = code;
        }
        setAgoraLocalesError(false);
        setAgoraByLocalId(map);
      })
      .catch(() => {
        if (!cancelled) {
          setAgoraLocalesError(true);
          // Mantener null para no cachear «sin Agora» falso; el bloque medias mostrará error.
          setAgoraByLocalId({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [puedeVer]);

  const asegurarMediasLocal = useCallback(
    async (localId: string) => {
      const mesBonus = data?.mes;
      if (!mesBonus || !localId || agoraByLocalId === null) return;
      const key = mediasCacheKey(localId, mesBonus);
      const existing = mediasCacheRef.current[key];
      if (
        existing?.status === 'ready' ||
        existing?.status === 'loading' ||
        existing?.status === 'sin_agora' ||
        existing?.status === 'error'
      ) {
        return;
      }

      if (agoraLocalesError) {
        const err: MediasLocalState = {
          status: 'error',
          message: 'No se pudieron cargar los locales. Recarga la pantalla.',
        };
        mediasCacheRef.current[key] = err;
        setMediasPorLocal((prev) => ({ ...prev, [key]: err }));
        return;
      }

      const agoraCode = agoraByLocalId[localId];
      if (!agoraCode) {
        const sin: MediasLocalState = { status: 'sin_agora' };
        mediasCacheRef.current[key] = sin;
        setMediasPorLocal((prev) => ({ ...prev, [key]: sin }));
        return;
      }

      const loading: MediasLocalState = { status: 'loading' };
      mediasCacheRef.current[key] = loading;
      setMediasPorLocal((prev) => ({ ...prev, [key]: loading }));

      try {
        const { fechaInicio, fechaFin } = rangoMesBonus(mesBonus);
        if (!fechaInicio || !fechaFin) throw new Error('Mes de bonus inválido');

        const filas = await obtenerFilasObjetivos('', agoraCode, fechaInicio, fechaFin);
        const hasta =
          data?.hastaFecha && /^\d{4}-\d{2}-\d{2}$/.test(data.hastaFecha)
            ? data.hastaFecha
            : fechaFin;
        const fechaFinPeriodoCorte = hasta < fechaFin ? hasta : fechaFin;
        const corte = fechaCorteMediaRealObjetivos(fechaFinPeriodoCorte, ayerIsoLocal());
        const filasMedias = mediasPorDiaSemanaDesdeFilas(filas, {
          fechaMaxRealInclusive: corte,
        });
        const ready: MediasLocalState = { status: 'ready', filas: filasMedias };
        if (mediasCacheRef.current[key]?.status === 'loading') {
          mediasCacheRef.current[key] = ready;
          setMediasPorLocal((prev) => ({ ...prev, [key]: ready }));
        }
      } catch (e) {
        const err: MediasLocalState = {
          status: 'error',
          message: (e as Error).message || 'No se pudieron cargar las medias',
        };
        if (mediasCacheRef.current[key]?.status === 'loading') {
          mediasCacheRef.current[key] = err;
          setMediasPorLocal((prev) => ({ ...prev, [key]: err }));
        }
      }
    },
    [agoraByLocalId, agoraLocalesError, data?.hastaFecha, data?.mes],
  );

  // Al expandir o cuando llega el mapa Agora, cargar medias pendientes.
  useEffect(() => {
    if (!data?.mes || agoraByLocalId === null) return;
    for (const [localId, abierto] of Object.entries(localesExpandidos)) {
      if (abierto) void asegurarMediasLocal(localId);
    }
  }, [agoraByLocalId, asegurarMediasLocal, data?.mes, localesExpandidos]);

  const bodyPcts = useCallback(() => {
    const locales = Object.entries(pctLocalDraft).map(([localId, text]) => ({
      localId,
      pctFondo: parsePctInput(text),
    }));
    return {
      pctDefaultGlobal: parsePctInput(pctGlobalDraft) ?? 0,
      locales,
    };
  }, [pctGlobalDraft, pctLocalDraft]);

  const guardarPcts = async () => {
    if (!data || !editable) return;
    setSaving(true);
    setError(null);
    setAccionMsg(null);
    try {
      const res = await apiFetch(`/api/bonus/${data.mes}/pcts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPcts()),
      });
      const json = (await res.json()) as BonusResponse;
      if (!res.ok) throw new Error(json.error || 'No se pudieron guardar los %');
      setData(json);
      syncDraftsFromData(json);
      setAccionMsg('Porcentajes guardados.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const cerrarMes = async () => {
    if (!data || !editable) return;
    const ok = await confirmar(
      'Cerrar mes de bonus',
      `¿Cerrar el mes ${data.mes}? Quedará bloqueado y no se podrán editar los %. Se guardarán los porcentajes actuales.`,
      { confirmarLabel: 'Cerrar mes', variant: 'danger' },
    );
    if (!ok) return;
    setSaving(true);
    setError(null);
    setAccionMsg(null);
    try {
      const res = await apiFetch(`/api/bonus/${data.mes}/cerrar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPcts()),
      });
      const json = (await res.json()) as BonusResponse;
      if (!res.ok) throw new Error(json.error || 'No se pudo cerrar el mes');
      setData(json);
      syncDraftsFromData(json);
      setAccionMsg('Mes cerrado correctamente.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const exportarCsv = async () => {
    if (!data) return;
    try {
      const csv = buildCsv(data);
      await descargarCsv(csv, `bonus_${data.mes}.csv`);
      setAccionMsg('CSV exportado.');
    } catch (e) {
      setError((e as Error).message || 'No se pudo exportar el CSV');
    }
  };

  const exportarPdf = async () => {
    if (!data || loading || exportandoPdf) return;
    setExportandoPdf(true);
    setError(null);
    setAccionMsg(null);
    try {
      const payload = buildPdfDatosFromUi(data, pctGlobalDraft, pctLocalDraft);
      const doc = await generarPdfBonusMensual(payload);
      const fname = `${pdfBonusMensualFileSlug(data.mes)}.pdf`;
      if (Platform.OS === 'web') {
        doc.save(fname);
      } else {
        const dataUri = doc.output('datauristring');
        const base64 = dataUri.split(',')[1] ?? '';
        const dir = FileSystemLegacy.cacheDirectory || FileSystemLegacy.documentDirectory;
        if (!dir) throw new Error('No hay directorio para guardar el PDF');
        const path = `${dir}${fname}`;
        await FileSystemLegacy.writeAsStringAsync(path, base64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, { mimeType: 'application/pdf', dialogTitle: fname });
        }
      }
      setAccionMsg('PDF descargado (incluye % draft y fondo recalculado).');
    } catch (e) {
      setError((e as Error).message || 'No se pudo generar el PDF');
    } finally {
      setExportandoPdf(false);
    }
  };

  const toggleLocalDetalle = (localId: string) => {
    setLocalesExpandidos((prev) => {
      const next = !prev[localId];
      if (next && data?.mes) {
        const key = mediasCacheKey(localId, data.mes);
        // Reintentar si el intento anterior falló.
        if (mediasCacheRef.current[key]?.status === 'error') {
          delete mediasCacheRef.current[key];
          setMediasPorLocal((m) => {
            const copy = { ...m };
            delete copy[key];
            return copy;
          });
        }
        void asegurarMediasLocal(localId);
      }
      return { ...prev, [localId]: next };
    });
  };

  const empresaActiva = useMemo(() => {
    if (!data?.empresas?.length) return null;
    if (empresaActivaKey) {
      const found = data.empresas.find((e) => empKeyOf(e) === empresaActivaKey);
      if (found) return found;
    }
    return data.empresas[0];
  }, [data, empresaActivaKey]);

  if (!puedeVer) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.emptyText}>No tienes permiso para ver el módulo Bonus.</Text>
      </View>
    );
  }

  const btnMin = isPhone ? { minHeight: MIN_TOUCH } : null;
  const tg = data?.totalesGrupo;

  const panelResumen = (
    <ScrollView
      style={styles.panelScroll}
      contentContainerStyle={styles.panelScrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.card, styles.filtrosCard, styles.filtrosOnTop]}>
        <View style={[styles.filtrosRow, shouldStackToolbar && styles.filtrosStack]}>
          <SelectorDesplegable
            compact
            sinIconoTrigger
            style={styles.filtroSelector}
            placeholder="Año"
            tituloLista="Año"
            iconoLista="calendar-today"
            valorId={anio}
            opciones={aniosOpciones}
            onSeleccionar={setAnio}
          />
          <SelectorDesplegable
            compact
            sinIconoTrigger
            style={styles.filtroSelectorMes}
            placeholder="Mes"
            tituloLista="Mes"
            iconoLista="date-range"
            valorId={mes}
            opciones={MESES_OPCIONES}
            onSeleccionar={setMes}
          />
          <TouchableOpacity
            style={[styles.btnSec, btnMin]}
            onPress={cargar}
            disabled={loading}
          >
            <MaterialIcons name="refresh" size={18} color="#0ea5e9" />
            <Text style={styles.btnSecText}>Actualizar</Text>
          </TouchableOpacity>
        </View>
      </View>

      {data ? (
        <View style={[styles.banner, cerrado ? styles.bannerCerrado : styles.bannerBorrador]}>
          <MaterialIcons
            name={cerrado ? 'lock' : 'edit-note'}
            size={20}
            color={cerrado ? '#b45309' : '#0369a1'}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.bannerTitle}>
              Mes {data.mes} · {cerrado ? 'Cerrado' : 'Borrador'}
            </Text>
            <Text style={styles.bannerSub}>
              Datos hasta {formatFecha(data.hastaFecha)}
            </Text>
          </View>
        </View>
      ) : null}

      {tg ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>KPIs del grupo</Text>
          <View style={styles.kpiGrid}>
            <KpiChip label="Real c/IVA" value={formatMoneda(tg.realGross)} />
            <KpiChip label="Obj c/IVA" value={formatMoneda(tg.objGross)} />
            <KpiChip label="Desv c/IVA" value={formatMoneda(tg.desvGross)} />
            <KpiChip label="Desv s/IVA" value={formatMoneda(tg.desvSinIva)} />
            <KpiChip label="Incentivos" value={formatMoneda(tg.incentivos)} />
            <KpiChip label="Fondo" value={formatMoneda(tg.fondo)} emphasize />
            <KpiChip label="Total" value={formatMoneda(totalDeTotales(tg))} badge />
          </View>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Empresas</Text>
        {loading && !data ? (
          <View style={styles.inlineCenter}>
            <ActivityIndicator color="#0ea5e9" />
          </View>
        ) : !(data?.empresas?.length) ? (
          <Text style={styles.emptyText}>
            {data ? 'No hay empresas en este mes.' : 'Carga un mes para ver empresas.'}
          </Text>
        ) : (
          <View style={styles.empresaLista}>
            {(data.empresas || []).map((emp) => {
              const key = empKeyOf(emp);
              const activa = empresaActiva && empKeyOf(empresaActiva) === key;
              const desvPositiva = (Number(emp.totales?.desvGross) || 0) > 0;
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.empresaItem,
                    desvPositiva && styles.empresaItemPositiva,
                    activa && styles.empresaItemActiva,
                    activa && !desvPositiva && styles.empresaItemActivaFondo,
                  ]}
                  onPress={() => setEmpresaActivaKey(key)}
                  activeOpacity={0.75}
                >
                  <View style={styles.empresaItemTop}>
                    <Text
                      style={[
                        styles.empresaNombre,
                        desvPositiva && styles.empresaNombrePositiva,
                        activa && styles.empresaNombreActiva,
                      ]}
                      numberOfLines={1}
                    >
                      {emp.nombre}
                    </Text>
                    <Text style={styles.empresaLocales}>
                      {emp.locales?.length || 0} loc.
                    </Text>
                  </View>
                  <View style={styles.empresaTotales}>
                    <View style={styles.empresaTotalBadge}>
                      <Text style={styles.empresaTotalBadgeText}>
                        Total {formatMoneda(totalDeTotales(emp.totales || emptyTotales()))}
                      </Text>
                    </View>
                    <Text style={styles.empresaMeta}>
                      Fondo {formatMoneda(emp.totales?.fondo ?? 0)}
                    </Text>
                    <Text
                      style={[
                        styles.empresaMeta,
                        desvPositiva && styles.empresaMetaPositiva,
                      ]}
                    >
                      Desv {formatMoneda(emp.totales?.desvGross ?? 0)}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

      {data ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>% global y acciones</Text>
          <View style={styles.pctGlobalRow}>
            <Text style={styles.pctGlobalLabel}>% global fondo</Text>
            {editable ? (
              <PctInput
                value={pctGlobalDraft}
                onCommit={setPctGlobalDraft}
                placeholder="0"
                disabled={!editable || saving}
              />
            ) : (
              <Text style={styles.pctGlobalReadonly}>
                {formatPctDisplay(data.pctDefaultGlobal) || '0'} %
              </Text>
            )}
            {editable ? (
              <Text style={styles.pctGlobalHint}>Locales sin % propio</Text>
            ) : null}
          </View>

          <View style={[styles.actionsRow, shouldStackToolbar && styles.actionsStack]}>
            {editable ? (
              <TouchableOpacity
                style={[styles.btnPrimary, btnMin, saving && styles.btnDisabled]}
                onPress={guardarPcts}
                disabled={saving}
              >
                <MaterialIcons name="save" size={18} color="#fff" />
                <Text style={styles.btnPrimaryText}>Guardar %</Text>
              </TouchableOpacity>
            ) : null}
            {editable ? (
              <TouchableOpacity
                style={[styles.btnDanger, btnMin, saving && styles.btnDisabled]}
                onPress={cerrarMes}
                disabled={saving}
              >
                <MaterialIcons name="lock" size={18} color="#fff" />
                <Text style={styles.btnPrimaryText}>Cerrar mes</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.btnSec, btnMin, (!data || loading) && styles.btnDisabled]}
              onPress={exportarCsv}
              disabled={!data || loading}
            >
              <MaterialIcons name="file-download" size={18} color="#059669" />
              <Text style={[styles.btnSecText, { color: '#059669' }]}>Export CSV</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.btnSec,
                btnMin,
                (!data || loading || exportandoPdf) && styles.btnDisabled,
              ]}
              onPress={exportarPdf}
              disabled={!data || loading || exportandoPdf}
            >
              {exportandoPdf ? (
                <ActivityIndicator size="small" color="#dc2626" />
              ) : (
                <MaterialIcons name="picture-as-pdf" size={18} color="#dc2626" />
              )}
              <Text style={[styles.btnSecText, { color: '#dc2626' }]}>
                {exportandoPdf ? 'Generando…' : 'Descargar PDF'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <MaterialIcons name="error-outline" size={18} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={cargar}>
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {accionMsg ? <Text style={styles.okText}>{accionMsg}</Text> : null}
      {data?.avisos?.length ? (
        <View style={styles.avisosBox}>
          {data.avisos.map((a) => (
            <Text key={a} style={styles.avisoText}>· {a}</Text>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );

  const panelDesglose = (
    <ScrollView
      style={styles.panelScroll}
      contentContainerStyle={styles.panelScrollContent}
      keyboardShouldPersistTaps="handled"
      horizontal={false}
    >
      {loading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator color="#0ea5e9" />
          <Text style={styles.emptyText}>Cargando bonus del mes…</Text>
        </View>
      ) : !empresaActiva ? (
        <View style={[styles.card, styles.desgloseEmpty]}>
          <MaterialIcons name="business" size={28} color="#94a3b8" />
          <Text style={styles.emptyText}>
            {data ? 'Selecciona una empresa para ver el desglose.' : 'Selecciona año y mes para cargar el bonus.'}
          </Text>
        </View>
      ) : (
        <View style={styles.card}>
          <View style={styles.desgloseHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Desglose</Text>
              <Text style={styles.desgloseEmpresa} numberOfLines={1}>
                {empresaActiva.nombre}
              </Text>
            </View>
            <Text style={styles.empresaLocales}>
              {empresaActiva.locales?.length || 0} locales
            </Text>
          </View>

          {empresaActiva.totales ? (
            <View style={styles.totalesEmpresaBox}>
              <View style={styles.kpiGrid}>
                <KpiChip label="Real" value={formatMoneda(empresaActiva.totales.realGross)} />
                <KpiChip label="Obj" value={formatMoneda(empresaActiva.totales.objGross)} />
                <KpiChip label="Desv" value={formatMoneda(empresaActiva.totales.desvGross)} />
                <KpiChip label="Incentivos" value={formatMoneda(empresaActiva.totales.incentivos)} />
                <KpiChip label="Base" value={formatMoneda(empresaActiva.totales.baseFondo)} />
                <KpiChip label="Fondo" value={formatMoneda(empresaActiva.totales.fondo)} emphasize />
                <KpiChip
                  label="Total"
                  value={formatMoneda(totalDeTotales(empresaActiva.totales))}
                  badge
                />
              </View>
            </View>
          ) : null}

          <View style={styles.tabla}>
            <View style={styles.tablaHeader}>
              <Text style={[styles.th, styles.colAcc]} />
              <Text style={[styles.th, styles.colLocal]}>Local</Text>
              <Text style={[styles.th, styles.colNum]}>Real</Text>
              <Text style={[styles.th, styles.colNum]}>Obj</Text>
              <Text style={[styles.th, styles.colNum]}>Desv</Text>
              <Text style={[styles.th, styles.colNum]}>Incent.</Text>
              <Text style={[styles.th, styles.colNum]}>Base</Text>
              <Text style={[styles.th, styles.colPct]}>%</Text>
              <Text style={[styles.th, styles.colNum]}>Fondo</Text>
              <Text style={[styles.th, styles.colTotal, styles.thTotal]}>Total</Text>
            </View>
            {(empresaActiva.locales || []).map((loc) => {
              const expandido = !!localesExpandidos[loc.localId];
              const tieneDetalle = (loc.incentivosDetalle?.length || 0) > 0;
              const mediasKey = data?.mes
                ? mediasCacheKey(loc.localId, data.mes)
                : '';
              const mediasState = mediasKey ? mediasPorLocal[mediasKey] : undefined;
              return (
                <View key={loc.localId}>
                  <View style={styles.tablaRow}>
                    <TouchableOpacity
                      style={styles.colAcc}
                      onPress={() => toggleLocalDetalle(loc.localId)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityLabel={
                        expandido
                          ? 'Ocultar medias y detalle del local'
                          : 'Ver medias y detalle del local'
                      }
                    >
                      <MaterialIcons
                        name={expandido ? 'expand-less' : 'expand-more'}
                        size={18}
                        color="#0ea5e9"
                      />
                    </TouchableOpacity>
                    <Text style={[styles.td, styles.colLocal]} numberOfLines={2}>
                      {loc.localNombre}
                    </Text>
                    <Text style={[styles.td, styles.colNum]} numberOfLines={1}>
                      {formatMoneda(loc.realGross, { sinSimbolo: true })}
                    </Text>
                    <Text style={[styles.td, styles.colNum]} numberOfLines={1}>
                      {formatMoneda(loc.objGross, { sinSimbolo: true })}
                    </Text>
                    <Text style={[styles.td, styles.colNum]} numberOfLines={1}>
                      {formatMoneda(loc.desvGross, { sinSimbolo: true })}
                    </Text>
                    <Text style={[styles.td, styles.colNum]} numberOfLines={1}>
                      {formatMoneda(loc.incentivosCampana, { sinSimbolo: true })}
                    </Text>
                    <Text style={[styles.td, styles.colNum]} numberOfLines={1}>
                      {formatMoneda(loc.baseFondo, { sinSimbolo: true })}
                    </Text>
                    <View style={[styles.colPct, styles.pctCell]}>
                      {editable ? (
                        <PctInput
                          compact
                          value={pctLocalDraft[loc.localId] ?? ''}
                          onCommit={(t) =>
                            setPctLocalDraft((prev) => ({ ...prev, [loc.localId]: t }))
                          }
                          placeholder={String(data?.pctDefaultGlobal ?? 0)}
                          disabled={saving}
                        />
                      ) : (
                        <Text style={[styles.td, styles.tdPct]} numberOfLines={1}>
                          {loc.pctFondo != null
                            ? `${loc.pctFondo}`
                            : `${loc.pctEfectivo ?? data?.pctDefaultGlobal ?? 0}*`}
                        </Text>
                      )}
                    </View>
                    <Text style={[styles.td, styles.colNum, styles.fondoCell]} numberOfLines={1}>
                      {formatMoneda(loc.fondo, { sinSimbolo: true })}
                    </Text>
                    <View style={styles.colTotal}>
                      <View style={styles.totalCellBadge}>
                        <Text style={styles.totalCellBadgeText} numberOfLines={1}>
                          {formatMoneda(totalDeLocal(loc), { sinSimbolo: true })}
                        </Text>
                      </View>
                    </View>
                  </View>
                  {expandido ? (
                    <View style={styles.detalleBox}>
                      <View style={styles.mediasBlock}>
                        <Text style={styles.mediasTitle}>Media por día de la semana</Text>
                        <Text style={styles.mediasHint}>
                          Media real del mes del local. El badge es la variación vs la media
                          comparativa.
                        </Text>
                        {!mediasState || mediasState.status === 'loading' ? (
                          <View style={styles.mediasLoading}>
                            <ActivityIndicator size="small" color="#0ea5e9" />
                          </View>
                        ) : mediasState.status === 'sin_agora' ? (
                          <Text style={styles.mediasMsg}>Sin código Agora para este local</Text>
                        ) : mediasState.status === 'error' ? (
                          <Text style={styles.mediasMsgError}>{mediasState.message}</Text>
                        ) : (
                          <View style={styles.mediasLista}>
                            {mediasState.filas.map((row) => {
                              const variacion =
                                row.nReal > 0 && row.nComp > 0 && row.mediaComp > 0
                                  ? variacionPctMediasVsComp(row.mediaReal, row.mediaComp)
                                  : null;
                              return (
                                <View key={row.label} style={styles.mediasRow}>
                                  <Text style={styles.mediasDia}>{row.label}</Text>
                                  <Text style={styles.mediasReal} numberOfLines={1}>
                                    {row.nReal === 0
                                      ? '—'
                                      : `${formatMoneda(row.mediaReal)} (${row.nReal})`}
                                  </Text>
                                  {variacion != null ? (
                                    <View
                                      style={[
                                        styles.mediasVarBadge,
                                        variacion.up
                                          ? styles.mediasVarBadgeUp
                                          : styles.mediasVarBadgeDown,
                                      ]}
                                    >
                                      <Text
                                        style={[
                                          styles.mediasVarText,
                                          variacion.up
                                            ? styles.mediasVarTextUp
                                            : styles.mediasVarTextDown,
                                        ]}
                                      >
                                        {variacion.up ? '+' : ''}
                                        {variacion.pct.toFixed(1)}%
                                      </Text>
                                    </View>
                                  ) : (
                                    <Text style={styles.mediasVarDash}>—</Text>
                                  )}
                                </View>
                              );
                            })}
                          </View>
                        )}
                      </View>

                      {tieneDetalle ? (
                        <View style={styles.incentivosBlock}>
                          <Text style={styles.mediasTitle}>Detalle incentivos</Text>
                          <View style={styles.detalleHeader}>
                            <Text style={[styles.detalleTh, { flex: 1.4 }]}>Empleado</Text>
                            <Text style={[styles.detalleTh, { flex: 1.6 }]}>Producto</Text>
                            <Text style={[styles.detalleTh, { width: 44, textAlign: 'right' }]}>
                              Uds
                            </Text>
                            <Text style={[styles.detalleTh, { width: 72, textAlign: 'right' }]}>
                              €
                            </Text>
                          </View>
                          {loc.incentivosDetalle!.map((d, idx) => (
                            <View
                              key={`${loc.localId}-${d.productId}-${d.agoraUserId}-${idx}`}
                              style={styles.detalleRow}
                            >
                              <Text style={[styles.detalleTd, { flex: 1.4 }]} numberOfLines={1}>
                                {d.destinatario === 'equipo' ? 'Equipo' : (d.userName || '—')}
                              </Text>
                              <Text style={[styles.detalleTd, { flex: 1.6 }]} numberOfLines={1}>
                                {d.productName || d.productId || '—'}
                              </Text>
                              <Text style={[styles.detalleTd, { width: 44, textAlign: 'right' }]}>
                                {(d.unidades ?? 0).toLocaleString('es-ES')}
                              </Text>
                              <Text style={[styles.detalleTd, { width: 72, textAlign: 'right' }]}>
                                {formatMoneda(d.incentivoEur, { sinSimbolo: true })}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>

          <Text style={styles.hintReadonly}>
            {cerrado
              ? 'Mes cerrado: solo lectura. El asterisco en % indica valor heredado del global. Total = incentivos + fondo.'
              : '% sobre la desv s/IVA (sin restar incentivos). Total = incentivos + fondo. El fondo se recalcula al guardar o al cerrar.'}
          </Text>
        </View>
      )}
    </ScrollView>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/recursos-humanos' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Bonus</Text>
          <Text style={styles.subtitle}>Desviación, incentivos de campaña y fondo común</Text>
        </View>
      </View>

      <View style={[styles.split, apilarPaneles && styles.splitStack]}>
        <View style={[styles.panel, !apilarPaneles && styles.panelLeft]}>
          {panelResumen}
        </View>
        <View style={[styles.panel, !apilarPaneles && styles.panelRight, apilarPaneles && styles.panelStackBottom]}>
          {panelDesglose}
        </View>
      </View>
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0', padding: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  inlineCenter: { alignItems: 'center', paddingVertical: 16 },
  emptyText: { fontSize: 13, color: '#64748b', textAlign: 'center' },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },

  split: { flex: 1, flexDirection: 'row', gap: 12, minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  panel: { flex: 1, minWidth: 0, minHeight: 0 },
  panelLeft: { flex: 1 },
  panelRight: { flex: 1 },
  panelStackBottom: { flex: 1.15 },
  panelScroll: { flex: 1, position: 'relative', zIndex: 0 },
  panelScrollContent: { gap: 10, paddingBottom: 28 },

  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    gap: 10,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  filtrosCard: { position: 'relative', zIndex: 50 },
  filtrosOnTop: { zIndex: 50 },
  filtrosRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    position: 'relative',
    zIndex: 50,
  },
  filtrosStack: { flexDirection: 'column', alignItems: 'stretch' },
  filtroSelector: { width: 100 },
  filtroSelectorMes: { width: 130 },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  bannerBorrador: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  bannerCerrado: { backgroundColor: '#fffbeb', borderColor: '#fcd34d' },
  bannerTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  bannerSub: { fontSize: 12, color: '#475569', marginTop: 2 },

  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  kpiChip: {
    minWidth: '30%',
    flexGrow: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  kpiChipEmph: {
    backgroundColor: '#ecfeff',
    borderColor: '#a5f3fc',
  },
  kpiChipBadge: {
    backgroundColor: '#dcfce7',
    borderColor: '#86efac',
  },
  kpiLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  kpiLabel: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  kpiLabelBadge: { color: '#166534' },
  kpiValue: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  kpiValueEmph: { color: '#0e7490' },
  kpiValueBadge: { color: '#15803d' },
  totalBadge: {
    backgroundColor: '#16a34a',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    minWidth: 16,
    alignItems: 'center',
  },
  totalBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },

  empresaLista: { gap: 8 },
  empresaItem: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
    minHeight: MIN_TOUCH,
  },
  empresaItemPositiva: {
    backgroundColor: '#dcfce7',
    borderColor: '#86efac',
  },
  empresaItemActiva: {
    borderColor: '#0ea5e9',
    borderWidth: 2,
  },
  empresaItemActivaFondo: {
    backgroundColor: '#e0f2fe',
  },
  empresaItemTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  empresaNombre: { flex: 1, fontSize: 14, fontWeight: '700', color: '#0f172a' },
  empresaNombrePositiva: { color: '#166534' },
  empresaNombreActiva: { color: '#0369a1' },
  empresaLocales: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  empresaMetaPositiva: { color: '#15803d', fontWeight: '700' },
  empresaTotales: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  empresaMeta: { fontSize: 12, color: '#475569' },

  pctGlobalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  pctGlobalLabel: { fontSize: 13, fontWeight: '600', color: '#334155' },
  pctGlobalHint: { fontSize: 12, color: '#94a3b8' },
  pctGlobalReadonly: { fontSize: 14, fontWeight: '600', color: '#0f172a' },
  pctInput: {
    width: 72,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#fff',
    textAlign: 'right',
  },
  pctInputCompact: {
    width: 34,
    paddingVertical: 2,
    paddingHorizontal: 2,
    fontSize: 10,
    borderRadius: 6,
  },
  pctInputDisabled: { backgroundColor: '#f1f5f9', color: '#64748b' },

  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    position: 'relative',
    zIndex: 10,
  },
  actionsStack: { flexDirection: 'column', alignItems: 'stretch' },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#dc2626',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnSec: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnSecText: { color: '#0ea5e9', fontWeight: '600', fontSize: 13 },
  btnDisabled: { opacity: 0.5 },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { flex: 1, color: '#dc2626', fontSize: 13 },
  retryText: { color: '#0ea5e9', fontWeight: '600', fontSize: 13 },
  okText: { color: '#16a34a', fontSize: 13, fontWeight: '600' },
  avisosBox: {
    backgroundColor: '#fff7ed',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#fed7aa',
  },
  avisoText: { fontSize: 12, color: '#9a3412', marginBottom: 2 },

  desgloseEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 12,
    minHeight: 180,
  },
  desgloseHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  desgloseEmpresa: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 2,
  },
  totalesEmpresaBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },

  tabla: { width: '100%', alignSelf: 'stretch' },
  tablaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 5,
    paddingHorizontal: 2,
  },
  tablaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: '#f1f5f9',
    paddingVertical: 5,
    paddingHorizontal: 2,
    minHeight: 36,
  },
  th: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: -0.2,
  },
  td: { fontSize: 10, color: '#0f172a', fontVariant: ['tabular-nums'] },
  tdPct: { textAlign: 'right', width: '100%' },
  colLocal: { flex: 1.35, minWidth: 0, paddingRight: 4 },
  colNum: { flex: 1, minWidth: 0, textAlign: 'right', paddingRight: 2 },
  colPct: { width: 34, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 2 },
  colAcc: { width: 20, alignItems: 'center', justifyContent: 'center' },
  colTotal: {
    flex: 1.05,
    minWidth: 0,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  thTotal: { textAlign: 'right', color: '#15803d' },
  pctCell: { justifyContent: 'center' },
  fondoCell: { fontWeight: '700' },
  totalCellBadge: {
    backgroundColor: '#dcfce7',
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    maxWidth: '100%',
  },
  totalCellBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#15803d',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  empresaTotalBadge: {
    backgroundColor: '#dcfce7',
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  empresaTotalBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#15803d',
  },

  detalleBox: {
    backgroundColor: '#f8fafc',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderColor: '#e2e8f0',
    marginLeft: 4,
    gap: 10,
  },
  mediasBlock: { gap: 4 },
  incentivosBlock: { gap: 4, borderTopWidth: 1, borderTopColor: '#e2e8f0', paddingTop: 8 },
  mediasTitle: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
  mediasHint: { fontSize: 10, color: '#94a3b8', marginBottom: 2 },
  mediasLoading: { alignItems: 'flex-start', paddingVertical: 8 },
  mediasMsg: { fontSize: 11, color: '#64748b', paddingVertical: 4 },
  mediasMsgError: { fontSize: 11, color: '#dc2626', paddingVertical: 4 },
  mediasLista: { gap: 2 },
  mediasRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
    minHeight: 22,
  },
  mediasDia: {
    width: 28,
    fontSize: 11,
    fontWeight: '700',
    color: '#1e293b',
  },
  mediasReal: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    color: '#0f172a',
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  mediasVarBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    minWidth: 52,
    alignItems: 'center',
  },
  mediasVarBadgeUp: {
    backgroundColor: 'rgba(5, 150, 105, 0.14)',
    borderColor: 'rgba(5, 150, 105, 0.35)',
  },
  mediasVarBadgeDown: {
    backgroundColor: 'rgba(220, 38, 38, 0.12)',
    borderColor: 'rgba(220, 38, 38, 0.35)',
  },
  mediasVarText: { fontSize: 9, fontWeight: '700' },
  mediasVarTextUp: { color: '#047857' },
  mediasVarTextDown: { color: '#b91c1c' },
  mediasVarDash: {
    minWidth: 52,
    textAlign: 'center',
    fontSize: 11,
    color: '#cbd5e1',
  },
  detalleHeader: { flexDirection: 'row', marginBottom: 4, gap: 6 },
  detalleTh: { fontSize: 9, fontWeight: '700', color: '#94a3b8' },
  detalleRow: { flexDirection: 'row', gap: 6, paddingVertical: 2 },
  detalleTd: { fontSize: 10, color: '#334155' },
  hintReadonly: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
});
