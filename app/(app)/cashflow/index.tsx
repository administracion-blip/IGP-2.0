import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { InputFecha } from '../../components/InputFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { CollapsibleSection } from '../../components/CollapsibleSection';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';
import { formatId6 } from '../../utils/idFormat';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';
import {
  type CashflowEstado,
  type CashflowMovimiento,
  type CashflowResumen,
  type CashflowTipo,
  ESTADO_CASHFLOW_META,
  CHIP_ESTADO_CASHFLOW_PASTEL,
  CHIP_TIPO_CASHFLOW_PASTEL,
  CATEGORIA_CASHFLOW_LABEL,
  formatImporteCashflow,
  lineasMovimiento,
} from '../../types/cashflow';

type LocalItem = { id_Locales?: string | number; nombre?: string; Nombre?: string };

function formatMoneda(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const parts = Math.abs(n).toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = n < 0 ? '-' : '';
  return `${sign}${intPart},${parts[1]} €`;
}

function fechaCorta(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso || '—';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function normalizarBusqueda(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function movimientoCoincideBusqueda(m: CashflowMovimiento, q: string): boolean {
  const needle = normalizarBusqueda(q);
  if (!needle) return true;

  const lineas = lineasMovimiento(m).map((l) => l.descripcion);
  const campos = [
    m.movimientoId,
    m.concepto,
    m.localNombre,
    m.localId,
    m.empresaNombre,
    m.empresaCif,
    m.empresaId,
    m.numeroRecibo,
    m.contraparte?.nombre,
    m.contraparte?.nif,
    m.contraparte?.telefono,
    m.contraparteRef?.id,
    m.contraparteRef?.tipo,
    m.categoria,
    CATEGORIA_CASHFLOW_LABEL[m.categoria],
    m.creadoPorNombre,
    m.creadoPor,
    m.firmadoPorNombre,
    m.firmadoPorId,
    m.actuacionId,
    m.tipo === 'pago' ? 'pago pagos' : 'cobro cobros',
    ESTADO_CASHFLOW_META[m.estado]?.label,
    ...lineas,
    ...(m.emailsCopia ?? []),
  ];

  const haystack = normalizarBusqueda(campos.filter(Boolean).join(' '));
  return haystack.includes(needle);
}

function esPendienteAccion(estado: CashflowEstado): boolean {
  return estado === 'Pendiente_firma' || estado === 'Pendiente_validacion';
}

const FILTROS_ESTADO: { id: CashflowEstado | ''; label: string }[] = [
  { id: '', label: 'Todos' },
  { id: 'Pendiente_firma', label: 'Pendiente firma' },
  { id: 'Pendiente_validacion', label: 'Pend. validación' },
  { id: 'Firmado', label: 'Firmado' },
  { id: 'Anulado', label: 'Anulado' },
];

const FILTROS_TIPO: { id: CashflowTipo | ''; label: string }[] = [
  { id: '', label: 'Todos' },
  { id: 'pago', label: 'Pagos' },
  { id: 'cobro', label: 'Cobros' },
];

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export default function CashflowIndexScreen() {
  const router = useRouter();
  const { hasPermiso, localPermitido } = useAuth();
  const { shouldStackPanels, shouldStackToolbar } = useBreakpoint();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [fromIso, setFromIso] = useState(() => fechaJornadaNegocioIso());
  const [toIso, setToIso] = useState(() => fechaJornadaNegocioIso());
  const [localId, setLocalId] = useState('');
  const [filtroTipo, setFiltroTipo] = useState<CashflowTipo | ''>('');
  const [filtroEstado, setFiltroEstado] = useState<CashflowEstado | ''>('');
  const [busqueda, setBusqueda] = useState('');

  const [movimientos, setMovimientos] = useState<CashflowMovimiento[]>([]);
  const [resumen, setResumen] = useState<CashflowResumen | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const puedeRegistrar = hasPermiso('cashflow.registrar');

  const localesPermitidos = useMemo(
    () =>
      locales
        .map((l) => ({
          id: formatId6(l.id_Locales),
          nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
        }))
        .filter((l) => l.nombre && localPermitido(l.nombre))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [locales, localPermitido],
  );

  const conteoPorTipo = useMemo(() => {
    const counts: Record<string, number> = { '': movimientos.length, pago: 0, cobro: 0 };
    for (const m of movimientos) {
      if (counts[m.tipo] != null) counts[m.tipo]++;
    }
    return counts;
  }, [movimientos]);

  const conteoPorEstado = useMemo(() => {
    const counts: Record<string, number> = {
      '': movimientos.length,
      Pendiente_firma: 0,
      Pendiente_validacion: 0,
      Firmado: 0,
      Anulado: 0,
    };
    for (const m of movimientos) {
      if (counts[m.estado] != null) counts[m.estado]++;
    }
    return counts;
  }, [movimientos]);

  const movimientosFiltrados = useMemo(() => {
    let list = movimientos;
    if (filtroTipo) list = list.filter((m) => m.tipo === filtroTipo);
    if (filtroEstado) list = list.filter((m) => m.estado === filtroEstado);
    const q = busqueda.trim();
    if (q) list = list.filter((m) => movimientoCoincideBusqueda(m, q));
    return list;
  }, [movimientos, filtroTipo, filtroEstado, busqueda]);

  const gruposMovimientos = useMemo(() => {
    const pendientes: CashflowMovimiento[] = [];
    const firmados: CashflowMovimiento[] = [];
    const anulados: CashflowMovimiento[] = [];

    for (const m of movimientosFiltrados) {
      if (m.estado === 'Anulado') anulados.push(m);
      else if (m.estado === 'Firmado') firmados.push(m);
      else if (esPendienteAccion(m.estado)) pendientes.push(m);
      else firmados.push(m);
    }

    return { pendientes, firmados, anulados };
  }, [movimientosFiltrados]);

  const hayBusqueda = busqueda.trim().length > 0;

  useEffect(() => {
    apiFetch('/api/locales')
      .then((r) => r.json())
      .then((d) => setLocales(Array.isArray(d.locales) ? d.locales : []))
      .catch(() => setLocales([]));
  }, []);

  const cargar = useCallback(() => {
    if (!fromIso || !toIso) return;
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);

    const q = new URLSearchParams({ dateFrom: fromIso, dateTo: toIso });
    if (localId) q.set('localId', localId);

    Promise.all([
      apiFetch(`/api/cashflow?${q}`).then((r) => r.json()),
      apiFetch(`/api/cashflow/resumen?dateFrom=${fromIso}&dateTo=${toIso}`).then((r) => r.json()),
    ])
      .then(([lista, res]) => {
        if (reqIdRef.current !== myId) return;
        if (lista.error) throw new Error(lista.error);
        if (res.error) throw new Error(res.error);
        setMovimientos(Array.isArray(lista.movimientos) ? lista.movimientos : []);
        setResumen(res as CashflowResumen);
      })
      .catch((e) => {
        if (reqIdRef.current !== myId) return;
        setError(e instanceof Error ? e.message : 'Error al cargar movimientos');
        setMovimientos([]);
        setResumen(null);
      })
      .finally(() => {
        if (reqIdRef.current === myId) setLoading(false);
      });
  }, [fromIso, toIso, localId]);

  useFocusEffect(
    useCallback(() => {
      const t = setTimeout(cargar, 200);
      return () => clearTimeout(t);
    }, [cargar]),
  );

  function renderMovimientoRow(m: CashflowMovimiento) {
    const meta = ESTADO_CASHFLOW_META[m.estado] ?? ESTADO_CASHFLOW_META.Pendiente_firma;
    const esPago = m.tipo === 'pago';
    return (
      <TouchableOpacity
        key={m.movimientoId}
        style={styles.card}
        activeOpacity={0.7}
        onPress={() => router.push(`/cashflow/${m.movimientoId}` as never)}
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleWrap}>
            <Text style={styles.cardTitle} numberOfLines={1}>{m.concepto}</Text>
            <View style={[styles.badge, { backgroundColor: esPago ? statusColors.danger.bg : statusColors.success.bg, borderColor: esPago ? '#fca5a5' : '#86efac' }]}>
              <Text style={[styles.badgeText, { color: esPago ? '#991b1b' : '#166534' }]}>
                {esPago ? 'Pago' : 'Cobro'}
              </Text>
            </View>
            <View style={[styles.badge, { backgroundColor: meta.bg, borderColor: meta.border }]}>
              <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
            </View>
            <View
              style={[
                styles.dotSem,
                { backgroundColor: m.estado === 'Anulado' ? colors.textMuted : esPago ? colors.danger : colors.success },
              ]}
            />
          </View>
          <Text style={[styles.cardImporte, esPago ? styles.importePago : styles.importeCobro]}>
            {formatImporteCashflow(m.importe, m.tipo)}
          </Text>
        </View>
        <View style={styles.cardBody}>
          <View style={styles.cardField}>
            <Text style={styles.cardFieldLabel}>Fecha</Text>
            <Text style={styles.cardFieldValue}>{fechaCorta(m.fecha)}</Text>
          </View>
          <View style={styles.cardField}>
            <Text style={styles.cardFieldLabel}>Local</Text>
            <Text style={styles.cardFieldValue} numberOfLines={1}>{m.localNombre || '—'}</Text>
          </View>
          <View style={styles.cardField}>
            <Text style={styles.cardFieldLabel}>Categoría</Text>
            <Text style={styles.cardFieldValue} numberOfLines={1}>
              {CATEGORIA_CASHFLOW_LABEL[m.categoria] ?? m.categoria}
            </Text>
          </View>
          <View style={styles.cardField}>
            <Text style={styles.cardFieldLabel}>Contraparte</Text>
            <Text style={styles.cardFieldValue} numberOfLines={1}>{m.contraparte?.nombre || '—'}</Text>
          </View>
          {m.numeroRecibo ? (
            <View style={styles.cardField}>
              <Text style={styles.cardFieldLabel}>Recibo</Text>
              <Text style={styles.cardFieldValue}>{m.numeroRecibo}</Text>
            </View>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  }

  const listaContenido = () => {
    if (loading) return null;
    if (movimientos.length === 0 && !error) {
      return (
        <View style={styles.emptyWrap}>
          <MaterialIcons name="account-balance-wallet" size={40} color={colors.borderStrong} />
          <Text style={styles.emptyText}>No hay movimientos en el rango seleccionado.</Text>
        </View>
      );
    }
    if (movimientosFiltrados.length === 0) {
      return (
        <View style={styles.emptyWrap}>
          <MaterialIcons name="search-off" size={40} color={colors.borderStrong} />
          <Text style={styles.emptyText}>
            {hayBusqueda ? 'No hay movimientos que coincidan con la búsqueda.' : 'No hay movimientos con este filtro.'}
          </Text>
        </View>
      );
    }
    if (hayBusqueda) return movimientosFiltrados.map(renderMovimientoRow);
    return (
      <View style={styles.listaAgrupada}>
        <View style={styles.sectionBlock}>
          <View style={styles.sectionHeader}>
            <MaterialIcons name="pending-actions" size={16} color={colors.warning} />
            <Text style={styles.sectionTitle}>
              Pendientes ({gruposMovimientos.pendientes.length})
            </Text>
          </View>
          {gruposMovimientos.pendientes.length > 0 ? (
            gruposMovimientos.pendientes.map(renderMovimientoRow)
          ) : (
            <Text style={styles.sectionHint}>No hay movimientos pendientes en este rango.</Text>
          )}
        </View>
        {gruposMovimientos.firmados.length > 0 ? (
          <View style={styles.sectionBlock}>
            <CollapsibleSection title={`Firmados (${gruposMovimientos.firmados.length})`} defaultOpen={false}>
              {gruposMovimientos.firmados.map(renderMovimientoRow)}
            </CollapsibleSection>
          </View>
        ) : null}
        {gruposMovimientos.anulados.length > 0 ? (
          <View style={styles.sectionBlock}>
            <CollapsibleSection title={`Anulados (${gruposMovimientos.anulados.length})`} defaultOpen={false}>
              {gruposMovimientos.anulados.map(renderMovimientoRow)}
            </CollapsibleSection>
          </View>
        ) : null}
      </View>
    );
  };

  const panelKpi = (
    <View style={styles.panelKpi}>
      <Text style={styles.sectionTitle}>Resumen firmados</Text>
      <Text style={styles.resumenHint}>
        {resumen ? `${fechaCorta(resumen.dateFrom)} – ${fechaCorta(resumen.dateTo)}` : '—'}
      </Text>
      {resumen ? (
        <>
          <View style={styles.kpiRow}>
            <KpiCard label="Pagos" value={formatMoneda(resumen.pagos)} color={colors.danger} />
            <KpiCard label="Cobros banco" value={formatMoneda(resumen.cobrosBanco)} color={colors.success} />
          </View>
          <View style={styles.kpiRow}>
            <KpiCard label="Reparto socios" value={formatMoneda(resumen.cobrosReparto)} />
            <KpiCard label="Neto banco" value={formatMoneda(resumen.neto)} color={colors.accent} />
          </View>
          <View style={styles.kpiRow}>
            <KpiCard label="En lista" value={String(movimientosFiltrados.length)} />
            <KpiCard label="Pendientes" value={String(conteoPorEstado.Pendiente_firma + conteoPorEstado.Pendiente_validacion)} color={colors.warning} />
          </View>
        </>
      ) : (
        <Text style={styles.resumenHint}>Sin datos de resumen para el periodo.</Text>
      )}
      <Text style={styles.resumenHint}>
        Pagos y cobros en efectivo fuera del TPV. Los firmados entran en el resumen financiero del periodo.
      </Text>
    </View>
  );

  if (!hasPermiso('cashflow.ver')) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color={colors.textMuted} />
        <Text style={styles.errorText}>No tienes permiso para ver Cashflow.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Cashflow</Text>
        {puedeRegistrar ? (
          <TouchableOpacity style={styles.createBtn} onPress={() => router.push('/cashflow/nuevo' as never)}>
            <MaterialIcons name="add" size={16} color={colors.surface} />
            <Text style={styles.createBtnText}>Nuevo</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <View style={[styles.filtrosRow, shouldStackToolbar && styles.filtrosCol]}>
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
              valorId={localId}
              opciones={[
                { id: '', titulo: 'Todos mis locales', icono: 'apps' as const },
                ...localesPermitidos.map((l) => ({
                  id: l.id,
                  titulo: l.nombre,
                  subtitulo: `ID ${l.id}`,
                  icono: 'store' as const,
                })),
              ]}
              onSeleccionar={setLocalId}
            />
          </View>
        </View>

        <View style={styles.chipRowEstado}>
          {FILTROS_TIPO.map((f) => {
            const key = f.id || '';
            const pastel = CHIP_TIPO_CASHFLOW_PASTEL[key] ?? CHIP_TIPO_CASHFLOW_PASTEL[''];
            const sel = filtroTipo === f.id;
            const n = conteoPorTipo[key] ?? 0;
            return (
              <TouchableOpacity
                key={key || 'tipo-todos'}
                style={[
                  styles.estadoChip,
                  { backgroundColor: sel ? pastel.bgSel : pastel.bg, borderColor: sel ? pastel.borderSel : pastel.border },
                ]}
                onPress={() => setFiltroTipo(f.id)}
                activeOpacity={0.75}
              >
                <Text style={[styles.estadoChipText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                  {f.label}
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

        <View style={styles.chipRowEstado}>
          {FILTROS_ESTADO.map((f) => {
            const key = f.id || '';
            const pastel = CHIP_ESTADO_CASHFLOW_PASTEL[key] ?? CHIP_ESTADO_CASHFLOW_PASTEL[''];
            const sel = filtroEstado === f.id;
            const n = conteoPorEstado[key] ?? 0;
            return (
              <TouchableOpacity
                key={key || 'est-todos'}
                style={[
                  styles.estadoChip,
                  { backgroundColor: sel ? pastel.bgSel : pastel.bg, borderColor: sel ? pastel.borderSel : pastel.border },
                ]}
                onPress={() => setFiltroEstado(f.id)}
                activeOpacity={0.75}
              >
                <Text style={[styles.estadoChipText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                  {f.label}
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

        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={busqueda}
            onChangeText={setBusqueda}
            placeholder="Buscar por concepto, contraparte, NIF, recibo, local…"
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {busqueda.length > 0 ? (
            <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={8}>
              <MaterialIcons name="close" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {error ? (
        <View style={styles.errorBar}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
        <View style={[styles.panelLista, !shouldStackPanels && styles.panelListaBorder]}>
          {loading ? (
            <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
              {movimientos.length > 0 && movimientosFiltrados.length > 0 ? (
                <Text style={styles.resultCount}>
                  {movimientosFiltrados.length !== movimientos.length
                    ? `${movimientosFiltrados.length} de ${movimientos.length} movimientos`
                    : `${movimientos.length} movimiento${movimientos.length === 1 ? '' : 's'}`}
                </Text>
              ) : null}
              {listaContenido()}
            </ScrollView>
          )}
        </View>
        <View style={[styles.panelKpiWrap, !shouldStackPanels && styles.panelKpiWrapSide, shouldStackPanels && styles.panelKpiWrapStack]}>
          {panelKpi}
        </View>
      </View>
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
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 14,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.accent,
  },
  createBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.surface },

  toolbar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  filtrosCol: { flexDirection: 'column' },
  filtroCol: { flexGrow: 1, minWidth: 120, maxWidth: 200 },
  filtroColWide: { flexGrow: 1, minWidth: 180, maxWidth: 320 },
  labelFiltros: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase' },
  inputFechaCompact: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], paddingVertical: SPACING.sm, paddingHorizontal: 10, minHeight: 40 },

  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  estadoChipText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  estadoChipTextSel: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  /** Velo muy suave; no es colors.overlay. */
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

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  searchInput: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, paddingVertical: 4, minHeight: 36 },

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
  panelListaBorder: { borderRightWidth: 1, borderRightColor: colors.border },
  panelKpiWrap: { minWidth: 280, backgroundColor: colors.surface },
  panelKpiWrapSide: { flex: 0.42, maxWidth: 420 },
  panelKpiWrapStack: { flex: undefined, borderTopWidth: 1, borderTopColor: colors.border },

  list: { flex: 1 },
  listContent: { padding: SPACING.md, gap: 10, paddingBottom: SPACING.xl },
  resultCount: { fontSize: typography.etiqueta.fontSize, color: colors.textMuted, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, marginBottom: 4 },
  listaAgrupada: { gap: 10 },
  sectionBlock: { gap: SPACING.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: 4 },
  sectionTitle: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong },
  sectionHint: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, fontStyle: 'italic', paddingHorizontal: 4 },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
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
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, flexWrap: 'wrap' },
  cardTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, flexShrink: 1 },
  badge: { paddingHorizontal: SPACING.sm, paddingVertical: 2, borderRadius: radius.md, borderWidth: 1 },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  /** 4 px; por debajo de radius.sm (6). */
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardImporte: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontVariant: ['tabular-nums'] },
  importePago: { color: colors.danger },
  importeCobro: { color: colors.success },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: SPACING.sm },
  cardField: { minWidth: 84, marginRight: SPACING.sm },
  cardFieldLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted, textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary },

  panelKpi: { flex: 1, padding: SPACING.md, gap: 10 },
  kpiRow: { flexDirection: 'row', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textMuted, textTransform: 'uppercase' },
  kpiValue: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textStrong, marginTop: 2, fontVariant: ['tabular-nums'] },
  resumenHint: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, lineHeight: 16 },
});
