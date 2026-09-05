import { Stack } from 'expo-router';
import { tasksColor } from '../../constants/tasksUiTokens';

/**
 * Módulo de reuniones (Fase 1B): listado y ficha.
 */
export default function ReunionesLayout() {
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tasksColor.fondoApp } }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="[id]" />
    </Stack>
  );
}
