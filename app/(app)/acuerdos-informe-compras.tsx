import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as XLSX from 'xlsx';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { InputFecha } from '../components/InputFecha';
import { ComprasProveedorModal } from '../components/ComprasProveedorModal';
import { useAuth } from '../contexts/AuthContext';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { FILTROS_ESTADO_ACUERDO, CHIP_ESTADO_ACUERDO_PASTEL, colorEstadoAcuerdo } from '../lib/acuerdosEstado';
import { apiFetch, errorMessage } from '../utils/api';
import { formatMoneda } from '../utils/formatMoneda';
import type { InformeComprasLinea, InformeComprasResumenAcuerdo } from '../types/acuerdo';

const PERIODOS = [
  { id: 'mes', label: 'Este mes' },
  { id: 'mes_ant', label: 'Mes anterior' },
  { id: 'trimestre', label: 'Trimestre' },
  { id: 'anio', label: 'Este año' },
] as const;

const CHIP_PERIODO_PASTEL = {
  bg: '#f8fafc',
  bgSel: '#e0f2fe',
  border: '#e2e8f0',
  borderSel: '#7dd3fc',
  text: '#64748b',
  textSel: '#075985',
} as const;

const CHIP_SOLO_COMPRAS_PASTEL = {
  bg: '#eff6ff',
  bgSel: '#dbeafe',
  border: '#bfdbfe',
  borderSel: '#93c5fd',
  text: '#1e40af',
} as const;

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rangoPeriodo(id: string): { desde: string; hasta: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  if (id === 'mes') {
    return { desde: isoLocal(new Date(y, m, 1)), hasta: isoLocal(new Date(y, m + 1, 0)) };
  }
  if (id === 'mes_ant') {
    return { desde: isoLocal(new Date(y, m - 1, 1)), hasta: isoLocal(new Date(y, m, 0)) };
  }
  if (id === 'trimestre') {
    const qStart = Math.floor(m / 3) * 3;
    return { desde: isoLocal(new Date(y, qStart, 1)), hasta: isoLocal(new Date(y, qStart + 3, 0)) };
  }
  return { desde: isoLocal(new Date(y, 0, 1)), hasta: isoLocal(new Date(y, 11, 31)) };
}

