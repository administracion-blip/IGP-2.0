import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { hubAccentById } from '../../lib/hubNavAccent';

const OPCIONES: {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  descripcion: string;
  permiso: string;
}[] = [
  { id: 'pedidos', label: 'Pedidos', icon: 'local-shipping', descripcion: 'Gestión de pedidos a proveedores', permiso: 'pedidos.ver' },
  { id: 'almacen', label: 'Preparar Pedidos', icon: 'inventory-2', descripcion: 'Almacén: preparar los pedidos enviados por los locales', permiso: 'pedidos.preparar' },
  { id: 'pedidos-completados', label: 'Pedidos Completados', icon: 'check-circle', descripcion: 'Pedidos con estado completado', permiso: 'pedidos.ver_completados' },
  { id: 'traspasos-agora', label: 'Traspasos a Agora', icon: 'sync-alt', descripcion: 'Exportar artículos de pedidos completados a Agora (Excel)', permiso: 'pedidos.exportar_traspaso' },
  { id: 'detalles-pedidos', label: 'Detalles Pedidos', icon: 'list-alt', descripcion: 'Artículos asociados a cada pedido', permiso: 'pedidos.ver' },
  { id: 'compras-proveedor', label: 'Compras a Proveedor', icon: 'receipt-long', descripcion: 'Albaranes de entrada desde Ágora', permiso: 'compras_proveedor.ver' },
  { id: 'conciliacion-facturas', label: 'Conciliación Facturas', icon: 'fact-check', descripcion: 'Contraste de albaranes de Ágora con facturas de gasto por proveedor', permiso: 'compras_proveedor.ver' },
  { id: 'abonos-rappel', label: 'Abonos por Rappel', icon: 'savings', descripcion: 'Abono al local por rappels, por mes y año', permiso: 'pedidos.ver' },
  { id: 'facturacion', label: 'Facturación Mensual', icon: 'request-quote', descripcion: 'Facturas de ventas internas y abonos de rappel entre sociedades del grupo', permiso: 'compras.facturar' },
  { id: 'ventas-empresa', label: 'Ventas por Empresa', icon: 'point-of-sale', descripcion: 'Total a cobrar a cada sociedad (pedidos completados)', permiso: 'pedidos.ver' },
  { id: 'mia', label: 'MIA — Aprovisionamiento', icon: 'psychology', descripcion: 'Motor inteligente: calcula pedidos sugeridos por almacén', permiso: 'mia.ver' },
  { id: 'escandallos', label: 'Escandallos', icon: 'restaurant-menu', descripcion: 'Recetas de platos: ingredientes para MIA', permiso: 'escandallos.ver' },
  { id: 'acuerdos', label: 'Acuerdos', icon: 'handshake', descripcion: 'Acuerdos comerciales con proveedores', permiso: 'acuerdos.ver' },
];

export default function ComprasIndexScreen() {
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
    if (id === 'pedidos') router.push('/compras/pedidos');
    if (id === 'almacen') router.push('/compras/almacen');
    if (id === 'pedidos-completados') router.push('/compras/pedidos-completados');
    if (id === 'traspasos-agora') router.push('/compras/traspasos-agora');
    if (id === 'detalles-pedidos') router.push('/compras/detalles-pedidos');
    if (id === 'compras-proveedor') router.push('/compras/compras-proveedor');
    if (id === 'conciliacion-facturas') router.push('/compras/conciliacion-facturas');
    if (id === 'abonos-rappel') router.push('/compras/abonos-rappel');
    if (id === 'facturacion') router.push('/compras/facturacion');
    if (id === 'ventas-empresa') router.push('/compras/ventas-empresa');
    if (id === 'mia') router.push('/compras/mia');
    if (id === 'escandallos') router.push('/compras/escandallos');
    if (id === 'acuerdos') router.push('/acuerdos');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Compras</Text>
      <Text style={styles.subtitle}>Gestión de compras y proveedores. Selecciona una opción.</Text>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
        <HubNavGrid>
          {visibles.map((opcion) => {
            const accent = hubAccentById(opcion.id);
            const esAlmacen = opcion.id === 'almacen';
            return (
              <HubNavCard
                key={opcion.id}
                label={opcion.label}
                description={opcion.descripcion}
                icon={opcion.icon}
                accentBg={accent.accentBg}
                accentFg={accent.accentFg}
                variant={esAlmacen ? 'accent' : 'default'}
                width={cardWidth}
                compact={compact}
                onPress={() => handleSeleccionar(opcion.id)}
                trailing={
                  <EstrellaFavorito
                    favorito={{
                      route: opcion.id === 'acuerdos' ? '/acuerdos' : `/compras/${opcion.id}`,
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
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#ffffff' },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748b', marginBottom: 16 },
});
