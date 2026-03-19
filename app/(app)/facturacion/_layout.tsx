import { Stack } from 'expo-router';

export default function FacturacionLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="facturas-venta" />
      <Stack.Screen name="facturas-gasto" />
      <Stack.Screen name="factura-detalle" />
      <Stack.Screen name="series" />
      <Stack.Screen name="pagos-cobros" />
      <Stack.Screen name="registro-masivo" />
      <Stack.Screen name="cuadro-mando" />
    </Stack>
  );
}
