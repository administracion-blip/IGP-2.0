import { Stack } from 'expo-router';

/**
 * Módulo de reuniones (Fase 1B): listado y ficha.
 */
export default function ReunionesLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#ffffff' } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[id]" />
    </Stack>
  );
}
