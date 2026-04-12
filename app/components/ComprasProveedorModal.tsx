import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

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

const colStyle: Record<string, unknown> = { fontSize: 10, fontWeight: '700', color: '#475569', textTransform: 'uppercase', paddingRight: 10 };
const cellStyle: Record<string, unknown> = { fontSize: 11, color: '#334155', paddingRight: 10 };

type ComprasProveedorModalProps = {
  visible: boolean;
  onClose: () => void;
  productName: string;
  productId: string;
  fechaInicio?: string;
  fechaFin?: string;
};

export function ComprasProveedorModal({ visible, onClose, productName, productId, fechaInicio, fechaFin }: ComprasProveedorModalProps) {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setItems([]);
    try {
      const params = new URLSearchParams({ productId });
      if (fechaInicio) params.set('fechaInicio', fechaInicio);
      if (fechaFin) params.set('fechaFin', fechaFin);
      const res = await fetch(`${API_URL}/api/agora/purchases/por-producto?${params.toString()}`);
      const json = await res.json();
      setItems(json.items || []);
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
      totalQty += Number((c as any).Quantity) || 0;
      totalAmt += Number((c as any).TotalAmount) || 0;
    }
    return { totalQty, totalAmt };
  }, [items]);

  const gruposMes = useMemo(() => {
    const map: Record<string, { label: string; items: Record<string, unknown>[]; totalQty: number; totalAmt: number }> = {};
    for (const c of items) {
      const fecha = (c as any).AlbaranFecha || '';
      const key = fecha.slice(0, 7);
      if (!map[key]) {
        const [y, m] = key.split('-');
        map[key] = { label: `${MESES_ES[parseInt(m, 10) - 1] || m} ${y}`, items: [], totalQty: 0, totalAmt: 0 };
      }
      map[key].items.push(c);
      map[key].totalQty += Number((c as any).Quantity) || 0;
      map[key].totalAmt += Number((c as any).TotalAmount) || 0;
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a)).map(([, v]) => v);
  }, [items]);

  const periodoLabel = (fechaInicio || fechaFin)
    ? ` · ${formatFecha(fechaInicio || '')} – ${formatFecha(fechaFin || '')}`
    : '';

  return (
    <Modal visible={visible} transparent animationType="fade">
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 16 }} onPress={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 14, maxWidth: 960, width: '95%', maxHeight: '85%', alignSelf: 'center', overflow: 'hidden', padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: '#0f172a', marginBottom: 4 }}>Compras a proveedor</Text>
              <Text style={{ fontSize: 12, color: '#64748b' }}>
                {productName} ({productId}){periodoLabel}
              </Text>
            </View>
            <TouchableOpacity onPress={handleClose} style={{ padding: 4 }}>
              <MaterialIcons name="close" size={20} color="#64748b" />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color="#0ea5e9" style={{ marginTop: 40 }} />
          ) : items.length === 0 && loaded ? (
            <Text style={{ textAlign: 'center', color: '#94a3b8', marginTop: 40, fontSize: 14 }}>Sin registros de compra para este producto en el periodo del acuerdo</Text>
          ) : items.length > 0 ? (
            <>
              <Text style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                {items.length} registro{items.length !== 1 ? 's' : ''}
                {' · '}<Text style={{ fontWeight: '700', color: '#0f172a' }}>{resumen.totalQty.toLocaleString('es-ES')} uds.</Text>
                {' · '}<Text style={{ fontWeight: '700', color: '#0f172a' }}>{formatMoneda(resumen.totalAmt)}</Text>
              </Text>
              <ScrollView horizontal nestedScrollEnabled>
                <View style={{ minWidth: 1100 }}>
                  <View style={{ flexDirection: 'row', backgroundColor: '#f8fafc', paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}>
                    <Text style={[colStyle as any, { width: 90 }]}>Fecha</Text>
                    <Text style={[colStyle as any, { width: 100 }]}>Albarán</Text>
                    <Text style={[colStyle as any, { width: 170 }]}>Proveedor</Text>
                    <Text style={[colStyle as any, { width: 70, textAlign: 'right' }]}>Cantidad</Text>
                    <Text style={[colStyle as any, { width: 70 }]}>Unidad</Text>
                    <Text style={[colStyle as any, { width: 80, textAlign: 'right' }]}>Precio</Text>
                    <Text style={[colStyle as any, { width: 60, textAlign: 'right' }]}>Dto.%</Text>
                    <Text style={[colStyle as any, { width: 90, textAlign: 'right' }]}>Total</Text>
                    <Text style={[colStyle as any, { width: 60, textAlign: 'right' }]}>IVA%</Text>
                    <Text style={[colStyle as any, { width: 120 }]}>Familia</Text>
                    <Text style={[colStyle as any, { width: 120 }]}>Almacén</Text>
                    <Text style={[colStyle as any, { width: 70, textAlign: 'center' }]}>Confirm.</Text>
                  </View>
                  <ScrollView style={{ maxHeight: 400 }} nestedScrollEnabled>
                    {gruposMes.map((grupo) => (
                      <View key={grupo.label}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0f9ff', paddingVertical: 6, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: '#bae6fd' }}>
                          <MaterialIcons name="date-range" size={13} color="#0369a1" style={{ marginRight: 6 }} />
                          <Text style={{ fontSize: 12, fontWeight: '700', color: '#0369a1', marginRight: 12 }}>{grupo.label}</Text>
                          <View style={{ backgroundColor: '#dbeafe', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginRight: 8 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: '#1e40af' }}>{grupo.totalQty.toLocaleString('es-ES')} uds.</Text>
                          </View>
                          <View style={{ backgroundColor: '#d1fae5', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: '#065f46' }}>{formatMoneda(grupo.totalAmt)}</Text>
                          </View>
                        </View>
                        {grupo.items.map((c: any, idx: number) => (
                          <View key={`${c.PK}-${c.SK}-${idx}`} style={{ flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' }}>
                            <Text style={[cellStyle as any, { width: 90 }]}>{formatFecha(c.AlbaranFecha || '')}</Text>
                            <Text style={[cellStyle as any, { width: 100 }]}>{`${c.AlbaranSerie || ''}-${c.AlbaranNumero || ''}`}</Text>
                            <Text style={[cellStyle as any, { width: 170 }]} numberOfLines={1}>{c.SupplierName || ''}</Text>
                            <Text style={[cellStyle as any, { width: 70, textAlign: 'right', fontWeight: '600' }]}>{(c.Quantity ?? 0).toLocaleString('es-ES')}</Text>
                            <Text style={[cellStyle as any, { width: 70 }]}>{c.PurchaseUnitName || ''}</Text>
                            <Text style={[cellStyle as any, { width: 80, textAlign: 'right' }]}>{formatMoneda(c.Price)}</Text>
                            <Text style={[cellStyle as any, { width: 60, textAlign: 'right' }]}>{c.DiscountRate ? `${(c.DiscountRate * 100).toFixed(1)}%` : ''}</Text>
                            <Text style={[cellStyle as any, { width: 90, textAlign: 'right', fontWeight: '600' }]}>{formatMoneda(c.TotalAmount)}</Text>
                            <Text style={[cellStyle as any, { width: 60, textAlign: 'right' }]}>{c.VatRate ? `${(c.VatRate * 100).toFixed(0)}%` : ''}</Text>
                            <Text style={[cellStyle as any, { width: 120 }]} numberOfLines={1}>{c.FamilyName || ''}</Text>
                            <Text style={[cellStyle as any, { width: 120 }]} numberOfLines={1}>{c.WarehouseName || ''}</Text>
                            <Text style={[cellStyle as any, { width: 70, textAlign: 'center' }]}>{c.Confirmed ? 'Sí' : 'No'}</Text>
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
