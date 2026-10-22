import { Stack } from 'expo-router';

export default function RrssLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#ffffff' },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="nueva-propuesta" />
      <Stack.Screen name="propuesta/[id]" />
      <Stack.Screen name="calendario" />
      <Stack.Screen name="carteles-musico" />
      <Stack.Screen name="config-estilo" />
    </Stack>
  );
}
