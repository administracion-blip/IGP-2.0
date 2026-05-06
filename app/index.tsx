import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiFetch } from './utils/api';
import { getToken, removeToken } from './utils/authToken';

const AUTH_KEY = 'erp_user';

type Decision = 'login' | 'app';

export default function Index() {
  const [isReady, setIsReady] = useState(false);
  const [decision, setDecision] = useState<Decision>('login');

  useEffect(() => {
    let cancelled = false;

    async function decidir(): Promise<Decision> {
      const token = await getToken();
      if (!token) return 'login';

      const stored = await AsyncStorage.getItem(AUTH_KEY).catch(() => null);
      if (!stored) return 'login';

      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 10000);
        const res = await apiFetch('/api/me', { signal: controller.signal });
        clearTimeout(tid);

        if (res.status === 401 || res.status === 403) {
          await AsyncStorage.removeItem(AUTH_KEY).catch(() => {});
          await removeToken();
          return 'login';
        }
        if (!res.ok) {
          /** Errores transitorios (red, 5xx): no expulsamos. AuthContext reintentará. */
          return 'app';
        }
        return 'app';
      } catch {
        /** Sin red: confiamos en el cache local para no bloquear al usuario offline. */
        return 'app';
      }
    }

    decidir()
      .then((d) => {
        if (!cancelled) setDecision(d);
      })
      .finally(() => {
        if (!cancelled) setIsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!isReady) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color="#0ea5e9" />
      </View>
    );
  }
  if (decision === 'app') return <Redirect href="/(app)" />;
  return <Redirect href="/login" />;
}

const styles = StyleSheet.create({
  boot: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f1f5f9' },
});
