import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type CompraLinea = {
  PK: string;
  SK: string;
  AlbaranSerie: string;
  AlbaranNumero: string;
  AlbaranFecha: string;
  SupplierDocumentNumber: string;
  Confirmed: boolean;
  Invoiced: boolean;
  SupplierId: string;
  SupplierName: string;
  SupplierCif: string;
  WarehouseId: string;
  WarehouseName: string;
  LineIndex: number;
  ProductId: string;
  ProductName: string;
  Quantity: number;
  Price: number;
  DiscountRate: number;
  CashDiscount: number;
  TotalAmount: number;
  VatRate: number;
  SurchargeRate: number;
  PurchaseUnitName: string;
  FamilyId: string;
  FamilyName: string;
  LotNumber: string;
  LineNotes: string;
  syncedAt: string;
};

const COLUMNAS: { key: keyof CompraLinea | 'AlbaranRef'; label: string; width: number; align?: 'right' | 'center' }[] = [
  { key: 'AlbaranFecha', label: 'Fecha', width: 100 },
  { key: 'AlbaranRef', label: 'Albarán', width: 110 },
  { key: 'SupplierName', label: 'Proveedor', width: 180 },
  { key: 'ProductName', label: 'Producto', width: 200 },
  { key: 'ProductId', label: 'ID Prod.', width: 80 },
  { key: 'Quantity', label: 'Cantidad', width: 80, align: 'right' },
  { key: 'PurchaseUnitName', label: 'Unidad', width: 80 },
  { key: 'Price', label: 'Precio', width: 90, align: 'right' },
  { key: 'DiscountRate', label: 'Dto. %', width: 70, align: 'right' },
  { key: 'TotalAmount', label: 'Total', width: 100, align: 'right' },
  { key: 'VatRate', label: 'IVA %', width: 70, align: 'right' },
  { key: 'FamilyName', label: 'Familia', width: 130 },
  { key: 'WarehouseName', label: 'Almacén', width: 130 },
  { key: 'Confirmed', label: 'Confirm.', width: 80, align: 'center' },
  { key: 'Invoiced', label: 'Facturado', width: 80, align: 'center' },
];

