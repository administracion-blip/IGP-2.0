import { Stack } from 'expo-router';

export default function CajasLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="cierres-teoricos" />
      <Stack.Screen name="revision-formas-pago" />
      <Stack.Screen name="arqueo-caja" />
      <Stack.Screen name="comparativa-fechas-cajas" />
      <Stack.Screen name="objetivos" />
      <Stack.Screen name="incentivos-producto" />
      <Stack.Screen name="franjas-horarias" />
      <Stack.Screen name="control-excepciones" />
      <Stack.Screen name="efectivo-ingresar" />
      <Stack.Screen name="top" />
    </Stack>
  );
}
