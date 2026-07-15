import { Stack } from 'expo-router';

export default function IncentivosProductoLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[campanaId]" />
    </Stack>
  );
}
