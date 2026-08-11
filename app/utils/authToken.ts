import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// [SEC S-09] JWT en SecureStore (iOS/Android). En web queda AsyncStorage/localStorage
// (riesgo residual: accesible a XSS; no hay Keychain/Keystore equivalente en navegador).

const TOKEN_KEY = 'erp_token';

const isNativeSecure =
  Platform.OS === 'ios' || Platform.OS === 'android';

async function getFromAsyncStorage(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

async function saveToAsyncStorage(token: string): Promise<void> {
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

async function removeFromAsyncStorage(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

async function getFromSecureStore(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function saveToSecureStore(token: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

async function removeFromSecureStore(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export async function saveToken(token: string): Promise<void> {
  if (!isNativeSecure) {
    await saveToAsyncStorage(token);
    return;
  }

  const ok = await saveToSecureStore(token);
  if (ok) {
    await removeFromAsyncStorage();
    return;
  }
  // Fallback si SecureStore falla: no tumbar login
  await saveToAsyncStorage(token);
}

export async function getToken(): Promise<string | null> {
  if (!isNativeSecure) {
    return getFromAsyncStorage();
  }

  const secure = await getFromSecureStore();
  if (secure) return secure;

  // Migración one-shot: legacy en AsyncStorage → SecureStore
  const legacy = await getFromAsyncStorage();
  if (!legacy) return null;

  const ok = await saveToSecureStore(legacy);
  if (ok) {
    await removeFromAsyncStorage();
  }
  return legacy;
}

export async function removeToken(): Promise<void> {
  if (isNativeSecure) {
    await removeFromSecureStore();
  }
  await removeFromAsyncStorage();
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) return { 'Content-Type': 'application/json' };
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}
