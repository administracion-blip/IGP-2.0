import { useMemo, type ComponentProps } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';
import { HubNavCard, HubNavGrid } from '../../components/ui/HubNavCard';
import { useHubNavGrid } from '../../hooks/useHubNavGrid';
import { hubAccentById } from '../../lib/hubNavAccent';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

type Opcion = {
  id: string;
  label: string;
  icon: IconName;
  descripcion: string;
  permiso: string;
};

type Grupo = {
  id: string;
  titulo: string;
  opciones: Opcion[];
};

/** Pedidos del local al almacén, su preparación y la liquidación entre sociedades. */
const PEDIDOS_INTERNOS: Opcion[] = [
  { id: 'pedidos', label: 'Pedidos', icon: 'local-shipping', descripcion: 'Pedidos de los locales al almacén', permiso: 'pedidos.ver' },
  { id: 'almacen', label: 'Preparar Pedidos', icon: 'inventory-2', descripcion: 'Almacén: preparar los pedidos enviados por los locales', permiso: 'pedidos.preparar' },
  { id: 'pedidos-completados', label: 'Pedidos Completados', icon: 'check-circle', descripcion: 'Pedidos con estado completado', permiso: 'pedidos.ver_completados' },
  { id: 'traspasos-agora', label: 'Traspasos a Agora', icon: 'sync-alt', descripcion: 'Exportar artículos de pedidos completados a Agora (Excel)', permiso: 'pedidos.exportar_traspaso' },
  { id: 'detalles-pedidos', label: 'Detalles Pedidos', icon: 'list-alt', descripcion: 'Artículos asociados a cada pedido', permiso: 'pedidos.ver' },
  { id: 'abonos-rappel', label: 'Abonos por Rappel', icon: 'savings', descripcion: 'Abono al local por rappels, por mes y año', permiso: 'pedidos.ver' },
  { id: 'facturacion', label: 'Facturación Mensual', icon: 'request-quote', descripcion: 'Facturas de ventas internas y abonos de rappel entre sociedades del grupo', permiso: 'compras.facturar' },
  { id: 'ventas-empresa', label: 'Ventas por Empresa', icon: 'point-of-sale', descripcion: 'Total a cobrar a cada sociedad (pedidos completados)', permiso: 'pedidos.ver' },
];

/** Compras que entran de fuera y el cálculo que ayuda a pedirlas. */
const PEDIDOS_PROVEEDORES: Opcion[] = [
  { id: 'compras-proveedor', label: 'Compras a Proveedor', icon: 'receipt-long', descripcion: 'Albaranes de entrada desde Ágora', permiso: 'compras_proveedor.ver' },
  { id: 'conciliacion-facturas', label: 'Conciliación Facturas', icon: 'fact-check', descripcion: 'Contraste de albaranes de Ágora con facturas de gasto por proveedor', permiso: 'compras_proveedor.ver' },
  { id: 'mia', label: 'MIA — Aprovisionamiento', icon: 'psychology', descripcion: 'Motor inteligente: calcula pedidos sugeridos por almacén', permiso: 'mia.ver' },
  { id: 'acuerdos', label: 'Acuerdos', icon: 'handshake', descripcion: 'Acuerdos comerciales con proveedores', permiso: 'acuerdos.ver' },
];

/** Qué se cuenta en cada almacén. La revisión y el Excel se añaden aquí. */
const INVENTARIO: Opcion[] = [
  {
    id: 'inventario-plantillas',
    label: 'Plantillas de inventario',
    icon: 'inventory',
    descripcion: 'Familias a contar en cada almacén',
    permiso: 'inventario.gestionar',
  },
];

/** Fuera de los dos bloques: misma ruta y el mismo sitio suelto de antes. */
const ESCANDALLOS: Opcion = {
  id: 'escandallos',
  label: 'Escandallos',
  icon: 'restaurant-menu',
  descripcion: 'Recetas de platos: ingredientes para MIA',
  permiso: 'escandallos.ver',
};

const GRUPOS: Grupo[] = [
  { id: 'internos', titulo: 'Pedidos internos', opciones: PEDIDOS_INTERNOS },
  { id: 'proveedores', titulo: 'Pedidos a proveedores', opciones: PEDIDOS_PROVEEDORES },
  { id: 'inventario', titulo: 'Inventario', opciones: INVENTARIO },
];

function porNombre(a: Opcion, b: Opcion): number {
  return a.label.localeCompare(b.label, 'es');
}

export default function ComprasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { cardWidth, compact } = useHubNavGrid();

  const gruposVisibles = useMemo(
    () =>
      GRUPOS.map((grupo) => ({
        ...grupo,
        opciones: grupo.opciones.filter((o) => hasPermiso(o.permiso)).sort(porNombre),
      })).filter((grupo) => grupo.opciones.length > 0),
    [hasPermiso],
  );

  const escandallosVisible = hasPermiso(ESCANDALLOS.permiso);

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
    if (id === 'inventario-plantillas') router.push('/compras/inventario-plantillas');
  }

  function renderTarjeta(opcion: Opcion) {
    const accent = hubAccentById(opcion.id);
    return (
      <HubNavCard
        key={opcion.id}
        label={opcion.label}
        description={opcion.descripcion}
        icon={opcion.icon}
        accentBg={accent.accentBg}
        accentFg={accent.accentFg}
        variant={opcion.id === 'almacen' ? 'accent' : 'default'}
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
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Compras</Text>
      <Text style={styles.subtitle}>Gestión de compras y proveedores. Selecciona una opción.</Text>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator>
        {gruposVisibles.map((grupo) => (
          <View key={grupo.id} style={styles.seccion}>
            <Text style={styles.seccionTitulo}>{grupo.titulo}</Text>
            <HubNavGrid>{grupo.opciones.map(renderTarjeta)}</HubNavGrid>
          </View>
        ))}
        {escandallosVisible ? (
          <View style={styles.seccion}>
            <HubNavGrid>{renderTarjeta(ESCANDALLOS)}</HubNavGrid>
          </View>
        ) : null}
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
  seccion: { marginBottom: 8 },
  seccionTitulo: { fontSize: 15, fontWeight: '700', color: '#0f172a', marginBottom: 10 },
});
