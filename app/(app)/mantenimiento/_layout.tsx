import { Stack } from 'expo-router';
import { MantenimientoLocalesProvider } from './LocalesContext';

export default function MantenimientoLayout() {
  return (
    <MantenimientoLocalesProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="reportar" />
        <Stack.Screen name="abiertas" />
        <Stack.Screen name="programadas-hoy" />
        <Stack.Screen name="reparaciones-realizadas" />
        <Stack.Screen name="recurrentes" />
        <Stack.Screen name="limpieza/index" />
        <Stack.Screen name="limpieza/catalogo" />
        <Stack.Screen name="limpieza/programacion" />
        <Stack.Screen name="limpieza/registros" />
      </Stack>
    </MantenimientoLocalesProvider>
  );
}
