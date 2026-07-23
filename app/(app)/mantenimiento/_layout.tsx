import { Stack } from 'expo-router';
import { MantenimientoLocalesProvider } from './LocalesContext';

export default function MantenimientoLayout() {
  return (
    <MantenimientoLocalesProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#ffffff' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="incidencias" />
        <Stack.Screen name="reportar" />
        <Stack.Screen name="abiertas" />
        <Stack.Screen name="programadas-hoy" />
        <Stack.Screen name="reparaciones-realizadas" />
        <Stack.Screen name="recurrentes" />
        <Stack.Screen name="limpieza/index" />
        <Stack.Screen name="limpieza/maestros" />
        <Stack.Screen name="limpieza/catalogo" />
        <Stack.Screen name="limpieza/objetos" />
        <Stack.Screen name="limpieza/programacion" />
        <Stack.Screen name="limpieza/registros" />
        <Stack.Screen name="limpieza/calendario" />
      </Stack>
    </MantenimientoLocalesProvider>
  );
}
