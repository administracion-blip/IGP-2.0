import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Pressable,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { apiFetch } from '../../../utils/api';
import { formatFecha } from '../../../utils/formatFecha';
import { formatMoneda } from '../../../utils/formatMoneda';
import { CampanaFormModal } from '../../../components/CampanaFormModal';
import {
  colorEstadoCampana,
  etiquetaDestinatario,
  etiquetaTipoIncentivo,
  etiquetaWarning,
} from '../../../lib/incentivosProducto';
import type { Campana, ResultadosCampana } from '../../../types/incentivosProducto';

type TabKey = 'producto' | 'empleado' | 'local' | 'evolucion';

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiCardLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiCardValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function FilaCard({
  titulo,
  badge,
  badgeColor,
  semaforo,
  fields,
}: {
  titulo: string;
  badge?: string;
  badgeColor?: { bg: string; text: string };
  semaforo?: 'verde' | 'rojo' | null;
  fields: { label: string; value: string }[];
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <Text style={styles.cardTitle} numberOfLines={1}>{titulo}</Text>
          {badge && badgeColor ? (
            <View style={[styles.badge, { backgroundColor: badgeColor.bg, borderColor: badgeColor.text }]}>
              <Text style={[styles.badgeText, { color: badgeColor.text }]}>{badge}</Text>
            </View>
          ) : null}
          {semaforo ? (
            <View
              style={[
                styles.dotSem,
                { backgroundColor: semaforo === 'verde' ? '#16a34a' : '#dc2626' },
              ]}
            />
          ) : null}
        </View>
      </View>
      <View style={styles.cardBody}>
        {fields.map((f) => (
          <View key={f.label} style={styles.cardField}>
            <Text style={styles.cardFieldLabel}>{f.label}</Text>
            <Text style={styles.cardFieldValue} numberOfLines={2}>{f.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export default function CampanaDetalleScreen() {
  const { campanaId } = useLocalSearchParams<{ campanaId: string }>();
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels, shouldStackToolbar } = useBreakpoint();
  const puedeGestionar = hasPermiso('incentivos_producto.gestionar');
  const puedeExportar = hasPermiso('incentivos_producto.exportar');
  const puedeVer = hasPermiso('incentivos_producto.ver');

  const [campana, setCampana] = useState<Campana | null>(null);
  const [resultados, setResultados] = useState<ResultadosCampana | null>(null);
  const [localesMap, setLocalesMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('producto');
  const [modalEditar, setModalEditar] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportando, setExportando] = useState(false);

  const cargar = useCallback(async () => {
    if (!campanaId || !puedeVer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [resCamp, resRes, resLoc] = await Promise.all([
        apiFetch(`/api/campanas/${campanaId}`),
        apiFetch(`/api/campanas/${campanaId}/resultados`),
        apiFetch('/api/locales'),
      ]);
      const dataCamp = await resCamp.json();
      const dataRes = await resRes.json();
      const dataLoc = await resLoc.json();
      if (!resCamp.ok) throw new Error(dataCamp.error || 'Campaña no encontrada');
      if (!resRes.ok) throw new Error(dataRes.error || 'Error en resultados');
      setCampana(dataCamp.item);
      setResultados(dataRes);
      const map: Record<string, string> = {};
      for (const l of dataLoc.locales || []) {
        const id = String(l.id_Locales ?? '').trim();
        const nombre = String(l.nombre ?? l.Nombre ?? id).trim();
        if (id) map[id] = nombre;
      }
      setLocalesMap(map);
    } catch (e) {
      setError((e as Error).message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, [campanaId, puedeVer]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const nombreLocal = useCallback(
    (id: string) => localesMap[id] || id,
    [localesMap],
  );

  const semaforoGlobal = useMemo(() => {
    const neto = resultados?.totales?.resultadoNeto;
    if (neto == null) return null;
    return neto >= 0 ? 'verde' : 'rojo';
  }, [resultados]);

  const exportarExcel = async () => {
    if (!campana || !resultados || !puedeExportar) return;
    setExportMenuOpen(false);
    setExportando(true);
    try {
      const wb = XLSX.utils.book_new();

      const resumen = [
        ['Campaña', campana.nombre],
        ['Estado', campana.estado],
        ['Periodo', `${campana.fechaInicio} — ${campana.fechaFin}`],
        ['Margen incremental', resultados.totales.margenIncremental],
        ['Coste incentivo', resultados.totales.costeIncentivo],
        ['Resultado neto', resultados.totales.resultadoNeto],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');

      const prodRows = resultados.porProducto.map((p) => ({
        Producto: p.productName,
        'Uds/día baseline': p.udsBaselinePorDia,
        'Uds/día campaña': p.udsCampanaPorDia,
        'Uds campaña': p.udsCampanaTotal,
        Incrementales: p.udsIncrementales,
        'Margen unit.': p.margenUnitario,
        'Margen incremental': p.margenIncremental,
        'Coste incentivo': p.costeIncentivo,
        'Resultado neto': p.resultadoNeto,
        Veredicto: p.veredicto,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(prodRows), 'Por producto');

      if (resultados.porEmpleado.length > 0) {
        const empRows = resultados.porEmpleado.map((e) => ({
          Local: nombreLocal(e.localId),
          Empleado: e.userName || e.agoraUserId,
          Unidades: e.unidades,
          Importe: e.importe,
          Incentivo: e.incentivoDevengado,
        }));
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(empRows), 'Por empleado');
      }

      const locRows = resultados.porLocal.map((l) => ({
        Local: nombreLocal(l.localId),
        Unidades: l.unidades,
        Incentivo: l.incentivoDevengado,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(locRows), 'Por local');

      const fname = `incentivos_${campana.nombre.replace(/\s+/g, '_').slice(0, 30)}_${campanaId.slice(0, 8)}.xlsx`;

      if (Platform.OS === 'web') {
        XLSX.writeFile(wb, fname);
      } else {
        const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const path = `${FileSystemLegacy.cacheDirectory}${fname}`;
        await FileSystemLegacy.writeAsStringAsync(path, base64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        }
      }
    } catch (e) {
      setError((e as Error).message || 'Error al exportar');
    } finally {
      setExportando(false);
    }
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'producto', label: 'Por producto' },
    ...(campana?.destinatario === 'individual'
      ? [{ key: 'empleado' as TabKey, label: 'Por empleado' }]
      : []),
    { key: 'local', label: 'Por local' },
    { key: 'evolucion', label: 'Evolución' },
  ];

  if (!puedeVer) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.sinPermiso}>Sin permiso para ver esta campaña.</Text>
      </View>
    );
  }

  const totalUdsCampana = resultados?.porProducto.reduce((a, p) => a + p.udsCampanaTotal, 0) ?? 0;
  const totalIncrementales = resultados?.porProducto.reduce((a, p) => a + p.udsIncrementales, 0) ?? 0;

  return (
    <View style={styles.container}>
      <View style={[styles.header, shouldStackToolbar && styles.headerStack]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.tituloBlock}>
          <Text style={styles.headerTitle} numberOfLines={2}>{campana?.nombre || 'Campaña'}</Text>
          {campana ? (
            <Text style={styles.subtitle}>
              {formatFecha(campana.fechaInicio)} — {formatFecha(campana.fechaFin)}
            </Text>
          ) : null}
        </View>
        <View style={styles.acciones}>
          {puedeGestionar && campana ? (
            <TouchableOpacity style={styles.btnIcon} onPress={() => setModalEditar(true)}>
              <MaterialIcons name="edit" size={20} color="#64748b" />
            </TouchableOpacity>
          ) : null}
          {puedeExportar ? (
            <View>
              <TouchableOpacity
                style={styles.btnExport}
                onPress={() => setExportMenuOpen((v) => !v)}
                disabled={exportando || !resultados}
              >
                {exportando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <MaterialIcons name="download" size={16} color="#fff" />
                    <Text style={styles.btnExportText}>Descargar</Text>
                  </>
                )}
              </TouchableOpacity>
              {exportMenuOpen ? (
                <View style={styles.exportMenu}>
                  <TouchableOpacity style={styles.exportItem} onPress={exportarExcel}>
                    <MaterialIcons name="table-chart" size={18} color="#16a34a" />
                    <Text style={styles.exportItemText}>Excel (.xlsx)</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
      ) : error ? (
        <View style={styles.errorBar}><Text style={styles.errorText}>{error}</Text></View>
      ) : campana && resultados ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {resultados.warnings?.length ? (
            <View style={styles.warningsBox}>
              {resultados.warnings.map((w) => (
                <Text key={w} style={styles.warningText}>⚠ {etiquetaWarning(w)}</Text>
              ))}
            </View>
          ) : null}

          <View style={styles.metaRow}>
            <View style={[styles.estadoBadge, { backgroundColor: colorEstadoCampana(campana.estado) + '18', borderColor: colorEstadoCampana(campana.estado) }]}>
              <Text style={[styles.estadoText, { color: colorEstadoCampana(campana.estado) }]}>
                {campana.estado}
              </Text>
            </View>
            <Text style={styles.metaText}>
              {etiquetaTipoIncentivo(campana.tipoIncentivo)} · {campana.valorIncentivo}
            </Text>
            <Text style={styles.metaText}>{etiquetaDestinatario(campana.destinatario)}</Text>
          </View>

          <View style={[styles.kpiRow, shouldStackPanels && styles.kpiRowStack]}>
            <KpiCard label="Uds. campaña" value={totalUdsCampana.toFixed(0)} />
            <KpiCard label="Incrementales" value={totalIncrementales.toFixed(0)} />
            <KpiCard label="Coste incentivo" value={formatMoneda(resultados.totales.costeIncentivo)} color="#d97706" />
            <KpiCard
              label="Resultado neto"
              value={formatMoneda(resultados.totales.resultadoNeto)}
              color={semaforoGlobal === 'verde' ? '#16a34a' : semaforoGlobal === 'rojo' ? '#dc2626' : undefined}
            />
          </View>

          <View style={styles.toolbarTabs}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.chipRowTabs}>
                {tabs.map((t) => {
                  const sel = tab === t.key;
                  return (
                    <TouchableOpacity
                      key={t.key}
                      style={[styles.tabChip, sel && styles.tabChipSel]}
                      onPress={() => setTab(t.key)}
                      activeOpacity={0.75}
                    >
                      <Text style={[styles.tabChipText, sel && styles.tabChipTextSel]}>{t.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          {tab === 'producto' ? (
            <View style={styles.tabla}>
              {resultados.porProducto.map((p) => (
                <FilaCard
                  key={p.productId}
                  titulo={p.productName}
                  badge={p.veredicto}
                  badgeColor={
                    p.veredicto === 'RENTABLE'
                      ? { bg: '#dcfce7', text: '#166534' }
                      : { bg: '#fee2e2', text: '#991b1b' }
                  }
                  semaforo={p.resultadoNeto >= 0 ? 'verde' : 'rojo'}
                  fields={[
                    { label: 'Uds campaña', value: String(p.udsCampanaTotal) },
                    { label: 'Incrementales', value: String(p.udsIncrementales) },
                    { label: 'Margen incr.', value: formatMoneda(p.margenIncremental) },
                    { label: 'Incentivo', value: formatMoneda(p.costeIncentivo) },
                    { label: 'Neto', value: formatMoneda(p.resultadoNeto) },
                  ]}
                />
              ))}
            </View>
          ) : null}

          {tab === 'empleado' ? (
            <View style={styles.tabla}>
              {resultados.porEmpleado.length === 0 ? (
                <View style={styles.emptyWrap}>
                  <MaterialIcons name="groups" size={32} color="#cbd5e1" />
                  <Text style={styles.vacioTab}>Sin datos de empleado (destinatario: equipo).</Text>
                </View>
              ) : (
                resultados.porEmpleado.map((e, i) => (
                  <FilaCard
                    key={`${e.localId}-${e.agoraUserId}`}
                    titulo={`#${i + 1} ${e.userName || e.agoraUserId}`}
                    fields={[
                      { label: 'Local', value: nombreLocal(e.localId) },
                      { label: 'Unidades', value: String(e.unidades) },
                      { label: 'Incentivo', value: formatMoneda(e.incentivoDevengado) },
                    ]}
                  />
                ))
              )}
            </View>
          ) : null}

          {tab === 'local' ? (
            <View style={styles.tabla}>
              {resultados.porLocal.map((l) => (
                <FilaCard
                  key={l.localId}
                  titulo={nombreLocal(l.localId)}
                  fields={[
                    { label: 'Unidades', value: String(l.unidades) },
                    { label: 'Incentivo', value: formatMoneda(l.incentivoDevengado) },
                  ]}
                />
              ))}
            </View>
          ) : null}

          {tab === 'evolucion' ? (
            <View style={styles.tabla}>
              {resultados.serieDiaria.map((d) => (
                <View key={d.fecha} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{formatFecha(d.fecha)}</Text>
                    <Text style={[styles.cardFieldValue, { fontWeight: '700', color: '#0ea5e9' }]}>
                      {d.unidades} uds
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <Text style={styles.notaPie}>
            Los datos se actualizan con el sync nocturno de ventas por producto (jornada Ágora).
          </Text>
        </ScrollView>
      ) : null}

      {exportMenuOpen ? (
        <Pressable style={styles.exportOverlay} onPress={() => setExportMenuOpen(false)} />
      ) : null}

      <CampanaFormModal
        visible={modalEditar}
        onClose={() => setModalEditar(false)}
        onSaved={cargar}
        campana={campana}
        puedeGestionar={puedeGestionar}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { padding: 40, alignItems: 'center', gap: 8 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 10 },
  sinPermiso: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
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
  headerStack: { flexWrap: 'wrap', alignItems: 'flex-start' },
  backBtn: { padding: 4 },
  tituloBlock: { flex: 1, minWidth: 0 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnIcon: { padding: 6 },
  btnExport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnExportText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  exportMenu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 4,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    zIndex: 20,
    minWidth: 160,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  exportItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
  },
  exportItemText: { fontSize: 13, fontWeight: '600', color: '#334155' },
  exportOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 32 },
  warningsBox: {
    backgroundColor: '#fffbeb',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    gap: 4,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  warningText: { fontSize: 13, color: '#92400e' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 },
  estadoBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  estadoText: { fontSize: 11, fontWeight: '700' },
  metaText: { fontSize: 13, color: '#64748b' },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  kpiRowStack: { flexDirection: 'column' },
  kpiCard: {
    flex: 1,
    minWidth: 120,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiCardLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiCardValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginTop: 2 },
  toolbarTabs: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginBottom: 12,
  },
  chipRowTabs: { flexDirection: 'row', gap: 6 },
  tabChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  tabChipSel: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  tabChipText: { fontSize: 11, fontWeight: '600', color: '#475569' },
  tabChipTextSel: { color: '#075985', fontWeight: '800' },
  tabla: { gap: 10 },
  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },
  vacioTab: { color: '#94a3b8', fontStyle: 'italic', textAlign: 'center' },
  notaPie: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 16, textAlign: 'center' },
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
});
