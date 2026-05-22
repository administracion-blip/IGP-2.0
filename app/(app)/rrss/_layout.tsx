import { Stack } from 'expo-router';
import { MarketingLocalesProvider } from './LocalesContext';

export default function RrssLayout() {
  return (
    <MarketingLocalesProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="nueva-propuesta" />
        <Stack.Screen name="propuesta/[id]" />
        <Stack.Screen name="calendario" />
        <Stack.Screen name="carteles-musico" />
        <Stack.Screen name="config-estilo" />
      </Stack>
    </MarketingLocalesProvider>
  );
}
