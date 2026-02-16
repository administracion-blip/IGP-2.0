import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { emailValido } from './utils/validation';

const AUTH_KEY = 'erp_user';
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

export type UserSession = {
  id_usuario: string;
  email: string;
  Nombre: string;
  Rol?: string;
};

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setError(null);
    if (!email.trim() || !password) {
      setError('Introduce email y Password');
      return;
    }
    if (!emailValido(email)) {
      setError('El email debe contener @');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      let data: { error?: string; user?: UserSession };
      try {
        data = await res.json();
      } catch {
        setError(`Respuesta inválida del servidor (${res.status})`);
        return;
      }
      if (!res.ok) {
        setError(data.error || 'Credenciales incorrectas');
        return;
      }
      await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(data.user));
      router.replace('/(app)');
    } catch (e) {
      const msg =
        Platform.OS === 'web'
          ? `No se pudo conectar con ${API_URL}. ¿Está el API en marcha? (npm run dev)`
          : `No se pudo conectar con ${API_URL}. ¿Está el API en marcha? En móvil usa la IP de tu PC (ej. http://192.168.1.x:3002).`;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>ERP Hostelería</Text>
        <Text style={styles.subtitle}>Iniciar sesión</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#888"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          editable={!loading}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#888"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          editable={!loading}
        />

        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Entrar</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f8fafc',
    textAlign: 'center',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#334155',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    color: '#f8fafc',
    marginBottom: 10,
  },
  button: {
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  errorText: {
    color: '#f87171',
    fontSize: 13,
    marginBottom: 8,
    textAlign: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
