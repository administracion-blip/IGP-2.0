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

  const movimientosFiltrados = useMemo(() => {
    const q = busqueda.trim();
    if (!q) return movimientos;
    return movimientos.filter((m) => movimientoCoincideBusqueda(m, q));
  }, [movimientos, busqueda]);

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
    if (filtroTipo) q.set('tipo', filtroTipo);
    if (filtroEstado) q.set('estado', filtroEstado);

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
  }, [fromIso, toIso, localId, filtroTipo, filtroEstado]);

  useFocusEffect(
    useCallback(() => {
      const t = setTimeout(cargar, 200);
      return () => clearTimeout(t);
    }, [cargar]),
  );

  if (!hasPermiso('cashflow.ver')) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>No tienes permiso para ver Cashflow.</Text>
      </View>
    );
  }

  function renderMovimientoRow(m: CashflowMovimiento) {
    const meta = ESTADO_CASHFLOW_META[m.estado] ?? ESTADO_CASHFLOW_META.Pendiente_firma;
    const esPago = m.tipo === 'pago';
    return (
      <TouchableOpacity
        key={m.movimientoId}
        style={styles.rowCard}
        onPress={() => router.push(`/cashflow/${m.movimientoId}` as never)}
      >
        <View style={styles.rowTop}>
          <View style={[styles.tipoBadge, esPago ? styles.tipoPago : styles.tipoCobro]}>
            <MaterialIcons
              name={esPago ? 'arrow-upward' : 'arrow-downward'}
              size={14}
              color={esPago ? '#b91c1c' : '#15803d'}
            />
            <Text style={[styles.tipoText, esPago ? styles.tipoTextPago : styles.tipoTextCobro]}>
              {esPago ? 'Pago' : 'Cobro'}
            </Text>
          </View>
          <View style={[styles.estadoBadge, { backgroundColor: meta.bg }]}>
            <Text style={[styles.estadoText, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Text style={[styles.importe, esPago ? styles.importePago : styles.importeCobro]}>
            {formatImporteCashflow(m.importe, m.tipo)}
          </Text>
        </View>
        <Text style={styles.concepto} numberOfLines={2}>{m.concepto}</Text>
        <View style={styles.rowMeta}>
          <Text style={styles.metaText}>{fechaCorta(m.fecha)} · {m.localNombre || '—'}</Text>
          <Text style={styles.metaText}>{CATEGORIA_CASHFLOW_LABEL[m.categoria] ?? m.categoria}</Text>
        </View>
        <Text style={styles.contraparte} numberOfLines={1}>
          {m.contraparte?.nombre || '—'}
          {m.numeroRecibo ? ` · Recibo ${m.numeroRecibo}` : ''}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.formMax}>
          <View style={[styles.headerRow, shouldStackToolbar && styles.headerCol]}>
            <View style={styles.headerMain}>
              <TouchableOpacity onPress={() => router.push('/' as never)} style={styles.backBtn}>
                <MaterialIcons name="arrow-back" size={22} color="#334155" />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>Cashflow</Text>
                <Text style={styles.subtitle}>Pagos y cobros en efectivo fuera del TPV</Text>
              </View>
            </View>
            {puedeRegistrar ? (
              <TouchableOpacity
                style={styles.btnNuevo}
                onPress={() => router.push('/cashflow/nuevo' as never)}
              >
                <MaterialIcons name="add" size={20} color="#fff" />
                <Text style={styles.btnNuevoText}>Nuevo movimiento</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={[styles.filtrosRow, shouldStackPanels && styles.filtrosCol]}>
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

          <View style={styles.chipsRow}>
            {FILTROS_TIPO.map((f) => (
              <TouchableOpacity
                key={f.id || 'todos'}
                style={[styles.chipFiltro, filtroTipo === f.id && styles.chipFiltroActivo]}
                onPress={() => setFiltroTipo(f.id)}
              >
                <Text style={[styles.chipFiltroText, filtroTipo === f.id && styles.chipFiltroTextActivo]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.chipsRow}>
            {FILTROS_ESTADO.map((f) => (
              <TouchableOpacity
                key={f.id || 'est-todos'}
                style={[styles.chipFiltro, filtroEstado === f.id && styles.chipFiltroActivo]}
                onPress={() => setFiltroEstado(f.id)}
              >
                <Text style={[styles.chipFiltroText, filtroEstado === f.id && styles.chipFiltroTextActivo]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.searchWrap}>
            <MaterialIcons name="search" size={18} color="#94a3b8" />
            <TextInput
              style={styles.searchInput}
              value={busqueda}
              onChangeText={setBusqueda}
              placeholder="Buscar por concepto, contraparte, NIF, recibo, local, empresa…"
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
          {movimientos.length > 0 ? (
            <Text style={styles.resultCount}>
              {movimientosFiltrados.length !== movimientos.length
                ? `${movimientosFiltrados.length} de ${movimientos.length} movimientos`
                : `${movimientos.length} movimiento${movimientos.length === 1 ? '' : 's'}`}
            </Text>
          ) : null}

          {error ? (
            <View style={styles.errBox}>
              <MaterialIcons name="error-outline" size={18} color="#dc2626" />
              <Text style={styles.errText}>{error}</Text>
            </View>
          ) : null}

          {loading ? <ActivityIndicator color="#0ea5e9" style={{ marginVertical: 16 }} /> : null}

          {!loading && resumen ? (
            <View style={styles.resumenCard}>
              <Text style={styles.resumenTitle}>Resumen firmados ({fechaCorta(resumen.dateFrom)} – {fechaCorta(resumen.dateTo)})</Text>
              <View style={styles.resumenGrid}>
                <View style={styles.resumenItem}>
                  <Text style={styles.resumenLabel}>Pagos</Text>
                  <Text style={[styles.resumenVal, styles.resumenPago]}>{formatMoneda(resumen.pagos)}</Text>
                </View>
                <View style={styles.resumenItem}>
                  <Text style={styles.resumenLabel}>Cobros banco</Text>
                  <Text style={[styles.resumenVal, styles.resumenCobro]}>{formatMoneda(resumen.cobrosBanco)}</Text>
                </View>
                <View style={styles.resumenItem}>
                  <Text style={styles.resumenLabel}>Reparto socios</Text>
                  <Text style={styles.resumenVal}>{formatMoneda(resumen.cobrosReparto)}</Text>
                </View>
                <View style={styles.resumenItem}>
                  <Text style={styles.resumenLabel}>Neto banco</Text>
                  <Text style={[styles.resumenVal, styles.resumenNeto]}>{formatMoneda(resumen.neto)}</Text>
                </View>
              </View>
            </View>
          ) : null}

          {!loading && movimientos.length === 0 && !error ? (
            <Text style={styles.hint}>No hay movimientos en el rango seleccionado.</Text>
          ) : null}

          {!loading && movimientos.length > 0 && movimientosFiltrados.length === 0 ? (
            <Text style={styles.hint}>No hay movimientos que coincidan con la búsqueda.</Text>
          ) : null}

          {!loading && movimientosFiltrados.length > 0 ? (
            hayBusqueda ? (
              movimientosFiltrados.map(renderMovimientoRow)
            ) : (
              <View style={styles.listaAgrupada}>
                <View style={styles.sectionBlock}>
                  <View style={styles.sectionHeader}>
                    <MaterialIcons name="pending-actions" size={18} color="#b45309" />
                    <Text style={styles.sectionTitle}>
                      Pendientes de firma y validación ({gruposMovimientos.pendientes.length})
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
                    <CollapsibleSection
                      title={`Firmados (${gruposMovimientos.firmados.length})`}
                      defaultOpen={false}
                    >
                      {gruposMovimientos.firmados.map(renderMovimientoRow)}
                    </CollapsibleSection>
                  </View>
                ) : null}

                {gruposMovimientos.anulados.length > 0 ? (
                  <View style={styles.sectionBlock}>
                    <CollapsibleSection
                      title={`Anulados (${gruposMovimientos.anulados.length})`}
                      defaultOpen={false}
                    >
                      {gruposMovimientos.anulados.map(renderMovimientoRow)}
                    </CollapsibleSection>
                  </View>
                ) : null}
              </View>
            )
          ) : null}

          <View style={{ height: 32 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  scrollContent: { padding: 16, alignItems: 'center' },
  formMax: { width: '100%', maxWidth: 960 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12 },
  headerCol: { flexDirection: 'column', alignItems: 'stretch' },
  headerMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  btnNuevo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnNuevoText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  filtrosRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  filtrosCol: { flexDirection: 'column' },
  filtroCol: { flexGrow: 1, minWidth: 120, maxWidth: 200 },
  filtroColWide: { flexGrow: 1, minWidth: 180, maxWidth: 320 },
  labelFiltros: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase' },
  inputFechaCompact: { fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, minHeight: 40 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chipFiltro: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  chipFiltroActivo: { borderColor: '#0ea5e9', backgroundColor: '#e0f2fe' },
  chipFiltroText: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  chipFiltroTextActivo: { color: '#0369a1' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
  },
  searchInput: { flex: 1, fontSize: 14, color: '#334155', paddingVertical: 4, minHeight: 36 },
  resultCount: { fontSize: 12, color: '#64748b', marginBottom: 10 },
  listaAgrupada: { gap: 4 },
  sectionBlock: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingBottom: 8,
    marginBottom: 10,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#334155', flex: 1 },
  sectionHint: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', paddingBottom: 8 },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: '#fef2f2', borderRadius: 8, marginBottom: 12 },
  errText: { flex: 1, fontSize: 12, color: '#b91c1c' },
  hint: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', marginVertical: 12 },
  resumenCard: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', padding: 14, marginBottom: 14 },
  resumenTitle: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 10 },
  resumenGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  resumenItem: { minWidth: 120, flex: 1 },
  resumenLabel: { fontSize: 11, color: '#64748b', marginBottom: 2 },
  resumenVal: { fontSize: 16, fontWeight: '800', color: '#334155' },
  resumenPago: { color: '#b91c1c' },
  resumenCobro: { color: '#15803d' },
  resumenNeto: { color: '#0369a1' },
  rowCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 8,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  tipoBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  tipoPago: { backgroundColor: '#fef2f2' },
  tipoCobro: { backgroundColor: '#f0fdf4' },
  tipoText: { fontSize: 11, fontWeight: '700' },
  tipoTextPago: { color: '#b91c1c' },
  tipoTextCobro: { color: '#15803d' },
  estadoBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  estadoText: { fontSize: 11, fontWeight: '600' },
  importe: { marginLeft: 'auto', fontSize: 16, fontWeight: '800', color: '#0f172a' },
  importePago: { color: '#b91c1c' },
  importeCobro: { color: '#15803d' },
  concepto: { fontSize: 14, fontWeight: '600', color: '#334155', marginBottom: 4 },
  rowMeta: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 2 },
  metaText: { fontSize: 11, color: '#64748b' },
  contraparte: { fontSize: 12, color: '#475569' },
  errorText: { padding: 16, color: '#b91c1c' },
});
