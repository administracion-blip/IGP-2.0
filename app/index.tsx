import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_KEY = 'erp_user';

export default function Index() {
  const [isReady, setIsReady] = useState(false);
  const [user, setUser] = useState<{ Nombre?: string } | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(AUTH_KEY).then((stored) => {
      setUser(stored ? JSON.parse(stored) : null);
      setIsReady(true);
    });
  }, []);

  if (!isReady) return null;
  if (user?.Nombre !== undefined) return <Redirect href="/(app)" />;
  return <Redirect href="/login" />;
}
