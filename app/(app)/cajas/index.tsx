import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';
import { FacturacionYtdWidget } from '../../components/FacturacionYtdWidget';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { hubAccentById } from '../../lib/hubNavAccent';

type OpcionCaja = {
  id: string;
  label: string;
  descripcion: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  permiso: string;
};

const OPCIONES: OpcionCaja[] = [
  { id: 'cierres-teoricos', label: 'Cierres de ventas teóricas', descripcion: 'Cierres teóricos de ventas desde Ágora', icon: 'receipt-long', permiso: 'cierres.ver' },
  { id: 'revision-formas-pago', label: 'Revisión formas de pago', descripcion: 'Cuadre de formas de pago del arqueo', icon: 'payments', permiso: 'cierres.ver' },
  { id: 'arqueo-caja', label: 'Arqueo de Caja', descripcion: 'Cuadrar y cerrar caja al final del día', icon: 'account-balance-wallet', permiso: 'cierres.ver' },
  { id: 'movimientos-caja', label: 'Movimientos de caja', descripcion: 'Entradas y salidas de efectivo en caja', icon: 'swap-horiz', permiso: 'cierres.ver' },
  { id: 'revision-cajas', label: 'Revisión de cajas', descripcion: 'Revisión operativa de cierres de caja', icon: 'fact-check', permiso: 'cierres.ver' },
  { id: 'comparativa-fechas-cajas', label: 'Comparativa Fechas Cajas', descripcion: 'Comparar cierres de caja entre fechas', icon: 'event', permiso: 'comparativa.ver' },
  { id: 'objetivos', label: 'Objetivos', descripcion: 'Objetivos de venta por local y periodo', icon: 'flag', permiso: 'objetivos.ver' },
  { id: 'franjas-horarias', label: 'Plantillas de franjas', descripcion: 'Plantillas horarias para objetivos', icon: 'schedule', permiso: 'objetivos.ver' },
  { id: 'control-excepciones', label: 'Control de Excepciones', descripcion: 'Seguimiento de excepciones en cierres', icon: 'rule', permiso: 'excepciones.ver' },
  { id: 'top', label: 'Top', descripcion: 'Ranking de locales por ventas', icon: 'emoji-events', permiso: 'top.ver' },
  { id: 'cashflow', label: 'Cashflow', descripcion: 'Entradas, salidas, cobros y pagos fuera de caja', icon: 'trending-up', permiso: 'cashflow.ver' },
];

export default function CajasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { cardWidth, compact } = useHubNavGrid();

  const visibles = useMemo(
    () =>
      OPCIONES.filter((o) => hasPermiso(o.permiso)).sort((a, b) =>
        a.label.localeCompare(b.label, 'es'),
      ),
    [hasPermiso],
  );

  function handleSeleccionar(id: string) {
    if (id === 'cierres-teoricos') router.push('/cajas/cierres-teoricos');
    if (id === 'revision-formas-pago') router.push('/cajas/revision-formas-pago');
    if (id === 'arqueo-caja') router.push('/cajas/arqueo-caja');
    if (id === 'movimientos-caja') router.push('/cajas/movimientos-caja');
    if (id === 'revision-cajas') router.push('/cajas/revision-cajas');
    if (id === 'comparativa-fechas-cajas') router.push('/cajas/comparativa-fechas-cajas');
    if (id === 'objetivos') router.push('/cajas/objetivos');
    if (id === 'franjas-horarias') router.push('/cajas/franjas-horarias');
    if (id === 'control-excepciones') router.push('/cajas/control-excepciones');
    if (id === 'top') router.push('/cajas/top');
    if (id === 'cashflow') router.push('/cashflow');
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Cajas</Text>
      <Text style={styles.subtitle}>Ventas, arqueos y control diario</Text>

      <HubNavGrid style={styles.gridMargin}>
        {visibles.map((opcion) => {
          const accent = hubAccentById(opcion.id);
          return (
            <HubNavCard
              key={opcion.id}
              label={opcion.label}
              description={opcion.descripcion}
              icon={opcion.icon}
              accentBg={accent.accentBg}
              accentFg={accent.accentFg}
              width={cardWidth}
              compact={compact}
              onPress={() => handleSeleccionar(opcion.id)}
              trailing={
                <EstrellaFavorito
                  favorito={{
                    route: opcion.id === 'cashflow' ? '/cashflow' : `/cajas/${opcion.id}`,
                    label: opcion.label,
                    icon: opcion.icon,
                    permiso: opcion.permiso,
                  }}
                />
              }
            />
          );
        })}
      </HubNavGrid>

      {visibles.length === 0 ? (
        <Text style={styles.empty}>No tienes permisos para ningún submódulo de Cajas.</Text>
      ) : null}

      <Text style={styles.sectionLabel}>Facturación del grupo</Text>
      <FacturacionYtdWidget />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#ffffff' },
  scrollContent: { padding: 16, paddingBottom: 32 },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#64748b', marginBottom: 16 },
  gridMargin: { marginBottom: 18 },
  empty: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', marginBottom: 12 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
});
