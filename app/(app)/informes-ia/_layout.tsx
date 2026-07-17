import { Stack } from 'expo-router';

export default function InformesIaLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="plantillas" />
      <Stack.Screen name="ajustes" />
    </Stack>
  );
}
