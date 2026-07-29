import { Stack } from 'expo-router';

export default function ComprasLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="pedidos" />
      <Stack.Screen name="almacen" />
      <Stack.Screen name="pedidos-completados" />
      <Stack.Screen name="detalles-pedidos" />
      <Stack.Screen name="compras-proveedor" />
      <Stack.Screen name="compras-proveedor-ultimo" />
      <Stack.Screen name="compras-proveedor-resumen" />
      <Stack.Screen name="conciliacion-facturas" />
      <Stack.Screen name="abonos-rappel" />
      <Stack.Screen name="ventas-empresa" />
      <Stack.Screen name="traspasos-agora" />
      <Stack.Screen name="facturacion" />
    </Stack>
  );
}
