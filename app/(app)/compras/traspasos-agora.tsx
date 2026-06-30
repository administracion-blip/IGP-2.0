import { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { InputFecha } from '../../components/InputFecha';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { apiFetch } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';

type FilaTraspaso = {
  pedidoId: string;
  fechaIso: string;
  almacenOrigenId: string;
  almacenDestinoId: string;
  productId: string;
  productoNombre: string;
  cantidad: number;
};

type ResumenProducto = {
  productId: string;
  productoNombre: string;
  cantidad: number;
};

type PedidoResumen = {
  Id: string;
  Fecha: string;
  FechaIso: string;
  LocalId: string;
  AlmacenOrigenId: string;
  AlmacenDestinoId: string;
  lineasValidas: number;
  sinAlmacenes: boolean;
  TraspasoExportadoEn: string | null;
  TraspasoExportadoPor: string | null;
};

type ExportData = {
  ok: boolean;
  desde: string;
  hasta: string;
  incluirExportados: boolean;
  pedidos: PedidoResumen[];
  filas: FilaTraspaso[];
  resumen: ResumenProducto[];
  omitidas: number;
  totalUnidades: number;
};

const COLUMNAS_EXCEL = ['Fecha', 'Id Almacen Origen', 'Id Almacen Destino', 'Id Producto', 'Cantidad'];

function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function haceDiasIso(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

export default function TraspasosAgoraScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels } = useBreakpoint();

  const [desde, setDesde] = useState<string>(haceDiasIso(7));
  const [hasta, setHasta] = useState<string>(hoyIso());
  const [incluirExportados, setIncluirExportados] = useState(false);

  const [data, setData] = useState<ExportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [marcando, setMarcando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const puede = hasPermiso('pedidos.exportar_traspaso');

  const cargar = useCallback(() => {
    if (!desde || !hasta) {
      setError('Selecciona un rango de fechas válido.');
      return;
    }
    if (desde > hasta) {
      setError('La fecha "Desde" no puede ser posterior a "Hasta".');
      return;
    }
    setLoading(true);
    setError(null);
    setAviso(null);
    const params = new URLSearchParams({ desde, hasta, incluirExportados: incluirExportados ? 'true' : 'false' });
    apiFetch(`/api/pedidos/traspaso-export?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
          setData(null);
          return;
        }
        setData(d as ExportData);
      })
      .catch((e) => {
        setError(e.message || 'Error de conexión');
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [desde, hasta, incluirExportados]);

  const pedidosSinAlmacenes = useMemo(
    () => (data?.pedidos ?? []).filter((p) => p.sinAlmacenes),
    [data],
  );

  const maxResumen = useMemo(() => {
    if (!data?.resumen?.length) return 0;
    return Math.max(...data.resumen.map((r) => r.cantidad));
  }, [data]);

  const construirLibro = useCallback((d: ExportData) => {
    // Hoja principal: estructura exacta lista para importar en Agora.
    const detalle: (string | number)[][] = [
      [...COLUMNAS_EXCEL],
      ...d.filas.map((f) => [
        formatFecha(f.fechaIso),
        f.almacenOrigenId,
        f.almacenDestinoId,
        f.productId,
        f.cantidad,
      ]),
    ];
    const wsDetalle = XLSX.utils.aoa_to_sheet(detalle);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsDetalle, 'Traspasos');
    return wb;
  }, []);

  const descargarYmarcado = useCallback(async () => {
    if (!data || data.filas.length === 0) return;
    const snapshot = data;
    const stamp = new Date().toISOString().slice(0, 10);
    const fname = `traspasos_agora_${snapshot.desde}_${snapshot.hasta}_${stamp}.xlsx`;
    const wb = construirLibro(snapshot);

    // 1) Generar y descargar/compartir el Excel.
    try {
      if (Platform.OS === 'web') {
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
        const fileUri = `${cacheDir}${fname}`;
        await FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 });
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: fname,
        });
      }
    } catch {
      setError('No se pudo generar el archivo Excel.');
      return;
    }

    // 2) Marcar los pedidos como exportados (control de duplicados).
    setMarcando(true);
    setError(null);
    try {
      const ids = snapshot.pedidos.map((p) => p.Id);
      const r = await apiFetch('/api/pedidos/traspaso-export/marcar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedidoIds: ids }),
      });
      const res = await r.json();
      if (res.error) {
        setAviso(`El Excel se descargó, pero no se pudo registrar la exportación: ${res.error}`);
      } else {
        setAviso(`Exportación registrada: ${res.marcados} pedido(s) marcados como exportados.`);
        cargar();
      }
    } catch (e: unknown) {
      setAviso(`El Excel se descargó, pero falló el registro de exportación: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      setMarcando(false);
    }
  }, [data, construirLibro, cargar]);

  if (!puede) {
    return (
      <View style={[styles.container, styles.centro]}>
        <MaterialIcons name="lock-outline" size={32} color="#94a3b8" />
        <Text style={styles.sinPermisoText}>No tienes permiso para exportar traspasos a Agora.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.volverBtn}>
          <Text style={styles.volverBtnText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const hayDatos = Boolean(data && data.filas.length > 0);
  const puedeExportar = hayDatos && !loading && !marcando;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Volver</Text>
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>Traspasos a Agora</Text>
          <Text style={styles.subtitle}>
            Exporta los artículos de los pedidos completados para importarlos como traspasos en Agora.
          </Text>
        </View>
      </View>

      <View style={[styles.toolbar, shouldStackPanels && styles.toolbarStack]}>
        <View style={styles.toolbarFechasRow}>
          <View style={styles.toolbarField}>
            <Text style={styles.fieldLabel}>Desde</Text>
            <InputFecha
              style={styles.inputFecha}
              valueIso={desde}
              onChangeIso={setDesde}
              placeholder="dd/mm/aaaa"
            />
          </View>
          <View style={styles.toolbarField}>
            <Text style={styles.fieldLabel}>Hasta</Text>
            <InputFecha
              style={styles.inputFecha}
              valueIso={hasta}
              onChangeIso={setHasta}
              placeholder="dd/mm/aaaa"
            />
          </View>
        </View>
        <View style={styles.toolbarFieldWide}>
          <Text style={styles.fieldLabel}>Opciones</Text>
          <TouchableOpacity
            style={[styles.toggle, incluirExportados && styles.toggleActivo]}
            onPress={() => setIncluirExportados((v) => !v)}
            activeOpacity={0.7}
          >
            <MaterialIcons
              name={incluirExportados ? 'check-box' : 'check-box-outline-blank'}
              size={18}
              color={incluirExportados ? '#0ea5e9' : '#94a3b8'}
            />
            <Text style={[styles.toggleText, incluirExportados && styles.toggleTextActivo]}>
              Incluir ya exportados
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.toolbarBtns}>
          <TouchableOpacity
            style={[styles.cargarBtn, loading && styles.btnDisabled]}
            onPress={cargar}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="search" size={18} color="#fff" />
            )}
            <Text style={styles.cargarBtnText}>Previsualizar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.exportBtn, !puedeExportar && styles.btnDisabled]}
            onPress={descargarYmarcado}
            disabled={!puedeExportar}
            activeOpacity={0.8}
          >
            {marcando ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="download" size={18} color="#fff" />
            )}
            <Text style={styles.exportBtnText}>Descargar Excel</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error ? (
        <View style={[styles.banner, styles.bannerError]}>
          <MaterialIcons name="error-outline" size={18} color="#dc2626" />
          <Text style={styles.bannerErrorText}>{error}</Text>
        </View>
      ) : null}
      {aviso ? (
        <View style={[styles.banner, styles.bannerOk]}>
          <MaterialIcons name="check-circle-outline" size={18} color="#16a34a" />
          <Text style={styles.bannerOkText}>{aviso}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centro}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      ) : !data ? (
        <View style={styles.centro}>
          <MaterialIcons name="inventory-2" size={36} color="#cbd5e1" />
          <Text style={styles.vacioText}>
            Elige un rango de fechas y pulsa «Previsualizar» para ver los artículos a traspasar.
          </Text>
        </View>
      ) : data.filas.length === 0 ? (
        <View style={styles.centro}>
          <MaterialIcons name="task-alt" size={36} color="#cbd5e1" />
          <Text style={styles.vacioText}>
            No hay pedidos completados pendientes de exportar en este rango.
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
          <View style={styles.kpisRow}>
            <View style={styles.kpiCard}>
              <Text style={styles.kpiValor}>{data.pedidos.length}</Text>
              <Text style={styles.kpiLabel}>Pedidos</Text>
            </View>
            <View style={styles.kpiCard}>
              <Text style={styles.kpiValor}>{data.filas.length}</Text>
              <Text style={styles.kpiLabel}>Líneas</Text>
            </View>
            <View style={styles.kpiCard}>
              <Text style={styles.kpiValor}>{data.resumen.length}</Text>
              <Text style={styles.kpiLabel}>Productos</Text>
            </View>
            <View style={[styles.kpiCard, styles.kpiCardDestacado]}>
              <Text style={[styles.kpiValor, styles.kpiValorDestacado]}>{data.totalUnidades}</Text>
              <Text style={styles.kpiLabel}>Unidades</Text>
            </View>
          </View>

          {pedidosSinAlmacenes.length > 0 ? (
            <View style={[styles.banner, styles.bannerWarn]}>
              <MaterialIcons name="warning-amber" size={18} color="#b45309" />
              <Text style={styles.bannerWarnText}>
                {pedidosSinAlmacenes.length} pedido(s) no tienen almacén de origen o destino. Sus líneas saldrán con
                el campo vacío y Agora podría rechazarlas.
              </Text>
            </View>
          ) : null}

          <View style={[styles.panelsRow, shouldStackPanels && styles.panelsStack]}>
            {/* Resumen agregado visual: unidades por producto */}
            <View style={[styles.panel, styles.panelResumen]}>
              <View style={styles.panelHead}>
                <MaterialIcons name="bar-chart" size={18} color="#0ea5e9" />
                <Text style={styles.panelTitulo}>Unidades por producto</Text>
              </View>
              {data.resumen.map((r) => {
                const pct = maxResumen > 0 ? Math.max(4, Math.round((r.cantidad / maxResumen) * 100)) : 0;
                return (
                  <View key={r.productId} style={styles.resumenFila}>
                    <View style={styles.resumenInfo}>
                      <Text style={styles.resumenNombre} numberOfLines={1}>
                        {r.productoNombre || r.productId}
                      </Text>
                      <Text style={styles.resumenCantidad}>{r.cantidad}</Text>
                    </View>
                    <View style={styles.resumenBarBg}>
                      <View style={[styles.resumenBar, { width: `${pct}%` }]} />
                    </View>
                  </View>
                );
              })}
            </View>

            {/* Pedidos incluidos */}
            <View style={[styles.panel, styles.panelPedidos]}>
              <View style={styles.panelHead}>
                <MaterialIcons name="receipt-long" size={18} color="#0ea5e9" />
                <Text style={styles.panelTitulo}>Pedidos incluidos</Text>
              </View>
              {data.pedidos.map((p) => (
                <View key={p.Id} style={styles.pedidoFila}>
                  <View style={styles.pedidoInfo}>
                    <Text style={styles.pedidoId} numberOfLines={1}>{p.Id}</Text>
                    <Text style={styles.pedidoMeta}>
                      {formatFecha(p.FechaIso)} · {p.lineasValidas} línea(s)
                    </Text>
                  </View>
                  <View style={styles.pedidoBadges}>
                    {p.sinAlmacenes ? (
                      <View style={[styles.badge, styles.badgeWarn]}>
                        <Text style={styles.badgeWarnText}>Sin almacén</Text>
                      </View>
                    ) : null}
                    {p.TraspasoExportadoEn ? (
                      <View style={[styles.badge, styles.badgeExportado]}>
                        <MaterialIcons name="history" size={12} color="#92400e" />
                        <Text style={styles.badgeExportadoText}>Ya exportado</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>

          {data.omitidas > 0 ? (
            <Text style={styles.notaPie}>
              {data.omitidas} línea(s) sin producto o sin cantidad se han omitido.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  centro: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  sinPermisoText: { fontSize: 15, color: '#64748b', textAlign: 'center' },
  vacioText: { fontSize: 14, color: '#64748b', textAlign: 'center', maxWidth: 420 },
  volverBtn: { minHeight: MIN_TOUCH, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: '#0ea5e9', borderRadius: 10 },
  volverBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10 },
  backBtn: { paddingVertical: 4, paddingHorizontal: 8, marginTop: 2 },
  backText: { fontSize: 14, color: '#0ea5e9', fontWeight: '600' },
  headerTextWrap: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },

  toolbar: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginBottom: 12, flexWrap: 'wrap', zIndex: 50 },
  toolbarStack: { flexDirection: 'column', alignItems: 'stretch' },
  toolbarFechasRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, flexShrink: 0 },
  toolbarField: { width: 128, flexShrink: 0 },
  toolbarFieldWide: { flexShrink: 0 },
  fieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  inputFecha: {
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 36,
    color: '#334155',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  toggle: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    minHeight: 36, paddingHorizontal: 12,
    borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc',
  },
  toggleActivo: { borderColor: '#bae6fd', backgroundColor: '#e0f2fe' },
  toggleText: { fontSize: 13, color: '#64748b', fontWeight: '600' },
  toggleTextActivo: { color: '#0369a1' },
  toolbarBtns: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, flexShrink: 0 },
  cargarBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: MIN_TOUCH, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#0ea5e9',
  },
  cargarBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: MIN_TOUCH, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#16a34a',
  },
  exportBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  btnDisabled: { opacity: 0.5 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, marginBottom: 10 },
  bannerError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  bannerErrorText: { flex: 1, fontSize: 13, color: '#dc2626', fontWeight: '500' },
  bannerOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  bannerOkText: { flex: 1, fontSize: 13, color: '#15803d', fontWeight: '500' },
  bannerWarn: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  bannerWarnText: { flex: 1, fontSize: 13, color: '#b45309', fontWeight: '500' },

  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },

  kpisRow: { flexDirection: 'row', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
  kpiCard: {
    flex: 1, minWidth: 92, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0',
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 10, alignItems: 'center',
  },
  kpiCardDestacado: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' },
  kpiValor: { fontSize: 22, fontWeight: '800', color: '#334155' },
  kpiValorDestacado: { color: '#16a34a' },
  kpiLabel: { fontSize: 11, color: '#64748b', fontWeight: '600', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.3 },

  panelsRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  panelsStack: { flexDirection: 'column' },
  panel: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 12, padding: 14 },
  panelResumen: { flex: 1.2, minWidth: 0 },
  panelPedidos: { flex: 1, minWidth: 0 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  panelTitulo: { fontSize: 15, fontWeight: '700', color: '#334155' },

  resumenFila: { marginBottom: 10 },
  resumenInfo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 8 },
  resumenNombre: { flex: 1, fontSize: 13, color: '#475569', fontWeight: '500' },
  resumenCantidad: { fontSize: 14, color: '#0369a1', fontWeight: '800' },
  resumenBarBg: { height: 8, borderRadius: 4, backgroundColor: '#f1f5f9', overflow: 'hidden' },
  resumenBar: { height: 8, borderRadius: 4, backgroundColor: '#0ea5e9' },

  pedidoFila: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  pedidoInfo: { flex: 1, minWidth: 0 },
  pedidoId: { fontSize: 13, color: '#334155', fontWeight: '700' },
  pedidoMeta: { fontSize: 12, color: '#94a3b8', marginTop: 1 },
  pedidoBadges: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999 },
  badgeWarn: { backgroundColor: '#fef3c7' },
  badgeWarnText: { fontSize: 11, color: '#b45309', fontWeight: '700' },
  badgeExportado: { backgroundColor: '#fef3c7' },
  badgeExportadoText: { fontSize: 11, color: '#92400e', fontWeight: '700' },

  notaPie: { fontSize: 12, color: '#94a3b8', marginTop: 12, fontStyle: 'italic' },
});
