import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';
import { formatMoneda, labelEstado, colorEstado, esEmpresaSedeGrupoParipe } from '../../utils/facturacion';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';

type EmpresaOpt = { id: string; nombre: string };

type MesMensual = {
  mes: string;
  ingresos: number;
  gastos: number;
  cobrado: number;
  pagado: number;
  numOut: number;
  numIn: number;
};

type TopEntry = { nombre: string; total: number; count: number };

type Metricas = {
  totalEmitido: number;
  totalCobrado: number;
  totalPendienteCobro: number;
  facturasVencidasCount: number;
  facturasVencidasImporte: number;
  totalGastos: number;
  totalPagado: number;
  totalPendientePago: number;
  countOut: number;
  countIn: number;
  margenNeto: number;
  mensual: MesMensual[];
  topClientes: TopEntry[];
  topProveedores: TopEntry[];
  estadosOut: Record<string, number>;
  estadosIn: Record<string, number>;
};

const OPCIONES: {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  descripcion: string;
  permiso: string;
}[] = [
  { id: 'facturas-venta', label: 'Facturas emitidas', icon: 'receipt-long', descripcion: 'Facturas de venta a clientes', permiso: 'facturacion.ver' },
  { id: 'facturas-gasto', label: 'Facturas recibidas', icon: 'description', descripcion: 'Facturas de gasto / proveedores', permiso: 'facturacion.ver' },
  { id: 'remesas', label: 'Remesas de pago', icon: 'account-balance', descripcion: 'Agrupa facturas y genera fichero para el banco', permiso: 'remesas.ver' },
  { id: 'pagos-cobros', label: 'Pagos y cobros', icon: 'account-balance-wallet', descripcion: 'Movimientos de pago y cobro', permiso: 'facturacion.cobrar_pagar' },
  { id: 'cuadro-mando', label: 'Cuadro de mando', icon: 'analytics', descripcion: 'Análisis financiero, IVA, aging', permiso: 'facturacion.ver' },
  { id: 'series', label: 'Series', icon: 'format-list-numbered', descripcion: 'Configuración de series de facturación', permiso: 'facturacion.series' },
];

const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const AÑOS_RANGO = 16;

function mesNombre(m: number) {
  return MESES_CORTOS[m - 1] || String(m);
}

function mesLabel(yyyymm: string) {
  const m = parseInt(yyyymm.slice(5, 7), 10);
  return MESES_CORTOS[m - 1] || yyyymm;
}

