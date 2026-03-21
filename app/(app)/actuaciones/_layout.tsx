import { Stack } from 'expo-router';

export default function ActuacionesLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="artistas" />
      <Stack.Screen name="programacion" />
    </Stack>
  );
}
