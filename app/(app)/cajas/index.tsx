import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';
import { FacturacionYtdWidget } from '../../components/FacturacionYtdWidget';
import { MIN_TOUCH } from '../../constants/layout';

type OpcionCaja = {
  id: string;
  label: string;
  shortLabel: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  permiso: string;
};

const OPCIONES: OpcionCaja[] = [
  {
    id: 'cierres-teoricos',
    label: 'Cierres de ventas teóricas',
    shortLabel: 'Cierres',
    icon: 'receipt-long',
    permiso: 'cierres.ver',
  },
  {
    id: 'revision-formas-pago',
    label: 'Revisión formas de pago',
    shortLabel: 'Formas pago',
    icon: 'payments',
    permiso: 'cierres.ver',
  },
  {
    id: 'arqueo-caja',
    label: 'Arqueo de Caja',
    shortLabel: 'Arqueo',
    icon: 'account-balance-wallet',
    permiso: 'cierres.ver',
  },
  {
    id: 'movimientos-caja',
    label: 'Movimientos de caja',
    shortLabel: 'Movimientos',
    icon: 'swap-horiz',
    permiso: 'cierres.ver',
  },
  {
    id: 'revision-cajas',
    label: 'Revisión de cajas',
    shortLabel: 'Revisión',
    icon: 'fact-check',
    permiso: 'cierres.ver',
  },
  {
    id: 'comparativa-fechas-cajas',
    label: 'Comparativa Fechas Cajas',
    shortLabel: 'Comparativa',
    icon: 'event',
    permiso: 'comparativa.ver',
  },
  {
    id: 'objetivos',
    label: 'Objetivos',
    shortLabel: 'Objetivos',
    icon: 'flag',
    permiso: 'objetivos.ver',
  },
  {
    id: 'incentivos-producto',
    label: 'Incentivos por producto',
    shortLabel: 'Incentivos',
    icon: 'redeem',
    permiso: 'incentivos_producto.ver',
  },
  {
    id: 'franjas-horarias',
    label: 'Plantillas de franjas',
    shortLabel: 'Franjas',
    icon: 'schedule',
    permiso: 'objetivos.ver',
  },
  {
    id: 'control-excepciones',
    label: 'Control de Excepciones',
    shortLabel: 'Excepciones',
    icon: 'rule',
    permiso: 'excepciones.ver',
  },
  {
    id: 'top',
    label: 'Top',
    shortLabel: 'Top',
    icon: 'emoji-events',
    permiso: 'top.ver',
  },
];

export default function CajasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const visibles = OPCIONES.filter((o) => hasPermiso(o.permiso));

  function handleSeleccionar(id: string) {
    if (id === 'cierres-teoricos') router.push('/cajas/cierres-teoricos');
    if (id === 'revision-formas-pago') router.push('/cajas/revision-formas-pago');
    if (id === 'arqueo-caja') router.push('/cajas/arqueo-caja');
    if (id === 'movimientos-caja') router.push('/cajas/movimientos-caja');
    if (id === 'revision-cajas') router.push('/cajas/revision-cajas');
    if (id === 'comparativa-fechas-cajas') router.push('/cajas/comparativa-fechas-cajas');
    if (id === 'objetivos') router.push('/cajas/objetivos');
    if (id === 'incentivos-producto') router.push('/cajas/incentivos-producto');
    if (id === 'franjas-horarias') router.push('/cajas/franjas-horarias');
    if (id === 'control-excepciones') router.push('/cajas/control-excepciones');
    if (id === 'top') router.push('/cajas/top');
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Cajas</Text>
      <Text style={styles.subtitle}>Ventas, arqueos y control diario</Text>

      <View style={styles.tilesRow}>
        {visibles.map((opcion) => (
          <TouchableOpacity
            key={opcion.id}
            style={styles.tile}
            onPress={() => handleSeleccionar(opcion.id)}
            activeOpacity={0.7}
            accessibilityLabel={opcion.label}
          >
            <View style={styles.tileStar}>
              <EstrellaFavorito
                size={14}
                favorito={{
                  route: `/cajas/${opcion.id}`,
                  label: opcion.label,
                  icon: opcion.icon,
                  permiso: opcion.permiso,
                }}
              />
            </View>
            <MaterialIcons name={opcion.icon} size={22} color="#0ea5e9" />
            <Text style={styles.tileLabel} numberOfLines={2}>
              {opcion.shortLabel}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {visibles.length === 0 ? (
        <Text style={styles.empty}>No tienes permisos para ningún submódulo de Cajas.</Text>
      ) : null}

      <Text style={styles.sectionLabel}>Facturación del grupo</Text>
      <FacturacionYtdWidget />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: {
    padding: 12,
    paddingBottom: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 12,
  },
  tilesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 18,
  },
  tile: {
    width: 96,
    minHeight: MIN_TOUCH + 28,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  tileStar: {
    position: 'absolute',
    top: 2,
    right: 2,
    zIndex: 1,
  },
  tileLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#334155',
    textAlign: 'center',
    lineHeight: 14,
  },
  empty: {
    fontSize: 13,
    color: '#94a3b8',
    fontStyle: 'italic',
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
});
