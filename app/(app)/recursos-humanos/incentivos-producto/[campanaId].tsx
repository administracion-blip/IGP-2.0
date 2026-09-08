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
  Modal,
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
import { VentasCampanaPanel } from '../../../components/VentasCampanaPanel';
import { VentasCampanaModal } from '../../../components/VentasCampanaModal';
import { VentasSyncAviso } from '../../../components/VentasSyncAviso';
import {
  colorEstadoCampana,
  etiquetaDestinatario,
  etiquetaTipoIncentivo,
  etiquetaWarning,
  formatValorIncentivoDisplay,
} from '../../../lib/incentivosProducto';
import { campanaSePuedeBorrar, estadoEfectivoCampana, etiquetaEstadoAutomatico } from '../../../lib/campanaEstado';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { generarPdfIncentivosCampana, pdfIncentivosCampanaFileSlug } from '../../../lib/incentivosProductoPdf';
import { tasksColor, tasksRadius, tasksTabla } from '../../../constants/tasksUiTokens';
import type { Campana, ResultadosCampana, TipoIncentivo } from '../../../types/incentivosProducto';
import type { DetalleVentasCampana, FiltroVentasCampana } from '../../../types/ventasCampana';

type TabKey = 'producto' | 'empleado' | 'local' | 'evolucion';

type DeckRowItem = {
  id: string;
  titulo: string;
  meta?: string;
  subtitulo?: string;
  uds: number;
  precioCoste?: number;
  bonificacion?: number;
  incentivo?: number;
  filtro: FiltroVentasCampana;
};

type DeckColumn = { key: string; label: string; flex?: number; width?: number };

function mapIncentivo(n: number): string | undefined {
  return n > 0 ? formatMoneda(n) : undefined;
}

function mapBonificacion(n: number): string | undefined {
  if (!(n > 0)) return undefined;
  return `${formatMoneda(n)}/ud`;
}

function formatUds(n: number): string {
  if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
  return n.toFixed(1);
}

function mapPrecioCoste(n?: number): string {
  if (n != null && n > 0) return formatMoneda(n);
  return '—';
}

function metaProducto(productId: string): string {
  return `ID${productId}`;
}

function tabLabel(tab: TabKey): string {
  if (tab === 'producto') return 'Por producto';
  if (tab === 'empleado') return 'Por empleado';
  if (tab === 'local') return 'Por local';
  return 'Evolución diaria';
}

function deckColumns(tab: TabKey): DeckColumn[] {
  if (tab === 'producto') {
    return [
      { key: 'nombre', label: 'Producto', flex: 2.2 },
      { key: 'uds', label: 'Uds.', width: 48 },
      { key: 'precioCoste', label: 'Pr. compra', width: 68 },
      { key: 'bonificacion', label: 'Bonificación', width: 76 },
      { key: 'incentivo', label: 'Incentivo', width: 96 },
    ];
  }
  if (tab === 'empleado') {
    return [
      { key: 'nombre', label: 'Empleado', flex: 1.6 },
      { key: 'local', label: 'Local', flex: 1.4 },
      { key: 'uds', label: 'Uds.', width: 48 },
      { key: 'incentivo', label: 'Incentivo', width: 96 },
    ];
  }
  if (tab === 'local') {
    return [
      { key: 'nombre', label: 'Local', flex: 2.2 },
      { key: 'uds', label: 'Uds.', width: 48 },
      { key: 'incentivo', label: 'Incentivo', width: 96 },
    ];
  }
  return [
    { key: 'nombre', label: 'Fecha', flex: 1.6 },
    { key: 'uds', label: 'Uds.', width: 56 },
  ];
}