function formatFecha(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatMoneda(n: number | null | undefined): string {
  if (n == null) return '';
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatPct(n: number | null | undefined): string {
  if (n == null || n === 0) return '';
  return (n * 100).toFixed(1) + '%';
}

export default function ComprasProveedorScreen() {
  const router = useRouter();
  const { width: winWidth } = useWindowDimensions();

  const [items, setItems] = useState<CompraLinea[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [lastLoad, setLastLoad] = useState<Date | null>(null);

  const cargarDatos = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/agora/purchases`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al cargar datos');
      setItems(data.items || []);
      setLastLoad(new Date());
    } catch (err: any) {
      setError(err.message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  const sincronizar = useCallback(async (fullSync = false) => {
    setSyncing(true);
    setSyncResult('');
    try {
      const bodyPayload: Record<string, string> = {};
      if (fullSync) bodyPayload.dateFrom = '2025-01-01';
      const res = await fetch(`${API_URL}/api/agora/purchases/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al sincronizar');
      setSyncResult(
        `Sincronizado: ${data.totalUpserted ?? 0} líneas (${data.dateFrom} → ${data.dateTo}, ${data.daysProcessed ?? 0} días)` +
        (data.errors?.length ? ` · ${data.errors.length} errores` : '')
      );
      await cargarDatos();
    } catch (err: any) {
      setSyncResult(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }, [cargarDatos]);

  useEffect(() => {
    cargarDatos();
  }, [cargarDatos]);

  const filtrados = useMemo(() => {
    if (!busqueda.trim()) return items;
    const q = busqueda.trim().toLowerCase();
    return items.filter((item) =>
      (item.ProductName || '').toLowerCase().includes(q) ||
      (item.ProductId || '').toLowerCase().includes(q) ||
      (item.SupplierName || '').toLowerCase().includes(q) ||
      (item.AlbaranNumero || '').toLowerCase().includes(q) ||
      (item.FamilyName || '').toLowerCase().includes(q) ||
      (item.WarehouseName || '').toLowerCase().includes(q)
    );
  }, [items, busqueda]);

  const PAGE_SIZE = 100;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
  const paginados = useMemo(
    () => filtrados.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtrados, page]
  );

  useEffect(() => { setPage(0); }, [busqueda]);

  const totalWidth = COLUMNAS.reduce((s, c) => s + c.width, 0);

  const getCellValue = (item: CompraLinea, col: typeof COLUMNAS[number]) => {
    if (col.key === 'AlbaranRef') return `${item.AlbaranSerie}-${item.AlbaranNumero}`;
    if (col.key === 'AlbaranFecha') return formatFecha(item.AlbaranFecha);
    if (col.key === 'Price' || col.key === 'TotalAmount' || col.key === 'CashDiscount') return formatMoneda(item[col.key] as number);
    if (col.key === 'DiscountRate' || col.key === 'VatRate' || col.key === 'SurchargeRate') return formatPct(item[col.key] as number);
    if (col.key === 'Quantity') {
      const v = item.Quantity;
      return v != null ? v.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 3 }) : '';
    }
    if (col.key === 'Confirmed') return item.Confirmed ? 'Sí' : 'No';
    if (col.key === 'Invoiced') return item.Invoiced ? 'Sí' : 'No';
    const val = (item as any)[col.key];
    return val != null ? String(val) : '';
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#0ea5e9" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Compras a Proveedor</Text>
          <Text style={styles.headerSubtitle}>
            {items.length} líneas
            {lastLoad ? ` · Última carga: ${lastLoad.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </Text>
        </View>
      </View>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          <View style={styles.searchWrap}>
            <MaterialIcons name="search" size={18} color="#94a3b8" />
            <TextInput
              style={styles.searchInput}
              value={busqueda}
              onChangeText={setBusqueda}
              placeholder="Buscar producto, proveedor, albarán…"
              placeholderTextColor="#94a3b8"
            />
            {busqueda.length > 0 && (
              <TouchableOpacity onPress={() => setBusqueda('')} hitSlop={8}>
                <MaterialIcons name="close" size={16} color="#94a3b8" />
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.resultCount}>
            {filtrados.length !== items.length ? `${filtrados.length} de ` : ''}{items.length} registros
          </Text>
        </View>
        <View style={styles.toolbarRight}>
          <TouchableOpacity style={styles.reloadBtn} onPress={cargarDatos} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="refresh" size={20} color="#0ea5e9" />
            )}
            <Text style={styles.reloadBtnText}>Recargar</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.syncBtn} onPress={() => sincronizar(false)} disabled={syncing}>
            {syncing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="sync" size={20} color="#fff" />
            )}
            <Text style={styles.syncBtnText}>{syncing ? 'Sincronizando…' : 'Sincronizar (60 días)'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.syncFullBtn} onPress={() => sincronizar(true)} disabled={syncing}>
            <MaterialIcons name="cloud-download" size={18} color="#0ea5e9" />
            <Text style={styles.syncFullBtnText}>Sync completo</Text>
          </TouchableOpacity>
        </View>
      </View>

      {syncResult ? (
        <View style={[styles.syncResultBar, syncResult.startsWith('Error') && styles.syncResultBarError]}>
          <MaterialIcons name={syncResult.startsWith('Error') ? 'error-outline' : 'check-circle'} size={16} color={syncResult.startsWith('Error') ? '#dc2626' : '#16a34a'} />
          <Text style={[styles.syncResultText, syncResult.startsWith('Error') && styles.syncResultTextError]}>{syncResult}</Text>
          <TouchableOpacity onPress={() => setSyncResult('')} hitSlop={8}>
            <MaterialIcons name="close" size={14} color="#94a3b8" />
          </TouchableOpacity>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBar}>
          <MaterialIcons name="error-outline" size={16} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Table */}
      <ScrollView style={styles.tableWrap} horizontal>
        <View style={{ minWidth: Math.max(totalWidth, winWidth - 40) }}>
          {/* Table Header */}
          <View style={styles.tableHeader}>
            {COLUMNAS.map((col) => (
              <View key={col.key} style={[styles.thCell, { width: col.width }]}>
                <Text style={[styles.thText, col.align === 'right' && styles.textRight, col.align === 'center' && styles.textCenter]} numberOfLines={1}>
                  {col.label}
                </Text>
              </View>
            ))}
          </View>

          {/* Table Body */}
          <ScrollView style={styles.tableBody}>
            {loading && items.length === 0 ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator size="large" color="#0ea5e9" />
                <Text style={styles.emptyText}>Cargando datos…</Text>
              </View>
            ) : paginados.length === 0 ? (
              <View style={styles.emptyWrap}>
                <MaterialIcons name="inbox" size={48} color="#cbd5e1" />
                <Text style={styles.emptyText}>
                  {items.length === 0
                    ? 'No hay datos. Pulsa "Sincronizar Ágora" para importar albaranes de entrada.'
                    : 'Sin resultados para la búsqueda.'}
                </Text>
              </View>
            ) : (
              paginados.map((item, rowIdx) => (
                <View key={`${item.PK}-${item.SK}`} style={[styles.row, rowIdx % 2 === 1 && styles.rowAlt]}>
                  {COLUMNAS.map((col) => (
                    <View key={col.key} style={[styles.cell, { width: col.width }]}>
                      <Text
                        style={[styles.cellText, col.align === 'right' && styles.textRight, col.align === 'center' && styles.textCenter]}
                        numberOfLines={1}
                      >
                        {getCellValue(item, col)}
                      </Text>
                    </View>
                  ))}
                </View>
              ))
            )}
          </ScrollView>

          {/* Pagination */}
          {totalPages > 1 && (
            <View style={styles.pagination}>
              <TouchableOpacity onPress={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={styles.pageBtn}>
                <MaterialIcons name="chevron-left" size={20} color={page === 0 ? '#cbd5e1' : '#0ea5e9'} />
              </TouchableOpacity>
              <Text style={styles.pageText}>
                Pág. {page + 1} de {totalPages}
              </Text>
              <TouchableOpacity onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={styles.pageBtn}>
                <MaterialIcons name="chevron-right" size={20} color={page >= totalPages - 1 ? '#cbd5e1' : '#0ea5e9'} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', gap: 10 },
  backBtn: { padding: 4 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  headerSubtitle: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, gap: 12, flexWrap: 'wrap' },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 200 },
  toolbarRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, gap: 6, flex: 1, maxWidth: 400 },
  searchInput: { flex: 1, fontSize: 13, color: '#334155', outlineStyle: 'none' as any },
  resultCount: { fontSize: 12, color: '#94a3b8', flexShrink: 0 },
  reloadBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  reloadBtnText: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  syncBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#0ea5e9' },
  syncBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  syncFullBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  syncFullBtnText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  syncResultBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0' },
  syncResultBarError: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  syncResultText: { flex: 1, fontSize: 12, color: '#16a34a' },
  syncResultTextError: { color: '#dc2626' },
  errorBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 16, marginBottom: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca' },
  errorText: { flex: 1, fontSize: 12, color: '#dc2626' },
  tableWrap: { flex: 1 },
  tableHeader: { flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: '#e2e8f0', backgroundColor: '#f8fafc', paddingVertical: 8, paddingHorizontal: 8 },
  thCell: { paddingHorizontal: 6 },
  thText: { fontSize: 12, fontWeight: '700', color: '#475569' },
  tableBody: { flex: 1 },
  row: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  rowAlt: { backgroundColor: '#fafbfc' },
  cell: { paddingHorizontal: 6, justifyContent: 'center' },
  cellText: { fontSize: 12, color: '#334155' },
  textRight: { textAlign: 'right' },
  textCenter: { textAlign: 'center' },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center', maxWidth: 360 },
  pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  pageBtn: { padding: 4 },
  pageText: { fontSize: 12, color: '#64748b' },
});
