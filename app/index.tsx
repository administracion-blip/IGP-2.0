import { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_KEY = 'erp_user';

export default function Index() {
  const [isReady, setIsReady] = useState(false);
  const [user, setUser] = useState<{ Nombre?: string } | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(AUTH_KEY)
      .then((stored) => {
        if (!stored) {
          setUser(null);
          return;
        }
        try {
          setUser(JSON.parse(stored));
        } catch {
          setUser(null);
        }
      })
      .catch(() => setUser(null))
      .finally(() => setIsReady(true));
  }, []);

  if (!isReady) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color="#0ea5e9" />
      </View>
    );
  }
  if (user?.Nombre !== undefined) return <Redirect href="/(app)" />;
  return <Redirect href="/login" />;
}

const styles = StyleSheet.create({
  boot: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f1f5f9' },
});
