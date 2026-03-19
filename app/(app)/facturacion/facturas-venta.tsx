import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoneda, labelEstado } from '../../utils/facturacion';
import { BadgeEstado } from '../../components/BadgeEstado';
import { InputFecha } from '../../components/InputFecha';
import { useLocalToast } from '../../components/Toast';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

function isoToDmy(iso: string): string {
  if (!iso || iso.length < 10) return '—';
  const [y, m, d] = iso.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function dmyToIso(dmy: string): string {
  if (!dmy) return '';
  const m = dmy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dmy)) return dmy;
  return '';
}

const PAGE_SIZE = 50;
const MIN_COL_WIDTH = 60;

type Factura = {
  id_factura: string;
  numero_factura: string;
  fecha_emision: string;
  emisor_nombre: string;
  empresa_nombre: string;
  empresa_cif: string;
  base_imponible: number;
  total_iva: number;
  total_factura: number;
  estado: string;
  saldo_pendiente: number;
};

const COLUMNAS = [
  { key: 'id_factura', label: 'ID' },
  { key: 'numero_factura', label: 'Nº Factura' },
  { key: 'fecha_emision', label: 'Fecha' },
  { key: 'emisor_nombre', label: 'Emisor' },
  { key: 'empresa_nombre', label: 'Receptor' },
  { key: 'base_imponible', label: 'Base imp.' },
  { key: 'total_iva', label: 'IVA' },
  { key: 'total_factura', label: 'Total' },
  { key: 'estado', label: 'Estado' },
  { key: 'saldo_pendiente', label: 'Saldo pte.' },
] as const;

const DEFAULT_WIDTHS: Record<string, number> = {
  id_factura: 100,
  numero_factura: 140,
  fecha_emision: 100,
  emisor_nombre: 160,
  empresa_nombre: 160,
  base_imponible: 100,
  total_iva: 90,
  total_factura: 100,
  estado: 120,
  saldo_pendiente: 110,
};

const TABS_ESTADO = [
  { key: '', label: 'Todas' },
  { key: 'borrador', label: 'Borrador' },
  { key: 'emitida', label: 'Emitida' },
  { key: 'parcialmente_cobrada', label: 'Parcial cobrada' },
  { key: 'cobrada', label: 'Cobrada' },
  { key: 'vencida', label: 'Vencida' },
  { key: 'anulada', label: 'Anulada' },
] as const;

const METODOS_PAGO = ['transferencia', 'efectivo', 'tarjeta', 'bizum', 'domiciliacion', 'otro'] as const;

