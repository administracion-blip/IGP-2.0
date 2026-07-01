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
import { useRouter, useLocalSearchParams } from 'expo-router';
import { apiFetch, errorMessage } from './utils/api';

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string; email?: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const email = typeof params.email === 'string' ? params.email : '';

  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const enlaceInvalido = !token || !email;

  async function handleSubmit() {
    setError(null);
    if (!password || !password2) {
      setError('Introduce y repite la nueva contraseña');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
      return;
    }
    if (password !== password2) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/api/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email, token, password }),
        timeoutMs: 15000,
      });
      let data: { ok?: boolean; message?: string; error?: string } = {};
      try {
        data = await res.json();
      } catch {
        // sin cuerpo
      }
      if (!res.ok) {
        setError(data.error || 'No se pudo restablecer la contraseña');
        return;
      }
      setOk(true);
    } catch (e) {
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
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
        <Text style={styles.title}>Nueva contraseña</Text>

        {enlaceInvalido ? (
          <>
            <Text style={styles.errorText}>
              El enlace de recuperación no es válido. Solicita uno nuevo desde la
              pantalla de inicio de sesión.
            </Text>
            <TouchableOpacity style={styles.button} onPress={() => router.replace('/login')}>
              <Text style={styles.buttonText}>Volver al inicio de sesión</Text>
            </TouchableOpacity>
          </>
        ) : ok ? (
          <>
            <Text style={styles.info}>
              Tu contraseña se ha actualizado correctamente. Ya puedes iniciar sesión.
            </Text>
            <TouchableOpacity style={styles.button} onPress={() => router.replace('/login')}>
              <Text style={styles.buttonText}>Ir al inicio de sesión</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.subtitle}>Elige una nueva contraseña para {email}.</Text>

            <TextInput
              style={styles.input}
              placeholder="Nueva contraseña"
              placeholderTextColor="#888"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password-new"
              editable={!loading}
            />
            <TextInput
              style={styles.input}
              placeholder="Repite la contraseña"
              placeholderTextColor="#888"
              value={password2}
              onChangeText={setPassword2}
              secureTextEntry
              autoComplete="password-new"
              editable={!loading}
              onSubmitEditing={handleSubmit}
            />

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleSubmit}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Guardar contraseña</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => router.replace('/login')}
              disabled={loading}
              style={styles.backLink}
            >
              <Text style={styles.backText}>Volver al inicio de sesión</Text>
            </TouchableOpacity>
          </>
        )}
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
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f8fafc',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 16,
  },
  info: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
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
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  errorText: {
    color: '#f87171',
    fontSize: 13,
    marginBottom: 12,
    textAlign: 'center',
  },
  backLink: {
    marginTop: 14,
    alignSelf: 'center',
    paddingVertical: 6,
  },
  backText: {
    color: '#38bdf8',
    fontSize: 13,
    textAlign: 'center',
  },
});
