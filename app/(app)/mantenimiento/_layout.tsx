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
      </Stack>
    </MantenimientoLocalesProvider>
  );
}
