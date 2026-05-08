import { Stack } from 'expo-router';

/**
 * Módulo Planning del día: índice + subrutas (p. ej. cuadrante de personal).
 */
export default function PlanningDiaLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="cuadrante" />
    </Stack>
  );
}
