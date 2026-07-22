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
  sin_arqueo: { color: '#64748b', bg: '#f1f5f9', border: '#cbd5e1', label: 'Sin arqueo' },
  incidencia: { color: '#dc2626', bg: '#fef2f2', border: '#fecaca', label: 'Incidencia' },
  borrador: { color: '#b45309', bg: '#fffbeb', border: '#fcd34d', label: 'Borrador' },
  ok: { color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', label: 'Cuadra' },
  revisado: { color: '#15803d', bg: '#dcfce7', border: '#86efac', label: 'Revisada' },
  vacio: { color: '#cbd5e1', bg: '#f8fafc', border: '#e2e8f0', label: 'Sin datos' },
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
  pendientes: { bg: '#fffbeb', bgSel: '#fde68a', border: '#fde68a', borderSel: '#fcd34d', text: '#92400e' },
  revisadas: { bg: '#dcfce7', bgSel: '#bbf7d0', border: '#bbf7d0', borderSel: '#86efac', text: '#166534' },
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
              <MaterialIcons name="close" size={24} color="#64748b" />
            </TouchableOpacity>
          ) : null}
        </View>

        {t.estadoArqueo === 'sin_arqueo' ? (
          <View style={styles.modalAvisoSin}>
            <MaterialIcons name="info-outline" size={16} color="#b45309" />
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
              <ActivityIndicator size="small" color={t.revisado ? '#b45309' : '#fff'} />
            ) : (
              <MaterialIcons name={t.revisado ? 'undo' : 'verified'} size={18} color={t.revisado ? '#b45309' : '#fff'} />
            )}
            <Text style={[styles.accionBtnText, t.revisado ? styles.accionBtnTextQuitar : null]}>
              {t.revisado ? 'Quitar revisión' : 'Marcar como revisada'}
            </Text>
          </TouchableOpacity>
        ) : null}
        {t.revisado && t.revisadoPor ? <Text style={styles.revisadoMeta}>Revisada por {t.revisadoPor}</Text> : null}

        <View style={styles.navRow}>
          <TouchableOpacity style={styles.navBtn} onPress={() => irAPantalla('/cajas/arqueo-caja', sel)}>
            <MaterialIcons name="account-balance-wallet" size={16} color="#0369a1" />
            <Text style={styles.navBtnText}>Abrir arqueo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.navBtn} onPress={() => irAPantalla('/cajas/movimientos-caja', sel)}>
            <MaterialIcons name="swap-horiz" size={16} color="#0369a1" />
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
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.errorText}>No tienes permiso para ver esta pantalla.</Text>
      </View>
    );
  }

  const hayDatos = (data?.locales || []).length > 0;

  const listaPanel = (
    <View style={[styles.panelLista, !shouldStackPanels && styles.panelListaBorder]}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          {!hayDatos ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="date-range" size={40} color="#cbd5e1" />
              <Text style={styles.emptyText}>Selecciona un rango de fechas y local con datos para revisar.</Text>
            </View>
          ) : lista.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name={modo === 'pendientes' ? 'check-circle' : 'inbox'} size={40} color={modo === 'pendientes' ? '#86efac' : '#cbd5e1'} />
              <Text style={styles.emptyText}>
                {modo === 'pendientes' ? '¡Todo revisado! No quedan cajas pendientes.' : 'Aún no hay cajas marcadas como revisadas.'}
              </Text>
            </View>
          ) : (
            listaAgrupada.map((g) => (
              <View key={g.workplaceId} style={styles.grupoLocal}>
                <View style={styles.grupoHeader}>
                  <MaterialIcons name="store" size={14} color="#64748b" />
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
          <MaterialIcons name="touch-app" size={40} color="#cbd5e1" />
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
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
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
          <MaterialIcons name="account-balance" size={16} color="#0ea5e9" />
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
              placeholderTextColor="#94a3b8"
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
          <KpiCard label="Pendientes" value={String(resumenKpi.pendientes)} color="#d97706" />
          <KpiCard label="Revisadas" value={String(resumenKpi.revisadas)} color="#16a34a" />
          <KpiCard label="Incidencias" value={String(resumenKpi.incidencias)} color="#dc2626" />
          <KpiCard label="Sin arqueo" value={String(resumenKpi.sinArqueo)} />
          <KpiCard label="Cobertura" value={resumenKpi.cobertura} color="#0ea5e9" />
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { padding: 40, alignItems: 'center', gap: 8 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },

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
  createBtnOutline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  createBtnOutlineText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },

  toolbar: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8 },
  filtrosRowStack: { flexDirection: 'column' },
  filtroCol: { flexGrow: 1, flexShrink: 1, minWidth: 120, maxWidth: 170 },
  filtroColWide: { flexGrow: 1, flexShrink: 1, minWidth: 160, maxWidth: 280 },
  filtroColTol: { flexGrow: 0, flexShrink: 0, width: 96 },
  labelFiltros: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  inputFechaCompact: { fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, minHeight: 40 },
  inputTol: {
    borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9,
    fontSize: 14, color: '#334155', backgroundColor: '#fff', minHeight: 40, textAlign: 'center',
  },

  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  estadoChipText: { fontSize: 11, fontWeight: '600' },
  estadoChipTextSel: { fontWeight: '800' },
  estadoChipCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(15,23,42,0.06)',
    alignItems: 'center',
  },
  estadoChipCountSel: { backgroundColor: 'rgba(15,23,42,0.10)' },
  estadoChipCountText: { fontSize: 10, fontWeight: '700' },

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 88,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginTop: 2 },

  errorBar: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontSize: 12, color: '#dc2626' },

  split: { flex: 1, flexDirection: 'row', minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  panelLista: { flex: 1, minWidth: 0 },
  panelListaBorder: { borderRightWidth: 1, borderRightColor: '#e2e8f0', maxWidth: 420 },
  panelDetalle: { flex: 1.2, minWidth: 0, backgroundColor: '#fff' },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 24 },

  grupoLocal: { gap: 8 },
  grupoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  grupoNombre: { flex: 1, minWidth: 0, fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 },
  grupoCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
  },
  grupoCountText: { fontSize: 10, fontWeight: '700', color: '#475569' },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardActiva: { borderColor: '#7dd3fc', backgroundColor: '#f0f9ff' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardImporte: { fontSize: 13, fontWeight: '700' },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },

  detalleVacio: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  detalleVacioText: { fontSize: 14, color: '#94a3b8', textAlign: 'center', fontWeight: '600' },
  detalleVacioHint: { fontSize: 12, color: '#cbd5e1', textAlign: 'center' },
  detalleScroll: { padding: 20, maxWidth: 640, width: '100%', alignSelf: 'center' },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'center', padding: 16,
    ...(Platform.OS === 'web' ? { zIndex: 9999 } as object : {}),
  },
  modalSheet: {
    alignSelf: 'center', width: '100%', maxWidth: 520, backgroundColor: '#fff', borderRadius: 12,
    maxHeight: '88%', overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 16px 48px rgba(0,0,0,0.2)', zIndex: 10000 } as object : { elevation: 12 }),
  },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  modalSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  modalAvisoSin: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fffbeb', borderRadius: 8, borderWidth: 1, borderColor: '#fcd34d', marginBottom: 12 },
  modalAvisoSinText: { flex: 1, fontSize: 12, color: '#92400e' },
  modalDescBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 8, borderWidth: 1, marginBottom: 12 },
  modalDescOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  modalDescBad: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  modalDescLabel: { fontSize: 13, fontWeight: '600', color: '#334155' },
  modalDescVal: { fontSize: 18, fontWeight: '700' },
  tablaHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  thMetodo: { flex: 1, fontSize: 10, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase' },
  thNum: { width: 76, fontSize: 10, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', textAlign: 'right' },
  tablaRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  tdMetodo: { flex: 1, minWidth: 0, fontSize: 13, color: '#334155', fontWeight: '500' },
  tdNum: { width: 76, fontSize: 13, color: '#334155', textAlign: 'right' },
  bloque: { marginTop: 12, padding: 10, backgroundColor: '#f8fafc', borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  bloqueTitle: { fontSize: 12, fontWeight: '700', color: '#334155', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  bloqueLinea: { fontSize: 13, color: '#475569', marginBottom: 2 },
  bloqueLineaMini: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic', marginTop: 6 },
  bloqueWarn: { fontSize: 12, color: '#b45309', marginTop: 4 },
  accionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, paddingVertical: 13, borderRadius: 10 },
  accionBtnRevisar: { backgroundColor: '#16a34a' },
  accionBtnQuitar: { backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fcd34d' },
  accionBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  accionBtnTextQuitar: { color: '#b45309' },
  btnDis: { opacity: 0.6 },
  revisadoMeta: { fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 6 },
  navRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  navBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 10, borderWidth: 1, borderColor: '#bae6fd', backgroundColor: '#f0f9ff' },
  navBtnText: { fontSize: 13, fontWeight: '600', color: '#0369a1' },
  diffOk: { color: '#059669' },
  diffBad: { color: '#dc2626' },
});