export default function FacturasVentaScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();

  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filtroEstado, setFiltroEstado] = useState('');
  const [fechaDesde, setFechaDesde] = useState('');
  const [fechaHasta, setFechaHasta] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({ ...DEFAULT_WIDTHS });
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [operando, setOperando] = useState(false);
  const [sortCol, setSortCol] = useState<string>('fecha_emision');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [modalAnularVisible, setModalAnularVisible] = useState(false);
  const [modalCobrarVisible, setModalCobrarVisible] = useState(false);
  const [cobroImporte, setCobroImporte] = useState('');
  const [cobroMetodo, setCobroMetodo] = useState<string>('transferencia');
  const [cobroReferencia, setCobroReferencia] = useState('');
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [haySeries, setHaySeries] = useState(true);

  const { show: showToast, ToastView } = useLocalToast();

  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/facturacion/series`)
      .then((r) => r.json())
      .then((d) => {
        const all = d.series ?? d ?? [];
        setHaySeries(all.some((s: any) => s.tipo === 'OUT'));
      })
      .catch(() => {});
  }, []);

  const refetch = useCallback(() => {
    setError(null);
    setLoading(true);
    fetch(`${API_URL}/api/facturacion/facturas?tipo=OUT`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setFacturas(data.facturas || []);
      })
      .catch((e) => setError(e?.message || 'Error de conexión'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const facturasFiltradas = useMemo(() => {
    let resultado = facturas;
    if (filtroEstado) resultado = resultado.filter((f) => f.estado === filtroEstado);
    if (filtroBusqueda.trim()) {
      const q = filtroBusqueda.trim().toLowerCase();
      resultado = resultado.filter(
        (f) =>
          (f.numero_factura || '').toLowerCase().includes(q) ||
          (f.emisor_nombre || '').toLowerCase().includes(q) ||
          (f.empresa_nombre || '').toLowerCase().includes(q) ||
          (f.empresa_cif || '').toLowerCase().includes(q)
      );
    }
    const isoDesde = dmyToIso(fechaDesde);
    const isoHasta = dmyToIso(fechaHasta);
    if (isoDesde) resultado = resultado.filter((f) => f.fecha_emision >= isoDesde);
    if (isoHasta) resultado = resultado.filter((f) => f.fecha_emision <= isoHasta);

    if (sortCol) {
      resultado = [...resultado].sort((a, b) => {
        const va = (a as any)[sortCol] ?? '';
        const vb = (b as any)[sortCol] ?? '';
        const numA = typeof va === 'number' ? va : parseFloat(va);
        const numB = typeof vb === 'number' ? vb : parseFloat(vb);
        let cmp: number;
        if (!isNaN(numA) && !isNaN(numB)) cmp = numA - numB;
        else cmp = String(va).localeCompare(String(vb), 'es', { sensitivity: 'base' });
        return sortDir === 'desc' ? -cmp : cmp;
      });
    }
    return resultado;
  }, [facturas, filtroEstado, filtroBusqueda, fechaDesde, fechaHasta, sortCol, sortDir]);

  const totalRegistros = facturasFiltradas.length;
  const totalPages = Math.max(1, Math.ceil(totalRegistros / PAGE_SIZE));
  const pageIndexClamped = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const facturasPagina = useMemo(() => {
    const start = pageIndexClamped * PAGE_SIZE;
    return facturasFiltradas.slice(start, start + PAGE_SIZE);
  }, [facturasFiltradas, pageIndexClamped]);

  useEffect(() => {
    setPageIndex((p) => (p >= totalPages ? Math.max(0, totalPages - 1) : p));
  }, [totalPages]);

  useEffect(() => {
    setPageIndex(0);
    setSelectedId(null);
  }, [filtroBusqueda, filtroEstado, fechaDesde, fechaHasta]);

  const goPrevPage = () => { setPageIndex((p) => Math.max(0, p - 1)); setSelectedId(null); };
  const goNextPage = () => { setPageIndex((p) => Math.min(totalPages - 1, p + 1)); setSelectedId(null); };

  const selectedFactura = useMemo(
    () => (selectedId ? facturasPagina.find((f) => f.id_factura === selectedId) ?? null : null),
    [selectedId, facturasPagina]
  );

  const getColWidth = useCallback((col: string) => columnWidths[col] ?? 120, [columnWidths]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !resizingCol) return;
    const handleMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientX - r.startX;
      const next = Math.max(MIN_COL_WIDTH, r.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [r.col]: next }));
    };
    const handleUp = () => { resizeRef.current = null; setResizingCol(null); };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => { document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp); };
  }, [resizingCol]);

  const handleResizeStart = (col: string, e: { nativeEvent?: { clientX: number }; clientX?: number }) => {
    if (Platform.OS !== 'web') return;
    const clientX = e.nativeEvent?.clientX ?? (e as { clientX: number }).clientX ?? 0;
    resizeRef.current = { col, startX: clientX, startWidth: getColWidth(col) };
    setResizingCol(col);
  };

  const handleCrear = () => {
    if (!haySeries) {
      showToast('Sin series', 'No hay series de facturación configuradas para ventas. Ve a Facturación > Series para crear al menos una serie de tipo OUT.', 'warning');
      return;
    }
    router.push('/facturacion/factura-detalle?tipo=OUT&modo=crear' as any);
  };
  const handleEditar = () => {
    if (!selectedId) return;
    router.push(`/facturacion/factura-detalle?id=${selectedId}&modo=editar` as any);
  };

  const handleDuplicar = async () => {
    if (!selectedId) return;
    setOperando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/duplicar`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Error al duplicar'); return; }
      refetch();
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const handleEmitir = async () => {
    if (!selectedId) return;
    setOperando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/emitir`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Error al emitir'); return; }
      refetch();
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const abrirModalAnular = () => { if (!selectedId) return; setErrorModal(null); setModalAnularVisible(true); };
  const confirmarAnular = async () => {
    if (!selectedId) return;
    setOperando(true);
    setErrorModal(null);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/anular`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErrorModal(data.error || 'Error al anular'); setOperando(false); return; }
      setModalAnularVisible(false);
      refetch();
      setSelectedId(null);
    } catch (e) {
      setErrorModal(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const abrirModalCobrar = () => {
    if (!selectedFactura) return;
    setCobroImporte(selectedFactura.saldo_pendiente > 0 ? String(selectedFactura.saldo_pendiente) : '');
    setCobroMetodo('transferencia');
    setCobroReferencia('');
    setErrorModal(null);
    setModalCobrarVisible(true);
  };

  const confirmarCobro = async () => {
    if (!selectedId) return;
    const importe = parseFloat(cobroImporte);
    if (isNaN(importe) || importe <= 0) { setErrorModal('El importe debe ser mayor que 0'); return; }
    setOperando(true);
    setErrorModal(null);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/facturas/${selectedId}/pagos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importe, metodo_pago: cobroMetodo, referencia: cobroReferencia.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorModal(data.error || 'Error al registrar cobro'); setOperando(false); return; }
      setModalCobrarVisible(false);
      refetch();
      setSelectedId(null);
    } catch (e) {
      setErrorModal(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setOperando(false);
    }
  };

  const toolbarBtns: { id: string; label: string; icon: React.ComponentProps<typeof MaterialIcons>['name']; permiso: string; needsSelection: boolean }[] = [
    { id: 'crear', label: 'Crear', icon: 'add-circle-outline', permiso: 'facturacion.crear', needsSelection: false },
    { id: 'editar', label: 'Editar', icon: 'edit', permiso: 'facturacion.editar', needsSelection: true },
    { id: 'duplicar', label: 'Duplicar', icon: 'content-copy', permiso: 'facturacion.crear', needsSelection: true },
    { id: 'emitir', label: 'Emitir', icon: 'send', permiso: 'facturacion.emitir', needsSelection: true },
    { id: 'anular', label: 'Anular', icon: 'block', permiso: 'facturacion.anular', needsSelection: true },
    { id: 'cobrar', label: 'Cobrar', icon: 'payments', permiso: 'facturacion.cobrar_pagar', needsSelection: true },
  ];

  const handleToolbarPress = (id: string) => {
    if (id === 'crear') handleCrear();
    else if (id === 'editar') handleEditar();
    else if (id === 'duplicar') handleDuplicar();
    else if (id === 'emitir') handleEmitir();
    else if (id === 'anular') abrirModalAnular();
    else if (id === 'cobrar') abrirModalCobrar();
  };

  const valorCelda = useCallback((item: Factura, col: string): string => {
    switch (col) {
      case 'id_factura': return (item.id_factura || '').substring(0, 8) + '…';
      case 'numero_factura': return item.numero_factura || '—';
      case 'fecha_emision': return isoToDmy(item.fecha_emision);
      case 'emisor_nombre': return item.emisor_nombre || '—';
      case 'empresa_nombre': return item.empresa_nombre || '—';
      case 'base_imponible': return formatMoneda(item.base_imponible ?? 0);
      case 'total_iva': return formatMoneda(item.total_iva ?? 0);
      case 'total_factura': return formatMoneda(item.total_factura ?? 0);
      case 'saldo_pendiente': return formatMoneda(item.saldo_pendiente ?? 0);
      case 'estado': return labelEstado(item.estado);
      default: return '—';
    }
  }, []);

  if (loading && facturas.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>Cargando facturas…</Text>
      </View>
    );
  }

  if (error && facturas.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <Text style={styles.title}>Facturas emitidas</Text>
        </View>
        <View style={styles.center}>
          <MaterialIcons name="error-outline" size={48} color="#f87171" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryBtnText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.push('/facturacion' as any)} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Facturas emitidas</Text>
      </View>

      {/* Tabs de estado */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabsContent}>
        {TABS_ESTADO.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, filtroEstado === tab.key && styles.tabActive]}
            onPress={() => setFiltroEstado(tab.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, filtroEstado === tab.key && styles.tabTextActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Toolbar */}
      <View style={styles.toolbarRow}>
        <View style={styles.toolbar}>
          {toolbarBtns.filter((b) => hasPermiso(b.permiso)).map((btn) => {
            const disabled = operando || (btn.needsSelection && !selectedId);
            return (
              <View
                key={btn.id}
                style={styles.toolbarBtnWrap}
                {...(Platform.OS === 'web'
                  ? ({ onMouseEnter: () => setHoveredBtn(btn.id), onMouseLeave: () => setHoveredBtn(null) } as object)
                  : {})}
              >
                {hoveredBtn === btn.id && (
                  <View style={styles.tooltip}>
                    <Text style={styles.tooltipText}>{btn.label}</Text>
                  </View>
                )}
                <TouchableOpacity
                  style={[styles.toolbarBtn, disabled && styles.toolbarBtnDisabled]}
                  onPress={() => handleToolbarPress(btn.id)}
                  disabled={disabled}
                  accessibilityLabel={btn.label}
                >
                  <MaterialIcons name={btn.icon} size={18} color={disabled ? '#94a3b8' : '#0ea5e9'} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        <View
          style={styles.toolbarBtnWrap}
          {...(Platform.OS === 'web'
            ? ({ onMouseEnter: () => setHoveredBtn('refresh'), onMouseLeave: () => setHoveredBtn(null) } as object)
            : {})}
        >
          {hoveredBtn === 'refresh' && (
            <View style={styles.tooltip}><Text style={styles.tooltipText}>Actualizar</Text></View>
          )}
          <TouchableOpacity style={styles.toolbarBtn} onPress={refetch} disabled={loading} accessibilityLabel="Actualizar">
            <MaterialIcons name="refresh" size={18} color={loading ? '#94a3b8' : '#0ea5e9'} />
          </TouchableOpacity>
        </View>

        {Platform.OS === 'web' && hasPermiso('facturacion.ver') && (
          <View
            style={styles.toolbarBtnWrap}
            {...({ onMouseEnter: () => setHoveredBtn('excel'), onMouseLeave: () => setHoveredBtn(null) } as object)}
          >
            {hoveredBtn === 'excel' && (
              <View style={styles.tooltip}><Text style={styles.tooltipText}>Exportar Excel</Text></View>
            )}
            <TouchableOpacity
              style={styles.toolbarBtn}
              onPress={async () => {
                const { exportarFacturasVentaExcel } = await import('../../utils/exportFacturasExcel');
                exportarFacturasVentaExcel(facturasFiltradas);
              }}
              accessibilityLabel="Exportar Excel"
            >
              <MaterialIcons name="file-download" size={18} color="#059669" />
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={18} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={filtroBusqueda}
            onChangeText={setFiltroBusqueda}
            placeholder="Buscar…"
            placeholderTextColor="#94a3b8"
          />
        </View>

        <View style={styles.fechaFilterWrap}>
          <Text style={styles.fechaLabel}>Desde</Text>
          <InputFecha value={fechaDesde} onChange={setFechaDesde} format="dmy" placeholder="dd/mm/aaaa" style={styles.fechaInput} />
          <Text style={styles.fechaLabel}>Hasta</Text>
          <InputFecha value={fechaHasta} onChange={setFechaHasta} format="dmy" placeholder="dd/mm/aaaa" style={styles.fechaInput} />
        </View>
      </View>

      {/* Resumen rápido */}
      {facturasFiltradas.length > 0 && (
        <View style={styles.resumenRow}>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Total facturado</Text>
            <Text style={[styles.resumenVal, { color: '#059669' }]}>
              {formatMoneda(facturasFiltradas.reduce((s, f) => s + (f.total_factura ?? 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Pendiente cobro</Text>
            <Text style={[styles.resumenVal, { color: '#b45309' }]}>
              {formatMoneda(facturasFiltradas.reduce((s, f) => s + (f.saldo_pendiente ?? 0), 0))}
            </Text>
          </View>
          <View style={styles.resumenItem}>
            <Text style={styles.resumenLabel}>Facturas</Text>
            <Text style={styles.resumenVal}>{facturasFiltradas.length}</Text>
          </View>
        </View>
      )}

      {/* Subtítulo con paginación */}
      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle}>
          {totalRegistros === 0
            ? '0 registros'
            : totalPages > 1
              ? `${pageIndexClamped * PAGE_SIZE + 1}–${Math.min((pageIndexClamped + 1) * PAGE_SIZE, totalRegistros)} de ${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`
              : `${totalRegistros} registro${totalRegistros !== 1 ? 's' : ''}`}
        </Text>
        {totalPages > 1 && (
          <View style={styles.pagination}>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped <= 0 && styles.pageBtnDisabled]}
              onPress={goPrevPage}
              disabled={pageIndexClamped <= 0}
            >
              <MaterialIcons name="chevron-left" size={20} color={pageIndexClamped <= 0 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
            <Text style={styles.pageText}>Página {pageIndexClamped + 1} de {totalPages}</Text>
            <TouchableOpacity
              style={[styles.pageBtn, pageIndexClamped >= totalPages - 1 && styles.pageBtnDisabled]}
              onPress={goNextPage}
              disabled={pageIndexClamped >= totalPages - 1}
            >
              <MaterialIcons name="chevron-right" size={20} color={pageIndexClamped >= totalPages - 1 ? '#94a3b8' : '#0ea5e9'} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Tabla */}
      <ScrollView horizontal style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.table}>
          <View style={styles.rowHeader}>
            {COLUMNAS.map((col) => (
              <TouchableOpacity
                key={col.key}
                style={[styles.cellHeader, { width: getColWidth(col.key) }]}
                onPress={() => toggleSort(col.key)}
                activeOpacity={0.7}
              >
                <Text style={styles.cellHeaderText} numberOfLines={1} ellipsizeMode="tail">{col.label}</Text>
                {sortCol === col.key && (
                  <MaterialIcons name={sortDir === 'asc' ? 'arrow-upward' : 'arrow-downward'} size={12} color="#334155" />
                )}
                {Platform.OS === 'web' && (
                  <View
                    style={styles.resizeHandle}
                    onMouseDown={(e: { nativeEvent?: { clientX: number }; clientX?: number }) => handleResizeStart(col.key, e)}
                  />
                )}
              </TouchableOpacity>
            ))}
          </View>

          {facturasPagina.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={styles.emptyText}>
                {facturas.length === 0 ? 'No hay facturas' : 'Sin resultados para el filtro aplicado'}
              </Text>
            </View>
          ) : (
            facturasPagina.map((item) => (
              <TouchableOpacity
                key={item.id_factura}
                style={[styles.row, selectedId === item.id_factura && styles.rowSelected]}
                onPress={() => setSelectedId(selectedId === item.id_factura ? null : item.id_factura)}
                activeOpacity={0.8}
              >
                {COLUMNAS.map((col) => (
                  <View key={col.key} style={[styles.cell, { width: getColWidth(col.key) }]}>
                    {col.key === 'estado' ? (
                      <BadgeEstado estado={item.estado} />
                    ) : (
                      <Text style={styles.cellText} numberOfLines={1} ellipsizeMode="tail">
                        {valorCelda(item, col.key)}
                      </Text>
                    )}
                  </View>
                ))}
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>

      {/* Modal confirmar anulación */}
      <Modal visible={modalAnularVisible} transparent animationType="fade" onRequestClose={() => setModalAnularVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalContentWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>Anular factura</Text>
                    <Text style={styles.modalSubtitle}>
                      ¿Seguro que deseas anular la factura {selectedFactura?.numero_factura}? Esta acción no se puede deshacer.
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setModalAnularVisible(false)} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                {errorModal && (
                  <View style={styles.modalErrorWrap}>
                    <MaterialIcons name="error-outline" size={16} color="#dc2626" />
                    <Text style={styles.modalError}>{errorModal}</Text>
                  </View>
                )}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtnSecondary} onPress={() => setModalAnularVisible(false)} disabled={operando}>
                    <Text style={styles.modalFooterBtnSecondaryText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtnDanger, operando && styles.modalFooterBtnDisabled]}
                    onPress={confirmarAnular}
                    disabled={operando}
                  >
                    {operando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name="block" size={18} color="#fff" />
                        <Text style={styles.modalFooterBtnDangerText}>Anular</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>

      {/* Modal cobrar */}
      <Modal visible={modalCobrarVisible} transparent animationType="fade" onRequestClose={() => setModalCobrarVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => {}}>
          <KeyboardAvoidingView style={styles.modalContentWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalCardTouch}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <View>
                    <Text style={styles.modalTitle}>Registrar cobro</Text>
                    <Text style={styles.modalSubtitle}>Factura {selectedFactura?.numero_factura}</Text>
                  </View>
                  <TouchableOpacity onPress={() => setModalCobrarVisible(false)} style={styles.modalClose}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>
                <View style={styles.modalBody}>
                  <Text style={styles.formLabel}>Importe (€)</Text>
                  <TextInput
                    style={styles.formInput}
                    value={cobroImporte}
                    onChangeText={setCobroImporte}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor="#94a3b8"
                  />
                  <Text style={styles.formLabel}>Método de pago</Text>
                  <View style={styles.metodosGrid}>
                    {METODOS_PAGO.map((m) => (
                      <TouchableOpacity
                        key={m}
                        style={[styles.metodoOption, cobroMetodo === m && styles.metodoOptionSelected]}
                        onPress={() => setCobroMetodo(m)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.metodoOptionText, cobroMetodo === m && styles.metodoOptionTextSelected]}>
                          {m.charAt(0).toUpperCase() + m.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={styles.formLabel}>Referencia (opcional)</Text>
                  <TextInput
                    style={styles.formInput}
                    value={cobroReferencia}
                    onChangeText={setCobroReferencia}
                    placeholder="Nº transferencia, recibo…"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                {errorModal && (
                  <View style={styles.modalErrorWrap}>
                    <MaterialIcons name="error-outline" size={16} color="#dc2626" />
                    <Text style={styles.modalError}>{errorModal}</Text>
                  </View>
                )}
                <View style={styles.modalFooter}>
                  <TouchableOpacity style={styles.modalFooterBtnSecondary} onPress={() => setModalCobrarVisible(false)} disabled={operando}>
                    <Text style={styles.modalFooterBtnSecondaryText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalFooterBtnPrimary, operando && styles.modalFooterBtnDisabled]}
                    onPress={confirmarCobro}
                    disabled={operando}
                  >
                    {operando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name="payments" size={18} color="#fff" />
                        <Text style={styles.modalFooterBtnPrimaryText}>Cobrar</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          </KeyboardAvoidingView>
        </TouchableOpacity>
      </Modal>
      {ToastView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontSize: 12, color: '#64748b' },
  errorText: { fontSize: 12, color: '#f87171', textAlign: 'center' },
  retryBtn: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: '#fef2f2', borderRadius: 8 },
  retryBtnText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },

  resumenRow: { flexDirection: 'row', gap: 12, marginBottom: 8, flexWrap: 'wrap' },
  resumenItem: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  resumenLabel: { fontSize: 10, color: '#94a3b8' },
  resumenVal: { fontSize: 14, fontWeight: '700', color: '#334155' },

  tabsScroll: { marginBottom: 8, flexGrow: 0 },
  tabsContent: { gap: 6, paddingVertical: 2 },
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  tabActive: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  tabText: { fontSize: 12, color: '#64748b', fontWeight: '500' },
  tabTextActive: { color: '#fff', fontWeight: '600' },

  toolbarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolbarBtnWrap: { position: 'relative' },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: 4,
    backgroundColor: '#334155',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    zIndex: 10,
  },
  tooltipText: { fontSize: 9, color: '#f8fafc', fontWeight: '400' },
  toolbarBtn: { padding: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, backgroundColor: '#f8fafc' },
  toolbarBtnDisabled: { opacity: 0.6 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 280,
    height: 32,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontSize: 12, color: '#334155', paddingVertical: 0 },

  fechaFilterWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fechaLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  fechaInput: { fontSize: 11, paddingVertical: 3, paddingHorizontal: 6, minHeight: 28, color: '#334155', width: 110 },

  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 12,
    flexWrap: 'wrap',
  },
  subtitle: { fontSize: 14, color: '#64748b' },
  pagination: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pageBtn: { padding: 4 },
  pageBtnDisabled: { opacity: 0.5 },
  pageText: { fontSize: 11, color: '#64748b', marginHorizontal: 4 },

  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  table: {
    minWidth: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  rowHeader: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderBottomWidth: 1, borderBottomColor: '#cbd5e1' },
  cellHeader: {
    minWidth: MIN_COL_WIDTH,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative',
  },
  cellHeaderText: { fontSize: 11, fontWeight: '600', color: '#334155' },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', backgroundColor: '#fff' },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: { minWidth: MIN_COL_WIDTH, paddingVertical: 4, paddingHorizontal: 8, borderRightWidth: 1, borderRightColor: '#e2e8f0', justifyContent: 'center' },
  cellText: { fontSize: 11, color: '#475569' },
  emptyRow: { padding: 24, alignItems: 'center' },
  emptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },

  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalContentWrap: { width: '100%', maxWidth: 480, padding: 24, alignItems: 'center' },
  modalCardTouch: { width: '100%' },
  modalCard: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#334155', marginBottom: 4 },
  modalSubtitle: { fontSize: 13, color: '#64748b', lineHeight: 18 },
  modalClose: { padding: 4, marginTop: -4 },
  modalBody: { paddingHorizontal: 24, paddingVertical: 20, gap: 12 },
  formLabel: { fontSize: 12, fontWeight: '600', color: '#334155', marginBottom: 4 },
  formInput: {
    fontSize: 13,
    color: '#334155',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  metodosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  metodoOption: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  metodoOptionSelected: { backgroundColor: '#e0f2fe', borderColor: '#0ea5e9' },
  metodoOptionText: { fontSize: 12, color: '#334155', fontWeight: '500' },
  metodoOptionTextSelected: { color: '#0369a1', fontWeight: '600' },
  modalErrorWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#fef2f2',
    marginHorizontal: 24,
    marginBottom: 8,
    borderRadius: 8,
  },
  modalError: { fontSize: 12, color: '#dc2626', flex: 1 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  modalFooterBtnSecondary: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  modalFooterBtnSecondaryText: { fontSize: 14, color: '#64748b', fontWeight: '500' },
  modalFooterBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#0ea5e9',
  },
  modalFooterBtnPrimaryText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  modalFooterBtnDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#dc2626',
  },
  modalFooterBtnDangerText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  modalFooterBtnDisabled: { opacity: 0.7 },
});
