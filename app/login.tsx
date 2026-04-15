import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveToken } from './utils/authToken';
import { emailValido } from './utils/validation';
import { fetchImagenApp } from './lib/personalizacion';

const AUTH_KEY = 'erp_user';
const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

/** Anillo exterior: cyan → violeta → rosa (mismo espíritu que el icono de perfil). */
const LOGO_RING_COLORS = ['#33CCFF', '#9988FF', '#FF66CC'] as const;

export type UserSession = {
  id_usuario: string;
  email: string;
  Nombre: string;
  Rol?: string;
  Locales?: string[];
};

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imagenApp, setImagenApp] = useState<string | null>(null);

  useEffect(() => {
    fetchImagenApp(API_URL).then(setImagenApp);
  }, []);

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
      if (data.token) await saveToken(data.token);
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
        {imagenApp ? (
          <LinearGradient
            colors={[...LOGO_RING_COLORS]}
            locations={[0, 0.5, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.logoRingGradient}
          >
            <View style={styles.logoLoginWrap}>
              <Image
                source={{ uri: imagenApp }}
                style={styles.logoLoginImage}
                resizeMode="contain"
                accessibilityLabel="Logo"
              />
            </View>
          </LinearGradient>
        ) : null}
        <Text style={styles.title}>Grupo Paripé</Text>
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
        <Text style={styles.poweredBy}>Powered by Tabolize</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  /** Anillo con gradiente; el padding es el grosor del aro. */
  logoRingGradient: {
    width: 124,
    height: 124,
    borderRadius: 62,
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 12,
    overflow: 'hidden',
  },
  /** Círculo interior: el padding reduce solo el área de la imagen, no el aro exterior. */
  logoLoginWrap: {
    width: 112,
    height: 112,
    borderRadius: 56,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
    padding: 12,
  },
  logoLoginImage: {
    width: '100%',
    height: '100%',
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
  poweredBy: {
    marginTop: 22,
    alignSelf: 'center',
    fontSize: 11,
    color: '#64748b',
    textAlign: 'center',
    letterSpacing: 0.4,
    ...Platform.select({
      ios: { fontFamily: 'Courier' },
      android: { fontFamily: 'monospace' },
      web: { fontFamily: 'Courier New, Courier, Lucida Console, monospace' },
      default: { fontFamily: 'monospace' },
    }),
  },
});