function DeckTable({
  tab,
  items,
  selId,
  onSelect,
  onVerVentasProducto,
}: {
  tab: TabKey;
  items: DeckRowItem[];
  selId: string | null;
  onSelect: (id: string) => void;
  onVerVentasProducto?: (item: DeckRowItem) => void;
}) {
  const cols = deckColumns(tab);
  const colBox = (c: DeckColumn) =>
    c.flex ? { flex: c.flex, minWidth: 0 } : { width: c.width, flexShrink: 0 as const };

  return (
    <View style={styles.deckSection}>
      <Text style={styles.deckSectionTitle}>{tabLabel(tab)} ({items.length})</Text>
      <View style={styles.detailTableFrame}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.detailTableScrollH}
          contentContainerStyle={styles.detailTableScrollContent}
        >
          <View style={styles.detailTableWrap}>
          <View style={styles.detailTableHeader}>
            {cols.map((c) => (
              <View
                key={c.key}
                style={[
                  colBox(c),
                  (c.key === 'uds' || c.key === 'incentivo' || c.key === 'bonificacion' || c.key === 'precioCoste') && styles.colAlignCenter,
                ]}
              >
                <Text
                  style={[
                    styles.detailTableHeaderText,
                    (c.key === 'uds' || c.key === 'incentivo' || c.key === 'bonificacion' || c.key === 'precioCoste') && styles.colHeaderTextCenter,
                  ]}
                  numberOfLines={1}
                >
                  {c.label}
                </Text>
              </View>
            ))}
          </View>
          {items.map((item) => {
            const selected = selId === item.id;
            const incentivoTxt = item.incentivo != null ? mapIncentivo(item.incentivo) : undefined;
            const bonificacionTxt = item.bonificacion != null ? mapBonificacion(item.bonificacion) : undefined;
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.detailTableRow, selected && styles.detailTableRowSel]}
                onPress={() => onSelect(item.id)}
                activeOpacity={0.75}
              >
                {cols.map((c) => {
                  if (c.key === 'nombre') {
                    const productId = item.filtro.productId;
                    return (
                      <View key={c.key} style={[styles.colNombre, { flex: c.flex }]}>
                        {productId && onVerVentasProducto ? (
                          <TouchableOpacity
                            style={styles.ventasIconBtn}
                            onPress={(e) => {
                              if (Platform.OS === 'web' && e && 'stopPropagation' in e) {
                                (e as unknown as { stopPropagation: () => void }).stopPropagation();
                              }
                              onVerVentasProducto(item);
                            }}
                            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                            accessibilityLabel={`Ver ventas de ${item.titulo}`}
                          >
                            <MaterialIcons name="info-outline" size={14} color="#0ea5e9" />
                          </TouchableOpacity>
                        ) : null}
                        <View style={styles.colNombreTexto}>
                          <Text style={styles.cellName} numberOfLines={1}>{item.titulo}</Text>
                          {item.meta ? (
                            <Text style={styles.cellMeta} numberOfLines={1}>{item.meta}</Text>
                          ) : null}
                        </View>
                      </View>
                    );
                  }
                  if (c.key === 'local') {
                    return (
                      <View key={c.key} style={{ flex: c.flex, minWidth: 0 }}>
                        <Text style={styles.cellSubtitulo} numberOfLines={2}>{item.subtitulo || '—'}</Text>
                      </View>
                    );
                  }
                  if (c.key === 'uds') {
                    return (
                      <View key={c.key} style={[colBox(c), styles.colAlignCenter]}>
                        <Text style={styles.calcCellText}>{formatUds(item.uds)}</Text>
                      </View>
                    );
                  }
                  if (c.key === 'precioCoste') {
                    return (
                      <View key={c.key} style={[colBox(c), styles.colAlignCenter]}>
                        <Text style={styles.calcCellText} numberOfLines={1}>
                          {mapPrecioCoste(item.precioCoste)}
                        </Text>
                      </View>
                    );
                  }
                  if (c.key === 'bonificacion') {
                    return (
                      <View key={c.key} style={[colBox(c), styles.colAlignCenter]}>
                        {bonificacionTxt ? (
                          <Text style={styles.calcCellText} numberOfLines={1}>{bonificacionTxt}</Text>
                        ) : null}
                      </View>
                    );
                  }
                  if (c.key === 'incentivo') {
                    return (
                      <View key={c.key} style={[colBox(c), styles.colAlignCenter]}>
                        {incentivoTxt ? (
                          <View style={styles.incentivoBadge}>
                            <Text style={styles.incentivoBadgeText} numberOfLines={1}>{incentivoTxt}</Text>
                          </View>
                        ) : null}
                      </View>
                    );
                  }
                  return null;
                })}
              </TouchableOpacity>
            );
          })}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.kpiValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export default function CampanaDetalleScreen() {
  const { campanaId } = useLocalSearchParams<{ campanaId: string }>();
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels } = useBreakpoint();
  const puedeGestionar = hasPermiso('incentivos_producto.gestionar');
  const puedeEditar = hasPermiso('incentivos_producto.editar');
  const puedeBorrar = hasPermiso('incentivos_producto.borrar');
  const puedeExportar = hasPermiso('incentivos_producto.exportar');
  const puedeVer = hasPermiso('incentivos_producto.ver');
  const { confirmar, ConfirmarView } = useConfirmar();

  const [campana, setCampana] = useState<Campana | null>(null);
  const [resultados, setResultados] = useState<ResultadosCampana | null>(null);
  const [ventasDetalle, setVentasDetalle] = useState<DetalleVentasCampana | null>(null);
  const [ventasLoading, setVentasLoading] = useState(false);
  const [ventasError, setVentasError] = useState<string | null>(null);
  const [localesMap, setLocalesMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('producto');
  const [selId, setSelId] = useState<string | null>(null);
  const [modalForm, setModalForm] = useState<'editar' | 'duplicar' | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportando, setExportando] = useState(false);
  const [archivando, setArchivando] = useState(false);
  const [bonificando, setBonificando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [ventasProductoModal, setVentasProductoModal] = useState<DeckRowItem | null>(null);

  const cargar = useCallback(async () => {
    if (!campanaId || !puedeVer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setVentasLoading(true);
    setVentasError(null);
    try {
      const [resCamp, resRes, resLoc, resVentas] = await Promise.all([
        apiFetch(`/api/campanas/${campanaId}`),
        apiFetch(`/api/campanas/${campanaId}/resultados`),
        apiFetch('/api/locales'),
        apiFetch(`/api/campanas/${campanaId}/ventas-detalle`),
      ]);
      const dataCamp = await resCamp.json();
      const dataRes = await resRes.json();
      const dataLoc = await resLoc.json();
      const dataVentas = await resVentas.json();
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
      if (!resVentas.ok) {
        setVentasError(dataVentas.error || 'Error al cargar ventas');
        setVentasDetalle(null);
      } else {
        setVentasDetalle(dataVentas);
      }
    } catch (e) {
      setError((e as Error).message || 'Error de conexión');
    } finally {
      setLoading(false);
      setVentasLoading(false);
    }
  }, [campanaId, puedeVer]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const nombreLocal = useCallback(
    (id: string) => localesMap[id] || id,
    [localesMap],
  );

  const deckItems: DeckRowItem[] = useMemo(() => {
    if (!resultados) return [];

    if (tab === 'producto') {
      return resultados.porProducto.map((p) => ({
        id: p.productId,
        titulo: p.productName,
        meta: metaProducto(p.productId),
        uds: p.udsCampanaTotal,
        precioCoste: p.precioCoste,
        bonificacion: p.bonificacionUnitaria,
        incentivo: p.costeIncentivo,
        filtro: { productId: p.productId },
      }));
    }

    if (tab === 'empleado') {
      return resultados.porEmpleado.map((e) => ({
        id: `${e.localId}|${e.agoraUserId}`,
        titulo: e.userName || e.agoraUserId,
        subtitulo: nombreLocal(e.localId),
        uds: e.unidades,
        incentivo: e.incentivoDevengado,
        filtro: { localId: e.localId, agoraUserId: e.agoraUserId },
      }));
    }

    if (tab === 'local') {
      return resultados.porLocal.map((l) => ({
        id: l.localId,
        titulo: nombreLocal(l.localId),
        uds: l.unidades,
        incentivo: l.incentivoDevengado,
        filtro: { localId: l.localId },
      }));
    }

    return resultados.serieDiaria.map((d) => ({
      id: d.fecha,
      titulo: formatFecha(d.fecha),
      uds: d.unidades,
      filtro: { fecha: d.fecha },
    }));
  }, [resultados, tab, nombreLocal]);

  const tabs: { key: TabKey; label: string }[] = useMemo(() => [
    { key: 'producto', label: 'Por producto' },
    ...(campana?.destinatario === 'individual'
      ? [{ key: 'empleado' as TabKey, label: 'Por empleado' }]
      : []),
    { key: 'local', label: 'Por local' },
    { key: 'evolucion', label: 'Evolución' },
  ], [campana?.destinatario]);

  useEffect(() => {
    if (selId && !deckItems.some((d) => d.id === selId)) {
      setSelId(null);
    }
  }, [deckItems, selId]);

  const selItem = useMemo(
    () => deckItems.find((d) => d.id === selId) ?? null,
    [deckItems, selId],
  );

  const exportarExcel = async () => {
    if (!campana || !resultados || !puedeExportar) return;
    setExportMenuOpen(false);
    setExportando(true);
    try {
      const wb = XLSX.utils.book_new();
      const resumen = [
        ['Campaña', campana.nombre],
        ['Estado', estadoEfectivoCampana(campana)],
        ['Periodo', `${campana.fechaInicio} — ${campana.fechaFin}`],
        ['Unidades campaña', resultados.totales.unidadesCampana],
        ['Coste incentivo', resultados.totales.costeIncentivo],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), 'Resumen');
      const prodRows = resultados.porProducto.map((p) => ({
        Producto: p.productName,
        'Uds campaña': p.udsCampanaTotal,
        'Pr. compra': p.precioCoste ?? '',
        'Bonificación €/ud': p.bonificacionUnitaria ?? 0,
        'Coste incentivo': p.costeIncentivo,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(prodRows), 'Por producto');
      const fname = `incentivos_${campana.nombre.replace(/\s+/g, '_').slice(0, 30)}_${campanaId!.slice(0, 8)}.xlsx`;
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

  const exportarPdf = async () => {
    if (!campana || !resultados || !puedeExportar) return;
    setExportMenuOpen(false);
    setExportando(true);
    try {
      const doc = await generarPdfIncentivosCampana(campana, resultados, {
        localesMap: new Map(Object.entries(localesMap)),
        ventasDetalle,
      });
      const fname = `${pdfIncentivosCampanaFileSlug(campana)}.pdf`;
      if (Platform.OS === 'web') {
        doc.save(fname);
      } else {
        const dataUri = doc.output('datauristring');
        const base64 = dataUri.split(',')[1] ?? '';
        const path = `${FileSystemLegacy.cacheDirectory}${fname}`;
        await FileSystemLegacy.writeAsStringAsync(path, base64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, { mimeType: 'application/pdf' });
        }
      }
    } catch (e) {
      setError((e as Error).message || 'Error al exportar PDF');
    } finally {
      setExportando(false);
    }
  };

  const cerrarRevisionRrhh = async () => {
    if (!campana || !puedeGestionar) return;
    const ok = await confirmar(
      'Confirmar revisión RRHH',
      `¿Cerrar «${campana.nombre}» tras revisión de incentivos?`,
      { confirmarLabel: 'Confirmar' },
    );
    if (!ok) return;
    setBonificando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/campanas/${campana.campanaId}`, {
        method: 'PATCH',
        body: JSON.stringify({ bonificar: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo confirmar la revisión');
      await cargar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBonificando(false);
    }
  };

  const archivarCampana = async () => {
    if (!campana || !puedeGestionar) return;
    const ok = await confirmar(
      'Archivar campaña',
      `¿Archivar «${campana.nombre}»? Pasará a histórico.`,
      { confirmarLabel: 'Archivar' },
    );
    if (!ok) return;
    setArchivando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/campanas/${campana.campanaId}`, {
        method: 'PATCH',
        body: JSON.stringify({ archivar: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo archivar');
      await cargar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setArchivando(false);
    }
  };

  const borrarCampana = async () => {
    if (!campana || !puedeBorrar || !campanaSePuedeBorrar(campana)) return;
    const ok = await confirmar(
      'Borrar campaña',
      `¿Borrar definitivamente la campaña «${campana.nombre}»? Esta acción no se puede deshacer.`,
      { confirmarLabel: 'Borrar', variant: 'danger' },
    );
    if (!ok) return;
    setBorrando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/campanas/${campana.campanaId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo borrar');
      router.replace('/recursos-humanos/incentivos-producto');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBorrando(false);
    }
  };

  if (!puedeVer) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.emptyText}>Sin permiso para ver esta campaña.</Text>
      </View>
    );
  }

  const totalUdsCampana = resultados?.totales.unidadesCampana
    ?? resultados?.porProducto.reduce((a, p) => a + p.udsCampanaTotal, 0)
    ?? 0;

  const ec = campana ? colorEstadoCampana(estadoEfectivoCampana(campana)) : '#64748b';
  const estadoCampana = campana ? estadoEfectivoCampana(campana) : null;
  const warningsVisibles = (resultados?.warnings ?? []).filter(
    (w) => !String(w).startsWith('coste_desconocido'),
  );

  const panelVentas = (
    <VentasCampanaPanel
      loading={ventasLoading}
      error={ventasError}
      data={ventasDetalle}
      localesMap={localesMap}
      filtro={selItem?.filtro}
      titulo={selItem ? `Ventas · ${selItem.titulo}` : 'Ventas · Todas'}
      embedded={!shouldStackPanels}
    />
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={20} color={tasksColor.textoSecundario} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={2}>{campana?.nombre || 'Campaña'}</Text>
        <View style={styles.acciones}>
          {puedeGestionar && campana && estadoCampana === 'Finalizada' ? (
            <TouchableOpacity
              style={styles.createBtnOutline}
              onPress={cerrarRevisionRrhh}
              disabled={bonificando}
            >
              {bonificando ? (
                <ActivityIndicator size="small" color="#d97706" />
              ) : (
                <>
                  <MaterialIcons name="fact-check" size={16} color="#d97706" />
                  <Text style={styles.cerrarRrhhBtnText}>Cerrar RRHH</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
          {puedeGestionar && campana && estadoCampana === 'Bonificada' ? (
            <TouchableOpacity
              style={styles.createBtnOutline}
              onPress={archivarCampana}
              disabled={archivando}
            >
              {archivando ? (
                <ActivityIndicator size="small" color="#64748b" />
              ) : (
                <>
                  <MaterialIcons name="archive" size={16} color="#64748b" />
                  <Text style={styles.archivarBtnText}>Archivar</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
          {puedeGestionar && campana ? (
            <TouchableOpacity style={styles.btnIcon} onPress={() => setModalForm('duplicar')}>
              <MaterialIcons name="content-copy" size={20} color="#0ea5e9" />
            </TouchableOpacity>
          ) : null}
          {puedeEditar && campana ? (
            <TouchableOpacity style={styles.btnIcon} onPress={() => setModalForm('editar')}>
              <MaterialIcons name="edit" size={20} color="#64748b" />
            </TouchableOpacity>
          ) : null}
          {puedeBorrar && campana && campanaSePuedeBorrar(campana) ? (
            <TouchableOpacity
              style={styles.btnIcon}
              onPress={borrarCampana}
              disabled={borrando}
            >
              {borrando ? (
                <ActivityIndicator size="small" color="#ef4444" />
              ) : (
                <MaterialIcons name="delete-outline" size={20} color="#ef4444" />
              )}
            </TouchableOpacity>
          ) : null}
          {puedeExportar ? (
            <View style={styles.exportAnchor}>
              <TouchableOpacity
                style={styles.createBtnOutline}
                onPress={() => setExportMenuOpen((v) => !v)}
                disabled={exportando || !resultados}
              >
                {exportando ? (
                  <ActivityIndicator size="small" color="#0ea5e9" />
                ) : (
                  <>
                    <MaterialIcons name="download" size={16} color="#0ea5e9" />
                    <Text style={styles.createBtnOutlineText}>Descargar</Text>
                  </>
                )}
              </TouchableOpacity>
              {exportMenuOpen ? (
                <>
                  <Pressable style={styles.exportOverlay} onPress={() => setExportMenuOpen(false)} />
                  <View style={styles.exportMenu}>
                    <TouchableOpacity style={styles.exportItem} onPress={exportarExcel}>
                      <MaterialIcons name="table-chart" size={18} color="#16a34a" />
                      <Text style={styles.exportItemText}>Excel (.xlsx)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.exportItem} onPress={exportarPdf}>
                      <MaterialIcons name="picture-as-pdf" size={18} color="#dc2626" />
                      <Text style={styles.exportItemText}>PDF detalle</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      {campana && resultados && !loading ? (
        <View style={styles.toolbar}>
          <View style={styles.metaRow}>
            <View style={[styles.badge, { backgroundColor: ec + '18' }]}>
              <Text style={[styles.badgeText, { color: ec }]}>{estadoCampana}</Text>
            </View>
            {estadoCampana ? (
              <Text style={styles.metaHint}>{etiquetaEstadoAutomatico(estadoCampana)}</Text>
            ) : null}
            <Text style={styles.metaText}>
              {formatFecha(campana.fechaInicio)} — {formatFecha(campana.fechaFin)}
            </Text>
            <Text style={styles.metaText}>
              {etiquetaTipoIncentivo(campana.tipoIncentivo as TipoIncentivo)} ·{' '}
              {formatValorIncentivoDisplay(campana.tipoIncentivo as TipoIncentivo, campana.valorIncentivo)}
            </Text>
            <Text style={styles.metaText}>{etiquetaDestinatario(campana.destinatario)}</Text>
          </View>

          {warningsVisibles.length ? (
            <View style={styles.warningsBox}>
              {warningsVisibles.map((w) => (
                <Text key={w} style={styles.warningText}>⚠ {etiquetaWarning(w)}</Text>
              ))}
            </View>
          ) : null}

          <View style={styles.kpiRow}>
            <KpiCard label="Uds. campaña" value={totalUdsCampana.toFixed(0)} />
            <KpiCard
              label="Coste incentivo"
              value={formatMoneda(resultados.totales.costeIncentivo)}
            />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chipRowEstado}>
              {tabs.map((t) => {
                const sel = tab === t.key;
                return (
                  <TouchableOpacity
                    key={t.key}
                    style={[styles.estadoChip, sel && styles.estadoChipSel]}
                    onPress={() => {
                      setTab(t.key);
                      setSelId(null);
                    }}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.estadoChipText, sel && styles.estadoChipTextSel]}>{t.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBar}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      <VentasSyncAviso />

      <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
        <View style={[styles.panelLista, !shouldStackPanels && styles.panelHalf, !shouldStackPanels && styles.panelListaBorder]}>
          {loading ? (
            <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
              {deckItems.length === 0 ? (
                <View style={styles.emptyWrap}>
                  <MaterialIcons name="inbox" size={40} color="#cbd5e1" />
                  <Text style={styles.emptyText}>Sin datos en esta vista.</Text>
                </View>
              ) : (
                <DeckTable
                  tab={tab}
                  items={deckItems}
                  selId={selId}
                  onSelect={(id) => setSelId((prev) => (prev === id ? null : id))}
                  onVerVentasProducto={tab === 'producto' ? setVentasProductoModal : undefined}
                />
              )}
            </ScrollView>
          )}
        </View>
        {!shouldStackPanels ? (
          <View style={[styles.panelDetalle, styles.panelHalf]}>
            {!loading && campana && resultados ? panelVentas : null}
          </View>
        ) : null}
      </View>

      <Modal
        visible={shouldStackPanels && selItem != null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelId(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSelId(null)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            {panelVentas}
          </Pressable>
        </Pressable>
      </Modal>

      <VentasCampanaModal
        visible={ventasProductoModal != null}
        onClose={() => setVentasProductoModal(null)}
        localesMap={localesMap}
        data={ventasDetalle}
        loading={ventasLoading}
        error={ventasError}
        filtro={
          ventasProductoModal?.filtro.productId
            ? { productId: ventasProductoModal.filtro.productId }
            : undefined
        }
        titulo={ventasProductoModal ? `Ventas · ${ventasProductoModal.titulo}` : undefined}
      />

      <CampanaFormModal
        visible={modalForm != null}
        onClose={() => setModalForm(null)}
        onSaved={(info) => {
          setModalForm(null);
          if (info?.creada && info.campanaId) {
            router.replace(`/recursos-humanos/incentivos-producto/${info.campanaId}`);
            return;
          }
          cargar();
        }}
        campana={campana}
        duplicar={modalForm === 'duplicar'}
        puedeGestionar={modalForm === 'duplicar' ? puedeGestionar : puedeEditar}
      />
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: tasksColor.fondoApp },
  center: { padding: 40, alignItems: 'center', gap: 8 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, fontWeight: '400', color: tasksColor.textoTerciario, textAlign: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: tasksColor.superficie,
    borderBottomWidth: 1,
    borderBottomColor: tasksColor.bordeSutil,
    gap: 12,
    position: 'relative',
    zIndex: 30,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tasksColor.superficie,
  },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '600', color: tasksColor.textoPrimario, minWidth: 0 },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnIcon: { padding: 6 },
  createBtnOutline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: tasksRadius.control,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    backgroundColor: tasksColor.superficie,
  },
  createBtnOutlineText: { fontSize: 12, fontWeight: '400', color: tasksColor.acento },
  exportAnchor: { position: 'relative', zIndex: 60 },
  exportMenu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 4,
    backgroundColor: tasksColor.superficie,
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    zIndex: 41,
    minWidth: 160,
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }
      : {
          elevation: 12,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.16,
          shadowRadius: 12,
        }),
  },
  exportItem: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  exportItemText: { fontSize: 12, fontWeight: '400', color: '#334155' },
  exportOverlay: {
    ...Platform.select({
      web: { position: 'fixed', left: 0, right: 0, top: 0, bottom: 0, zIndex: 39 },
      default: { position: 'absolute', left: -2000, right: -2000, top: -2000, bottom: -2000 },
    }),
  },

  toolbar: {
    backgroundColor: tasksColor.superficie,
    borderBottomWidth: 1,
    borderBottomColor: tasksColor.bordeSutil,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    position: 'relative',
    zIndex: 0,
  },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  metaText: { fontSize: 12, fontWeight: '400', color: '#64748b' },
  metaHint: { fontSize: 11, fontWeight: '400', color: tasksColor.textoTerciario, fontStyle: 'italic' },
  archivarBtnText: { fontSize: 12, fontWeight: '400', color: '#64748b' },
  cerrarRrhhBtnText: { fontSize: 12, fontWeight: '400', color: tasksColor.aviso },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: tasksRadius.pildora,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
  },
  badgeText: { fontSize: 11, fontWeight: '400' },
  warningsBox: {
    backgroundColor: tasksColor.avisoSuave,
    padding: 10,
    borderRadius: tasksRadius.contenedor,
    gap: 4,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
  },
  warningText: { fontSize: 12, fontWeight: '400', color: '#92400e' },
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 88,
    backgroundColor: tasksColor.superficie,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    borderRadius: tasksRadius.contenedor,
    padding: 12,
  },
  kpiLabel: { fontSize: 11, fontWeight: '400', color: '#64748b' },
  kpiValue: { fontSize: 20, fontWeight: '600', color: tasksColor.textoPrimario, marginTop: 2 },
  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: tasksRadius.control,
  },
  estadoChipSel: { backgroundColor: tasksColor.acentoSuave },
  estadoChipText: { fontSize: 12, fontWeight: '400', color: tasksColor.textoSecundario },
  estadoChipTextSel: { color: tasksColor.acentoTexto, fontWeight: '500' },

  errorBar: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: tasksRadius.control,
    backgroundColor: tasksColor.peligroSuave,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
  },
  errorText: { fontSize: 12, fontWeight: '400', color: tasksColor.peligro },

  split: { flex: 1, flexDirection: 'row', minHeight: 0, position: 'relative', zIndex: 0 },
  splitStack: { flexDirection: 'column' },
  panelHalf: { flex: 1, width: '50%', maxWidth: '50%' },
  panelLista: { flex: 1, minWidth: 0, minHeight: 0 },
  panelListaBorder: { borderRightWidth: 1, borderRightColor: tasksColor.bordeSutil },
  panelDetalle: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: tasksColor.superficie },

  list: { flex: 1, minHeight: 0 },
  listContent: { flexGrow: 1, paddingTop: 8, paddingLeft: 8, paddingBottom: 8, paddingRight: 14 },

  deckSection: { flex: 1, gap: 6, alignSelf: 'stretch', minHeight: 0 },
  deckSectionTitle: { fontSize: 12, fontWeight: '400', color: '#334155', paddingHorizontal: 2 },

  detailTableFrame: {
    flex: 1,
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    borderRadius: tasksRadius.contenedor,
    overflow: 'hidden',
    marginBottom: 6,
    backgroundColor: tasksColor.superficie,
  },
  detailTableScrollH: { flex: 1 },
  detailTableScrollContent: { flexGrow: 1, minHeight: '100%' },
  detailTableWrap: {
    minWidth: 280,
    flexGrow: 1,
    minHeight: '100%',
  },
  detailTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: tasksColor.superficieHundida,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: tasksColor.bordeSutil,
    borderLeftWidth: tasksTabla.seleccionBarra,
    borderLeftColor: 'transparent',
    gap: 4,
  },
  detailTableHeaderText: { fontSize: 11, fontWeight: '400', color: tasksColor.textoTerciario },
  detailTableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: tasksColor.bordeSutil,
    borderLeftWidth: tasksTabla.seleccionBarra,
    borderLeftColor: 'transparent',
    gap: 4,
  },
  detailTableRowSel: {
    backgroundColor: tasksColor.acentoSuave,
    borderLeftColor: tasksColor.acento,
  },
  colAlignCenter: { alignItems: 'center', justifyContent: 'center' },
  colHeaderTextCenter: { textAlign: 'center', alignSelf: 'stretch' },
  cellName: { fontSize: 12, fontWeight: '400', color: '#334155' },
  cellMeta: { fontSize: 11, fontWeight: '400', color: tasksColor.textoTerciario, marginTop: 1 },
  colNombre: { flexDirection: 'row', alignItems: 'flex-start', gap: 2, minWidth: 0 },
  colNombreTexto: { flex: 1, minWidth: 0 },
  ventasIconBtn: { paddingTop: 1, paddingRight: 2 },
  cellSubtitulo: { fontSize: 12, fontWeight: '400', color: '#334155', lineHeight: 16 },
  calcCellText: { fontSize: 12, fontWeight: '400', color: '#334155' },
  incentivoBadge: {
    backgroundColor: tasksColor.exitoSuave,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    maxWidth: '100%',
  },
  incentivoBadgeText: {
    fontSize: 12,
    fontWeight: '400',
    color: tasksColor.exito,
    fontVariant: ['tabular-nums'],
  },

  detalleVacio: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  detalleVacioText: { fontSize: 12, fontWeight: '400', color: tasksColor.textoTerciario, textAlign: 'center' },
  detalleVacioHint: { fontSize: 11, fontWeight: '400', color: tasksColor.textoTerciario, textAlign: 'center' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: tasksColor.overlay,
    justifyContent: 'center',
    padding: 16,
    ...(Platform.OS === 'web' ? { zIndex: 9999 } as object : {}),
  },
  modalSheet: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 560,
    backgroundColor: tasksColor.superficie,
    borderRadius: tasksRadius.contenedor,
    maxHeight: '88%',
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 16px 48px rgba(0,0,0,0.2)', zIndex: 10000 } as object : { elevation: 12 }),
  },
});
