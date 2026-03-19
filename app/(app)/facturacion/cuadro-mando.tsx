import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { formatMoneda } from '../../utils/facturacion';
import { useAuth } from '../../contexts/AuthContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type MesMensual = {
  mes: string; ingresos: number; gastos: number; margen: number;
  cobrado: number; pagado: number; numOut: number; numIn: number;
  baseIva: number; ivaSoportado: number;
};
type Trimestre = { trimestre: string; ingresos: number; gastos: number; margen: number; ivaRepercutido: number; ivaSoportado: number };
type Comparativa = { anioActual: { ingresos: number; gastos: number; numOut: number; numIn: number }; anioAnterior: { ingresos: number; gastos: number; numOut: number; numIn: number } };
type Aging = { corriente: number; '30d': number; '60d': number; '90d': number; mas90: number };
type IvaResumen = { trimestre: string; repercutido: number; soportado: number; diferencia: number };
type PagoReciente = { id_pago: string; id_factura: string; fecha: string; importe: number; metodo_pago: string; creado_por: string };

type Data = {
  mensual: MesMensual[];
  trimestres: Trimestre[];
  comparativa: Comparativa;
  aging: Aging;
  ivaResumen: IvaResumen[];
  pagosRecientes: PagoReciente[];
};

const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
function mesLabel(yyyymm: string) {
  const m = parseInt(yyyymm.slice(5, 7), 10);
  return MESES_CORTOS[m - 1] || yyyymm;
}

