import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  type TextStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { apiFetch } from '../utils/api';
import type { CompraLinea } from '../types/compras';

const MESES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function formatFecha(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatMoneda(n: number | null | undefined): string {
  if (n == null) return '0,00 €';
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

const colStyle: TextStyle = { fontSize: 10, fontWeight: '700', color: '#475569', textTransform: 'uppercase', paddingRight: 10 };
const cellStyle: TextStyle = { fontSize: 11, color: '#334155', paddingRight: 10 };

type ComprasProveedorModalProps = {
  visible: boolean;
  onClose: () => void;
  productName: string;
  productId: string;
  fechaInicio?: string;
  fechaFin?: string;
};

type GrupoMes = {
  label: string;
  items: CompraLinea[];
  totalQty: number;
  totalAmt: number;
};

export function ComprasProveedorModal({ visible, onClose, productName, productId, fechaInicio, fechaFin }: ComprasProveedorModalProps) {
  const [items, setItems] = useState<CompraLinea[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setItems([]);
    try {
      const params = new URLSearchParams({ productId });
      if (fechaInicio) params.set('fechaInicio', fechaInicio);
      if (fechaFin) params.set('fechaFin', fechaFin);
      const res = await apiFetch(`/api/agora/purchases/por-producto?${params.toString()}`);
      const json = await res.json();
      setItems((json.items as CompraLinea[]) || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [productId, fechaInicio, fechaFin]);

  useEffect(() => {
    if (visible && !loaded) fetchData();
  }, [visible, loaded, fetchData]);

  const handleClose = useCallback(() => {
    setLoaded(false);
    setItems([]);
    onClose();
  }, [onClose]);

  const resumen = useMemo(() => {
    let totalQty = 0, totalAmt = 0;
    for (const c of items) {
      totalQty += Number(c.Quantity) || 0;
      totalAmt += Number(c.TotalAmount) || 0;
    }
    return { totalQty, totalAmt };
  }, [items]);

  const gruposMes = useMemo(() => {
    const map: Record<string, GrupoMes> = {};
    for (const c of items) {
      const fecha = c.AlbaranFecha || '';
      const key = fecha.slice(0, 7);
      if (!map[key]) {
        const [y, m] = key.split('-');
        map[key] = { label: `${MESES_ES[parseInt(m, 10) - 1] || m} ${y}`, items: [], totalQty: 0, totalAmt: 0 };
      }
      map[key].items.push(c);
      map[key].totalQty += Number(c.Quantity) || 0;
      map[key].totalAmt += Number(c.TotalAmount) || 0;
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a)).map(([, v]) => v);
  }, [items]);

  const periodoLabel = (fechaInicio || fechaFin)
    ? ` · ${formatFecha(fechaInicio || '')} – ${formatFecha(fechaFin || '')}`
    : '';

  return (
    <Modal visible={visible} transparent animationType="fade">
      <Pressable style={styles.overlay} onPress={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerTextWrap}>
              <Text style={styles.title}>Compras a proveedor</Text>
              <Text style={styles.subtitle}>
                {productName} ({productId}){periodoLabel}
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
              <MaterialIcons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color="#0ea5e9" style={styles.spinner} />
          ) : items.length === 0 && loaded ? (
            <Text style={styles.emptyText}>Sin registros de compra para este producto en el periodo del acuerdo</Text>
          ) : items.length > 0 ? (
            <>
              <Text style={styles.resumenText}>
                {items.length} registro{items.length !== 1 ? 's' : ''}
                {' · '}<Text style={styles.resumenStrong}>{resumen.totalQty.toLocaleString('es-ES')} uds.</Text>
                {' · '}<Text style={styles.resumenStrong}>{formatMoneda(resumen.totalAmt)}</Text>
              </Text>
              <ScrollView horizontal nestedScrollEnabled>
                <View style={styles.tableWrap}>
                  <View style={styles.thRow}>
                    <Text style={[colStyle, { width: 90 }]}>Fecha</Text>
                    <Text style={[colStyle, { width: 100 }]}>Albarán</Text>
                    <Text style={[colStyle, { width: 170 }]}>Proveedor</Text>
                    <Text style={[colStyle, { width: 70, textAlign: 'right' }]}>Cantidad</Text>
                    <Text style={[colStyle, { width: 70 }]}>Unidad</Text>
                    <Text style={[colStyle, { width: 80, textAlign: 'right' }]}>Precio</Text>
                    <Text style={[colStyle, { width: 60, textAlign: 'right' }]}>Dto.%</Text>
                    <Text style={[colStyle, { width: 90, textAlign: 'right' }]}>Total</Text>
                    <Text style={[colStyle, { width: 60, textAlign: 'right' }]}>IVA%</Text>
                    <Text style={[colStyle, { width: 120 }]}>Familia</Text>
                    <Text style={[colStyle, { width: 120 }]}>Almacén</Text>
                    <Text style={[colStyle, { width: 70, textAlign: 'center' }]}>Confirm.</Text>
                  </View>
                  <ScrollView style={styles.bodyScroll} nestedScrollEnabled>
                    {gruposMes.map((grupo) => (
                      <View key={grupo.label}>
                        <View style={styles.grupoMesRow}>
                          <MaterialIcons name="date-range" size={13} color="#0369a1" style={styles.grupoMesIcon} />
                          <Text style={styles.grupoMesLabel}>{grupo.label}</Text>
                          <View style={styles.badgeQty}>
                            <Text style={styles.badgeQtyText}>{grupo.totalQty.toLocaleString('es-ES')} uds.</Text>
                          </View>
                          <View style={styles.badgeAmt}>
                            <Text style={styles.badgeAmtText}>{formatMoneda(grupo.totalAmt)}</Text>
                          </View>
                        </View>
                        {grupo.items.map((c, idx) => (
                          <View key={`${c.PK}-${c.SK}-${idx}`} style={styles.dataRow}>
                            <Text style={[cellStyle, { width: 90 }]}>{formatFecha(c.AlbaranFecha || '')}</Text>
                            <Text style={[cellStyle, { width: 100 }]}>{`${c.AlbaranSerie || ''}-${c.AlbaranNumero || ''}`}</Text>
                            <Text style={[cellStyle, { width: 170 }]} numberOfLines={1}>{c.SupplierName || ''}</Text>
                            <Text style={[cellStyle, { width: 70, textAlign: 'right', fontWeight: '600' }]}>{(c.Quantity ?? 0).toLocaleString('es-ES')}</Text>
                            <Text style={[cellStyle, { width: 70 }]}>{c.PurchaseUnitName || ''}</Text>
                            <Text style={[cellStyle, { width: 80, textAlign: 'right' }]}>{formatMoneda(c.Price)}</Text>
                            <Text style={[cellStyle, { width: 60, textAlign: 'right' }]}>{c.DiscountRate ? `${(c.DiscountRate * 100).toFixed(1)}%` : ''}</Text>
                            <Text style={[cellStyle, { width: 90, textAlign: 'right', fontWeight: '600' }]}>{formatMoneda(c.TotalAmount)}</Text>
                            <Text style={[cellStyle, { width: 60, textAlign: 'right' }]}>{c.VatRate ? `${(c.VatRate * 100).toFixed(0)}%` : ''}</Text>
                            <Text style={[cellStyle, { width: 120 }]} numberOfLines={1}>{c.FamilyName || ''}</Text>
                            <Text style={[cellStyle, { width: 120 }]} numberOfLines={1}>{c.WarehouseName || ''}</Text>
                            <Text style={[cellStyle, { width: 70, textAlign: 'center' }]}>{c.Confirmed ? 'Sí' : 'No'}</Text>
                          </View>
                        ))}
                      </View>
                    ))}
                  </ScrollView>
                </View>
              </ScrollView>
            </>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 16 },
  card: { backgroundColor: '#fff', borderRadius: 14, maxWidth: 960, width: '95%', maxHeight: '85%', alignSelf: 'center', overflow: 'hidden', padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  headerTextWrap: { flex: 1 },
  title: { fontSize: 17, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  subtitle: { fontSize: 12, color: '#64748b' },
  closeBtn: { padding: 4 },
  spinner: { marginTop: 40 },
  emptyText: { textAlign: 'center', color: '#94a3b8', marginTop: 40, fontSize: 14 },
  resumenText: { fontSize: 12, color: '#64748b', marginBottom: 8 },
  resumenStrong: { fontWeight: '700', color: '#0f172a' },
  tableWrap: { minWidth: 1100 },
  thRow: { flexDirection: 'row', backgroundColor: '#f8fafc', paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  bodyScroll: { maxHeight: 400 },
  grupoMesRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0f9ff', paddingVertical: 6, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#bae6fd' },
  grupoMesIcon: { marginRight: 6 },
  grupoMesLabel: { fontSize: 12, fontWeight: '700', color: '#0369a1', marginRight: 12 },
  badgeQty: { backgroundColor: '#dbeafe', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginRight: 8 },
  badgeQtyText: { fontSize: 10, fontWeight: '700', color: '#1e40af' },
  badgeAmt: { backgroundColor: '#d1fae5', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  badgeAmtText: { fontSize: 10, fontWeight: '700', color: '#065f46' },
  dataRow: { flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
});
