import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';
import { apiFetch } from '../../../utils/api';

type AccionHub = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  route: string;
  requiereGestionar?: boolean;
};

const ACCIONES: AccionHub[] = [
  {
    id: 'escanear',
    label: 'Escanear',
    descripcion: 'Subir tickets o facturas, revisar líneas y confirmar lote',
    icon: 'document-scanner',
    route: '/facturacion/refacturacion/escanear',
    requiereGestionar: true,
  },
  {
    id: 'pendientes',
    label: 'Pendientes',
    descripcion: 'Revisar, editar, reasignar o descartar líneas pendientes',
    icon: 'playlist-add-check',
    route: '/facturacion/refacturacion/pendientes',
  },
  {
    id: 'emitir',
    label: 'Emitir',
    descripcion: 'Crear factura OUT en borrador a partir de líneas pendientes',
    icon: 'receipt-long',
    route: '/facturacion/refacturacion/emitir',
    requiereGestionar: true,
  },
];

export default function RefacturacionHubScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { hubGridColumns, isPhone } = useBreakpoint();
  const puedeVer = hasPermiso('refacturacion.ver');
  const puedeGestionar = hasPermiso('refacturacion.gestionar');
  const [pendientes, setPendientes] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!puedeVer) return;
      setLoadingCount(true);
      apiFetch('/api/refacturacion/lineas?estado=pendiente')
        .then((r) => r.json())
        .then((d) => {
          const list = Array.isArray(d.lineas) ? d.lineas : [];
          setPendientes(list.length);
        })
        .catch(() => setPendientes(null))
        .finally(() => setLoadingCount(false));
    }, [puedeVer]),
  );

  if (!puedeVer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>No tienes permiso para ver refacturaciones.</Text>
      </View>
    );
  }

  const cardWidth = hubGridColumns === 1 ? '100%' : '48%';

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/facturacion' as never)}
          style={[styles.backBtn, isPhone && { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH }]}
          accessibilityLabel="Volver a Facturación"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Refacturaciones</Text>
          <Text style={styles.subtitle}>
            Tickets y gastos entre sociedades del grupo (+5% sobre base)
          </Text>
        </View>
        <View style={styles.badge}>
          {loadingCount ? (
            <ActivityIndicator size="small" color="#6d28d9" />
          ) : (
            <>
              <Text style={styles.badgeNum}>{pendientes ?? '—'}</Text>
              <Text style={styles.badgeLabel}>pendientes</Text>
            </>
          )}
        </View>
      </View>

      <View style={styles.grid}>
        {ACCIONES.map((a) => {
          const bloqueada = a.requiereGestionar && !puedeGestionar;
          return (
            <TouchableOpacity
              key={a.id}
              style={[styles.card, { width: cardWidth }, bloqueada && styles.cardDisabled]}
              disabled={bloqueada}
              onPress={() => router.push(a.route as never)}
              activeOpacity={0.75}
            >
              <View style={styles.cardIconWrap}>
                <MaterialIcons name={a.icon} size={26} color="#6d28d9" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{a.label}</Text>
                <Text style={styles.cardDesc}>{a.descripcion}</Text>
                {bloqueada ? (
                  <Text style={styles.cardHint}>Requiere permiso gestionar</Text>
                ) : null}
              </View>
              <MaterialIcons name="chevron-right" size={22} color="#a78bfa" />
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  denied: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  backBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginTop: 2,
  },
  title: { fontSize: 20, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  badge: {
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#ede9fe',
    borderWidth: 1,
    borderColor: '#c4b5fd',
  },
  badgeNum: { fontSize: 18, fontWeight: '700', color: '#6d28d9' },
  badgeLabel: { fontSize: 10, color: '#7c3aed', fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#c4b5fd',
    padding: 14,
    minHeight: 88,
  },
  cardDisabled: { opacity: 0.55 },
  cardIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#ede9fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#5b21b6' },
  cardDesc: { fontSize: 12, color: '#64748b', marginTop: 2 },
  cardHint: { fontSize: 11, color: '#b45309', marginTop: 4 },
});
