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
      <View style={styles.container}>
        <Text style={styles.sinPermiso}>Sin permiso para ver esta campaña.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.tituloBlock}>
          <Text style={styles.title} numberOfLines={2}>{campana?.nombre || 'Campaña'}</Text>
          {campana ? (
            <Text style={styles.subtitle}>
              {formatFecha(campana.fechaInicio)} — {formatFecha(campana.fechaFin)}
            </Text>
          ) : null}
        </View>
        <View style={styles.acciones}>
          {puedeGestionar && campana ? (
            <TouchableOpacity style={styles.btnIcon} onPress={() => setModalEditar(true)}>
              <MaterialIcons name="edit" size={22} color="#0ea5e9" />
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
                  <ActivityIndicator size="small" color="#0ea5e9" />
                ) : (
                  <>
                    <MaterialIcons name="download" size={18} color="#0ea5e9" />
                    <Text style={styles.btnExportText}>Descargar</Text>
                    <MaterialIcons
                      name={exportMenuOpen ? 'expand-less' : 'expand-more'}
                      size={18}
                      color="#64748b"
                    />
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
        <ActivityIndicator style={{ marginTop: 40 }} color="#0ea5e9" />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : campana && resultados ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {resultados.warnings?.length ? (
            <View style={styles.warningsBox}>
              {resultados.warnings.map((w) => (
                <Text key={w} style={styles.warningText}>⚠ {etiquetaWarning(w)}</Text>
              ))}
            </View>
          ) : null}

          <View style={[styles.kpiRow, shouldStackPanels && styles.kpiRowStack]}>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>Uds. campaña</Text>
              <Text style={styles.kpiValor}>
                {resultados.porProducto.reduce((a, p) => a + p.udsCampanaTotal, 0).toFixed(0)}
              </Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>Incrementales</Text>
              <Text style={styles.kpiValor}>
                {resultados.porProducto.reduce((a, p) => a + p.udsIncrementales, 0).toFixed(0)}
              </Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>Coste incentivo</Text>
              <Text style={styles.kpiValor}>{formatMoneda(resultados.totales.costeIncentivo)}</Text>
            </View>
            <View
              style={[
                styles.kpi,
                semaforoGlobal === 'verde' && styles.kpiVerde,
                semaforoGlobal === 'rojo' && styles.kpiRojo,
              ]}
            >
              <Text style={styles.kpiLabel}>Resultado neto</Text>
              <Text style={styles.kpiValor}>{formatMoneda(resultados.totales.resultadoNeto)}</Text>
            </View>
          </View>

          <View style={styles.metaRow}>
            <View style={[styles.estadoBadge, { backgroundColor: colorEstadoCampana(campana.estado) + '22' }]}>
              <Text style={[styles.estadoText, { color: colorEstadoCampana(campana.estado) }]}>
                {campana.estado}
              </Text>
            </View>
            <Text style={styles.metaText}>
              {etiquetaTipoIncentivo(campana.tipoIncentivo)} · {campana.valorIncentivo}
            </Text>
            <Text style={styles.metaText}>{etiquetaDestinatario(campana.destinatario)}</Text>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
            <View style={styles.tabsRow}>
              {tabs.map((t) => (
                <TouchableOpacity
                  key={t.key}
                  style={[styles.tab, tab === t.key && styles.tabActivo]}
                  onPress={() => setTab(t.key)}
                >
                  <Text style={[styles.tabText, tab === t.key && styles.tabTextActivo]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {tab === 'producto' ? (
            <View style={styles.tabla}>
              {resultados.porProducto.map((p) => (
                <View key={p.productId} style={styles.filaCard}>
                  <View style={styles.filaTop}>
                    <Text style={styles.filaTitulo}>{p.productName}</Text>
                    <View
                      style={[
                        styles.veredicto,
                        { backgroundColor: p.veredicto === 'RENTABLE' ? '#dcfce7' : '#fee2e2' },
                      ]}
                    >
                      <Text
                        style={{
                          color: p.veredicto === 'RENTABLE' ? '#16a34a' : '#dc2626',
                          fontSize: 11,
                          fontWeight: '700',
                        }}
                      >
                        {p.veredicto}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.filaDet}>
                    Campaña: {p.udsCampanaTotal} uds · Incrementales: {p.udsIncrementales}
                  </Text>
                  <Text style={styles.filaDet}>
                    Margen incr.: {formatMoneda(p.margenIncremental)} · Incentivo:{' '}
                    {formatMoneda(p.costeIncentivo)} · Neto: {formatMoneda(p.resultadoNeto)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {tab === 'empleado' ? (
            <View style={styles.tabla}>
              {resultados.porEmpleado.length === 0 ? (
                <Text style={styles.vacioTab}>Sin datos de empleado (destinatario: equipo).</Text>
              ) : (
                resultados.porEmpleado.map((e, i) => (
                  <View key={`${e.localId}-${e.agoraUserId}`} style={styles.filaCard}>
                    <Text style={styles.filaTitulo}>
                      #{i + 1} {e.userName || e.agoraUserId}
                    </Text>
                    <Text style={styles.filaDet}>
                      {nombreLocal(e.localId)} · {e.unidades} uds · Incentivo:{' '}
                      {formatMoneda(e.incentivoDevengado)}
                    </Text>
                  </View>
                ))
              )}
            </View>
          ) : null}

          {tab === 'local' ? (
            <View style={styles.tabla}>
              {resultados.porLocal.map((l) => (
                <View key={l.localId} style={styles.filaCard}>
                  <Text style={styles.filaTitulo}>{nombreLocal(l.localId)}</Text>
                  <Text style={styles.filaDet}>
                    {l.unidades} uds · Incentivo: {formatMoneda(l.incentivoDevengado)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {tab === 'evolucion' ? (
            <View style={styles.tabla}>
              {resultados.serieDiaria.map((d) => (
                <View key={d.fecha} style={styles.serieFila}>
                  <Text style={styles.serieFecha}>{formatFecha(d.fecha)}</Text>
                  <Text style={styles.serieUds}>{d.unidades} uds</Text>
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
  container: { flex: 1, backgroundColor: '#e2e8f0' },
  sinPermiso: { padding: 24, textAlign: 'center', color: '#64748b' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  toolbarStack: { flexWrap: 'wrap' },
  backBtn: { padding: 4, marginTop: 2 },
  tituloBlock: { flex: 1 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnIcon: { padding: 6 },
  btnExport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  btnExportText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
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
  },
  warningText: { fontSize: 13, color: '#92400e' },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  kpiRowStack: { flexDirection: 'column' },
  kpi: {
    flex: 1,
    minWidth: 140,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  kpiVerde: { borderColor: '#86efac', backgroundColor: '#f0fdf4' },
  kpiRojo: { borderColor: '#fca5a5', backgroundColor: '#fef2f2' },
  kpiLabel: { fontSize: 12, color: '#64748b' },
  kpiValor: { fontSize: 18, fontWeight: '700', color: '#334155', marginTop: 4 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 },
  estadoBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  estadoText: { fontSize: 11, fontWeight: '700' },
  metaText: { fontSize: 13, color: '#64748b' },
  tabsScroll: { maxHeight: 44, marginBottom: 12 },
  tabsRow: { flexDirection: 'row', gap: 8 },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  tabActivo: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  tabText: { fontSize: 13, color: '#64748b' },
  tabTextActivo: { color: '#0369a1', fontWeight: '600' },
  tabla: { gap: 8 },
  filaCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  filaTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  filaTitulo: { fontSize: 15, fontWeight: '600', color: '#334155', flex: 1 },
  veredicto: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  filaDet: { fontSize: 13, color: '#64748b', marginTop: 4 },
  serieFila: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    padding: 10,
    borderRadius: 6,
    marginBottom: 4,
  },
  serieFecha: { fontSize: 14, color: '#334155' },
  serieUds: { fontSize: 14, fontWeight: '600', color: '#0ea5e9' },
  vacioTab: { color: '#94a3b8', fontStyle: 'italic', padding: 16 },
  notaPie: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 16, textAlign: 'center' },
  error: { color: '#dc2626', padding: 16 },
});
