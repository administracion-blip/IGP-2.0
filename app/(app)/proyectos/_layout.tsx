import { Stack } from 'expo-router';

/**
 * Módulo de dirección: hub, vista personal de tareas, listado de proyectos,
 * plantillas, cuadro de mando y las dos fichas (proyecto y tarea).
 */
export default function ProyectosLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#ffffff' } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="mis-tareas" />
      <Stack.Screen name="listado" />
      <Stack.Screen name="plantillas" />
      <Stack.Screen name="cuadro-mando" />
      <Stack.Screen name="[id]" />
      <Stack.Screen name="tarea/[id]" />
    </Stack>
  );
}
