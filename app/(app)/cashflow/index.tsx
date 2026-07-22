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
            <View style={[styles.badge, { backgroundColor: esPago ? '#fee2e2' : '#dcfce7', borderColor: esPago ? '#fca5a5' : '#86efac' }]}>
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
                { backgroundColor: m.estado === 'Anulado' ? '#94a3b8' : esPago ? '#dc2626' : '#16a34a' },
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
          <MaterialIcons name="account-balance-wallet" size={40} color="#cbd5e1" />
          <Text style={styles.emptyText}>No hay movimientos en el rango seleccionado.</Text>
        </View>
      );
    }
    if (movimientosFiltrados.length === 0) {
      return (
        <View style={styles.emptyWrap}>
          <MaterialIcons name="search-off" size={40} color="#cbd5e1" />
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
            <MaterialIcons name="pending-actions" size={16} color="#d97706" />
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
            <KpiCard label="Pagos" value={formatMoneda(resumen.pagos)} color="#dc2626" />
            <KpiCard label="Cobros banco" value={formatMoneda(resumen.cobrosBanco)} color="#16a34a" />
          </View>
          <View style={styles.kpiRow}>
            <KpiCard label="Reparto socios" value={formatMoneda(resumen.cobrosReparto)} />
            <KpiCard label="Neto banco" value={formatMoneda(resumen.neto)} color="#0ea5e9" />
          </View>
          <View style={styles.kpiRow}>
            <KpiCard label="En lista" value={String(movimientosFiltrados.length)} />
            <KpiCard label="Pendientes" value={String(conteoPorEstado.Pendiente_firma + conteoPorEstado.Pendiente_validacion)} color="#d97706" />
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
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.errorText}>No tienes permiso para ver Cashflow.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Cashflow</Text>
        {puedeRegistrar ? (
          <TouchableOpacity style={styles.createBtn} onPress={() => router.push('/cashflow/nuevo' as never)}>
            <MaterialIcons name="add" size={16} color="#fff" />
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
          <MaterialIcons name="search" size={18} color="#94a3b8" />
          <TextInput
            style={styles.searchInput}
            value={busqueda}
            onChangeText={setBusqueda}
            placeholder="Buscar por concepto, contraparte, NIF, recibo, local…"
            placeholderTextColor="#94a3b8"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {busqueda.length > 0 ? (
            <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={8}>
              <MaterialIcons name="close" size={16} color="#94a3b8" />
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
            <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
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
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  createBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  toolbar: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filtrosCol: { flexDirection: 'column' },
  filtroCol: { flexGrow: 1, minWidth: 120, maxWidth: 200 },
  filtroColWide: { flexGrow: 1, minWidth: 180, maxWidth: 320 },
  labelFiltros: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase' },
  inputFechaCompact: { fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, minHeight: 40 },

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

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 14, color: '#334155', paddingVertical: 4, minHeight: 36 },

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
  panelListaBorder: { borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  panelKpiWrap: { minWidth: 280, backgroundColor: '#fff' },
  panelKpiWrapSide: { flex: 0.42, maxWidth: 420 },
  panelKpiWrapStack: { flex: undefined, borderTopWidth: 1, borderTopColor: '#e2e8f0' },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 24 },
  resultCount: { fontSize: 11, color: '#64748b', fontWeight: '600', marginBottom: 4 },
  listaAgrupada: { gap: 10 },
  sectionBlock: { gap: 8 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  sectionHint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', paddingHorizontal: 4 },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
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
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, flexWrap: 'wrap' },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardImporte: { fontSize: 14, fontWeight: '800' },
  importePago: { color: '#dc2626' },
  importeCobro: { color: '#16a34a' },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },

  panelKpi: { flex: 1, padding: 12, gap: 10 },
  kpiRow: { flexDirection: 'row', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginTop: 2 },
  resumenHint: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
});
