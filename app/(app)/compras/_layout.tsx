import { Stack } from 'expo-router';

export default function ComprasLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="pedidos" />
      <Stack.Screen name="pedidos-completados" />
      <Stack.Screen name="detalles-pedidos" />
      <Stack.Screen name="compras-proveedor" />
    </Stack>
  );
}
