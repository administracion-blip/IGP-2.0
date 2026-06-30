import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { hubCardWidthPercent, MIN_TOUCH } from '../../constants/layout';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';

const OPCIONES: { id: string; label: string; icon: React.ComponentProps<typeof MaterialIcons>['name']; descripcion: string; permiso: string }[] = [
  {
    id: 'pedidos',
    label: 'Pedidos',
    icon: 'local-shipping',
    descripcion: 'Gestión de pedidos a proveedores',
    permiso: 'pedidos.ver',
  },
  {
    id: 'almacen',
    label: 'Preparar Pedidos',
    icon: 'inventory-2',
    descripcion: 'Almacén: preparar los pedidos enviados por los locales',
    permiso: 'pedidos.preparar',
  },
  {
    id: 'pedidos-completados',
    label: 'Pedidos Completados',
    icon: 'check-circle',
    descripcion: 'Pedidos con estado completado',
    permiso: 'pedidos.ver_completados',
  },
  {
    id: 'traspasos-agora',
    label: 'Traspasos a Agora',
    icon: 'sync-alt',
    descripcion: 'Exportar artículos de pedidos completados a Agora (Excel)',
    permiso: 'pedidos.exportar_traspaso',
  },
  {
    id: 'detalles-pedidos',
    label: 'Detalles Pedidos',
    icon: 'list-alt',
    descripcion: 'Artículos asociados a cada pedido',
    permiso: 'pedidos.ver',
  },
  {
    id: 'compras-proveedor',
    label: 'Compras a Proveedor',
    icon: 'receipt-long',
    descripcion: 'Albaranes de entrada desde Ágora',
    permiso: 'compras_proveedor.ver',
  },
  {
    id: 'abonos-rappel',
    label: 'Abonos por Rappel',
    icon: 'savings',
    descripcion: 'Abono al local por rappels, por mes y año',
    permiso: 'pedidos.ver',
  },
  {
    id: 'ventas-empresa',
    label: 'Ventas por Empresa',
    icon: 'point-of-sale',
    descripcion: 'Total a cobrar a cada sociedad (pedidos completados)',
    permiso: 'pedidos.ver',
  },
];

export default function ComprasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { hubGridColumns } = useBreakpoint();
  const cardWidth = hubCardWidthPercent(hubGridColumns);
  const cardColumn = hubGridColumns === 1;

  function handleSeleccionar(id: string) {
    if (id === 'pedidos') router.push('/compras/pedidos');
    if (id === 'almacen') router.push('/compras/almacen');
    if (id === 'pedidos-completados') router.push('/compras/pedidos-completados');
    if (id === 'traspasos-agora') router.push('/compras/traspasos-agora');
    if (id === 'detalles-pedidos') router.push('/compras/detalles-pedidos');
    if (id === 'compras-proveedor') router.push('/compras/compras-proveedor');
    if (id === 'abonos-rappel') router.push('/compras/abonos-rappel');
    if (id === 'ventas-empresa') router.push('/compras/ventas-empresa');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Compras</Text>
      <Text style={styles.subtitle}>Gestión de compras y proveedores. Selecciona una opción.</Text>

      <View style={styles.grid}>
        {OPCIONES.filter((o) => hasPermiso(o.permiso)).map((opcion) => {
          const esAlmacen = opcion.id === 'almacen';
          return (
          <TouchableOpacity
            key={opcion.id}
            style={[
              styles.card,
              esAlmacen && styles.cardAlmacen,
              { width: cardWidth, minHeight: MIN_TOUCH + 20 },
              cardColumn && styles.cardColumn,
            ]}
            onPress={() => handleSeleccionar(opcion.id)}
            activeOpacity={0.7}
          >
            <View style={styles.cardLeft}>
              <EstrellaFavorito
                favorito={{ route: `/compras/${opcion.id}`, label: opcion.label, icon: opcion.icon, permiso: opcion.permiso }}
              />
              <MaterialIcons name={opcion.icon} size={24} color={esAlmacen ? '#0f172a' : '#0ea5e9'} />
              <Text style={[styles.cardLabel, esAlmacen && styles.cardLabelAlmacen]}>{opcion.label}</Text>
            </View>
            <Text
              style={[
                styles.cardDescripcion,
                esAlmacen && styles.cardDescripcionAlmacen,
                cardColumn && styles.cardDescripcionStacked,
              ]}
              numberOfLines={2}
            >
              {opcion.descripcion}
            </Text>
          </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 10,
  },
  cardColumn: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  cardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  cardLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: '#334155',
  },
  cardDescripcion: {
    flex: 1,
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
    color: '#94a3b8',
    marginLeft: 8,
    textAlign: 'right',
  },
  cardDescripcionStacked: {
    marginLeft: 0,
    marginTop: 4,
    textAlign: 'left',
    width: '100%',
  },
  cardAlmacen: {
    backgroundColor: '#ffedd5',
    borderColor: '#fdba74',
  },
  cardLabelAlmacen: {
    color: '#0f172a',
    fontWeight: '700',
  },
  cardDescripcionAlmacen: {
    color: '#78716c',
    fontStyle: 'normal',
  },
});
