import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';

type LocalItem = { AgoraCode?: string; agoraCode?: string; Nombre?: string; nombre?: string };
type SaleCenter = { Id?: number; Nombre?: string; Local?: string; Activo?: boolean };

type TarjetaInfo = {
  teorica: number;
  sumaBoletas: number;
  diffBoletas: number;
  numBoletas: number;
  sinImagen: boolean;
  sinOcr: boolean;
};

type TpvCelda = {
  posId: string;
  posName: string;
  estadoArqueo: 'sin_arqueo' | 'borrador' | 'cerrado';
  revisado: boolean;
  revisadoPor: string | null;
  closeoutsCount: number;
  teorico: Record<string, number>;
  real: Record<string, number>;
  diff: Record<string, number>;
  descuadreTotal: number;
  diffEfectivo: number;
  diffTarjeta: number;
  movimientos: { retiradas: number; transferencias: number };
  tarjeta: TarjetaInfo;
};

type DiaLocal = {
  businessDay: string;
  tpvs: TpvCelda[];
  teorico: Record<string, number>;
  real: Record<string, number>;
  descuadreTotal: number;
  totalTpvs: number;
  conArqueo: number;
  sinArqueo: number;
  borradores: number;
  revisados: number;
  estadoJornada: string;
};

type LocalRevision = { workplaceId: string; workplaceName: string; dias: DiaLocal[] };
type RevisionResponse = { dateFrom: string; dateTo: string; locales: LocalRevision[]; error?: string };

/** Selección actual para el panel de detalle (a nivel TPV). */
type Seleccion = { workplaceId: string; workplaceName: string; businessDay: string; tpv: TpvCelda };

/** Caja individual (TPV-día) ya resuelta para la bandeja. */
type Item = Seleccion & { key: string; estado: EstadoCelda };

type EstadoCelda = 'sin_arqueo' | 'incidencia' | 'borrador' | 'ok' | 'revisado' | 'vacio';

const STATUS_META: Record<EstadoCelda, { color: string; bg: string; border: string; label: string }> = {
  sin_arqueo: { color: colors.textMuted, bg: colors.navActive, border: colors.borderStrong, label: 'Sin arqueo' },
  incidencia: { color: colors.danger, bg: statusColors.danger.bg, border: '#fecaca', label: 'Incidencia' },
  borrador: { color: statusColors.warning.text, bg: statusColors.warning.bg, border: '#fcd34d', label: 'Borrador' },
  ok: { color: colors.success, bg: '#f0fdf4', border: '#bbf7d0', label: 'Cuadra' },
  revisado: { color: statusColors.success.text, bg: statusColors.success.bg, border: '#86efac', label: 'Revisada' },
  vacio: { color: colors.borderStrong, bg: colors.bg, border: colors.border, label: 'Sin datos' },
};

const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

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
  if (!Number.isFinite(n)) return '—';
  const parts = Math.abs(n).toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = n < 0 ? '-' : '';
  return `${sign}${intPart},${parts[1]} €`;
}

