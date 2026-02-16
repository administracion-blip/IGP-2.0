import { Stack } from 'expo-router';

export default function CajasLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="cierres-teoricos" />
      <Stack.Screen name="arqueo-caja" />
    </Stack>
  );
}
