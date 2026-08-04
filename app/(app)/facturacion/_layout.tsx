import { Stack } from 'expo-router';

export default function FacturacionLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="facturas-venta" />
      <Stack.Screen name="facturas-gasto" />
      <Stack.Screen name="remesas/index" />
      <Stack.Screen name="remesas/[remesaId]" />
      <Stack.Screen name="factura-detalle" />
      <Stack.Screen name="series" />
      <Stack.Screen name="pagos-cobros" />
      <Stack.Screen name="registro-masivo" />
      <Stack.Screen name="cuadro-mando" />
      <Stack.Screen name="refacturacion/index" />
      <Stack.Screen name="refacturacion/escanear" />
      <Stack.Screen name="refacturacion/pendientes" />
      <Stack.Screen name="refacturacion/emitir" />
    </Stack>
  );
}
