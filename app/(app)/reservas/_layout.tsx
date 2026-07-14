import { Stack } from 'expo-router';

/**
 * Módulo Reservas: hub + Cover Manager (placeholder) + Activaciones de marcas.
 */
export default function ReservasLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="cover-manager" />
      <Stack.Screen name="activaciones" />
      <Stack.Screen name="activacion-nueva" />
      <Stack.Screen name="activacion-detalle" />
      <Stack.Screen name="activacion-sesiones" />
    </Stack>
  );
}