export default function FacturacionIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  const [metricas, setMetricas] = useState<Metricas | null>(null);
  const [loading, setLoading] = useState(true);
  const [empresaSeleccionadaId, setEmpresaSeleccionadaId] = useState('');
  const [empresasGrupoParipe, setEmpresasGrupoParipe] = useState<EmpresaOpt[]>([]);

  const [filtroAnio, setFiltroAnio] = useState(() => new Date().getFullYear());
  const [filtroMes, setFiltroMes] = useState(0);

  const añosOpciones = useMemo(() => {
    const y = new Date().getFullYear();
    return Array.from({ length: AÑOS_RANGO }, (_, i) => y - i);
  }, []);

  const mesesOrdenDesc = useMemo(() => Array.from({ length: 12 }, (_, i) => 12 - i), []);

  const fetchMetricas = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (empresaSeleccionadaId) params.set('empresaId', empresaSeleccionadaId);
    params.set('anio', String(filtroAnio));
    if (filtroMes >= 1 && filtroMes <= 12) params.set('mes', String(filtroMes));
    const q = `?${params.toString()}`;
    apiFetch(`/api/facturacion/metricas${q}`)
      .then((r) => r.json())
      .then((data) => setMetricas(data.metricas || null))
      .catch(() => setMetricas(null))
      .finally(() => setLoading(false));
  }, [empresaSeleccionadaId, filtroAnio, filtroMes]);

  useEffect(() => {
    apiFetch('/api/empresas')
      .then((r) => r.json())
      .then((d) => {
        const raw: unknown[] = d.empresas ?? d ?? [];
        const list: EmpresaOpt[] = raw
          .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
          .filter((e) => esEmpresaSedeGrupoParipe(e))
          .map((e) => {
            const id = e.id_empresa != null ? String(e.id_empresa) : '';
            const nombre = String(e.Nombre ?? e.nombre ?? '').trim() || id;
            return { id, nombre };
          })
          .filter((x) => x.id)
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        setEmpresasGrupoParipe(list);
      })
      .catch(() => setEmpresasGrupoParipe([]));
  }, []);

  useEffect(() => {
    apiFetch('/api/facturacion/check-vencimientos', { method: 'POST' })
      .catch(() => {})
      .finally(() => fetchMetricas());
  }, [fetchMetricas]);

  const labelPeriodoCorto = useMemo(
    () => filtroMes === 0 ? `${filtroAnio}` : `${mesNombre(filtroMes)} ${filtroAnio}`,
    [filtroAnio, filtroMes],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Facturación</Text>
          <View style={styles.navRow}>
            {OPCIONES.filter((o) => hasPermiso(o.permiso)).map((opcion) => (
              <TouchableOpacity
                key={opcion.id}
                style={styles.navBtn}
                onPress={() => router.push(`/facturacion/${opcion.id}` as any)}
                activeOpacity={0.7}
              >
                <MaterialIcons name={opcion.icon} size={14} color="#0ea5e9" />
                <Text style={styles.navBtnText}>{opcion.label}</Text>
                <EstrellaFavorito
                  favorito={{ route: `/facturacion/${opcion.id}`, label: opcion.label, icon: opcion.icon, permiso: opcion.permiso }}
                  size={14}
                />
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={fetchMetricas}>
          <MaterialIcons name="refresh" size={18} color="#64748b" />
        </TouchableOpacity>
      </View>

      <View style={styles.filtrosRow}>
        {empresasGrupoParipe.length > 0 ? (
          <SelectorDesplegable
            style={styles.empresaSelector}
            icono="business"
            tituloLista="Sociedad del grupo"
            iconoLista="business"
            placeholder="Todas las empresas (Grupo Paripe)"
            valorId={empresaSeleccionadaId}
            opciones={[
              { id: '', titulo: 'Todas las empresas', icono: 'layers' },
              ...empresasGrupoParipe.map((e) => ({ id: e.id, titulo: e.nombre, icono: 'domain' as const })),
            ]}
            onSeleccionar={(id) => setEmpresaSeleccionadaId(id)}
          />
        ) : null}
        <SelectorDesplegable
          style={styles.periodoSelector}
          icono="calendar-today"
          tituloLista="Año"
          iconoLista="event"
          valorId={String(filtroAnio)}
          opciones={añosOpciones.map((a) => ({ id: String(a), titulo: String(a), icono: 'event' as const }))}
          onSeleccionar={(id) => setFiltroAnio(Number(id))}
        />
        <SelectorDesplegable
          style={styles.periodoSelector}
          icono="date-range"
          tituloLista="Mes"
          iconoLista="calendar-month"
          valorId={String(filtroMes)}
          opciones={[
            { id: '0', titulo: 'Todo el año', icono: 'layers' },
            ...mesesOrdenDesc.map((m) => ({ id: String(m), titulo: mesNombre(m), icono: 'calendar-month' as const })),
          ]}
          onSeleccionar={(id) => setFiltroMes(Number(id))}
        />
      </View>

      {loading ? (
        <ActivityIndicator size="small" color="#0ea5e9" style={{ marginVertical: 20 }} />
      ) : metricas ? (
        <>
          {/* KPI CARDS */}
          <View style={styles.kpiGrid}>
            <KpiCard label="Total emitido" value={metricas.totalEmitido} icon="arrow-upward" color="#059669" sub={`${metricas.countOut} facturas`} />
            <KpiCard label="Cobrado" value={metricas.totalCobrado} icon="check-circle" color="#059669" />
            <KpiCard label="Pte. cobro" value={metricas.totalPendienteCobro} icon="schedule" color="#b45309" />
            <KpiCard label="Vencidas" value={metricas.facturasVencidasImporte} icon="warning" color="#dc2626" sub={metricas.facturasVencidasCount > 0 ? `${metricas.facturasVencidasCount} facturas` : undefined} />
            <KpiCard label="Gastos" value={metricas.totalGastos} icon="arrow-downward" color="#dc2626" sub={`${metricas.countIn} facturas`} />
            <KpiCard label="Pagado" value={metricas.totalPagado} icon="check-circle-outline" color="#059669" />
            <KpiCard label="Pte. pago" value={metricas.totalPendientePago} icon="schedule" color="#b45309" />
            <KpiCard label="Margen neto" value={metricas.margenNeto} icon="trending-up" color={metricas.margenNeto >= 0 ? '#059669' : '#dc2626'} highlight />
          </View>

          {/* GRÁFICA MENSUAL + TOPS */}
          <View style={[styles.chartsRow, !isWide && { flexDirection: 'column' }]}>
            {/* Evolución mensual */}
            <View style={[styles.chartCard, isWide && { flex: 2 }]}>
              <Text style={styles.chartTitle}>Evolución mensual (12 meses)</Text>
              <Text style={styles.chartSubtitle}>KPI y totales: {labelPeriodoCorto}</Text>
              <BarChart data={metricas.mensual} width={isWide ? undefined : width - 40} />
            </View>

            {/* Top clientes + proveedores */}
            <View style={[styles.chartsCol, isWide && { flex: 1 }]}>
              <View style={styles.chartCard}>
                <Text style={styles.chartTitle}>Top clientes</Text>
                {metricas.topClientes.length === 0 ? (
                  <Text style={styles.emptyText}>Sin datos</Text>
                ) : (
                  metricas.topClientes.map((c, i) => (
                    <View key={i} style={styles.topRow}>
                      <Text style={styles.topIndex}>{i + 1}.</Text>
                      <Text style={styles.topName} numberOfLines={1}>{c.nombre}</Text>
                      <Text style={styles.topValue}>{formatMoneda(c.total)}</Text>
                    </View>
                  ))
                )}
              </View>
              <View style={styles.chartCard}>
                <Text style={styles.chartTitle}>Top proveedores</Text>
                {metricas.topProveedores.length === 0 ? (
                  <Text style={styles.emptyText}>Sin datos</Text>
                ) : (
                  metricas.topProveedores.map((p, i) => (
                    <View key={i} style={styles.topRow}>
                      <Text style={styles.topIndex}>{i + 1}.</Text>
                      <Text style={styles.topName} numberOfLines={1}>{p.nombre}</Text>
                      <Text style={styles.topValue}>{formatMoneda(p.total)}</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          </View>

          {/* ESTADOS */}
          <View style={[styles.chartsRow, !isWide && { flexDirection: 'column' }]}>
            <View style={[styles.chartCard, { flex: 1 }]}>
              <Text style={styles.chartTitle}>Facturas emitidas por estado</Text>
              <EstadosGrid estados={metricas.estadosOut} />
            </View>
            <View style={[styles.chartCard, { flex: 1 }]}>
              <Text style={styles.chartTitle}>Facturas recibidas por estado</Text>
              <EstadosGrid estados={metricas.estadosIn} />
            </View>
          </View>
        </>
      ) : (
        <Text style={styles.emptyText}>No se pudieron cargar las métricas</Text>
      )}

      <View style={{ height: 20 }} />
    </ScrollView>
  );
}

// ─── KPI Card ───

function KpiCard({ label, value, icon, color, sub, highlight }: {
  label: string;
  value: number;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  color: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.kpiCard, highlight && styles.kpiHighlight]}>
      <View style={styles.kpiHeader}>
        <MaterialIcons name={icon} size={16} color={color} />
        <Text style={styles.kpiLabel}>{label}</Text>
      </View>
      <Text style={[styles.kpiValue, { color }]}>{formatMoneda(value)}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
    </View>
  );
}

// ─── Bar Chart (pure RN) ───

function BarChart({ data, width: containerW }: { data: MesMensual[]; width?: number }) {
  if (!data || data.length === 0) return <Text style={styles.emptyText}>Sin datos</Text>;

  const maxVal = Math.max(...data.map((d) => Math.max(d.ingresos, d.gastos)), 1);
  const barAreaH = 120;
  const barW = containerW ? Math.max(14, (containerW - 60) / data.length - 4) : 22;

  return (
    <View>
      <View style={[styles.barChartArea, { height: barAreaH }]}>  
        {data.map((d, i) => {
          const hIng = (d.ingresos / maxVal) * barAreaH;
          const hGas = (d.gastos / maxVal) * barAreaH;
          return (
            <View key={i} style={styles.barGroup}>
              <View style={styles.barPair}>
                <View style={[styles.bar, { height: hIng, width: barW / 2, backgroundColor: '#0ea5e9' }]} />
                <View style={[styles.bar, { height: hGas, width: barW / 2, backgroundColor: '#f97316' }]} />
              </View>
              <Text style={styles.barLabel}>{mesLabel(d.mes)}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#0ea5e9' }]} />
          <Text style={styles.legendText}>Ingresos</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: '#f97316' }]} />
          <Text style={styles.legendText}>Gastos</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Estados Grid ───

function EstadosGrid({ estados }: { estados: Record<string, number> }) {
  const entries = Object.entries(estados);
  if (entries.length === 0) return <Text style={styles.emptyText}>Sin facturas</Text>;
  return (
    <View style={styles.estadosWrap}>
      {entries.map(([estado, count]) => {
        const c = colorEstado(estado);
        return (
          <View key={estado} style={[styles.estadoBadge, { backgroundColor: c.bg }]}>
            <Text style={[styles.estadoBadgeText, { color: c.text }]}>{labelEstado(estado)}</Text>
            <Text style={[styles.estadoBadgeCount, { color: c.text }]}>{count}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  refreshBtn: { padding: 6, borderRadius: 6, backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: '#e2e8f0', marginTop: 2 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  navRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  navBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  navBtnText: { fontSize: 11, fontWeight: '500', color: '#0369a1' },

  empresaSelector: { flex: 1, minWidth: 160 },
  periodoSelector: { minWidth: 120 },

  filtrosRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  kpiCard: {
    minWidth: 150,
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    gap: 3,
  },
  kpiHighlight: { borderColor: '#0ea5e9', borderWidth: 1.5 },
  kpiHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  kpiLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  kpiValue: { fontSize: 17, fontWeight: '700' },
  kpiSub: { fontSize: 10, color: '#94a3b8' },

  chartsRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  chartsCol: { gap: 10 },
  chartCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
  },
  chartTitle: { fontSize: 13, fontWeight: '600', color: '#334155', marginBottom: 4 },
  chartSubtitle: { fontSize: 11, color: '#94a3b8', marginBottom: 8 },

  barChartArea: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingTop: 4 },
  barGroup: { alignItems: 'center', flex: 1 },
  barPair: { flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
  bar: { borderTopLeftRadius: 2, borderTopRightRadius: 2, minHeight: 2 },
  barLabel: { fontSize: 8, color: '#94a3b8', marginTop: 3 },
  legendRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 10, color: '#64748b' },

  topRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  topIndex: { fontSize: 11, color: '#94a3b8', fontWeight: '600', width: 18 },
  topName: { fontSize: 12, color: '#334155', flex: 1 },
  topValue: { fontSize: 12, fontWeight: '600', color: '#334155' },

  estadosWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  estadoBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  estadoBadgeText: { fontSize: 11, fontWeight: '500' },
  estadoBadgeCount: { fontSize: 12, fontWeight: '700' },

  emptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: 8 },
});
