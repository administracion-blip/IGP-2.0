import { Stack } from 'expo-router';

/**
 * Módulo RRPP: hub + Entradas online (coupons Ágora).
 */
export default function RrppLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="entradas/index" />
      <Stack.Screen name="entradas/nueva" />
      <Stack.Screen name="entradas/config" />
    </Stack>
  );
}