function parseNumInput(s: string): number {
  const n = parseFloat(String(s).replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function diaCorto(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DIAS_SEMANA[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}`;
}

/** Estado/semáforo de un TPV según el umbral de tolerancia. */
function estadoTpv(t: TpvCelda, tol: number): EstadoCelda {
  if (t.estadoArqueo === 'sin_arqueo') return 'sin_arqueo';
  const problemaImporte = Math.abs(t.descuadreTotal) > tol;
  const problemaBoletas =
    (t.tarjeta.numBoletas > 0 && Math.abs(t.tarjeta.diffBoletas) > tol) ||
    t.tarjeta.sinImagen ||
    t.tarjeta.sinOcr;
  if (problemaImporte || problemaBoletas) return 'incidencia';
  if (t.estadoArqueo === 'borrador') return 'borrador';
  if (t.revisado) return 'revisado';
  return 'ok';
}

/** Prioridad de urgencia en la bandeja de pendientes (menor = más arriba). */
const ORDEN_URGENCIA: Record<EstadoCelda, number> = {
  sin_arqueo: 0,
  incidencia: 1,
  borrador: 2,
  ok: 3,
  revisado: 4,
  vacio: 5,
};

const CHIP_MODO_PASTEL: Record<
  'pendientes' | 'revisadas',
  { bg: string; bgSel: string; border: string; borderSel: string; text: string }
> = {
  pendientes: { bg: statusColors.warning.bg, bgSel: '#fde68a', border: '#fde68a', borderSel: '#fcd34d', text: '#92400e' },
  revisadas: { bg: statusColors.success.bg, bgSel: '#bbf7d0', border: '#bbf7d0', borderSel: '#86efac', text: '#166534' },
};

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/**
 * Motivos concretos por los que una caja no está "limpia", para mostrarlos junto al día.
 * El descuadre de importe solo se incluye si supera la tolerancia; el resto (boletas,
 * borrador) puede aparecer aunque el importe cuadre.
 */
function motivosIncidencia(t: TpvCelda, tol: number): string[] {
  if (t.estadoArqueo === 'sin_arqueo') return ['Sin arqueo'];
  const out: string[] = [];
  if (Math.abs(t.descuadreTotal) > tol) out.push('Descuadre');
  if (t.tarjeta.numBoletas > 0 && Math.abs(t.tarjeta.diffBoletas) > tol) out.push('Boletas no cuadran');
  if (t.tarjeta.sinImagen) out.push('Boletas sin foto');
  if (t.tarjeta.sinOcr) out.push('Boletas sin OCR');
  if (t.estadoArqueo === 'borrador') out.push('Borrador');
  return out;
}

export default function RevisionCajasScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido, user } = useAuth();
  const { shouldStackPanels, shouldStackToolbar } = useBreakpoint();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [saleCenters, setSaleCenters] = useState<SaleCenter[]>([]);
  const [fromIso, setFromIso] = useState(() => fechaJornadaNegocioIso());
  const [toIso, setToIso] = useState(() => fechaJornadaNegocioIso());
  const [localFiltro, setLocalFiltro] = useState(''); // '' = todos los permitidos
  const [tolStr, setTolStr] = useState('1');
  /** Vista de la bandeja: pendientes (por defecto) o ya revisadas. */
  const [modo, setModo] = useState<'pendientes' | 'revisadas'>('pendientes');

  const [data, setData] = useState<RevisionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selKey, setSelKey] = useState<string | null>(null);
  const [accionBusy, setAccionBusy] = useState(false);

  /** Id incremental de la última petición de revisión (para descartar respuestas tardías). */
  const reqIdRef = useRef(0);

  const tol = useMemo(() => parseNumInput(tolStr), [tolStr]);

  const localesPermitidos = useMemo(
    () =>
      locales
        .map((l) => ({
          code: String(l.agoraCode ?? l.AgoraCode ?? '').trim(),
          nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
        }))
        .filter((l) => l.code && localPermitido(l.nombre)),
    [locales, localPermitido],
  );

  /** Código Ágora → nombre de local (para no mostrar el código como título). */
  const agoraCodeToNombre = useMemo(() => {
    const map: Record<string, string> = {};
    for (const l of locales) {
      const code = String(l.agoraCode ?? l.AgoraCode ?? '').trim();
      const nombre = String(l.nombre ?? l.Nombre ?? '').trim();
      if (code && nombre) map[code] = nombre;
    }
    return map;
  }, [locales]);

  /** Id de TPV → nombre del centro de venta (sale-center). */
  const saleCenterById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const sc of saleCenters) {
      const id = sc.Id != null ? String(sc.Id) : '';
      const nombre = String(sc.Nombre ?? '').trim();
      if (id && nombre) map[id] = nombre;
    }
    return map;
  }, [saleCenters]);

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => safeJson<{ locales?: LocalItem[] }>(r))
      .then((d) => setLocales(d.locales || []))
      .catch(() => setLocales([]));
    apiFetch('/api/agora/sale-centers')
      .then((r) => safeJson<{ saleCenters?: SaleCenter[] }>(r))
      .then((d) => setSaleCenters(d.saleCenters || []))
      .catch(() => setSaleCenters([]));
  }, []);

  const fetchRevision = useCallback(() => {
    const codes = localFiltro ? [localFiltro] : localesPermitidos.map((l) => l.code);
    if (!fromIso || !toIso || codes.length === 0) {
      setData(null);
      return;
    }
    // Guard de respuestas obsoletas: si se cambia de filtro mientras hay una
    // petición en vuelo, la lenta no debe machacar el resultado de la última.
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, workplaceIds: codes.join(',') });
    apiFetch(`/api/cajas/revision?${q}`)
      .then((r) => safeJson<RevisionResponse>(r))
      .then((d) => {
        if (reqIdRef.current !== myId) return;
        if ((d as { error?: string }).error) throw new Error((d as { error: string }).error);
        setData(d);
      })
      .catch((e) => {
        if (reqIdRef.current !== myId) return;
        setError(e instanceof Error ? e.message : 'Error al cargar la revisión');
        setData(null);
      })
      .finally(() => {
        if (reqIdRef.current === myId) setLoading(false);
      });
  }, [fromIso, toIso, localFiltro, localesPermitidos]);

  useEffect(() => {
    const t = setTimeout(fetchRevision, 300);
    return () => clearTimeout(t);
  }, [fetchRevision]);

  // Al volver a esta pantalla (p. ej. tras editar un arqueo o un movimiento) se
  // refrescan los datos, ya que la pantalla sigue montada y el useEffect no se reejecuta.
  const primerFoco = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (primerFoco.current) {
        primerFoco.current = false;
        return;
      }
      fetchRevision();
    }, [fetchRevision]),
  );

  /** Resuelve el nombre real del TPV (sale-center) evitando el "TPV {id}" del backend. */
  const nombreTpv = useCallback(
    (t: TpvCelda) => saleCenterById[t.posId] || t.posName || `TPV ${t.posId}`,
    [saleCenterById],
  );

  /** Todas las cajas (TPV-día) del rango, con nombres resueltos y estado calculado. */
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const loc of data?.locales || []) {
      const wpNombre = agoraCodeToNombre[loc.workplaceId] || loc.workplaceName || loc.workplaceId;
      for (const dia of loc.dias) {
        for (const t of dia.tpvs) {
          out.push({
            key: `${loc.workplaceId}#${dia.businessDay}#${t.posId}`,
            workplaceId: loc.workplaceId,
            workplaceName: wpNombre,
            businessDay: dia.businessDay,
            tpv: { ...t, posName: nombreTpv(t) },
            estado: estadoTpv(t, tol),
          });
        }
      }
    }
    return out;
  }, [data, tol, agoraCodeToNombre, nombreTpv]);

  /** Una caja se considera resuelta solo con el visto bueno humano (revisado). */
  const pendientes = useMemo(
    () =>
      items
        .filter((i) => !i.tpv.revisado)
        .sort(
          (a, b) =>
            (ORDEN_URGENCIA[a.estado] - ORDEN_URGENCIA[b.estado]) ||
            a.workplaceName.localeCompare(b.workplaceName) ||
            a.businessDay.localeCompare(b.businessDay) ||
            a.tpv.posName.localeCompare(b.tpv.posName),
        ),
    [items],
  );

  const revisadas = useMemo(
    () =>
      items
        .filter((i) => i.tpv.revisado)
        .sort(
          (a, b) =>
            a.workplaceName.localeCompare(b.workplaceName) ||
            a.businessDay.localeCompare(b.businessDay) ||
            a.tpv.posName.localeCompare(b.tpv.posName),
        ),
    [items],
  );

  const lista = modo === 'pendientes' ? pendientes : revisadas;
  const seleccion = useMemo<Item | null>(() => items.find((i) => i.key === selKey) ?? null, [items, selKey]);

  const totalConArqueo = items.filter((i) => i.tpv.estadoArqueo !== 'sin_arqueo').length;
  const resumenKpi = useMemo(() => {
    const incidencias = items.filter((i) => estadoTpv(i.tpv, tol) === 'incidencia').length;
    const sinArqueo = items.filter((i) => i.tpv.estadoArqueo === 'sin_arqueo').length;
    const coberturaPct = totalConArqueo > 0 ? Math.round((revisadas.length / totalConArqueo) * 100) : 0;
    return {
      pendientes: pendientes.length,
      revisadas: revisadas.length,
      incidencias,
      sinArqueo,
      cobertura: `${revisadas.length}/${totalConArqueo}`,
      coberturaPct,
    };
  }, [items, tol, pendientes.length, revisadas.length, totalConArqueo]);

  /** Bandeja agrupada por local (orden de aparición = orden de la lista plana). */
  const listaAgrupada = useMemo(() => {
    const grupos: { workplaceId: string; workplaceName: string; items: Item[] }[] = [];
    const idxByWp = new Map<string, number>();
    for (const it of lista) {
      let gi = idxByWp.get(it.workplaceId);
      if (gi === undefined) {
        idxByWp.set(it.workplaceId, grupos.length);
        grupos.push({ workplaceId: it.workplaceId, workplaceName: it.workplaceName, items: [] });
        gi = grupos.length - 1;
      }
      grupos[gi].items.push(it);
    }
    return grupos;
  }, [lista]);

  // Navegación con teclado (web): ↑/↓ recorre la lista visible.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (lista.length === 0) return;
      const idx = lista.findIndex((i) => i.key === selKey);
      let next = idx;
      if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(lista.length - 1, idx + 1);
      else next = idx < 0 ? 0 : Math.max(0, idx - 1);
      const target = lista[next];
      if (target) {
        e.preventDefault();
        setSelKey(target.key);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lista, selKey]);

  const marcarRevisada = useCallback(
    async (sel: Item, revisado: boolean) => {
      setAccionBusy(true);
      setError(null);
      // Si se resuelve en la vista de pendientes, preparar la siguiente caja.
      let siguiente: string | null = null;
      if (revisado && modo === 'pendientes') {
        const idx = lista.findIndex((i) => i.key === sel.key);
        siguiente = lista[idx + 1]?.key ?? lista[idx - 1]?.key ?? null;
      }
      try {
        const res = await apiFetch('/api/cajas/arqueos-reales/revisado', {
          method: 'POST',
          body: JSON.stringify({
            workplaceId: sel.workplaceId,
            businessDay: sel.businessDay,
            posId: sel.tpv.posId,
            revisado,
            usuarioId: user?.id_usuario,
            usuarioNombre: user?.Nombre,
          }),
        });
        const d = await safeJson<{ ok?: boolean; error?: string }>(res);
        if (!res.ok || d.error) throw new Error(d.error || 'Error al marcar la revisión');
        if (revisado && modo === 'pendientes') setSelKey(siguiente);
        fetchRevision();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al marcar la revisión');
      } finally {
        setAccionBusy(false);
      }
    },
    [user, fetchRevision, modo, lista],
  );

  const irAPantalla = useCallback(
    (pathname: '/cajas/arqueo-caja' | '/cajas/movimientos-caja', sel: Item) => {
      router.push({
        pathname,
        params: {
          workplaceId: sel.workplaceId,
          posId: sel.tpv.posId,
          posName: sel.tpv.posName,
          businessDay: sel.businessDay,
        },
      });
    },
    [router],
  );

  /** Contenido del detalle de una caja (reutilizado en panel lateral y modal). */
  const renderDetalle = (sel: Item, conCerrar: boolean) => {
    const t = sel.tpv;
    const grupos = Array.from(new Set([...Object.keys(t.teorico), ...Object.keys(t.real)]));
    const cuadra = Math.abs(t.descuadreTotal) <= tol;
    return (
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.detalleScroll}>
        <View style={styles.modalHeader}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.modalTitle} numberOfLines={1}>{sel.workplaceName} · {t.posName}</Text>
            <Text style={styles.modalSub}>{diaCorto(sel.businessDay)} · {sel.businessDay}</Text>
          </View>
          {conCerrar ? (
            <TouchableOpacity onPress={() => setSelKey(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <MaterialIcons name="close" size={24} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>

        {t.estadoArqueo === 'sin_arqueo' ? (
          <View style={styles.modalAvisoSin}>
            <MaterialIcons name="info-outline" size={16} color={statusColors.warning.text} />
            <Text style={styles.modalAvisoSinText}>Hay cierre teórico pero no se ha hecho el arqueo de esta caja.</Text>
          </View>
        ) : (
          <View style={[styles.modalDescBox, cuadra ? styles.modalDescOk : styles.modalDescBad]}>
            <Text style={styles.modalDescLabel}>Descuadre total</Text>
            <Text style={[styles.modalDescVal, cuadra ? styles.diffOk : styles.diffBad]}>{formatMoneda(t.descuadreTotal)}</Text>
          </View>
        )}

        <View style={styles.tablaHead}>
          <Text style={styles.thMetodo}>Método</Text>
          <Text style={styles.thNum}>Teórico</Text>
          <Text style={styles.thNum}>Real</Text>
          <Text style={styles.thNum}>Dif.</Text>
        </View>
        {grupos.map((g) => {
          const teo = t.teorico[g] ?? 0;
          const real = t.real[g] ?? 0;
          const diff = t.diff[g] ?? 0;
          return (
            <View key={g} style={styles.tablaRow}>
              <Text style={styles.tdMetodo} numberOfLines={1}>{g}</Text>
              <Text style={styles.tdNum}>{formatMoneda(teo)}</Text>
              <Text style={styles.tdNum}>{formatMoneda(real)}</Text>
              <Text style={[styles.tdNum, Math.abs(diff) <= tol ? styles.diffOk : styles.diffBad]}>{formatMoneda(diff)}</Text>
            </View>
          );
        })}

        <View style={styles.bloque}>
          <Text style={styles.bloqueTitle}>Efectivo (sobre)</Text>
          <Text style={styles.bloqueLinea}>
            Diferencia efectivo: <Text style={Math.abs(t.diffEfectivo) <= tol ? styles.diffOk : styles.diffBad}>{formatMoneda(t.diffEfectivo)}</Text>
          </Text>
          {t.movimientos.retiradas > 0 ? (
            <Text style={styles.bloqueLineaMini}>Incluye {formatMoneda(t.movimientos.retiradas)} de retiradas registradas.</Text>
          ) : null}
        </View>

        <View style={styles.bloque}>
          <Text style={styles.bloqueTitle}>Tarjeta (boletas vs marcado)</Text>
          <Text style={styles.bloqueLinea}>Marcado (Ágora): {formatMoneda(t.tarjeta.teorica)}</Text>
          <Text style={styles.bloqueLinea}>Suma boletas: {formatMoneda(t.tarjeta.sumaBoletas)} ({t.tarjeta.numBoletas})</Text>
          {t.tarjeta.numBoletas > 0 ? (
            <Text style={styles.bloqueLinea}>
              Diferencia: <Text style={Math.abs(t.tarjeta.diffBoletas) <= tol ? styles.diffOk : styles.diffBad}>{formatMoneda(t.tarjeta.diffBoletas)}</Text>
            </Text>
          ) : null}
          {t.tarjeta.sinImagen ? <Text style={styles.bloqueWarn}>⚠ Hay boletas sin foto.</Text> : null}
          {t.tarjeta.sinOcr ? <Text style={styles.bloqueWarn}>⚠ Hay boletas sin OCR o sin banco.</Text> : null}
        </View>

        {t.movimientos.transferencias > 0 ? (
          <Text style={styles.bloqueLineaMini}>Transferencias de prepago: {formatMoneda(t.movimientos.transferencias)}</Text>
        ) : null}

        {t.estadoArqueo !== 'sin_arqueo' ? (
          <TouchableOpacity
            style={[styles.accionBtn, t.revisado ? styles.accionBtnQuitar : styles.accionBtnRevisar, accionBusy && styles.btnDis]}
            onPress={() => marcarRevisada(sel, !t.revisado)}
            disabled={accionBusy}
          >
            {accionBusy ? (
              <ActivityIndicator size="small" color={t.revisado ? statusColors.warning.text : colors.surface} />
            ) : (
              <MaterialIcons name={t.revisado ? 'undo' : 'verified'} size={18} color={t.revisado ? statusColors.warning.text : colors.surface} />
            )}
            <Text style={[styles.accionBtnText, t.revisado ? styles.accionBtnTextQuitar : null]}>
              {t.revisado ? 'Quitar revisión' : 'Marcar como revisada'}
            </Text>
          </TouchableOpacity>
        ) : null}
        {t.revisado && t.revisadoPor ? <Text style={styles.revisadoMeta}>Revisada por {t.revisadoPor}</Text> : null}

        <View style={styles.navRow}>
          <TouchableOpacity style={styles.navBtn} onPress={() => irAPantalla('/cajas/arqueo-caja', sel)}>
            <MaterialIcons name="account-balance-wallet" size={16} color={statusColors.info.text} />
            <Text style={styles.navBtnText}>Abrir arqueo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.navBtn} onPress={() => irAPantalla('/cajas/movimientos-caja', sel)}>
            <MaterialIcons name="swap-horiz" size={16} color={statusColors.info.text} />
            <Text style={styles.navBtnText}>Movimientos</Text>
          </TouchableOpacity>
        </View>
        <View style={{ height: 8 }} />
      </ScrollView>
    );
  };

  /** Fila de la bandeja (una caja TPV-día) — tarjeta ERP como operaciones. */
  const renderFila = (it: Item) => {
    const meta = STATUS_META[it.estado];
    const activo = it.key === selKey;
    const descuadreOk = Math.abs(it.tpv.descuadreTotal) <= tol;
    const sinArqueo = it.estado === 'sin_arqueo';
    const semColor = sinArqueo ? STATUS_META.sin_arqueo.color : descuadreOk ? STATUS_META.ok.color : STATUS_META.incidencia.color;
    const motivos = motivosIncidencia(it.tpv, tol);
    const detalle = it.tpv.revisado ? 'Revisada' : motivos.length > 0 ? motivos.join(' · ') : 'Cuadra';
    return (
      <TouchableOpacity
        key={it.key}
        style={[styles.card, activo && styles.cardActiva]}
        activeOpacity={0.7}
        onPress={() => setSelKey(it.key)}
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleWrap}>
            <Text style={styles.cardTitle} numberOfLines={1}>{it.tpv.posName}</Text>
            <View style={[styles.badge, { backgroundColor: meta.bg, borderColor: meta.border }]}>
              <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
            </View>
            <View style={[styles.dotSem, { backgroundColor: semColor }]} />
          </View>
          {!sinArqueo ? (
            <Text style={[styles.cardImporte, descuadreOk ? styles.diffOk : styles.diffBad]}>
              {formatMoneda(it.tpv.descuadreTotal)}
            </Text>
          ) : null}
        </View>
        <View style={styles.cardBody}>
          <View style={styles.cardField}>
            <Text style={styles.cardFieldLabel}>Día</Text>
            <Text style={styles.cardFieldValue}>{diaCorto(it.businessDay)}</Text>
          </View>
          <View style={styles.cardField}>
            <Text style={styles.cardFieldLabel}>Detalle</Text>
            <Text style={styles.cardFieldValue} numberOfLines={2}>{detalle}</Text>
          </View>
          {it.tpv.revisado && it.tpv.revisadoPor ? (
            <View style={styles.cardField}>
              <Text style={styles.cardFieldLabel}>Revisada por</Text>
              <Text style={styles.cardFieldValue} numberOfLines={1}>{it.tpv.revisadoPor}</Text>
            </View>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  if (!hasPermiso('cierres.ver')) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color={colors.textMuted} />
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  const hayDatos = (data?.locales || []).length > 0;

  const listaPanel = (
    <View style={[styles.panelLista, !shouldStackPanels && styles.panelListaBorder]}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          {!hayDatos ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="date-range" size={40} color={colors.borderStrong} />
              <Text style={styles.emptyText}>Selecciona un rango de fechas y local con datos para revisar.</Text>
            </View>
          ) : lista.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name={modo === 'pendientes' ? 'check-circle' : 'inbox'} size={40} color={modo === 'pendientes' ? '#86efac' : colors.borderStrong} />
              <Text style={styles.emptyText}>
                {modo === 'pendientes' ? '¡Todo revisado! No quedan cajas pendientes.' : 'Aún no hay cajas marcadas como revisadas.'}
              </Text>
            </View>
          ) : (
            listaAgrupada.map((g) => (
              <View key={g.workplaceId} style={styles.grupoLocal}>
                <View style={styles.grupoHeader}>
                  <MaterialIcons name="store" size={14} color={colors.textMuted} />
                  <Text style={styles.grupoNombre} numberOfLines={1}>{g.workplaceName}</Text>
                  <View style={styles.grupoCount}>
                    <Text style={styles.grupoCountText}>{g.items.length}</Text>
                  </View>
                </View>
                {g.items.map(renderFila)}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );

  const panelDetalle = (
    <View style={styles.panelDetalle}>
      {seleccion ? (
        renderDetalle(seleccion, false)
      ) : (
        <View style={styles.detalleVacio}>
          <MaterialIcons name="touch-app" size={40} color={colors.borderStrong} />
          <Text style={styles.detalleVacioText}>Selecciona una caja de la lista para revisarla.</Text>
          <Text style={styles.detalleVacioHint}>En escritorio puedes moverte con las flechas ↑ / ↓.</Text>
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Revisión de cajas</Text>
        <TouchableOpacity
          style={styles.createBtnOutline}
          onPress={() =>
            router.push({
              pathname: '/cajas/efectivo-ingresar',
              params: { dateFrom: fromIso, dateTo: toIso, ...(localFiltro ? { workplaceId: localFiltro } : {}) },
            })
          }
        >
          <MaterialIcons name="account-balance" size={16} color={colors.accent} />
          <Text style={styles.createBtnOutlineText}>Efectivo a ingresar</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.toolbar}>
        <View style={[styles.filtrosRow, shouldStackToolbar && styles.filtrosRowStack]}>
          <View style={styles.filtroCol}>
            <Text style={styles.labelFiltros}>Desde</Text>
            <InputFecha valueIso={fromIso} onChangeIso={setFromIso} placeholder="dd/mm/aaaa" style={styles.inputFechaCompact} />
          </View>
          <View style={styles.filtroCol}>
            <Text style={styles.labelFiltros}>Hasta</Text>
            <InputFecha valueIso={toIso} onChangeIso={setToIso} placeholder="dd/mm/aaaa" style={styles.inputFechaCompact} />
          </View>
          <View style={styles.filtroColWide}>
            <Text style={styles.labelFiltros}>Local</Text>
            <SelectorDesplegable
              icono="store"
              iconoLista="store"
              tituloLista="Local"
              placeholder="Todos mis locales"
              buscador
              buscadorPlaceholder="Buscar local…"
              valorId={localFiltro}
              opciones={[
                { id: '', titulo: 'Todos mis locales', icono: 'apps' as const },
                ...localesPermitidos.map((l) => ({ id: l.code, titulo: l.nombre || '—', subtitulo: `id ${l.code}`, icono: 'store' as const })),
              ]}
              onSeleccionar={(id) => setLocalFiltro(id)}
            />
          </View>
          <View style={styles.filtroColTol}>
            <Text style={styles.labelFiltros}>Tolerancia €</Text>
            <TextInput
              style={styles.inputTol}
              value={tolStr}
              onChangeText={setTolStr}
              keyboardType="decimal-pad"
              placeholder="1"
              placeholderTextColor={colors.textMuted}
            />
          </View>
        </View>

        <View style={styles.chipRowEstado}>
          {(['pendientes', 'revisadas'] as const).map((key) => {
            const pastel = CHIP_MODO_PASTEL[key];
            const sel = modo === key;
            const n = key === 'pendientes' ? pendientes.length : revisadas.length;
            return (
              <TouchableOpacity
                key={key}
                style={[
                  styles.estadoChip,
                  {
                    backgroundColor: sel ? pastel.bgSel : pastel.bg,
                    borderColor: sel ? pastel.borderSel : pastel.border,
                  },
                ]}
                onPress={() => setModo(key)}
                activeOpacity={0.75}
              >
                <Text style={[styles.estadoChipText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                  {key === 'pendientes' ? 'Pendientes' : 'Revisadas'}
                </Text>
                <View style={[styles.estadoChipCount, sel && styles.estadoChipCountSel]}>
                  <Text style={[styles.estadoChipCountText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                    {n}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.kpiRow}>
          <KpiCard label="Pendientes" value={String(resumenKpi.pendientes)} color={colors.warning} />
          <KpiCard label="Revisadas" value={String(resumenKpi.revisadas)} color={colors.success} />
          <KpiCard label="Incidencias" value={String(resumenKpi.incidencias)} color={colors.danger} />
          <KpiCard label="Sin arqueo" value={String(resumenKpi.sinArqueo)} />
          <KpiCard label="Cobertura" value={resumenKpi.cobertura} color={colors.accent} />
        </View>
      </View>

      {error ? (
        <View style={styles.errorBar}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
        {listaPanel}
        {!shouldStackPanels ? panelDetalle : null}
      </View>

      {/* Modal de detalle solo en pantallas compactas */}
      <Modal
        visible={shouldStackPanels && seleccion != null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelKey(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSelKey(null)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            {seleccion ? renderDetalle(seleccion, true) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { padding: 40, alignItems: 'center', gap: SPACING.sm },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: SPACING.md },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: SPACING.md,
  },
  backBtn: { padding: SPACING.xs },
  headerTitle: { flex: 1, fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  createBtnOutline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: colors.accentMuted,
  },
  createBtnOutlineText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.accent },

  toolbar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: SPACING.sm },
  filtrosRowStack: { flexDirection: 'column' },
  filtroCol: { flexGrow: 1, flexShrink: 1, minWidth: 120, maxWidth: 170 },
  filtroColWide: { flexGrow: 1, flexShrink: 1, minWidth: 160, maxWidth: 280 },
  filtroColTol: { flexGrow: 0, flexShrink: 0, width: 96 },
  labelFiltros: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: SPACING.xs, textTransform: 'uppercase', letterSpacing: 0.3 },
  inputFechaCompact: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], paddingVertical: SPACING.sm, paddingHorizontal: 10, minHeight: 40 },
  inputTol: {
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: RADIO_MEDIO, paddingHorizontal: 10, paddingVertical: 9,
    fontVariant: ['tabular-nums'], fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, backgroundColor: colors.surface, minHeight: 40, textAlign: 'center',
  },

  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: SPACING.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  estadoChipText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  estadoChipTextSel: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  estadoChipCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: RADIO_MEDIO,
    backgroundColor: 'rgba(15,23,42,0.06)',
    alignItems: 'center',
  },
  estadoChipCountSel: { backgroundColor: 'rgba(15,23,42,0.10)' },
  estadoChipCountText: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 88,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase' },
  kpiValue: { fontVariant: ['tabular-nums'], fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginTop: 2 },

  errorBar: {
    marginHorizontal: SPACING.lg,
    marginTop: SPACING.sm,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: statusColors.danger.bg,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger },

  split: { flex: 1, flexDirection: 'row', minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  panelLista: { flex: 1, minWidth: 0 },
  panelListaBorder: { borderRightWidth: 1, borderRightColor: colors.border, maxWidth: 420 },
  panelDetalle: { flex: 1.2, minWidth: 0, backgroundColor: colors.surface },

  list: { flex: 1 },
  listContent: { padding: SPACING.md, gap: 10, paddingBottom: SPACING.xl },

  grupoLocal: { gap: SPACING.sm },
  grupoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SPACING.xs,
    paddingVertical: SPACING.xs,
  },
  grupoNombre: { flex: 1, minWidth: 0, fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  grupoCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.border,
    alignItems: 'center',
  },
  grupoCountText: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cardActiva: { borderColor: '#7dd3fc', backgroundColor: colors.accentMuted },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
    gap: SPACING.sm,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flexShrink: 1 },
  badge: { paddingHorizontal: SPACING.sm, paddingVertical: 2, borderRadius: radius.md, borderWidth: 1 },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  dotSem: { width: 8, height: 8, borderRadius: radius.sm, flexShrink: 0 },
  cardImporte: { fontVariant: ['tabular-nums'], fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: SPACING.sm },
  cardField: { minWidth: 84, marginRight: SPACING.sm },
  cardFieldLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary },

  detalleVacio: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: SPACING.sm },
  detalleVacioText: { fontSize: fontSizes[14], color: colors.textMuted, textAlign: 'center', fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  detalleVacioHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.borderStrong, textAlign: 'center' },
  detalleScroll: { padding: 20, maxWidth: 640, width: '100%', alignSelf: 'center' },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'center', padding: SPACING.lg,
    ...(Platform.OS === 'web' ? { zIndex: 9999 } as object : {}),
  },
  modalSheet: {
    alignSelf: 'center', width: '100%', maxWidth: 520, backgroundColor: colors.surface, borderRadius: radius.lg,
    maxHeight: '88%', overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 16px 48px rgba(0,0,0,0.2)', zIndex: 10000 } as object : { elevation: 12 }),
  },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: SPACING.sm, marginBottom: 10 },
  modalTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  modalSub: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  modalAvisoSin: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, padding: 10, backgroundColor: statusColors.warning.bg, borderRadius: RADIO_MEDIO, borderWidth: 1, borderColor: '#fcd34d', marginBottom: SPACING.md },
  modalAvisoSinText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: '#92400e' },
  modalDescBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: SPACING.md, borderRadius: RADIO_MEDIO, borderWidth: 1, marginBottom: SPACING.md },
  modalDescOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  modalDescBad: { backgroundColor: statusColors.danger.bg, borderColor: '#fecaca' },
  modalDescLabel: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  modalDescVal: { fontVariant: ['tabular-nums'], fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  tablaHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  thMetodo: { flex: 1, fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase' },
  thNum: { width: 76, fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase', textAlign: 'right' },
  tablaRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.navActive },
  tdMetodo: { flex: 1, minWidth: 0, fontSize: fontSizes[13], color: colors.textPrimary, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  tdNum: { fontVariant: ['tabular-nums'], width: 76, fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, textAlign: 'right' },
  bloque: { marginTop: SPACING.md, padding: 10, backgroundColor: colors.bg, borderRadius: RADIO_MEDIO, borderWidth: 1, borderColor: colors.border },
  bloqueTitle: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  bloqueLinea: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, marginBottom: 2 },
  bloqueLineaMini: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontStyle: 'italic', marginTop: 6 },
  bloqueWarn: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.warning.text, marginTop: SPACING.xs },
  accionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, marginTop: SPACING.lg, paddingVertical: 13, borderRadius: radius.md },
  accionBtnRevisar: { backgroundColor: colors.success },
  accionBtnQuitar: { backgroundColor: statusColors.warning.bg, borderWidth: 1, borderColor: '#fcd34d' },
  accionBtnText: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
  accionBtnTextQuitar: { color: statusColors.warning.text },
  btnDis: { opacity: 0.6 },
  revisadoMeta: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, textAlign: 'center', marginTop: 6 },
  navRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  navBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: radius.md, borderWidth: 1, borderColor: '#bae6fd', backgroundColor: colors.accentMuted },
  navBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: statusColors.info.text },
  diffOk: { color: '#059669' },
  diffBad: { color: colors.danger },
});
