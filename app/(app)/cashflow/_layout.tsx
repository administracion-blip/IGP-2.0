import { Stack } from 'expo-router';

export default function CashflowLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="nuevo" />
      <Stack.Screen name="[movimientoId]" />
    </Stack>
  );
}
