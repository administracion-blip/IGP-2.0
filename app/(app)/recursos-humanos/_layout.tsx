import { Stack } from 'expo-router';

/**
 * Módulo Recursos Humanos: índice del módulo. Las pantallas reales
 * (empleados, cuadrante) viven en sus rutas existentes para no duplicar
 * lógica; este módulo agrupa los accesos en un único hub del sidebar.
 */
export default function RecursosHumanosLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