function formatFechaIso(iso: string): string {
  if (!iso) return '—';
  const p = iso.split('-');
  if (p.length !== 3) return iso;
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function fmtQty(n: number) {
  return Number(n || 0).toLocaleString('es-ES', { maximumFractionDigits: 2 });
}

const EXCEL_HEADERS = [
  'Marca',
  'Acuerdo',
  'Estado',
  'Vigencia desde',
  'Vigencia hasta',
  'ID producto',
  'Producto',
  'Compradas',
  'Aport. unit.',
  'Aport. generada',
];

export default function AcuerdosInformeComprasScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackToolbar } = useBreakpoint();

  const mesActual = useMemo(() => rangoPeriodo('mes'), []);
  const [fechaDesde, setFechaDesde] = useState(mesActual.desde);
  const [fechaHasta, setFechaHasta] = useState(mesActual.hasta);
  const [periodoActivo, setPeriodoActivo] = useState<string | null>('mes');
  const [filtroEstado, setFiltroEstado] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [soloConCompras, setSoloConCompras] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resumen, setResumen] = useState<InformeComprasResumenAcuerdo[]>([]);
  const [lineas, setLineas] = useState<InformeComprasLinea[]>([]);
  const [totales, setTotales] = useState({ acuerdos: 0, compradas: 0, aportacionGenerada: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [comprasModal, setComprasModal] = useState<{
    productId: string;
    productName: string;
  } | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const lineasExport = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return lineas;
    return lineas.filter(
      (l) =>
        (l.Marca || '').toLowerCase().includes(q) ||
        (l.Nombre || '').toLowerCase().includes(q),
    );
  }, [lineas, busqueda]);

  const resumenExport = useMemo(() => {
    const pks = new Set(lineasExport.map((l) => l.acuerdoPK));
    return resumen.filter((r) => pks.has(r.acuerdoPK));
  }, [resumen, lineasExport]);

  const puedeExportar = hasPermiso('acuerdos.exportar') && lineasExport.length > 0;

  const cargar = useCallback(async () => {
    if (!fechaDesde || !fechaHasta) {
      setError('Indica fecha desde y hasta');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        fechaDesde,
        fechaHasta,
      });
      if (filtroEstado) params.set('estado', filtroEstado);
      if (soloConCompras) params.set('soloConCompras', 'true');
      const res = await apiFetch(`/api/acuerdos/informe-compras?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al cargar informe');
      setResumen(data.resumen || []);
      setLineas(data.lineas || []);
      setTotales(data.totales || { acuerdos: 0, compradas: 0, aportacionGenerada: 0 });
      setExpanded(new Set());
    } catch (e: unknown) {
      setError(errorMessage(e));
      setResumen([]);
      setLineas([]);
    } finally {
      setLoading(false);
    }
  }, [fechaDesde, fechaHasta, filtroEstado, soloConCompras]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const lineasPorAcuerdo = useMemo(() => {
    const map = new Map<string, InformeComprasLinea[]>();
    for (const l of lineas) {
      if (!map.has(l.acuerdoPK)) map.set(l.acuerdoPK, []);
      map.get(l.acuerdoPK)!.push(l);
    }
    return map;
  }, [lineas]);

  const resumenFiltrado = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return resumen;
    return resumen.filter(
      (r) =>
        (r.Marca || '').toLowerCase().includes(q) ||
        (r.Nombre || '').toLowerCase().includes(q),
    );
  }, [resumen, busqueda]);

  const conteoConCompras = useMemo(
    () => resumen.filter((r) => (r.totalCompradas ?? 0) > 0).length,
    [resumen],
  );

  const aplicarPeriodo = (id: string) => {
    const r = rangoPeriodo(id);
    setFechaDesde(r.desde);
    setFechaHasta(r.hasta);
    setPeriodoActivo(id);
  };

  const toggleExpand = (pk: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });
  };

  const exportarExcel = useCallback(() => {
    if (!puedeExportar) return;
    setExportMenuOpen(false);
    const rows = lineasExport.map((l) => [
      l.Marca,
      l.Nombre,
      l.Estado,
      l.FechaInicio,
      l.FechaFin,
      l.ProductId,
      l.ProductName,
      l.Compradas,
      l.AportacionUnitaria,
      l.AportacionGenerada,
    ]);
    const data = [EXCEL_HEADERS, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Informe acuerdos');
    const stamp = `${fechaDesde}_${fechaHasta}`;
    const fname = `informe_acuerdos_compras_${stamp}.xlsx`;
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
      FileSystemLegacy.writeAsStringAsync(`${cacheDir}${fname}`, base64, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      })
        .then(() =>
          Sharing.shareAsync(`${cacheDir}${fname}`, {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: fname,
          }),
        )
        .catch(() => {});
    }
  }, [lineasExport, fechaDesde, fechaHasta, puedeExportar]);

  const exportarPDF = useCallback(async () => {
    if (!puedeExportar) return;
    setExportMenuOpen(false);
    const stamp = `${fechaDesde}_${fechaHasta}`;
    const fname = `informe_acuerdos_compras_${stamp}.pdf`;

    const { jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    let y = 12;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Informe compras por acuerdo', 14, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60);
    doc.text(`Periodo informe: ${formatFechaIso(fechaDesde)} — ${formatFechaIso(fechaHasta)}`, 14, y);
    y += 4;
    doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, 14, y);
    y += 4;
    doc.text(
      `${totales.acuerdos} acuerdos · ${fmtQty(totales.compradas)} uds. · Aport. generada ${formatMoneda(totales.aportacionGenerada)}`,
      14,
      y,
    );
    y += 6;
    doc.setTextColor(0);

    autoTable(doc, {
      startY: y,
      head: [['Marca', 'Acuerdo', 'Estado', 'Vigencia', 'Compradas', 'Aport. generada']],
      body: resumenExport.map((r) => [
        r.Marca || '—',
        r.Nombre || '—',
        r.Estado || '—',
        `${formatFechaIso(r.FechaInicio)} — ${formatFechaIso(r.FechaFin)}`,
        fmtQty(r.totalCompradas),
        formatMoneda(r.totalAportacionGenerada),
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [14, 165, 233] },
      columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' } },
      margin: { left: 14, right: 14 },
    });

    const afterResumen = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    y = (afterResumen?.finalY ?? y) + 8;

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Desglose por producto', 14, y);
    y += 4;

    autoTable(doc, {
      startY: y,
      head: [['Marca', 'Producto', 'ID', 'Compradas', 'Aport. u.', 'Aport. generada']],
      body: lineasExport.map((l) => [
        l.Marca || '—',
        l.ProductName || '—',
        l.ProductId,
        fmtQty(l.Compradas),
        formatMoneda(l.AportacionUnitaria),
        formatMoneda(l.AportacionGenerada),
      ]),
      styles: { fontSize: 7 },
      headStyles: { fillColor: [100, 116, 139] },
      columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      margin: { left: 14, right: 14 },
    });

    if (Platform.OS === 'web') {
      doc.save(fname);
    } else {
      const dataUri = doc.output('datauristring');
      const base64 = dataUri.split(',')[1] || '';
      const cacheDir = FileSystemLegacy.cacheDirectory ?? '';
      const fileUri = `${cacheDir}${fname}`;
      FileSystemLegacy.writeAsStringAsync(fileUri, base64, { encoding: FileSystemLegacy.EncodingType.Base64 })
        .then(() => Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fname }))
        .catch(() => {});
    }
  }, [puedeExportar, fechaDesde, fechaHasta, totales, resumenExport, lineasExport]);

  if (!hasPermiso('acuerdos.ver')) {
    return (
      <View style={styles.denied}>
        <Text style={styles.deniedText}>No tienes permiso para ver acuerdos.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Informe compras por acuerdo</Text>
        {hasPermiso('acuerdos.exportar') ? (
          <View style={styles.exportAnchor}>
            <TouchableOpacity
              style={[styles.exportBtn, !puedeExportar && styles.exportBtnDisabled]}
              onPress={() => setExportMenuOpen((o) => !o)}
              disabled={!puedeExportar}
              activeOpacity={0.7}
            >
              <MaterialIcons name="download" size={16} color={puedeExportar ? '#0ea5e9' : '#94a3b8'} />
              <Text style={[styles.exportBtnText, !puedeExportar && styles.exportBtnTextDisabled]}>Descargar</Text>
              <MaterialIcons
                name={exportMenuOpen ? 'expand-less' : 'expand-more'}
                size={16}
                color={puedeExportar ? '#0ea5e9' : '#94a3b8'}
              />
            </TouchableOpacity>
            {exportMenuOpen && puedeExportar ? (
              <>
                <Pressable style={styles.exportOverlay} onPress={() => setExportMenuOpen(false)} />
                <View style={styles.exportMenu}>
                  <TouchableOpacity style={styles.exportMenuItem} onPress={exportarExcel} activeOpacity={0.7}>
                    <MaterialIcons name="table-chart" size={16} color="#16a34a" />
                    <Text style={styles.exportMenuItemText}>Excel (.xlsx)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.exportMenuItem, styles.exportMenuItemLast]}
                    onPress={exportarPDF}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name="picture-as-pdf" size={16} color="#dc2626" />
                    <Text style={styles.exportMenuItemText}>PDF (.pdf)</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={[styles.toolbar, shouldStackToolbar && styles.toolbarStack]}>
        <View style={[styles.fechaRow, shouldStackToolbar && styles.fechaRowStack]}>
          <View style={styles.fechaField}>
            <Text style={styles.fechaLabel}>Desde</Text>
            <InputFecha
              valueIso={fechaDesde}
              onChangeIso={(v) => {
                setFechaDesde(v);
                setPeriodoActivo(null);
              }}
              style={styles.fechaInput}
            />
          </View>
          <View style={styles.fechaField}>
            <Text style={styles.fechaLabel}>Hasta</Text>
            <InputFecha
              valueIso={fechaHasta}
              onChangeIso={(v) => {
                setFechaHasta(v);
                setPeriodoActivo(null);
              }}
              style={styles.fechaInput}
            />
          </View>
          <TouchableOpacity style={styles.btnFiltrar} onPress={cargar} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <MaterialIcons name="search" size={16} color="#fff" />
                <Text style={styles.btnFiltrarText}>Actualizar</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.chipRowEstado}>
          {PERIODOS.map((p) => {
            const sel = periodoActivo === p.id;
            return (
              <TouchableOpacity
                key={p.id}
                style={[
                  styles.estadoChip,
                  {
                    backgroundColor: sel ? CHIP_PERIODO_PASTEL.bgSel : CHIP_PERIODO_PASTEL.bg,
                    borderColor: sel ? CHIP_PERIODO_PASTEL.borderSel : CHIP_PERIODO_PASTEL.border,
                  },
                ]}
                onPress={() => aplicarPeriodo(p.id)}
                activeOpacity={0.75}
              >
                <Text style={[styles.estadoChipText, { color: sel ? CHIP_PERIODO_PASTEL.textSel : CHIP_PERIODO_PASTEL.text }, sel && styles.estadoChipTextSel]}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.chipRowEstado}>
          {FILTROS_ESTADO_ACUERDO.map((f) => {
            const key = f.id || '';
            const pastel = CHIP_ESTADO_ACUERDO_PASTEL[key] ?? CHIP_ESTADO_ACUERDO_PASTEL[''];
            const sel = filtroEstado === f.id;
            return (
              <TouchableOpacity
                key={f.id || 'todos'}
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
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={[
              styles.estadoChip,
              {
                backgroundColor: soloConCompras ? CHIP_SOLO_COMPRAS_PASTEL.bgSel : CHIP_SOLO_COMPRAS_PASTEL.bg,
                borderColor: soloConCompras ? CHIP_SOLO_COMPRAS_PASTEL.borderSel : CHIP_SOLO_COMPRAS_PASTEL.border,
              },
            ]}
            onPress={() => setSoloConCompras((v) => !v)}
            activeOpacity={0.75}
          >
            <Text style={[styles.estadoChipText, { color: CHIP_SOLO_COMPRAS_PASTEL.text }, soloConCompras && styles.estadoChipTextSel]}>
              Solo con compras
            </Text>
            <View style={[styles.estadoChipCount, soloConCompras && styles.estadoChipCountSel]}>
              <Text style={[styles.estadoChipCountText, { color: CHIP_SOLO_COMPRAS_PASTEL.text }, soloConCompras && styles.estadoChipTextSel]}>
                {conteoConCompras}
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.searchRow}>
          <MaterialIcons name="search" size={18} color="#94a3b8" />
          <TextInput
            value={busqueda}
            onChangeText={setBusqueda}
            placeholder="Filtrar por marca o nombre de acuerdo…"
            placeholderTextColor="#94a3b8"
            style={styles.searchInput}
          />
        </View>

        <View style={styles.kpiRow}>
          <KpiCard label="Acuerdos" value={String(totales.acuerdos)} />
          <KpiCard label="Uds. compradas" value={fmtQty(totales.compradas)} color="#0ea5e9" />
          <KpiCard label="Aport. generada" value={formatMoneda(totales.aportacionGenerada)} color="#16a34a" />
        </View>

        <Text style={styles.toolbarHint}>
          Periodo informe: {formatFechaIso(fechaDesde)} — {formatFechaIso(fechaHasta)}. Botellas compradas y aportación volumen generada (no modifica los acuerdos).
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {loading && resumen.length === 0 ? (
          <View style={styles.empty}>
            <ActivityIndicator size="large" color="#0ea5e9" />
            <Text style={styles.emptyText}>Generando informe…</Text>
          </View>
        ) : resumenFiltrado.length === 0 ? (
          <View style={styles.empty}>
            <MaterialIcons name="assessment" size={40} color="#cbd5e1" />
            <Text style={styles.emptyText}>No hay datos para los filtros seleccionados.</Text>
          </View>
        ) : (
          resumenFiltrado.map((r) => {
            const isOpen = expanded.has(r.acuerdoPK);
            const detalle = lineasPorAcuerdo.get(r.acuerdoPK) || [];
            const estadoColor = colorEstadoAcuerdo(r.Estado || '');
            return (
              <View key={r.acuerdoPK} style={styles.card}>
                <TouchableOpacity style={styles.cardHeader} onPress={() => toggleExpand(r.acuerdoPK)} activeOpacity={0.7}>
                  <MaterialIcons name={isOpen ? 'expand-less' : 'expand-more'} size={20} color="#64748b" />
                  <View style={styles.cardTitleWrap}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{r.Marca || '—'}</Text>
                    <View style={[styles.badge, { backgroundColor: estadoColor + '18', borderColor: estadoColor + '55' }]}>
                      <Text style={[styles.badgeText, { color: estadoColor }]}>{r.Estado || '—'}</Text>
                    </View>
                    <View style={[styles.dotSem, { backgroundColor: estadoColor }]} />
                  </View>
                  <Text style={[styles.cardImporte, { color: '#16a34a' }]}>{formatMoneda(r.totalAportacionGenerada)}</Text>
                </TouchableOpacity>

                <View style={styles.cardBody}>
                  {r.Nombre ? (
                    <View style={styles.cardField}>
                      <Text style={styles.cardFieldLabel}>Acuerdo</Text>
                      <Text style={styles.cardFieldValue} numberOfLines={2}>{r.Nombre}</Text>
                    </View>
                  ) : null}
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Vigencia</Text>
                    <Text style={styles.cardFieldValue}>
                      {formatFechaIso(r.FechaInicio)} — {formatFechaIso(r.FechaFin)}
                    </Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Compradas</Text>
                    <Text style={styles.cardFieldValue}>{fmtQty(r.totalCompradas)} uds.</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Productos</Text>
                    <Text style={styles.cardFieldValue}>{String(detalle.length)}</Text>
                  </View>
                </View>

                {isOpen ? (
                  <View style={styles.detalleWrap}>
                    <View style={styles.detalleHead}>
                      <Text style={[styles.detCol, { flex: 2 }]}>Producto</Text>
                      <Text style={[styles.detCol, styles.detColNum]}>Compr.</Text>
                      <Text style={[styles.detCol, styles.detColNum]}>Aport. u.</Text>
                      <Text style={[styles.detCol, styles.detColNum]}>Generada</Text>
                      <Text style={[styles.detCol, { width: 36 }]} />
                    </View>
                    {detalle.map((l) => (
                      <View key={`${l.acuerdoPK}-${l.ProductId}`} style={styles.detalleRow}>
                        <View style={{ flex: 2, minWidth: 0 }}>
                          <Text style={styles.detProd} numberOfLines={1}>{l.ProductName}</Text>
                          <Text style={styles.detId}>{l.ProductId}</Text>
                        </View>
                        <Text style={[styles.detCol, styles.detColNum, styles.detVal]}>{fmtQty(l.Compradas)}</Text>
                        <Text style={[styles.detCol, styles.detColNum, styles.detVal]}>
                          {formatMoneda(l.AportacionUnitaria)}
                        </Text>
                        <Text style={[styles.detCol, styles.detColNum, styles.detVal, styles.detAport]}>
                          {formatMoneda(l.AportacionGenerada)}
                        </Text>
                        <TouchableOpacity
                          style={styles.detBtn}
                          onPress={() =>
                            setComprasModal({ productId: l.ProductId, productName: l.ProductName })
                          }
                        >
                          <MaterialIcons name="receipt-long" size={18} color="#0ea5e9" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>

      {comprasModal ? (
        <ComprasProveedorModal
          visible
          onClose={() => setComprasModal(null)}
          productId={comprasModal.productId}
          productName={comprasModal.productName}
          fechaInicio={fechaDesde}
          fechaFin={fechaHasta}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  denied: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  deniedText: { fontSize: 15, color: '#64748b' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
    overflow: 'visible',
    zIndex: 20,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },

  exportAnchor: { position: 'relative', zIndex: 50 },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    minHeight: 40,
  },
  exportBtnDisabled: { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  exportBtnText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  exportBtnTextDisabled: { color: '#94a3b8' },
  exportOverlay: {
    ...Platform.select({
      web: { position: 'fixed' as const, left: 0, right: 0, top: 0, bottom: 0, zIndex: 39 },
      default: { position: 'absolute' as const, left: -2000, right: -2000, top: -2000, bottom: -2000 },
    }),
  },
  exportMenu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 4,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    minWidth: 168,
    overflow: 'hidden',
    zIndex: 41,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }
      : { elevation: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.16, shadowRadius: 12 }),
  },
  exportMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  exportMenuItemLast: { borderBottomWidth: 0 },
  exportMenuItemText: { fontSize: 12, color: '#334155', fontWeight: '600' },

  toolbar: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  toolbarStack: { gap: 10 },
  fechaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 },
  fechaRowStack: { flexDirection: 'column', alignItems: 'stretch' },
  fechaField: { flex: 1, minWidth: 120 },
  fechaLabel: { fontSize: 10, fontWeight: '600', color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  fechaInput: {
    fontSize: 12,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    backgroundColor: '#fff',
    color: '#334155',
    minHeight: 40,
  },
  btnFiltrar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    minHeight: 40,
    alignSelf: 'flex-end',
  },
  btnFiltrarText: { fontSize: 13, fontWeight: '600', color: '#fff' },

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

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#f8fafc',
  },
  searchInput: { flex: 1, fontSize: 14, color: '#1e293b', outlineStyle: 'none' } as object,

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kpiCard: {
    flex: 1,
    minWidth: 88,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginTop: 2 },
  toolbarHint: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },

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

  scroll: { flex: 1 },
  scrollContent: { padding: 12, gap: 10, paddingBottom: 32 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardImporte: { fontSize: 13, fontWeight: '700' },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },

  detalleWrap: {
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    backgroundColor: '#f8fafc',
    paddingBottom: 8,
  },
  detalleHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 4,
  },
  detalleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  detCol: { fontSize: 10, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase' },
  detColNum: { width: 72, textAlign: 'right' },
  detProd: { fontSize: 12, fontWeight: '600', color: '#334155' },
  detId: { fontSize: 10, color: '#94a3b8' },
  detVal: { fontSize: 12, color: '#334155', fontWeight: '500' },
  detAport: { color: '#16a34a', fontWeight: '700' },
  detBtn: { width: 36, alignItems: 'center', padding: 4 },
});