export default function CuadroMandoScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 900;

  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(() => {
    setLoading(true);
    fetch(`${API_URL}/api/facturacion/metricas-avanzadas`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (!hasPermiso('facturacion.ver')) {
    return <View style={styles.center}><Text style={styles.errorText}>Sin permisos</Text></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={{ padding: 4 }}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Cuadro de mando</Text>
          <Text style={styles.subtitle}>Análisis financiero detallado</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={fetchData}>
          <MaterialIcons name="refresh" size={18} color="#64748b" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#0ea5e9" style={{ marginVertical: 40 }} />
      ) : !data ? (
        <Text style={styles.emptyText}>No se pudieron cargar los datos</Text>
      ) : (
        <>
          {/* ── COMPARATIVA INTERANUAL ── */}
          <SectionTitle icon="compare-arrows" text="Comparativa interanual" />
          <View style={[styles.row, !isWide && styles.colLayout]}>
            <CompCard label={`${new Date().getFullYear()}`} ingresos={data.comparativa.anioActual.ingresos} gastos={data.comparativa.anioActual.gastos} numOut={data.comparativa.anioActual.numOut} numIn={data.comparativa.anioActual.numIn} current />
            <CompCard label={`${new Date().getFullYear() - 1}`} ingresos={data.comparativa.anioAnterior.ingresos} gastos={data.comparativa.anioAnterior.gastos} numOut={data.comparativa.anioAnterior.numOut} numIn={data.comparativa.anioAnterior.numIn} />
          </View>

          {/* ── TRIMESTRES ── */}
          <SectionTitle icon="date-range" text={`Trimestres ${new Date().getFullYear()}`} />
          <View style={[styles.row, !isWide && styles.colLayout]}>
            {data.trimestres.map((t) => (
              <View key={t.trimestre} style={styles.triCard}>
                <Text style={styles.triLabel}>{t.trimestre}</Text>
                <Row label="Ingresos" value={t.ingresos} color="#059669" />
                <Row label="Gastos" value={t.gastos} color="#dc2626" />
                <View style={styles.divider} />
                <Row label="Margen" value={t.margen} color={t.margen >= 0 ? '#059669' : '#dc2626'} bold />
              </View>
            ))}
          </View>

          {/* ── GRÁFICA MENSUAL ── */}
          <SectionTitle icon="show-chart" text="Evolución mensual (24 meses)" />
          <View style={styles.card}>
            <BarChart data={data.mensual.slice(-12)} containerWidth={isWide ? undefined : width - 48} />
          </View>

          {/* ── AGING ── */}
          <SectionTitle icon="hourglass-empty" text="Antigüedad de deuda (cobro)" />
          <View style={styles.card}>
            <View style={[styles.row, { gap: 0 }]}>
              <AgingBar label="Corriente" value={data.aging.corriente} color="#059669" total={Object.values(data.aging).reduce((a, b) => a + b, 0)} />
              <AgingBar label="0-30d" value={data.aging['30d']} color="#0ea5e9" total={Object.values(data.aging).reduce((a, b) => a + b, 0)} />
              <AgingBar label="31-60d" value={data.aging['60d']} color="#b45309" total={Object.values(data.aging).reduce((a, b) => a + b, 0)} />
              <AgingBar label="61-90d" value={data.aging['90d']} color="#ea580c" total={Object.values(data.aging).reduce((a, b) => a + b, 0)} />
              <AgingBar label=">90d" value={data.aging.mas90} color="#dc2626" total={Object.values(data.aging).reduce((a, b) => a + b, 0)} />
            </View>
          </View>

          {/* ── IVA TRIMESTRAL ── */}
          <SectionTitle icon="receipt" text="Resumen IVA trimestral (modelo 303)" />
          <View style={styles.card}>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, { flex: 1 }]}>Trimestre</Text>
              <Text style={[styles.th, { flex: 1.5, textAlign: 'right' }]}>Repercutido</Text>
              <Text style={[styles.th, { flex: 1.5, textAlign: 'right' }]}>Soportado</Text>
              <Text style={[styles.th, { flex: 1.5, textAlign: 'right' }]}>Diferencia</Text>
            </View>
            {data.ivaResumen.map((iv) => (
              <View key={iv.trimestre} style={styles.tableRow}>
                <Text style={[styles.td, { flex: 1, fontWeight: '600' }]}>{iv.trimestre}</Text>
                <Text style={[styles.td, { flex: 1.5, textAlign: 'right' }]}>{formatMoneda(iv.repercutido)}</Text>
                <Text style={[styles.td, { flex: 1.5, textAlign: 'right' }]}>{formatMoneda(iv.soportado)}</Text>
                <Text style={[styles.td, { flex: 1.5, textAlign: 'right', color: iv.diferencia >= 0 ? '#dc2626' : '#059669', fontWeight: '600' }]}>
                  {iv.diferencia >= 0 ? '' : '-'}{formatMoneda(Math.abs(iv.diferencia))}
                </Text>
              </View>
            ))}
            <View style={styles.tableRow}>
              <Text style={[styles.td, { flex: 1, fontWeight: '700' }]}>Total</Text>
              <Text style={[styles.td, { flex: 1.5, textAlign: 'right', fontWeight: '700' }]}>
                {formatMoneda(data.ivaResumen.reduce((s, i) => s + i.repercutido, 0))}
              </Text>
              <Text style={[styles.td, { flex: 1.5, textAlign: 'right', fontWeight: '700' }]}>
                {formatMoneda(data.ivaResumen.reduce((s, i) => s + i.soportado, 0))}
              </Text>
              <Text style={[styles.td, { flex: 1.5, textAlign: 'right', fontWeight: '700', color: '#334155' }]}>
                {formatMoneda(data.ivaResumen.reduce((s, i) => s + i.diferencia, 0))}
              </Text>
            </View>
          </View>

          {/* ── ACTIVIDAD RECIENTE ── */}
          <SectionTitle icon="history" text="Últimos movimientos" />
          <View style={styles.card}>
            {data.pagosRecientes.length === 0 ? (
              <Text style={styles.emptyText}>Sin movimientos recientes</Text>
            ) : (
              data.pagosRecientes.map((p) => (
                <View key={p.id_pago} style={styles.pagoRow}>
                  <MaterialIcons name="payments" size={14} color="#0ea5e9" />
                  <Text style={styles.pagoFecha}>{p.fecha}</Text>
                  <Text style={styles.pagoFactura} numberOfLines={1}>{p.id_factura}</Text>
                  <Text style={styles.pagoImporte}>{formatMoneda(p.importe)}</Text>
                  <Text style={styles.pagoMeta}>{p.creado_por}</Text>
                </View>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function SectionTitle({ icon, text }: { icon: React.ComponentProps<typeof MaterialIcons>['name']; text: string }) {
  return (
    <View style={styles.sectionTitleRow}>
      <MaterialIcons name={icon} size={18} color="#0ea5e9" />
      <Text style={styles.sectionTitle}>{text}</Text>
    </View>
  );
}

function CompCard({ label, ingresos, gastos, numOut, numIn, current }: { label: string; ingresos: number; gastos: number; numOut: number; numIn: number; current?: boolean }) {
  const margen = ingresos - gastos;
  return (
    <View style={[styles.compCard, current && styles.compCardCurrent]}>
      <Text style={styles.compLabel}>{label}</Text>
      <Row label="Ingresos" value={ingresos} color="#059669" />
      <Row label="Gastos" value={gastos} color="#dc2626" />
      <View style={styles.divider} />
      <Row label="Margen" value={margen} color={margen >= 0 ? '#059669' : '#dc2626'} bold />
      <Text style={styles.compSub}>{numOut} emitidas · {numIn} recibidas</Text>
    </View>
  );
}

function Row({ label, value, color, bold }: { label: string; value: number; color: string; bold?: boolean }) {
  return (
    <View style={styles.rowLine}>
      <Text style={[styles.rowLabel, bold && { fontWeight: '700' }]}>{label}</Text>
      <Text style={[styles.rowValue, { color }, bold && { fontWeight: '700', fontSize: 15 }]}>{formatMoneda(value)}</Text>
    </View>
  );
}

function AgingBar({ label, value, color, total }: { label: string; value: number; color: string; total: number }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <View style={styles.agingItem}>
      <View style={[styles.agingBarBg, { height: 60 }]}>
        <View style={[styles.agingBarFill, { height: `${Math.max(pct, 2)}%` as any, backgroundColor: color }]} />
      </View>
      <Text style={styles.agingValue}>{formatMoneda(value)}</Text>
      <Text style={styles.agingLabel}>{label}</Text>
    </View>
  );
}

function BarChart({ data, containerWidth }: { data: MesMensual[]; containerWidth?: number }) {
  if (!data || data.length === 0) return <Text style={styles.emptyText}>Sin datos</Text>;
  const maxVal = Math.max(...data.map((d) => Math.max(d.ingresos, d.gastos)), 1);
  const barH = 100;

  return (
    <View>
      <View style={[styles.barArea, { height: barH }]}>
        {data.map((d, i) => {
          const hIng = (d.ingresos / maxVal) * barH;
          const hGas = (d.gastos / maxVal) * barH;
          return (
            <View key={i} style={styles.barGroup}>
              <View style={styles.barPair}>
                <View style={[styles.bar, { height: hIng, backgroundColor: '#0ea5e9' }]} />
                <View style={[styles.bar, { height: hGas, backgroundColor: '#f97316' }]} />
              </View>
              <Text style={styles.barLabel}>{mesLabel(d.mes)}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.legendRow}>
        <LegendDot color="#0ea5e9" label="Ingresos" />
        <LegendDot color="#f97316" label="Gastos" />
      </View>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 13, color: '#dc2626' },
  emptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: 8 },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 12, color: '#64748b', marginTop: 1 },
  refreshBtn: { padding: 6, borderRadius: 6, backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: '#e2e8f0' },

  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16, marginBottom: 8 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#334155' },

  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  colLayout: { flexDirection: 'column' },

  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', padding: 12, marginBottom: 4 },

  compCard: { flex: 1, minWidth: 200, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', padding: 12, gap: 4 },
  compCardCurrent: { borderColor: '#0ea5e9', borderWidth: 1.5 },
  compLabel: { fontSize: 15, fontWeight: '700', color: '#334155', marginBottom: 4 },
  compSub: { fontSize: 10, color: '#94a3b8', marginTop: 2 },

  triCard: { flex: 1, minWidth: 150, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', padding: 10, gap: 3 },
  triLabel: { fontSize: 14, fontWeight: '700', color: '#0ea5e9', marginBottom: 4 },

  rowLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { fontSize: 12, color: '#64748b' },
  rowValue: { fontSize: 13, fontWeight: '600' },
  divider: { height: 1, backgroundColor: '#e2e8f0', marginVertical: 4 },

  agingItem: { flex: 1, alignItems: 'center', gap: 3 },
  agingBarBg: { width: '80%', backgroundColor: '#f1f5f9', borderRadius: 4, justifyContent: 'flex-end', overflow: 'hidden' },
  agingBarFill: { width: '100%', borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  agingValue: { fontSize: 10, fontWeight: '600', color: '#334155' },
  agingLabel: { fontSize: 9, color: '#94a3b8' },

  tableHeader: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#e2e8f0', paddingBottom: 6, marginBottom: 4 },
  th: { fontSize: 10, fontWeight: '600', color: '#64748b', textTransform: 'uppercase' },
  tableRow: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  td: { fontSize: 12, color: '#334155' },

  pagoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  pagoFecha: { fontSize: 11, color: '#64748b', width: 80 },
  pagoFactura: { fontSize: 11, color: '#334155', flex: 1 },
  pagoImporte: { fontSize: 12, fontWeight: '600', color: '#059669' },
  pagoMeta: { fontSize: 10, color: '#94a3b8', width: 80, textAlign: 'right' },

  barArea: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, paddingTop: 4 },
  barGroup: { alignItems: 'center', flex: 1 },
  barPair: { flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
  bar: { width: 8, borderTopLeftRadius: 2, borderTopRightRadius: 2, minHeight: 2 },
  barLabel: { fontSize: 8, color: '#94a3b8', marginTop: 3 },
  legendRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 10, color: '#64748b' },
});
